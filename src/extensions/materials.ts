import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson } from "../contracts/json.js";
import type { ContributionOrigin } from "../contracts/types.js";
import { extensionNamespace } from "../runtime/names.js";
import { contains, privateDirectory } from "../runtime/paths.js";
import type { ScriptSource } from "../runtime/scripts.js";
import { installMaterialDirectory, removeMaterialDirectory, type ManagedReserve } from "../runtime/current-materials.js";
import { boundedFile } from "../work/discovery.js";
import { methodSkill } from "../work/method-skills.js";
import type { PublishedMaterials } from "../work/published.js";
import type { ExtensionHandle } from "./registry.js";
import type {
  ExtensionPackageDescriptor,
  ExtensionPackageFile,
} from "./packages.js";

export interface MaterialDiagnostic {
  code: "extension_material_link_unavailable";
  source: string;
  target: string;
}
export interface PreparedExtensionMaterials {
  readonly handleId: string;
  readonly origin: ContributionOrigin;
  readonly directory: string;
  readonly materials: PublishedMaterials;
  readonly scripts?: ScriptSource;
  readonly diagnostics: readonly MaterialDiagnostic[];
}
interface FilePlan {
  source: ExtensionPackageFile;
  target: string;
  boundary: string;
}
interface SavedFile {
  path: string;
  revision: string;
  size: number;
  source?: { path: string; revision: string };
}
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const portable = (value: string) => value.normalize("NFC").toLowerCase();
const segment = (value: string) =>
  Buffer.byteLength(value) > 120
    ? "h-" + digest(value)
    : /^[A-Za-z0-9_.-]+$/.test(value) &&
        value !== "." &&
        value !== ".." &&
        !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)
      ? value
      : "x-" + Buffer.from(value).toString("hex");
const relative = (root: string, filename: string) =>
  path.relative(root, filename).split(path.sep).join("/");
