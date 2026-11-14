import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import type { JsonObject, JsonValue } from "../contracts/types.js";
import type {
  ScriptCatalog,
  ScriptMetadata,
  ScriptSnapshot,
  ScriptSource,
} from "./scripts.js";
import { atomicText, privateDirectory } from "./paths.js";

// Installed Agent metadata is trusted program input. Importing this module only
// reads it; platform files are written solely by explicit initialization below.
const installed = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
requireCondition(
  typeof installed.name === "string" &&
    installed.name.length > 0 &&
    installed.name.length <= 256 &&
    typeof installed.version === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(installed.version),
  "invalid_control_package",
  "Fixed platform scripts require the actual installed Agent name and version.",
);
export const CONTROL_OWNER = installed.name;
export const CONTROL_VERSION = installed.version;
export { DEFAULT_CONTROL_CAPACITY } from "../contracts/types.js";

export interface FixedControlScript {
  readonly name: string;
  readonly namespace: "sh" | "transfer";
  readonly filename: string;
  readonly code: string;
  readonly revision: string;
  readonly metadata: Readonly<ScriptMetadata>;
}
const id = { type: "string", minLength: 1, maxLength: 256 };
const cursor = { type: "string", minLength: 1, maxLength: 8192 };
const wait = { type: "integer", minimum: 0, maximum: 30000 };
const limit = { type: "integer", minimum: 1, maximum: 100 };
function schema(
  properties: JsonObject,
  required: string[] = [],
  extra: JsonObject = {},
): JsonObject {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
    ...extra,
  };
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function define(
  namespace: "sh" | "transfer",
  method: string,
  description: string,
  when: string,
  input: JsonValue,
  body?: string,
): FixedControlScript {
  const filename = `${method}.js`;
  const metadata: ScriptMetadata = {
    scriptName: filename,
    scriptDesc: description,
    scriptWhenUse: when,
    scriptInputSchema: input,
    scriptOpenDefault: true,
  };
  const code = `/**\n${JSON.stringify(metadata, null, 2)}\n*/\n${body ?? `return await ${namespace}.${method}(context.input);`}\n`;
  return immutable({
    name: `${namespace}/${filename}`,
    namespace,
    filename,
    code,
    revision: createHash("sha256").update(code).digest("hex"),
    metadata,
  });
}

// This closed set is program code, never an allowlist accepted from an SDK,
// script header, MCP input, local contribution or extension configuration.
export const FIXED_CONTROL_SCRIPTS: readonly FixedControlScript[] = immutable([
  define(
    "sh",
    "get",
    "读取托管进程的当前状态和增量输出",
    "普通运行已满时查询原进程；不启动新命令",
    schema(
      {
        processId: id,
        cursor,
        maxBytes: { type: "integer", minimum: 1, maximum: 1048576 },
        waitMs: wait,
        encoding: {
          anyOf: [
            {
              type: "string",
              enum: [
                "ascii",
                "utf8",
                "utf-8",
                "utf16le",
                "utf-16le",
                "ucs2",
                "ucs-2",
                "base64",
                "base64url",
                "latin1",
                "binary",
                "hex",
              ],
            },
            { type: "null" },
          ],
        },
      },
      ["processId"],
    ),
  ),
  define(
    "sh",
    "list",
    "按当前授权查询托管进程历史和活动记录",
    "寻找可继续读取或控制的原进程身份",
    schema({
      status: { type: "string", minLength: 1, maxLength: 128 },
      state: { type: "string", minLength: 1, maxLength: 128 },
      runId: id,
      contextId: id,
      limit,
      cursor,
    }),
  ),
  define(
    "sh",
    "write",
    "向托管进程写入文本或结束普通 stdin",
    "向现有交互进程提交输入；不创建进程",
    schema(
      {
        processId: id,
        data: {
          type: "string",
          maxLength: 1048576,
          description: "UTF-8 实际字节上限仍由 sh SDK 检查",
        },
        eof: { type: "boolean" },
      },
      ["processId"],
      {
        anyOf: [
          { required: ["data"], properties: { data: {} } },
          { required: ["eof"], properties: { eof: { const: true } } },
        ],
      },
    ),
  ),
  define(
    "sh",
    "resize",
    "调整托管 PTY 的列数和行数",
    "调整现有终端尺寸，非 PTY 会明确报错",
    schema(
      {
        processId: id,
        cols: { type: "integer", minimum: 1, maximum: 1000 },
        rows: { type: "integer", minimum: 1, maximum: 1000 },
      },
      ["processId", "cols", "rows"],
    ),
  ),
  define(
    "sh",
    "signal",
    "向托管进程投递平台支持的信号",
    "请求现有进程中断；投递不等于已退出",
    schema(
      {
        processId: id,
        signal: { type: "string", pattern: "^SIG[A-Z0-9]+$", maxLength: 32 },
      },
      ["processId", "signal"],
    ),
  ),
  define(
    "sh",
    "stop",
    "停止托管进程及受管后代并报告实际收尾",
    "普通运行已满时停止原进程或后台服务",
    schema(
      {
        processId: id,
        graceMs: wait,
        forceMs: wait,
      },
      ["processId"],
    ),
  ),
  define(
    "transfer",
    "get",
    "查询传输状态并可短暂等待",
    "继续跟踪已登记的上传或下载，不新建通道",
    schema(
      {
        transferId: id,
        waitMs: wait,
      },
      ["transferId"],
    ),
    "const { transferId, ...options } = context.input;\nreturn await transfer.get(transferId, options);",
  ),
  define(
    "transfer",
    "list",
    "按当前授权查询传输记录",
    "寻找原传输身份，不创建或重复执行传输",
    schema({
      direction: { type: "string", enum: ["upload", "download"] },
      status: {
        type: "string",
        enum: [
          "preparing",
          "pending",
          "transferring",
          "cancelling",
          "succeeded",
          "failed",
          "cancelled",
          "expired",
          "interrupted",
        ],
      },
      runId: id,
      limit,
      cursor,
    }),
  ),
  define(
    "transfer",
    "cancel",
    "请求取消已登记传输",
    "停止原上传或下载，结果以实际传输状态为准",
    schema({ transferId: id }, ["transferId"]),
    "return await transfer.cancel(context.input.transferId);",
  ),
]);
const definitions = new Map(
  FIXED_CONTROL_SCRIPTS.map((script) => [script.name, script]),
);

