import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson } from "../contracts/json.js";

export const defaultBuiltins = Object.freeze([
  "assert",
  "buffer",
  "child_process",
  "console",
  "crypto",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "net",
  "os",
  "path",
  "perf_hooks",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "zlib",
]);

export interface ModuleUse {
  readonly specifier: string;
  readonly kind: "builtin" | "npm" | "file";
  readonly entry: string;
  readonly version: string | null;
  readonly packageName?: string;
}

export interface ModulePolicy {
  /** Live policy, including checks on cached modules. Package approval is not inferred from disk. */
  readonly builtins: () => readonly string[];
  readonly approvedPackages: () => ReadonlyMap<string, string>;
}

interface Bridge {
  fromWork: (specifier: string, options?: object) => Promise<object>;
  resolveFromWork: (specifier: string) => string;
}
interface AuthorizedModule {
  specifier: string;
  kind: ModuleUse["kind"];
  root?: string;
  version: string | null;
  packageName?: string;
}

const bridgeSource = [
  "export const fromWork = (specifier, options) => import(specifier, options);",
  "export const resolveFromWork = (specifier) => import.meta.resolve(specifier);",
  "",
].join("\n");

function contained(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function freeze(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export class ModuleLoader {
  readonly work: string;
  readonly #policy: ModulePolicy;
  readonly #require: NodeJS.Require;
  readonly #bridge: Bridge;
  readonly #loaded = new Map<string, string>();

  private constructor(work: string, policy: ModulePolicy, bridge: Bridge) {
    this.work = work;
    this.#policy = policy;
    this.#require = createRequire(path.join(work, "package.json"));
    this.#bridge = bridge;
  }

  static async create(
    work: string,
    bootId: string,
    policy: ModulePolicy,
  ): Promise<ModuleLoader> {
    requireCondition(
      typeof vm.SourceTextModule === "function",
      "runtime_configuration",
      "This runtime requires Node's --experimental-vm-modules startup option.",
    );
    requireCondition(
      /^[a-zA-Z0-9_-]+$/.test(bootId),
      "invalid_boot_id",
      "The boot identity is invalid.",
    );
    const actual = realpathSync(work);
    requireCondition(
      statSync(actual).isDirectory(),
      "invalid_work",
      "The Agent work directory does not exist.",
    );
    const directory = path.join(actual, "tmp", "runtime", bootId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    requireCondition(
      contained(actual, realpathSync(directory)),
      "module_path_escape",
      "The runtime loader directory escapes work.",
    );
    const filename = path.join(directory, "importer.mjs");
    await writeFile(filename, bridgeSource, { flag: "wx", mode: 0o600 });
    const bridge = (await import(pathToFileURL(filename).href)) as Bridge;
    return new ModuleLoader(actual, policy, bridge);
  }

  #authorize(specifier: string): AuthorizedModule {
    requireCondition(
      typeof specifier === "string" &&
        specifier.length > 0 &&
        specifier.length <= 8192,
      "invalid_module",
      "The module specifier is invalid.",
    );
    if (isBuiltin(specifier)) {
      const name = specifier.replace(/^node:/, "");
      const allowed = this.#policy.builtins().some((entry) => {
        const normalized = entry.replace(/^node:/, "");
        return (
          isBuiltin(entry) &&
          (name === normalized ||
            (!normalized.includes("/") && name.split("/")[0] === normalized))
        );
      });
      requireCondition(
        allowed,
        "module_not_allowed",
        "This Node module is not allowed as a direct script entry.",
      );
      return {
        specifier: "node:" + name,
        kind: "builtin",
        version: process.version,
      };
    }
    requireCondition(
      !specifier.startsWith("node:"),
      "module_missing",
      "This Node module does not exist.",
    );
    const file =
      specifier.startsWith("file:") ||
      specifier.startsWith(".") ||
      path.isAbsolute(specifier);
    if (file) {
      const moduleRoot = realpathSync(path.join(this.work, "modules"));
      requireCondition(
        contained(this.work, moduleRoot),
        "module_path_escape",
        "The file module root escapes work.",
      );
      const candidate = specifier.startsWith("file:")
        ? fileURLToPath(specifier)
        : path.resolve(moduleRoot, specifier);
      const actual = realpathSync(candidate);
      requireCondition(
        contained(moduleRoot, actual),
        "module_not_allowed",
        "A direct file module must be inside work/modules.",
      );
      requireCondition(
        statSync(actual).isFile() &&
          [".js", ".mjs", ".cjs", ".json"].includes(path.extname(actual)),
        "invalid_module",
        "This file is not a supported direct module entry.",
      );
      const entry = pathToFileURL(actual).href;
      const version =
        "sha256:" +
        createHash("sha256").update(readFileSync(actual)).digest("hex");
      requireCondition(
        !this.#loaded.has(entry) || this.#loaded.get(entry) === version,
        "module_restart_required",
        "This file module changed after loading; restart is required for new imports.",
      );
      return { specifier: entry, kind: "file", root: moduleRoot, version };
    }
    requireCondition(
      !specifier.includes(":") &&
        !specifier.includes("\\") &&
        !specifier.includes("\0"),
      "invalid_module",
      "Unsupported module scheme or name.",
    );
    const parts = specifier.split("/");
    const name = specifier.startsWith("@")
      ? parts.slice(0, 2).join("/")
      : parts[0]!;
    requireCondition(
      name &&
        !name.endsWith("/") &&
        !parts.some((part) => !part || part === "." || part === ".."),
      "invalid_module",
      "The package specifier is invalid.",
    );
    const approved = this.#policy.approvedPackages().get(name);
    requireCondition(
      approved,
      "module_not_allowed",
      "This npm package has not been approved for this Agent environment.",
    );
    const manifest = JSON.parse(
      readFileSync(path.join(this.work, "package.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    requireCondition(
      ["dependencies", "devDependencies", "optionalDependencies"].some(
        (field) => typeof manifest[field]?.[name] === "string",
      ),
      "module_not_allowed",
      "This package is not a declared direct dependency of work.",
    );
    const modules = realpathSync(path.join(this.work, "node_modules"));
    requireCondition(
      contained(this.work, modules),
      "module_path_escape",
      "The npm environment escapes work.",
    );
    const root = realpathSync(path.join(modules, name));
    requireCondition(
      contained(modules, root),
      "module_not_allowed",
      "The package is outside this Agent's npm environment.",
    );
    const metadata = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    requireCondition(
      metadata.name === name && metadata.version === approved,
      "module_changed",
      "The installed package differs from the approved version.",
    );
    requireCondition(
      !this.#loaded.has(name) || this.#loaded.get(name) === approved,
      "module_restart_required",
      "A different version of this package is already loaded; restart is required.",
    );
    return {
      specifier,
      kind: "npm",
      root,
      version: approved,
      packageName: name,
    };
  }

  #entry(authorized: AuthorizedModule, mode: "import" | "require"): string {
    if (authorized.kind === "builtin") return authorized.specifier;
    const entry =
      authorized.kind === "file"
        ? authorized.specifier
        : mode === "import"
          ? this.#bridge.resolveFromWork(authorized.specifier)
          : pathToFileURL(this.#require.resolve(authorized.specifier)).href;
    const actual = realpathSync(fileURLToPath(entry));
    requireCondition(
      authorized.root && contained(authorized.root, actual),
      "module_not_allowed",
      "The resolved module entry escapes its approved source.",
    );
    return pathToFileURL(actual).href;
  }

  async execute(
    code: string,
    parameters: Readonly<Record<string, unknown>>,
    options: {
      filename?: string;
      onModule?: (use: ModuleUse) => void;
      console?: Console;
    } = {},
  ): Promise<unknown> {
    const record = (authorized: AuthorizedModule, entry: string) => {
      if (authorized.version && authorized.kind !== "builtin")
        this.#loaded.set(authorized.packageName ?? entry, authorized.version);
      options.onModule?.({
        specifier: authorized.specifier,
        kind: authorized.kind,
        entry,
        version: authorized.version,
        ...(authorized.packageName
          ? { packageName: authorized.packageName }
          : {}),
      });
    };
    const resolve = (specifier: string) => {
      const authorized = this.#authorize(specifier);
      const entry = this.#entry(authorized, "require");
      return {
        authorized,
        entry,
        native:
          authorized.kind === "builtin"
            ? authorized.specifier
            : fileURLToPath(entry),
      };
    };
    const guardedRequire = Object.assign(
      (specifier: string) => {
        const { authorized, entry, native } = resolve(specifier);
        const value = this.#require(native);
        record(authorized, entry);
        return value;
      },
      { resolve: (specifier: string) => resolve(specifier).native },
    );
    const publicParameters: Record<string, unknown> = {
      ...parameters,
      context: freeze(
        JSON.parse(canonicalJson(parameters.context ?? {}, 2 * 1024 * 1024)),
      ),
      require: guardedRequire,
    };
    const names = Object.keys(publicParameters);
    requireCondition(
      names.every((name) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)),
      "invalid_namespace",
      "A public SDK alias is not a JavaScript identifier.",
    );
    const realm = vm.createContext(
      Object.assign(Object.create(null), {
        console: options.console ?? console,
        Buffer,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        AbortController,
        AbortSignal,
        fetch,
        structuredClone,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        queueMicrotask,
      }),
    );
    const entry = vm.compileFunction(
      '"use strict"; return (async function () {\n' +
        code +
        "\n}).call(undefined);",
      names,
      {
        parsingContext: realm,
        filename: options.filename ?? "nexum:script.js",
        importModuleDynamically: async (specifier, _referrer, attributes) => {
          const authorized = this.#authorize(specifier);
          const filename = this.#entry(authorized, "import");
          const value = await this.#bridge.fromWork(filename, {
            with: attributes,
          });
          record(authorized, filename);
          // Node accepts an actual ESM namespace here; @types/node only lists vm.Module.
          // Returning that native namespace preserves live bindings and Node's cache.
          return value as vm.Module;
        },
      },
    );
    return await entry(...names.map((name) => publicParameters[name]));
  }
}
