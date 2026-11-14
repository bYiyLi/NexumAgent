import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  rename,
  rm,
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
import { boundedFile } from "../work/discovery.js";
import type { PublishedMaterials } from "../work/service.js";
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
  readonly entry: string;
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
    docs: [],
  });
  #sources: readonly ScriptSource[] = Object.freeze([]);
  constructor(
    work: string,
    limits: { maxFiles?: number; maxBytes?: number } = {},
  ) {
    // No directory creation or package evaluation during construction.
    this.work = work;
    this.#maxFiles = limits.maxFiles ?? 10000;
    this.#maxBytes = limits.maxBytes ?? 256 * 1024 * 1024;
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
    const methods = canonicalJson(handle.methods, 4 * 1024 * 1024);
    const snapshotRevision = digest(
      canonicalJson({ origin, methods }, 8 * 1024 * 1024),
    );
    const parent = privateDirectory(
      this.work,
      "docs",
      "extensions",
      segment(origin.namespace!),
      segment(descriptor.version),
    );
    const directory = path.join(parent, snapshotRevision);
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
    const docs = descriptor.materials.docs;
    mappings.set(path.resolve(descriptor.root, docs.relativePath), "manual");
    mappings.set(docs.path, "manual");
    for (const file of docs.files)
      add(
        file,
        "manual/" + sourceSuffix(docs.relativePath || ".", file.relativePath),
        docs.path,
      );
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
    for (const item of scripts?.entries ?? [])
      add(
        item.file,
        "reference/scripts/" + item.metadata.scriptName,
        scripts!.directory,
      );
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
    requireCondition(
      (await realpath(parent)) === parent,
      "extension_path_escape",
      "A reading parent must not redirect before staging.",
    );
    const temporary = await mkdtemp(path.join(parent, ".prepare-"));
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
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
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
      const generated = (prefix: string, parts: Iterable<string>) => {
        let size = Buffer.byteLength(prefix);
        const chunks = [prefix];
        for (const part of parts) {
          size += Buffer.byteLength(part);
          requireCondition(
            totalBytes + size <= this.#maxBytes,
            "extension_material_too_large",
            "Generated method references exceed their snapshot budget.",
          );
          chunks.push(part);
        }
        return chunks.join("");
      };
      const methodText = generated(
        "# " +
          label(origin.namespace!) +
          " 方法参考\n\n来源：" +
          label(origin.owner) +
          " " +
          label(descriptor.version) +
          "；" +
          origin.revision +
          "。仅包含已准备的公开方法与 Schema，不含配置或凭据。\n\n",
        (function* () {
          for (const method of handle.methods)
            yield "## " +
              label(
                [origin.namespace, ...(method.path as string[])].join("."),
              ) +
              "\n\n" +
              String(method.description) +
              "\n\n```json\n" +
              canonicalJson(method, 4 * 1024 * 1024) +
              "\n```\n";
        })(),
      );
      await save("reference/README.md", Buffer.from(methodText));
      const scriptText = generated(
        "# 组合脚本\n\n阅读副本不作为执行源；按 scriptName 执行仍核对当前启用包的原始声明目录。\n\n",
        (function* () {
          for (const item of scripts?.entries ?? [])
            yield "## " +
              label(`${origin.namespace}/${item.metadata.scriptName}`) +
              "\n\n" +
              label(item.metadata.scriptDesc) +
              "\n\n使用时机：" +
              label(item.metadata.scriptWhenUse) +
              "。\n\n[原始脚本与 JSON 头部阅读副本](<scripts/" +
              encodeURIComponent(item.metadata.scriptName) +
              ">)\n\n```json\n" +
              canonicalJson(item.metadata) +
              "\n```\n";
        })(),
      );
      await save("reference/scripts.md", Buffer.from(scriptText));
      const entryText = generated(
        "# " +
          label(origin.namespace!) +
          " 扩展手册\n\n" +
          label(origin.owner) +
          " " +
          label(descriptor.version) +
          "；内容修订 " +
          origin.revision +
          "。\n\n以下内容是独立阅读副本；实际 SDK 与脚本仅在该来源已启用且当前授权通过时可用。\n\n## 作者手册\n\n",
        (function* () {
          for (const item of plan)
            if (item.target.startsWith("manual/") && /\.md$/i.test(item.target))
              yield "- [" +
                label(item.target.slice(7)) +
                "](<" +
                item.target.split("/").map(encodeURIComponent).join("/") +
                ">)\n";
          yield "\n## 方法与脚本\n\n- [完整方法与 Schema](reference/README.md)\n- [全部组合脚本、用法与输入 Schema](reference/scripts.md)\n\n## 指令与 Skills\n\n";
          for (const item of plan)
            if (
              item.source === descriptor.materials.instructions ||
              (item.target.startsWith("skills/") &&
                path.posix.basename(item.target) === "SKILL.md")
            )
              yield "- [" +
                label(item.target) +
                "](<" +
                item.target.split("/").map(encodeURIComponent).join("/") +
                ">)\n";
        })(),
      );
      await save("README.md", Buffer.from(entryText));
      // Verify the entire declared reading set again before exposing a fixed coordinate.
      for (const item of plan) await readSource(item.source, item.boundary);
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
      await writeFile(path.join(temporary, "manifest.json"), manifest, {
        flag: "wx",
        mode: 0o600,
      });
      const verifyExisting = async () => {
        requireCondition(
          (await lstat(directory)).isDirectory() &&
            (await realpath(directory)) === directory,
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
              "A retained reading snapshot contains a symbolic link.",
            );
            if (info.isDirectory()) {
              requireCondition(
                expectedDirectories.has(relative(directory, filename)),
                "extension_material_conflict",
                "A retained reading revision has an unexpected directory.",
              );
              await walk(filename);
            } else {
              const record = expected.get(relative(directory, filename));
              requireCondition(
                info.isFile() && record,
                "extension_material_conflict",
                "A retained reading revision has unexpected files.",
              );
              const read = await boundedFile(filename, record.size, signal);
              requireCondition(
                read.bytes.length === record.size &&
                  read.revision === record.revision,
                "extension_material_conflict",
                "A retained reading revision was modified; old coordinates cannot be overwritten.",
              );
              found++;
            }
          }
        };
        await walk(directory);
        requireCondition(
          found === expected.size,
          "extension_material_conflict",
          "A retained reading revision is incomplete.",
        );
      };
      requireCondition(
        (await realpath(parent)) === parent &&
          (await realpath(temporary)) === temporary,
        "extension_path_escape",
        "A reading directory redirected before its immutable publication.",
      );
      const existing = await lstat(directory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (existing) await verifyExisting();
      else {
        try {
          await rename(temporary, directory);
        } catch (error) {
          if (
            !["EEXIST", "ENOTEMPTY"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
          await verifyExisting();
        }
      }
      const readingOrigin = { ...origin };
      const prepared: PreparedExtensionMaterials = freeze({
        handleId: handle.id,
        origin: readingOrigin,
        directory,
        entry: path.join(directory, "README.md"),
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
                  scope: { type: "agent", root: this.work },
                  origin: readingOrigin,
                  truncated: false,
                },
              ]
            : [],
          skills: (descriptor.materials.skills?.entries ?? []).map((skill) => ({
            skillId: `${origin.namespace}/${skill.metadata.name}`,
            ...skill.metadata,
            path: path.join(directory, "skills", skill.metadata.name),
            skillFile: path.join(
              directory,
              "skills",
              skill.metadata.name,
              "SKILL.md",
            ),
            scope: { type: "agent", root: this.work },
            origin: readingOrigin,
          })),
          docs: [
            {
              name: origin.namespace!,
              description:
                "SDK 用法、作者手册、完整方法参考、组合脚本、指令与 Skills",
              path: path.join(directory, "README.md"),
              owner: origin.owner,
              version: descriptor.version,
            },
          ],
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
      return prepared;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  #index(items: readonly PreparedExtensionMaterials[]) {
    const published: PublishedMaterials = freeze({
      instructions: items.flatMap((item) => item.materials.instructions),
      skills: items.flatMap((item) => item.materials.skills),
      docs: items.flatMap((item) => item.materials.docs),
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
    // All validation precedes this synchronous commit; no user callback or await follows it.
    this.#active.set(key, prepared);
    this.#published = index.published;
    this.#sources = index.sources;
  }
  withdraw(handleId: string): void {
    const previous = [...this.#active.values()].find(
      (item) => item.handleId === handleId,
    );
    if (!previous) return;
    const index = this.#index(
      [...this.#active.values()].filter((item) => item !== previous),
    );
    this.#active.delete(portable(previous.origin.namespace!));
    this.#published = index.published;
    this.#sources = index.sources;
  }
  published(): PublishedMaterials {
    return this.#published;
  }
  scriptSources(): readonly ScriptSource[] {
    return this.#sources;
  }
}
