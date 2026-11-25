import {
  linkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, newId } from "../contracts/json.js";
import type {
  ContributionOrigin,
  JsonObject,
  JsonValue,
} from "../contracts/types.js";
import { compileInputSchema } from "../contracts/validation.js";
import { extensionNamespace, scriptFilename } from "./names.js";
import { atomicText, contains, privateDirectory } from "./paths.js";
import { CONTROL_OWNER, CONTROL_VERSION } from "./platform-identity.js";

export interface ScriptMetadata {
  scriptName: string;
  scriptDesc: string;
  scriptWhenUse: string;
  scriptInputSchema: JsonValue;
  scriptOutputSchema?: JsonValue;
  scriptOpenDefault: boolean;
}
interface ScriptOriginBase {
  type: "local" | "platform" | "extension";
  owner: string;
  namespace: string | null;
  version: string | null;
}
export type ScriptOrigin = ContributionOrigin;
export interface ScriptSnapshot {
  name: string | null;
  code: string;
  metadata: ScriptMetadata | null;
  origin: ScriptOrigin;
  path: string | null;
}
export interface ScriptSource {
  readonly type: "platform" | "extension";
  readonly owner: string;
  readonly namespace: string;
  readonly version: string;
  readonly directory: string;
}
export interface ScriptUsage {
  owner: string;
  scriptName: string;
  count: number;
  lastStartedAt: number;
}
export interface ScriptDiagnostic {
  source: string;
  path: string | null;
  code: string;
  message: string;
}
export interface ScriptEntry extends ScriptMetadata {
  path: string;
  origin: ScriptOrigin;
}
export interface ScriptDiscovery {
  readonly entries: readonly ScriptEntry[];
  readonly warnings: readonly ScriptDiagnostic[];
}

const maxCodeBytes = 1024 * 1024;
const sha = (code: string) => createHash("sha256").update(code).digest("hex");
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type ScriptHeaderReader = (code: string) => ScriptMetadata | null;
type InputValidatorObserver = (validate: (value: unknown) => void) => void;
export function scriptHeader(
  code: string, onInputValidator?: InputValidatorObserver,
): ScriptMetadata | null {
  requireCondition(
    Buffer.byteLength(code) <= maxCodeBytes,
    "script_too_large",
    "The script exceeds its code budget.",
  );
  const text = code.replace(/^\uFEFF/, "").trimStart();
  if (!text.startsWith("/**")) return null;
  const end = text.indexOf("*/", 3);
  const body = text.slice(3, end < 0 ? undefined : end).trim();
  if (!body.startsWith("{")) return null;
  requireCondition(
    end >= 0 && Buffer.byteLength(body) <= 65536,
    "invalid_script_header",
    "The JSON script header is incomplete or exceeds 64 KiB.",
  );
  let parsed: JsonObject;
  try {
    parsed = JSON.parse(body) as JsonObject;
  } catch (error) {
    const match = /at position (\d+)/.exec((error as Error).message);
    const offset =
      code.indexOf("{", code.indexOf("/**") + 3) +
      (match ? Number(match[1]) : body.length);
    const prefix = code.slice(0, offset);
    throw new AgentError(
      "invalid_script_header",
      "Invalid JSON in the first script block comment.",
      {
        line: prefix.split("\n").length,
        column: offset - prefix.lastIndexOf("\n"),
        offset,
      },
    );
  }
  scriptFilename(parsed.scriptName);
  for (const key of ["scriptDesc", "scriptWhenUse"]) {
    requireCondition(
      typeof parsed[key] === "string" &&
        parsed[key].trim().length > 0 &&
        parsed[key].length <= 8192,
      "invalid_script_header",
      `The header requires a nonempty ${key}.`,
    );
  }
  const keys = new Set([
    "scriptName",
    "scriptDesc",
    "scriptWhenUse",
    "scriptInputSchema",
    "scriptOutputSchema",
    "scriptOpenDefault",
  ]);
  requireCondition(
    Object.keys(parsed).every((key) => keys.has(key)),
    "invalid_script_header",
    "The script header has an unknown field; origin and namespaces are assigned by the runtime.",
  );
  requireCondition(
    parsed.scriptOpenDefault === undefined ||
      typeof parsed.scriptOpenDefault === "boolean",
    "invalid_script_header",
    "scriptOpenDefault must be a JSON boolean.",
  );
  const validateInput = compileInputSchema(parsed.scriptInputSchema);
  if (Object.hasOwn(parsed, "scriptOutputSchema")) {
    try { compileInputSchema(parsed.scriptOutputSchema); }
    catch (cause) {
      throw new AgentError("invalid_output_schema", "The script output schema must be a valid local Draft 7 schema.", undefined, { cause });
    }
  }
  // Only publish the compiler after the complete header has been checked.
  onInputValidator?.(validateInput);
  return {
    scriptName: parsed.scriptName,
    scriptDesc: parsed.scriptDesc as string,
    scriptWhenUse: parsed.scriptWhenUse as string,
    scriptInputSchema: parsed.scriptInputSchema!,
    ...(parsed.scriptOutputSchema !== undefined ? { scriptOutputSchema: parsed.scriptOutputSchema } : {}),
    scriptOpenDefault: parsed.scriptOpenDefault ?? false,
  };
}