/** Explicit installation/initialization; this source is isolated from local bare-name scripts. */
export function materializeControlScripts(
  work: string,
): readonly ScriptSource[] {
  requireCondition(
    path.isAbsolute(work) && realpathSync.native(work) === work,
    "storage_path_escape",
    "Platform control sources require the established profile work directory.",
  );
  const root = privateDirectory(work, ".platform-controls", CONTROL_VERSION);
  const sources: ScriptSource[] = [];
  for (const namespace of ["sh", "transfer"] as const) {
    const directory = privateDirectory(root, namespace);
    for (const script of FIXED_CONTROL_SCRIPTS.filter(
      (value) => value.namespace === namespace,
    )) {
      const filename = path.join(directory, script.filename);
      const existing = lstatSync(filename, { throwIfNoEntry: false });
      requireCondition(
        !existing || existing.isFile(),
        "storage_path_escape",
        "A platform control file cannot redirect to another location.",
      );
      atomicText(filename, script.code);
    }
    sources.push(
      Object.freeze({
        type: "platform",
        owner: CONTROL_OWNER,
        namespace,
        version: CONTROL_VERSION,
        directory,
      }),
    );
  }
  return Object.freeze(sources);
}

/** Fixed lifecycle sources may use the Core's reserved control headroom. */
export async function materializeManagedControlScripts(
  work: string,
  reserve: (
    bytes: number,
    options?: { readonly control?: boolean },
  ) => Promise<{ release(): void }>,
): Promise<readonly ScriptSource[]> {
  const bytes = FIXED_CONTROL_SCRIPTS.reduce(
    (total, script) => total + Buffer.byteLength(script.code) + 1024,
    0,
  );
  const ticket = await reserve(bytes, { control: true });
  try {
    return materializeControlScripts(work);
  } finally {
    ticket.release();
  }
}

const changedSource = new Set([
  "script_not_found",
  "script_name_conflict",
  "script_path_escape",
  "script_too_large",
  "invalid_script_header",
  "script_header_mismatch",
  "invalid_script_name",
  "invalid_input_schema",
]);
const unreadable = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"]);

/** A source mismatch is ordinary work, not a request to elevate arbitrary code. */
export function qualifyControlScript(
  catalog: ScriptCatalog,
  name: string,
): ScriptSnapshot | undefined {
  const fixed = definitions.get(name);
  if (!fixed) return undefined;
  let current: ScriptSnapshot;
  try {
    current = catalog.resolve(name);
  } catch (cause) {
    if (types.isProxy(cause)) throw cause;
    if (cause instanceof AgentError && changedSource.has(cause.code))
      return undefined;
    const code =
      cause && typeof cause === "object"
        ? Object.getOwnPropertyDescriptor(cause, "code")
        : undefined;
    if (code && "value" in code && unreadable.has(code.value)) return undefined;
    // Unknown policy/configuration failures must not be treated as permission.
    throw cause;
  }
  if (
    current.name !== fixed.name ||
    current.code !== fixed.code ||
    current.origin.type !== "platform" ||
    current.origin.owner !== CONTROL_OWNER ||
    current.origin.namespace !== fixed.namespace ||
    current.origin.version !== CONTROL_VERSION ||
    current.origin.revision !== fixed.revision ||
    createHash("sha256").update(current.code).digest("hex") !== fixed.revision
  )
    return undefined;
  return immutable({
    name: fixed.name,
    code: fixed.code,
    metadata: { ...fixed.metadata },
    path: current.path,
    origin: {
      type: "platform",
      owner: CONTROL_OWNER,
      namespace: fixed.namespace,
      version: CONTROL_VERSION,
      revision: fixed.revision,
    },
  });
}
