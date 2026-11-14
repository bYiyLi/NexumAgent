import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { requireCondition } from "../contracts/errors.js";
import { canonicalJson } from "../contracts/json.js";
import type { ModulePolicy } from "../runtime/modules.js";
import { ScriptCatalog, type ScriptDiscovery } from "../runtime/scripts.js";
import { atomicText, contains, privateDirectory } from "../runtime/paths.js";
import { boundedFile } from "./discovery.js";

export interface DocLink {
  name: string;
  description: string;
  path: string;
  owner: string;
  version: string;
}
export interface PackageInfo {
  name: string;
  description: string;
  version: string | null;
  allowedVersion: string | null;
  status: string;
  types: string | null;
  homepage: string | null;
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";
const label = (text: string) =>
  text.replace(/[\r\n]+/g, " ").replace(/[\[\]`]/g, " ");

function writeGenerated(filename: string, text: string): void {
  try {
    const info = lstatSync(filename);
    requireCondition(
      info.isFile() && !info.isSymbolicLink(),
      "material_path_escape",
      "A generated manual must be a regular file.",
    );
    if (
      info.size === Buffer.byteLength(text) &&
      readFileSync(filename, "utf8") === text
    )
      return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  atomicText(filename, text);
}

export class DocumentCatalog {
  readonly work: string;
  readonly scripts: ScriptCatalog;
  readonly policy: ModulePolicy;
  constructor(work: string, scripts: ScriptCatalog, policy: ModulePolicy) {
    this.work = realpathSync.native(work);
    this.scripts = scripts;
    this.policy = policy;
    requireCondition(
      this.work === scripts.work,
      "runtime_profile_mismatch",
      "The document catalog and script environment must use the same work directory.",
    );
  }

  async refresh(
    links: readonly DocLink[] = [],
    signal?: AbortSignal,
    capturedScripts?: ScriptDiscovery,
  ) {
    signal?.throwIfAborted();
    const scripts = capturedScripts ?? this.scripts.discover();
    const scriptText = this.scripts.indexText(scripts);
    const approved = new Map(this.policy.approvedPackages());
    const builtinFamilies = [...this.policy.builtins()];
    const docs = privateDirectory(this.work, "docs");
    const packagesDirectory = privateDirectory(docs, "packages");
    const packages: PackageInfo[] = [];
    let manifest: Record<string, Record<string, unknown>> = {};
    try {
      const filename = realpathSync.native(
        path.join(this.work, "package.json"),
      );
      requireCondition(
        contains(this.work, filename),
        "module_path_escape",
        "The work manifest must remain inside this profile.",
      );
      manifest = JSON.parse(
        (await boundedFile(filename, 1024 * 1024, signal)).bytes.toString(
          "utf8",
        ),
      ) as typeof manifest;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const names = new Set<string>();
    for (const group of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ])
      for (const [name, value] of Object.entries(manifest[group] ?? {})) {
        requireCondition(
          typeof value === "string" &&
            /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name),
          "invalid_package_manifest",
          "The AI environment contains an unsupported direct package declaration.",
        );
        names.add(name);
      }
    for (const name of [...names].sort()) {
      signal?.throwIfAborted();
      const info: PackageInfo = {
        name,
        description: "",
        version: null,
        allowedVersion: approved.get(name) ?? null,
        status: "missing",
        types: null,
        homepage: null,
      };
      try {
        const modules = realpathSync.native(
          path.join(this.work, "node_modules"),
        );
        const root = realpathSync.native(path.join(modules, name));
        const filename = realpathSync.native(path.join(root, "package.json"));
        requireCondition(
          contains(this.work, modules) &&
            contains(modules, root) &&
            contains(root, filename),
          "module_path_escape",
          "The installed package escapes the AI environment.",
        );
        const data = JSON.parse(
          (await boundedFile(filename, 1024 * 1024, signal)).bytes.toString(
            "utf8",
          ),
        ) as Record<string, unknown>;
        requireCondition(
          data.name === name && typeof data.version === "string",
          "invalid_package_manifest",
          "The installed package identity is invalid.",
        );
        info.version = data.version;
        info.status =
          info.allowedVersion === null
            ? "not_approved"
            : info.version === info.allowedVersion
              ? "available"
              : "changed";
        if (typeof data.description === "string")
          info.description = [...data.description].slice(0, 1024).join("");
        const types = data.types ?? data.typings;
        if (typeof types === "string") {
          try {
            const actual = realpathSync.native(path.resolve(root, types));
            if (contains(root, actual) && statSync(actual).isFile())
              info.types = actual;
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
        if (typeof data.homepage === "string") {
          try {
            const url = new URL(data.homepage);
            if (
              ["https:", "http:"].includes(url.protocol) &&
              !url.username &&
              !url.password
            ) {
              url.search = "";
              url.hash = "";
              info.homepage = url.href;
            }
          } catch {}
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (!missing(error)) info.status = "unavailable";
      }
      packages.push(info);
    }
    const packageText =
      "# 已安装的 AI npm 包\n\n仅列出此 Agent work 的直接依赖；安装不等于已获准加载。详细用法由上游维护，类型声明可按需读取。\n\n" +
      packages
        .map(
          (item) =>
            `## ${label(item.name)}\n\n${label(item.description) || "未提供用途说明"}\n\n- 实际版本：${item.version ?? "未安装"}\n- 批准版本：${item.allowedVersion ?? "未批准"}\n- 状态：${item.status}\n- 类型入口：${item.types ?? "未声明可读取的入口"}\n- 上游：${item.homepage ?? "未提供"}`,
        )
        .join("\n\n") +
      "\n";
    this.scripts.refreshIndex(scripts);
    signal?.throwIfAborted();
    for (const link of links) {
      const actual = realpathSync.native(link.path);
      requireCondition(
        contains(docs, actual) &&
          statSync(actual).isFile() &&
          link.owner &&
          link.version,
        "invalid_doc_source",
        "Registered manuals must use their published local reading copy and actual owner/version.",
      );
    }
    function navigation(packageTarget: string, scriptTarget: string): string {
      return (
        "# Nexum Agent 使用手册\n\n此手册来自当前 Agent 的实际目录。通过脚本使用获准 Node/npm 读取文档，按行位置分段；读取续页时使用同一修订的入口。\n\n" +
        `- [可复用脚本](${scriptTarget})：按公开 scriptName 查找流程、用途和完整输入 Schema。\n` +
        `- [AI npm 包](${packageTarget})：已安装库、批准状态、上游与类型声明入口。\n` +
        links
          .map(
            (link) =>
              `- [${label(link.name)}](<${pathToFileURL(link.path).href}>)：${label(link.description)}（${label(link.owner)} ${label(link.version)}）`,
          )
          .join("\n") +
        "\n\n## 基本工作方式\n\n打开 Agent 或项目后使用返回的 contextId 创建运行。script、scriptName、replayRunId 三者只选一个；新工作不继承旧脚本变量。\n\nNode 文件操作显式基于 context.pwd 或 context.paths 解析绝对路径；包环境始终来自该 Agent 的 work。普通本地文件操作使用 Node/npm。\n\n观察等待到期后按原 runId 查询或控制；取消和运行总期限由运行系统管理。历史重放会创建新运行，可能再次产生副作用。\n\n## 文档与资料\n\n入口指令已随打开结果交付。Skills 先提供选择元数据；选中后读取对应 SKILL.md，再按需读取其资源。文件 URL 可交给 Node URL/fileURLToPath 处理，它指向 Agent 本地文件。\n"
      );
    }
    const immutableText = navigation("packages.md", "scripts.md");
    const revision = digest(
      canonicalJson(
        { manual: immutableText, packages: packageText, scripts: scriptText },
        16 * 1024 * 1024,
      ),
    );
    const versioned = privateDirectory(docs, ".catalog", revision);
    writeGenerated(path.join(versioned, "README.md"), immutableText);
    writeGenerated(path.join(versioned, "packages.md"), packageText);
    writeGenerated(path.join(versioned, "scripts.md"), scriptText);
    writeGenerated(path.join(packagesDirectory, "README.md"), packageText);
    writeGenerated(
      path.join(docs, "README.md"),
      navigation("packages/README.md", "scripts.md"),
    );
    const lines = immutableText.split("\n");
    return {
      entry: path.join(versioned, "README.md"),
      revision: "sha256:" + revision,
      content: lines.slice(0, 40).join("\n"),
      truncated: lines.length > 40,
      nextLine: lines.length > 40 ? 41 : null,
      packagesIndex: path.join(versioned, "packages.md"),
      builtinFamilies,
      packages,
    };
  }
}