export class ScriptCatalog {
  readonly work: string;
  readonly local: string;
  readonly skills: string;
  readonly owner: string;
  // Supplied by the trusted contribution registry, never by script input/header.
  #sources: () => readonly ScriptSource[];

  constructor(
    work: string,
    agentId: string,
    sources: () => readonly ScriptSource[] = () => [],
  ) {
    this.work = realpathSync.native(work);
    this.owner = `local:${agentId}`;
    this.local = privateDirectory(this.work, "scripts");
    this.skills = privateDirectory(this.work, "cache", "materials");
    this.#sources = sources;
  }

  #registered(targetNamespace?: string): ScriptSource[] {
    const namespaces = new Set<string>();
    // Installed, versioned scripts share ScriptCatalog and the existing Run
    // path. Their identity is code-owned, never supplied by caller metadata.
    const builtin: ScriptSource = {
      type: "platform",
      // The installed package name does not redefine Go's platform identity.
      owner: CONTROL_OWNER,
      namespace: "nexum",
      version: CONTROL_VERSION,
      directory: fileURLToPath(new URL("../../builtin/", import.meta.url)),
    };
    const result = [builtin, ...this.#sources()];
    for (const source of result) {
      if (source.type === "extension") extensionNamespace(source.namespace);
      else
        requireCondition(
          source.namespace === "nexum" ||
            [
              "sh",
              "transfer",
              "runtime",
              "state",
              "maintenance",
              "mcp",
              "api",
            ].includes(source.namespace),
          "invalid_namespace",
          "A platform source must use its registered platform namespace.",
        );
      const key = source.namespace.toLowerCase();
      requireCondition(
        !namespaces.has(key) && source.owner && source.version,
        "namespace_conflict",
        "Two active script sources cannot share a namespace.",
      );
      namespaces.add(key);
      requireCondition(
        path.isAbsolute(source.directory),
        "script_source_invalid",
        "A script source must have an absolute directory.",
      );
      if (
        source.type === "extension" &&
        (targetNamespace === undefined || source.namespace === targetNamespace)
      ) {
        const modules = realpathSync.native(path.join(this.work, "node_modules"));
        requireCondition(
          contains(this.work, modules) && contains(modules, realpathSync.native(source.directory)),
          "script_source_invalid",
          "Extension scripts must come from the registered Agent npm environment.",
        );
      }
    }
    return result;
  }

