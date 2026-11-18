import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const name = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const version = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;

/** Cloud Bootstrap owns the single package.json/pnpm installation.
 * Only installed, directly declared dependencies can enter the public module
 * catalog. Core itself must never become an importable user extension. */
export function cloudManagedPackages(root: string): ReadonlyMap<string, string> {
  const packages = new Map<string, string>();
  try {
    const work = path.join(root, "work");
    const modules = path.join(work, "node_modules");
    if (realpathSync.native(root) !== root ||
        realpathSync.native(work) !== work ||
        realpathSync.native(modules) !== modules) return packages;
    const filename = path.join(work, "package.json");
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      return packages;
    const manifest: unknown = JSON.parse(readFileSync(filename, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
      return packages;
    const declared = (manifest as Record<string, unknown>).dependencies;
    if (!declared || typeof declared !== "object" || Array.isArray(declared))
      return packages;
    for (const [packageName, specifier] of Object.entries(declared)) {
      if (packageName === "@nexum-hub/agent" || !name.test(packageName) ||
          packageName.length > 214 || typeof specifier !== "string") continue;
      try {
        const rootOfPackage = realpathSync.native(path.join(modules, packageName));
        if (!rootOfPackage.startsWith(modules + path.sep)) continue;
        const metadata = path.join(rootOfPackage, "package.json");
        const info = lstatSync(metadata);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
          continue;
        const item = JSON.parse(readFileSync(metadata, "utf8")) as {
          name?: unknown; version?: unknown;
        };
        if (item.name === packageName && typeof item.version === "string" &&
            version.test(item.version)) packages.set(packageName, item.version);
      } catch {
        // A missing optional package does not prevent Core from coming online.
      }
    }
  } catch {
    // Malformed user-managed manifest is not a second startup gate.
  }
  return packages;
}