const label = (value: string) => value.replace(/[\r\n\[\]`]/g, " ");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function text(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new AgentError(
      "extension_material_encoding",
      "Extension Markdown must be valid UTF-8.",
      undefined,
      { cause },
    );
  }
}
function sourceSuffix(directory: string, filename: string): string {
  const result = relative(directory, filename);
  requireCondition(
    result.length > 0 &&
      !result
        .split("/")
        .some(
          (part) =>
            part === "." ||
            part === ".." ||
            part.includes("\\") ||
            part.includes("\0"),
        ) &&
      !path.isAbsolute(result),
    "extension_path_escape",
    "An extension reading file must retain its declared relative subtree.",
  );
  return result;
}

/** Core-owned preparation and synchronous discovery index; it never enables a package. */
export class ExtensionMaterials {
  readonly work: string;
  #maxFiles: number;
  #maxBytes: number;
  #prepared = new WeakSet<PreparedExtensionMaterials>();
  #active = new Map<string, PreparedExtensionMaterials>();
  #published: PublishedMaterials = freeze({
    instructions: [],
    skills: [],
  });
  #sources: readonly ScriptSource[] = Object.freeze([]);
  #reserve?: ManagedReserve;
  #replacements = new Map<string, ReturnType<typeof installMaterialDirectory>>();
  #directories = new Map<string, string>();
  #stages = new Set<string>();
  constructor(
    work: string,
    limits: {
      maxFiles?: number;
      maxBytes?: number;
      reserve?: ManagedReserve;
    } = {},
  ) {
    // No directory creation or package evaluation during construction.
    this.work = work;
    this.#maxFiles = limits.maxFiles ?? 10000;
    this.#maxBytes = limits.maxBytes ?? 256 * 1024 * 1024;
    this.#reserve = limits.reserve;
    requireCondition(
      path.isAbsolute(work) &&
        [this.#maxFiles, this.#maxBytes].every(
          (n) => Number.isSafeInteger(n) && n > 0,
        ),
      "invalid_extension_limits",
      "Materials need an absolute work path and positive bounded limits.",
    );
  }

  async prepare(
    descriptor: ExtensionPackageDescriptor,
    handle: ExtensionHandle,
    signal?: AbortSignal,
  ): Promise<PreparedExtensionMaterials> {
    signal?.throwIfAborted();
    const origin = descriptor.source.origin;
    if (origin.type === "platform")
      requireCondition(
        [
          "nexum",
          "sh",
          "transfer",
          "output",
          "runtime",
          "state",
          "maintenance",
          "mcp",
          "api",
        ].includes(origin.namespace!),
        "invalid_namespace",
        "Core platform materials must use their registered platform namespace.",
      );
    else extensionNamespace(origin.namespace!);
    requireCondition(
      descriptor.work === this.work &&
        (await realpath(this.work)) === this.work &&
        ["extension", "platform"].includes(origin.type) &&
        origin.owner === descriptor.packageName &&
        origin.version === descriptor.version &&
        origin.revision === descriptor.revision &&
        canonicalJson(origin) === canonicalJson(handle.origin),
      "extension_material_source_mismatch",
      "Reading materials must bind the verified source and prepared Registry handle from this profile.",
    );
    requireCondition(
      (await realpath(descriptor.root)) === descriptor.root,
      "extension_path_escape",
      "A material source root must retain its canonical identity.",
    );
    if (origin.type === "extension") {
      const modules = await realpath(path.join(this.work, "node_modules"));
      requireCondition(
        contains(this.work, modules) &&
          contains(modules, descriptor.root) &&
          (await realpath(path.join(modules, descriptor.packageName))) ===
            descriptor.root,
        "extension_path_escape",
        "Extension material sources must remain in their installed package.",
      );
    }
    const readSource = async (file: ExtensionPackageFile, boundary: string) => {
      signal?.throwIfAborted();
      const lexical = path.resolve(descriptor.root, file.relativePath);
      requireCondition(
        contains(descriptor.root, lexical) &&
          (await realpath(lexical)) === file.path &&
          (await realpath(boundary)) === boundary &&
          contains(boundary, file.path),
        "extension_package_changed",
        "A declared reading source redirected after static inspection.",
      );
      const read = await boundedFile(
        file.path,
        Math.min(file.size, this.#maxBytes),
        signal,
      );
      requireCondition(
        read.bytes.length === file.size &&
          read.revision === file.revision &&
          (await realpath(lexical)) === file.path,
        "extension_package_changed",
        "A declared reading source changed after static inspection.",
      );
      return read.bytes;
    };
    const baseName = origin.namespace!.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-|-$/g, "") || "extension";
    const name = `${baseName}-sdk-${digest(origin.namespace!).slice(0, 8)}`;
    requireCondition(
      !descriptor.materials.skills?.entries.some((skill) => skill.metadata.name === name),
      "extension_material_conflict",
      "A generated Skill cannot replace an authored Skill's identity.",
    );
    const generated = methodSkill({
      name,
      description: `编写或核对 ${origin.namespace} SDK 的调用代码、参数及返回合同，或诊断该扩展的方法错误时使用。当前操作包括：${handle.methods.slice(0, 4).map((method) => String(method.description).replace(/[\r\n]+/g, " ").slice(0, 100)).join("；")}。具体任务优先选择同来源匹配的人工 Skill。`.slice(0, 1024),
      origin, bindingPath: [origin.namespace!], methods: handle.methods,
      references: {
        "types.md": "# 来源类型声明\n\n```typescript\n" +
          text(await readSource(descriptor.types, descriptor.root)) + "\n```\n",
      },
    });
    const methods = canonicalJson(handle.methods, 4 * 1024 * 1024);
    const snapshotRevision = digest(
      canonicalJson({ origin, methods, skill: generated.revision }, 8 * 1024 * 1024),
    );
    const parent = privateDirectory(
      this.work,
      "cache",
      "materials",
      "extensions",
    );
    const directory = path.join(parent, segment(origin.namespace!));
    const active = this.#active.get(portable(origin.namespace!));
    requireCondition(!active || active.handleId === handle.id,
      "namespace_conflict", "Withdraw the previous extension before replacing its current materials.");
    requireCondition(![...this.#directories].some(([id, dir]) => id !== handle.id && dir === directory),
      "namespace_conflict", "Another prepared instance owns this material directory.");
    const plan: FilePlan[] = [];
    const mappings = new Map<string, string>();
    const targets = new Set<string>();
    let sourceBytes = 0;
    const add = (
      source: ExtensionPackageFile,
      target: string,
      boundary: string,
    ) => {
      requireCondition(
        contains(descriptor.root, source.path) &&
          contains(descriptor.root, boundary) &&
          contains(boundary, source.path) &&
          source.size >= 0 &&
          Number.isSafeInteger(source.size) &&
          /^sha256:[0-9a-f]{64}$/.test(source.revision),
        "extension_material_source_mismatch",
        "A reading file must belong to its exact declared package subtree.",
      );
      requireCondition(
        !path.posix.isAbsolute(target) &&
          path.posix.normalize(target) === target &&
          !target
            .split("/")
            .some(
              (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                part.includes("\\") ||
                part.includes("\0"),
            ),
        "extension_path_escape",
        "A reading target must be a literal relative path within its staging tree.",
      );
      const key = portable(target);
      requireCondition(
        !targets.has(key),
        "extension_material_conflict",
        "Two reading files cannot share a portable path.",
      );
      targets.add(key);
      sourceBytes += source.size;
      requireCondition(
        plan.length + 1 <= this.#maxFiles && sourceBytes <= this.#maxBytes,
        "extension_material_too_large",
        "The extension reading snapshot exceeds its file or byte budget.",
      );
      plan.push({ source, target, boundary });
      // The same declared source may appear in more than one contribution. Prefer its first stable reading location.
      const lexical = path.resolve(descriptor.root, source.relativePath);
      if (!mappings.has(lexical)) mappings.set(lexical, target);
      if (!mappings.has(source.path)) mappings.set(source.path, target);
    };
    if (descriptor.materials.instructions) {
      const file = descriptor.materials.instructions;
      add(
        file,
        "instructions/" + path.posix.basename(file.relativePath),
        path.dirname(file.path),
      );
    }
    for (const skill of descriptor.materials.skills?.entries ?? []) {
      const prefix = "skills/" + skill.metadata.name;
      mappings.set(
        path.resolve(descriptor.root, skill.directory.relativePath),
        prefix,
      );
      mappings.set(skill.directory.path, prefix);
      for (const file of skill.directory.files)
        add(
          file,
          prefix +
            "/" +
            sourceSuffix(skill.directory.relativePath, file.relativePath),
          skill.directory.path,
        );
    }
    const scripts = descriptor.materials.scripts;
    for (const item of plan) {
      // Directory links inside the author's tree remain usable too.
      let source = path.dirname(
        path.resolve(descriptor.root, item.source.relativePath),
      );
      let target = path.posix.dirname(item.target);
      while (contains(descriptor.root, source) && target !== ".") {
        if (!mappings.has(source)) mappings.set(source, target);
        source = path.dirname(source);
        target = path.posix.dirname(target);
      }
    }
    const diagnostics: MaterialDiagnostic[] = [];
    const rewrite = (body: string, item: FilePlan, budget: number): string => {
      let upperBytes = Buffer.byteLength(body);
      requireCondition(
        upperBytes <= budget,
        "extension_material_too_large",
        "An entry or manual exceeds its reading budget.",
      );
      const translate = (href: string): string => {
        if (
          !href ||
          href.startsWith("#") ||
          (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href) && !/^file:/i.test(href))
        )
          return href;
        const at = href.search(/[?#]/),
          raw = at < 0 ? href : href.slice(0, at),
          tail = at < 0 ? "" : href.slice(at);
        let decoded: string;
        try {
          decoded = /^file:/i.test(raw)
            ? fileURLToPath(raw)
            : decodeURIComponent(raw);
        } catch {
          decoded = "\0";
        }
        const resolved = path.resolve(
          descriptor.root,
          path.posix.dirname(item.source.relativePath),
          decoded,
        );
        const mapped = mappings.get(resolved);
        if (mapped) {
          if (/^file:/.test(mapped)) return mapped + tail;
          const result =
            path.posix.relative(path.posix.dirname(item.target), mapped) || ".";
          return (
            result
              .split("/")
              .map((part) => encodeURIComponent(part))
              .join("/") + tail
          );
        }
        requireCondition(
          diagnostics.length < 1000,
          "extension_material_too_large",
          "The manual has too many unresolved local links.",
        );
        diagnostics.push({
          code: "extension_material_link_unavailable",
          source: item.source.relativePath,
          target: href.slice(0, 8192),
        });
        return href;
      };
      const replacement = (
        original: string,
        prefix: string,
        href: string,
        suffix: string,
        angled: boolean,
      ) => {
        const converted = translate(href);
        if (converted === href) return original;
        upperBytes +=
          Buffer.byteLength(prefix) +
          Buffer.byteLength(converted) +
          Buffer.byteLength(suffix) +
          (angled ? 2 : 0) -
          Buffer.byteLength(original);
        requireCondition(
          upperBytes <= budget,
          "extension_material_too_large",
          "Rewritten reading links exceed the complete entry budget.",
        );
        return (
          prefix +
          (angled ? "<" : "") +
          converted +
          (angled ? ">" : "") +
          suffix
        );
      };
      // A forward scanner avoids quadratic regex retries on a long run of unmatched '['.
      const inlineLinks = (line: string): string => {
        const parts: string[] = [];
        let opening = -1,
          written = 0;
        for (let at = 0; at < line.length; at++) {
          if (line[at] === "\\") {
            at++;
            continue;
          }
          if (line[at] === "[") opening = at;
          if (opening < 0 || line[at] !== "]" || line[at + 1] !== "(") continue;
          const end = line.indexOf(")", at + 2);
          if (end < 0) break;
          let start = at + 2;
          while (start < end && /\s/.test(line[start]!)) start++;
          const angled = line[start] === "<";
          let finish = start;
          if (angled) finish = line.indexOf(">", start + 1);
          else while (finish < end && !/\s/.test(line[finish]!)) finish++;
          const suffixStart = angled ? finish + 1 : finish;
          if (
            finish >= start &&
            finish <= end &&
            /^\s*(?:(?:"[^"]*"|'[^']*')\s*)?$/.test(
              line.slice(suffixStart, end),
            )
          ) {
            parts.push(
              line.slice(written, opening),
              replacement(
                line.slice(opening, end + 1),
                line.slice(opening, start),
                line.slice(angled ? start + 1 : start, finish),
                line.slice(suffixStart, end + 1),
                true,
              ),
            );
            written = end + 1;
          }
          at = end;
          opening = -1;
        }
        parts.push(line.slice(written));
        return parts.join("");
      };
      const rewriteLine = (line: string) =>
        inlineLinks(line)
          .replace(
            /^(\s{0,3}\[[^\]\n]+\]:\s*)(?:<([^>\n]*)>|([^\s]+))/gm,
            (
              all,
              prefix: string,
              angled: string | undefined,
              plain: string | undefined,
            ) => replacement(all, prefix, angled ?? plain ?? "", "", true),
          )
          .replace(
            /(\b(?:href|src)\s*=\s*["'])([^"'\n]*)(["'])/gi,
            (all, prefix: string, href: string, suffix: string) =>
              replacement(all, prefix, href, suffix, false),
          );
      let fence = "";
      let frontmatter =
        path.posix.basename(item.target) === "SKILL.md" &&
        /^---\r?\n/.test(body);
      return body
        .split("\n")
        .map((line, index) => {
          if (frontmatter) {
            if (index > 0 && /^---\r?$/.test(line)) frontmatter = false;
            return line;
          }
          const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
          if (marker) {
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length)
              fence = "";
            return line;
          }
          if (fence) return line;
          return line
            .split(/(`[^`]*`)/g)
            .map((part, index) => (index % 2 ? part : rewriteLine(part)))
            .join("");
        })
        .join("\n");
    };
    requireCondition(
      (await realpath(parent)) === parent,
      "extension_path_escape",
      "A reading parent must not redirect before staging.",
    );
    const temporary = await mkdtemp(path.join(parent, ".prepare-"));
    this.#stages.add(temporary);
    let replacement: ReturnType<typeof installMaterialDirectory> | undefined;
    let transferred = false;
    let totalBytes = 0;
    const saved: SavedFile[] = [];
    const save = async (
      filename: string,
      bytes: Buffer,
      source?: ExtensionPackageFile,
    ) => {
      signal?.throwIfAborted();
      requireCondition(
        saved.length + 1 <= this.#maxFiles &&
          totalBytes + bytes.length <= this.#maxBytes,
        "extension_material_too_large",
        "Generated references and copied materials exceed their complete snapshot budget.",
      );
      const target = path.join(temporary, filename);
      requireCondition(
        (await realpath(temporary)) === temporary,
        "extension_path_escape",
        "The private reading stage must not redirect.",
      );
      let parent = temporary;
      for (const part of path.posix.dirname(filename).split("/")) {
        if (part === ".") continue;
        const next = path.join(parent, part);
        const info = await lstat(next).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        requireCondition(
          !info || (info.isDirectory() && !info.isSymbolicLink()),
          "extension_path_escape",
          "A reading directory must not be a file or symbolic link.",
        );
        if (!info) await mkdir(next, { mode: 0o700 });
        requireCondition(
          (await realpath(next)) === next && contains(temporary, next),
          "extension_path_escape",
          "A reading directory escaped its private stage.",
        );
        parent = next;
      }
      requireCondition(
        contains(temporary, await realpath(path.dirname(target))),
        "extension_path_escape",
        "A generated reading directory escaped its private staging area.",
      );
      const reservation = bytes.length
        ? await this.#reserve?.(bytes.length)
        : undefined;
      try {
        signal?.throwIfAborted();
        requireCondition(
          (await realpath(temporary)) === temporary &&
            (await realpath(path.dirname(target))) === path.dirname(target),
          "extension_path_escape",
          "The reading stage changed during storage admission.",
        );
        await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      } finally {
        reservation?.release();
      }
      totalBytes += bytes.length;
      saved.push({
        path: filename,
        revision: "sha256:" + digest(bytes),
        size: bytes.length,
        ...(source
          ? { source: { path: source.relativePath, revision: source.revision } }
          : {}),
      });
    };
    try {
      let instructionContent: string | undefined;
      for (const item of plan) {
        let bytes = await readSource(item.source, item.boundary);
        if (
          /\.md$/i.test(item.target) ||
          item.source === descriptor.materials.instructions
        ) {
          const original = text(bytes);
          const rewritten = rewrite(
            original,
            item,
            Math.min(
              this.#maxBytes - totalBytes,
              item.source === descriptor.materials.instructions
                ? 65536
                : 8 * 1024 * 1024,
            ),
          );
          if (rewritten !== original) bytes = Buffer.from(rewritten);
        }
        if (item.source === descriptor.materials.instructions)
          instructionContent = text(bytes);
        await save(item.target, bytes, item.source);
      }
      requireCondition(diagnostics.length === 0, "extension_material_link_unavailable",
        "A declared Skill or instruction references an unavailable local resource.",
        { diagnostics: diagnostics as unknown as import("../contracts/types.js").JsonValue });
      for (const [file, body] of generated.files)
        await save(`generated/${name}/${file}`, Buffer.from(body));
      // Verify the entire declared reading set again before exposing a fixed coordinate.
      for (const item of plan) await readSource(item.source, item.boundary);
      await readSource(descriptor.types, descriptor.root);
      signal?.throwIfAborted();
      const manifest = Buffer.from(
        canonicalJson(
          { origin, revision: snapshotRevision, files: saved, diagnostics },
          16 * 1024 * 1024,
        ),
      );
      requireCondition(
        saved.length + 1 <= this.#maxFiles &&
          totalBytes + manifest.length <= this.#maxBytes,
        "extension_material_too_large",
        "The complete reading manifest exceeds its snapshot budget.",
      );
      const reservation = await this.#reserve?.(manifest.length);
      try {
        signal?.throwIfAborted();
        requireCondition(
          (await realpath(temporary)) === temporary,
          "extension_path_escape",
          "The reading stage changed during manifest storage admission.",
        );
        await writeFile(path.join(temporary, "manifest.json"), manifest, {
          flag: "wx",
          mode: 0o600,
        });
      } finally {
        reservation?.release();
      }
      const verifyTree = async (target: string) => {
        requireCondition(
          (await lstat(target)).isDirectory() &&
            (await realpath(target)) === target,
          "extension_material_conflict",
          "An existing reading revision cannot redirect or be replaced.",
        );
        const expected = new Map([
          ...saved.map((file) => [file.path, file] as const),
          [
            "manifest.json",
            {
              path: "manifest.json",
              revision: "sha256:" + digest(manifest),
              size: manifest.length,
            },
          ] as const,
        ]);
        let found = 0;
        const expectedDirectories = new Set<string>();
        for (const filename of expected.keys()) {
          let parent = path.posix.dirname(filename);
          while (parent !== ".") {
            expectedDirectories.add(parent);
            parent = path.posix.dirname(parent);
          }
        }
        const walk = async (current: string): Promise<void> => {
          const entries = await opendir(current, { bufferSize: 32 });
          for await (const item of entries) {
            signal?.throwIfAborted();
            const filename = path.join(current, item.name);
            const info = await lstat(filename);
            requireCondition(
              !info.isSymbolicLink(),
              "extension_material_conflict",
              "A generated reading tree contains a symbolic link.",
            );
            if (info.isDirectory()) {
              requireCondition(
                expectedDirectories.has(relative(target, filename)),
                "extension_material_conflict",
                "A generated reading tree has an unexpected directory.",
              );
              await walk(filename);
            } else {
              const record = expected.get(relative(target, filename));
              requireCondition(
                info.isFile() && record,
                "extension_material_conflict",
                "A generated reading tree has unexpected files.",
              );
              const read = await boundedFile(filename, record.size, signal);
              requireCondition(
                read.bytes.length === record.size &&
                  read.revision === record.revision,
                "extension_material_conflict",
                "A generated reading tree has changed since preparation.",
              );
              found++;
            }
          }
        };
        await walk(target);
        requireCondition(
          found === expected.size,
          "extension_material_conflict",
          "A generated reading tree is incomplete.",
        );
      };
      requireCondition(
        (await realpath(parent)) === parent &&
          (await realpath(temporary)) === temporary,
        "extension_path_escape",
        "A reading directory redirected before its immutable publication.",
      );
      await verifyTree(temporary);
      signal?.throwIfAborted();
      // Recheck namespace ownership after asynchronous staging.
      const current = this.#active.get(portable(origin.namespace!));
      requireCondition(!current || current.handleId === handle.id, "namespace_conflict",
        "Another active extension owns this material namespace.");
      requireCondition(![...this.#directories].some(([id, dir]) => id !== handle.id && dir === directory),
        "namespace_conflict", "Another prepared instance owns this material directory.");
      if (this.#directories.has(handle.id)) {
        // Same verified preparation is idempotent; a changed handle must
        // withdraw before replacement rather than mutate an active instance.
        await verifyTree(directory);
      } else {
        replacement = installMaterialDirectory(directory, temporary);
      }
      const readingOrigin = { ...origin };
      const prepared: PreparedExtensionMaterials = freeze({
        handleId: handle.id,
        origin: readingOrigin,
        directory,
        materials: {
          instructions: descriptor.materials.instructions
            ? [
                {
                  instructionId: `${origin.namespace}/instructions`,
                  kind: origin.type,
                  path: path.join(
                    directory,
                    "instructions",
                    path.posix.basename(
                      descriptor.materials.instructions.relativePath,
                    ),
                  ),
                  content: instructionContent!,
                  scope: { type: "agent" as const, root: this.work },
                  origin: readingOrigin,
                  truncated: false,
                },
              ]
            : [],
          skills: [...(descriptor.materials.skills?.entries ?? []).map((skill) => ({
            skillId: `${origin.namespace}/${skill.metadata.name}`,
            ...skill.metadata,
            path: path.join(directory, "skills", skill.metadata.name),
            skillFile: path.join(
              directory,
              "skills",
              skill.metadata.name,
              "SKILL.md",
            ),
            scope: { type: "agent" as const, root: this.work },
            origin: readingOrigin,
          })), {
            ...generated.metadata, skillId: `${origin.namespace}/${generated.metadata.name}`,
            path: path.join(directory, "generated", generated.metadata.name),
            skillFile: path.join(directory, "generated", generated.metadata.name, "SKILL.md"),
            scope: { type: "agent" as const, root: this.work }, origin: readingOrigin,
          }],
        },
        ...(scripts
          ? {
              scripts: {
                type: origin.type,
                owner: origin.owner,
                namespace: origin.namespace!,
                version: descriptor.version,
                directory: scripts.directory,
              } as ScriptSource,
            }
          : {}),
        diagnostics,
      });
      canonicalJson(prepared.materials, 4 * 1024 * 1024);
      this.#prepared.add(prepared);
      if (replacement) this.#replacements.set(handle.id, replacement);
      this.#directories.set(handle.id, directory);
      transferred = true;
      return prepared;
    } finally {
      try {
        if (!transferred && replacement) replacement.rollback();
        if (lstatSync(temporary, { throwIfNoEntry: false })) removeMaterialDirectory(temporary);
      } finally {
        this.#stages.delete(temporary);
      }
    }
  }

  #index(items: readonly PreparedExtensionMaterials[]) {
    const published: PublishedMaterials = freeze({
      instructions: items.flatMap((item) => item.materials.instructions),
      skills: items.flatMap((item) => item.materials.skills),
    });
    canonicalJson(published, 4 * 1024 * 1024);
    return {
      published,
      sources: Object.freeze(
        items.flatMap((item) => (item.scripts ? [item.scripts] : [])),
      ),
    };
  }
  publish(prepared: PreparedExtensionMaterials): void {
    requireCondition(
      this.#prepared.has(prepared),
      "extension_material_source_mismatch",
      "Only this profile's completed material preparation may be published.",
    );
    const key = portable(prepared.origin.namespace!);
    const previous = this.#active.get(key);
    requireCondition(
      !previous || previous === prepared,
      "namespace_conflict",
      "Another active extension already owns this material namespace.",
    );
    const items = [...this.#active.values()]
      .filter((item) => item !== previous)
      .concat(prepared)
      .sort((a, b) => compare(a.origin.namespace!, b.origin.namespace!));
    const index = this.#index(items);
    const replacement = this.#replacements.get(prepared.handleId);
    requireCondition(replacement && this.#directories.get(prepared.handleId) === prepared.directory,
      "extension_material_source_mismatch", "The current prepared material tree is unavailable.");
    if (!previous) replacement.commit();
    this.#active.set(key, prepared);
    this.#published = index.published;
    this.#sources = index.sources;
  }
  withdraw(handleId: string): void {
    const previous = [...this.#active.values()].find(
      (item) => item.handleId === handleId,
    );
    const replacement = this.#replacements.get(handleId);
    if (!previous) {
      if (replacement) replacement.rollback();
      this.#replacements.delete(handleId);
      this.#directories.delete(handleId);
      return;
    }
    const index = this.#index(
      [...this.#active.values()].filter((item) => item !== previous),
    );
    // Withdraw visibility first. A cleanup failure is retryable and does not
    // restore the withdrawn SDK. The next boot removes abandoned cache trees.
    this.#active.delete(portable(previous.origin.namespace!));
    this.#published = index.published;
    this.#sources = index.sources;
    try { replacement?.remove(); }
    catch { console.warn("Generated material cleanup failed: material_cleanup_failed"); }
    this.#replacements.delete(handleId);
    this.#directories.delete(handleId);
  }

  published(): PublishedMaterials {
    return this.#published;
  }
  scriptSources(): readonly ScriptSource[] {
    return this.#sources;
  }
  activeDirectories(): ReadonlySet<string> {
    return new Set([...this.#directories.values(), ...this.#stages]);
  }
}