  #read(
    directory: string,
    filename: string,
    origin: ScriptOriginBase,
    readHeader: ScriptHeaderReader = scriptHeader,
  ): ScriptSnapshot {
    scriptFilename(filename);
    if (directory === this.local) privateDirectory(this.work, "scripts");
    const root = realpathSync.native(directory);
    const matches = readdirSync(root).filter(
      (name) => name.toLowerCase() === filename.toLowerCase(),
    );
    requireCondition(matches.length > 0, "script_not_found",
      "The named script is no longer available in this source.");
    requireCondition(
      matches.length === 1 && matches[0] === filename,
      "script_name_conflict",
      "This script name has a portable filename collision.",
    );
    const candidate = path.join(root, filename);
    const actual = realpathSync.native(candidate);
    requireCondition(
      contains(root, actual) && path.basename(actual) === filename,
      "script_path_escape",
      "The script escapes its declared source or changes its filename.",
    );
    const stat = statSync(actual);
    requireCondition(
      stat.isFile() && stat.size <= maxCodeBytes,
      "script_too_large",
      "The script source is not a bounded regular file.",
    );
    const code = readFileSync(actual, "utf8");
    const metadata = readHeader(code);
    requireCondition(
      metadata && metadata.scriptName === filename,
      "script_header_mismatch",
      "A saved script needs a valid header matching its actual filename.",
    );
    return {
      name: origin.namespace ? `${origin.namespace}/${filename}` : filename,
      code,
      metadata,
      path: actual,
      origin: { ...origin, revision: sha(code) } as ScriptOrigin,
    };
  }

  #localOrigin(): ScriptOriginBase {
    return { type: "local", owner: this.owner, namespace: null, version: null };
  }

  resolve(
    name: string,
    canUse: (origin: ScriptOrigin) => boolean = () => true,
    onInputValidator?: InputValidatorObserver,
  ): ScriptSnapshot {
    const parts = name.split("/");
    requireCondition(
      parts.length === 1 || parts.length === 2,
      "invalid_script_name",
      "Use a local filename or namespace/filename.",
    );
    const filename = parts.at(-1)!;
    scriptFilename(filename);
    const sources = this.#registered(parts.length === 2 ? parts[0] : "");
    const readHeader = (code: string) => scriptHeader(code, onInputValidator);
    let snapshot: ScriptSnapshot;
    if (parts.length === 1)
      snapshot = this.#read(this.local, filename, this.#localOrigin(), readHeader);
    else {
      const source = sources.find((item) => item.namespace === parts[0]);
      requireCondition(
        source,
        "script_not_found",
        "This script namespace is not currently enabled.",
      );
      snapshot = this.#read(source.directory, filename, {
        type: source.type,
        owner: source.owner,
        namespace: source.namespace,
        version: source.version,
      }, readHeader);
    }
    requireCondition(
      canUse(snapshot.origin),
      "script_forbidden",
      "This script source is not authorized for the caller.",
    );
    return snapshot;
  }

  enroll(code: string, onInputValidator?: InputValidatorObserver): { snapshot: ScriptSnapshot; saved: boolean } {
    return this.#enroll(code, scriptHeader(code, onInputValidator));
  }

  #enroll(code: string, metadata: ScriptMetadata | null): { snapshot: ScriptSnapshot; saved: boolean } {
    privateDirectory(this.work, "scripts");
    if (!metadata)
      return {
        snapshot: {
          name: null,
          code,
          metadata: null,
          path: null,
          origin: {
            ...this.#localOrigin(),
            revision: sha(code),
          } as ScriptOrigin,
        },
        saved: false,
      };
    // Reuse the already validated header only for identical source bytes.
    // Readback still checks the real path, filename and actual file contents.
    // Other scripts found while refreshing the index are checked independently.
    const sameHeader: ScriptHeaderReader = (actual) =>
      actual === code ? metadata : scriptHeader(actual);
    // A hard link publishes a completed file without ever replacing an existing name.
    const temporary = path.join(this.local, "." + newId("script"));
    const destination = path.join(this.local, metadata.scriptName);
    let saved = false;
    try {
      writeFileSync(temporary, code, { flag: "wx", mode: 0o600 });
      // Detect portable case-insensitive collisions even on a case-sensitive host.
      const collision = readdirSync(this.local).find(
        (name) => name.toLowerCase() === metadata.scriptName.toLowerCase(),
      );
      requireCondition(
        !collision || collision === metadata.scriptName,
        "script_name_conflict",
        "This name collides with a differently cased script.",
      );
      try {
        linkSync(temporary, destination);
        saved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const snapshot = this.#read(
        this.local,
        metadata.scriptName,
        this.#localOrigin(),
        sameHeader,
      );
      requireCondition(
        snapshot.code === code,
        "script_name_conflict",
        "A different script already uses this name; choose another name or explicitly update the file.",
      );
      try {
        this.refreshIndex(this.#discover(() => true, sameHeader));
      } catch (error) {
        throw new AgentError(
          "script_index_failed",
          "The script exists but its index could not be refreshed.",
          { scriptName: metadata.scriptName, saved },
          { cause: error },
        );
      }
      return { snapshot, saved };
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** Core's asynchronous quota boundary around the existing synchronous publication. */
  async enrollManaged(
    code: string,
    options: {
      readonly reserve?: (bytes: number) => Promise<{ release(): void }>;
      readonly assertCurrent?: () => void;
    } = {},
  ): Promise<{ snapshot: ScriptSnapshot; saved: boolean }> {
    const metadata = scriptHeader(code);
    if (!metadata || !options.reserve) {
      options.assertCurrent?.();
      return this.#enroll(code, metadata);
    }
    // refreshIndex already enforces this exact eight-MiB ceiling. Reserving its
    // complete rewrite also covers the old file coexisting with its atomic temp.
    const ticket = await options.reserve(
      Buffer.byteLength(code) + 8 * 1024 * 1024 + 2048,
    );
    try {
      options.assertCurrent?.();
      return this.#enroll(code, metadata);
    } finally {
      ticket.release();
    }
  }

  discover(
    canUse: (origin: ScriptOrigin) => boolean = () => true,
  ): ScriptDiscovery {
    return this.#discover(canUse, scriptHeader);
  }

  #discover(
    canUse: (origin: ScriptOrigin) => boolean,
    readHeader: ScriptHeaderReader,
  ): ScriptDiscovery {
    const sources = [
      { directory: this.local, ...this.#localOrigin() },
      ...this.#registered(),
    ];
    const entries: ScriptEntry[] = [],
      warnings: ScriptDiagnostic[] = [];
    for (const source of sources) {
      if (
        !canUse({
          type: source.type,
          owner: source.owner,
          namespace: source.namespace,
          version: source.version,
          revision: "",
        })
      )
        continue;
      let files: string[];
      try {
        files = readdirSync(source.directory)
          .filter((name) => name.endsWith(".js"))
          .sort(compare);
      } catch {
        warnings.push({
          source: source.owner as string,
          path: source.directory,
          code: "script_source_unavailable",
          message: "The script source directory is unavailable.",
        });
        continue;
      }
      const seen = new Set<string>();
      for (const file of files) {
        try {
          const key = file.toLowerCase();
          requireCondition(
            !seen.has(key),
            "script_name_conflict",
            "Scripts have a portable filename collision.",
          );
          seen.add(key);
          const snapshot = this.#read(source.directory, file, {
            type: source.type as ScriptOrigin["type"],
            owner: source.owner as string,
            namespace: source.namespace as string | null,
            version: source.version as string | null,
          }, readHeader);
          if (canUse(snapshot.origin))
            entries.push({
              ...snapshot.metadata!,
              scriptName: snapshot.name!,
              path: snapshot.path!,
              origin: snapshot.origin,
            });
        } catch (error) {
          warnings.push({
            source: source.owner as string,
            path: path.join(source.directory, file),
            code:
              error instanceof AgentError ? error.code : "script_unavailable",
            message:
              error instanceof AgentError
                ? error.message
                : "The script could not be read.",
          });
        }
      }
    }
    return { entries, warnings };
  }

  indexText(discovery: ScriptDiscovery = this.discover()): string {
    const { entries, warnings } = discovery;
    const blocks = entries.map(
      (entry) =>
        `## ${entry.scriptName}\n\n${entry.scriptDesc}\n\n适用：${entry.scriptWhenUse}\n\n来源：${entry.origin.owner}；版本：${entry.origin.version ?? "本地"}；修订：${entry.origin.revision}\n\n源文件：${entry.path}\n\n\`\`\`json\n${JSON.stringify(entry.scriptInputSchema, null, 2)}\n\`\`\`${entry.scriptOutputSchema !== undefined ? "\n\n输出 Schema：\n\n```json\n" + JSON.stringify(entry.scriptOutputSchema, null, 2) + "\n```" : ""}`,
    );
    const text =
      "# 可用脚本\n\n选择任务匹配的公开 scriptName，按下方输入 Schema 构造 input 并用 agent.run.start 执行。若没有合适脚本，用内联 script；需要创建或修改可复用脚本时，先核对实际 Skill 清单中的 script-authoring；若完整清单仍无该项，报告资料缺失，不猜测调用约定。\n\n" +
      blocks.join("\n\n") +
      (warnings.length
        ? "\n\n发现提示：\n" +
          warnings
            .map(
              (warning) =>
                `- ${warning.code}: ${warning.path ?? warning.source}`,
            )
            .join("\n")
        : "") +
      "\n";
    requireCondition(
      Buffer.byteLength(text) <= 8 * 1024 * 1024,
      "script_index_too_large",
      "The generated script manual exceeds its budget.",
    );
    return text;
  }

  refreshIndex(discovery?: ScriptDiscovery): void {
    // Re-check the generated directory; it is writable by the same OS user.
    privateDirectory(this.work, "scripts");
    atomicText(path.join(this.local, "index.md"), this.indexText(discovery));
  }

  // Compatibility for the test/reference Work service: all authorized
  // catalog entries, independent of previous executions or display budgets.
  select(
    _usage: readonly ScriptUsage[],
    canUse: (origin: ScriptOrigin) => boolean = () => true,
    _maxBytes = 256 * 1024,
    discovery?: ScriptDiscovery,
  ) {
    const { entries, warnings } = discovery ?? this.discover(canUse);
    return {
      total: entries.length,
      items: [...entries].sort((a, b) => compare(a.scriptName, b.scriptName)),
      complete: warnings.length === 0,
      omitted: [],
      warnings: [...warnings],
    };
  }
}
