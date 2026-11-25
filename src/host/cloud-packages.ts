import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";

const name = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const version = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;

/** Go manages work package changes; the host exposes only actual direct dependencies. */
export function cloudManagedPackages(root: string, availableOnly = false): ReadonlyMap<string, string> {
  const packages = new Map<string, string>();
  try {
    const work = root;
    const modules = path.join(work, "node_modules");
    requireCondition(realpathSync.native(root) === root &&
        realpathSync.native(work) === work &&
        realpathSync.native(modules) === modules,
      "package_path_invalid", "The work package directories cannot redirect.");
    const filename = path.join(work, "package.json");
    const info = lstatSync(filename);
    requireCondition(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024,
      "package_manifest_invalid", "The work package manifest must be a bounded regular file.");
    const manifest: unknown = JSON.parse(readFileSync(filename, "utf8"));
    requireCondition(isPlainRecord(manifest), "package_manifest_invalid",
      "The work package manifest must be an object.");
    const declared = manifest.dependencies;
    if (declared === undefined) return packages;
    requireCondition(isPlainRecord(declared), "package_manifest_invalid",
      "The work package dependencies must be an object.");
    for (const [packageName, specifier] of Object.entries(declared)) {
      if (packageName === "@nexum/node-host" || packageName === "@nexum-hub/agent" || !name.test(packageName) ||
          packageName.length > 214 || typeof specifier !== "string") continue;
      try {
        const rootOfPackage = realpathSync.native(path.join(modules, packageName));
        requireCondition(rootOfPackage.startsWith(modules + path.sep),
          "package_path_invalid", "An installed package escapes the work environment.");
        const metadata = path.join(rootOfPackage, "package.json");
        const info = lstatSync(metadata);
        requireCondition(info.isFile() && !info.isSymbolicLink() && info.size <= 65536,
          "package_manifest_invalid", "The installed package metadata is invalid.");
        const item: unknown = JSON.parse(readFileSync(metadata, "utf8"));
        requireCondition(isPlainRecord(item) && item.name === packageName &&
          typeof item.version === "string" && version.test(item.version) &&
          (!version.test(specifier) || item.version === specifier),
        "package_manifest_invalid", "The installed package identity is invalid.");
        packages.set(packageName, item.version);
      } catch (cause) {
        if (availableOnly || (cause as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw cause;
      }
    }
  } catch (cause) {
    if (availableOnly) return new Map();
    if (cause instanceof SyntaxError)
      throw new AgentError("package_manifest_invalid", "A package manifest contains invalid JSON.", undefined, { cause });
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  return packages;
}
