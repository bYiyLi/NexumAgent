import { lstat, open, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { assetRevision, profileSource, revisionSource } from "../../browser-extension/asset-revision.mjs";

export type InstallationFailureReason =
  | "invalid_context" | "assets_not_prepared" | "asset_missing" | "asset_invalid"
  | "unsafe_asset_path" | "profile_mismatch" | "integrity_mismatch" | "build_mismatch"
  | "assets_changed" | "asset_read_failed" | "inspection_failed";

export type InstallationInspection =
  | { assetsReady: true; profile: "production" | "development"; directory: string; name: string; extensionVersion: string; extensionId: string }
  | { assetsReady: false; code: "browser_assets_unavailable"; reason: InstallationFailureReason };

class InspectionFailure extends Error {
  constructor(readonly reason: InstallationFailureReason) { super(reason); }
}
function requireEvidence(condition: unknown, reason: InstallationFailureReason): asserts condition {
  if (!condition) throw new InspectionFailure(reason);
}
const errno = (cause: unknown) => (cause as NodeJS.ErrnoException | undefined)?.code;
async function observed<T>(read: () => Promise<T>, missing: InstallationFailureReason): Promise<T> {
  try { return await read(); }
  catch (cause) {
    if (errno(cause) === "ENOENT") throw new InspectionFailure(missing);
    if (typeof errno(cause) === "string") throw new InspectionFailure("asset_read_failed");
    throw cause;
  }
}
function sameFile(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
function parse(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new InspectionFailure("asset_invalid"); }
  requireEvidence(value !== null && typeof value === "object" && !Array.isArray(value), "asset_invalid");
  return value as Record<string, unknown>;
}

/** Inspect only the fixed Browser assets of the supplied current Agent work.
 * This does not inspect user browser profiles or establish extension installation.
 * It performs no writes, launches, connection acquisition or recovery.
 */
export async function inspectInstallation(work: unknown, expectedProfile?: unknown): Promise<InstallationInspection> {
  try {
    requireEvidence(typeof work === "string" && path.isAbsolute(work), "invalid_context");
    requireEvidence(expectedProfile === undefined || expectedProfile === "production" ||
      expectedProfile === "development", "invalid_context");
    const root = await observed(() => realpath(work), "invalid_context");
    requireEvidence(path.relative(root, work) === "", "unsafe_asset_path");
    const parent = path.join(root, ".nexum-browser");
    const directory = path.join(parent, "extension");
    const directories: { target: string; info: Awaited<ReturnType<typeof lstat>> }[] = [];
    for (const target of [parent, directory]) {
      const info = await observed(() => lstat(target), "assets_not_prepared");
      requireEvidence(info.isDirectory() && !info.isSymbolicLink() &&
        path.relative(target, await observed(() => realpath(target), "assets_changed")) === "", "unsafe_asset_path");
      directories.push({ target, info });
    }
    async function checkDirectories(): Promise<void> {
      for (const { target, info } of directories) {
        const after = await observed(() => lstat(target), "assets_changed");
        requireEvidence(after.isDirectory() && !after.isSymbolicLink() && after.dev === info.dev &&
          after.ino === info.ino &&
          path.relative(target, await observed(() => realpath(target), "assets_changed")) === "", "assets_changed");
      }
    }
    async function readOwnedBytes(name: string, limit = 65536): Promise<Buffer> {
      await checkDirectories();
      const file = path.join(directory, name);
      const before = await observed(() => lstat(file), "asset_missing");
      requireEvidence(before.isFile() && !before.isSymbolicLink() &&
        path.relative(file, await observed(() => realpath(file), "assets_changed")) === "", "unsafe_asset_path");
      requireEvidence(before.size <= limit, "asset_invalid");
      const handle = await observed(() => open(file, "r"), "assets_changed");
      try {
        const stat = await observed(() => handle.stat(), "assets_changed");
        requireEvidence(sameFile(stat, before), "assets_changed");
        const bytes = Buffer.alloc(before.size + 1);
        let size = 0;
        while (size < bytes.length) {
          const { bytesRead } = await observed(() => handle.read(bytes, size, bytes.length - size, size), "assets_changed");
          if (!bytesRead) break;
          size += bytesRead;
        }
        const after = await observed(() => lstat(file), "assets_changed");
        requireEvidence(size === before.size && sameFile(after, before), "assets_changed");
        return bytes.subarray(0, size);
      } finally { await observed(() => handle.close(), "assets_changed"); }
    }

    const descriptor = await readOwnedBytes("nexum-installation.json");
    const installation = parse(descriptor);
    const { profile, extensionId, extensionVersion, assetRevision: revision, files } = installation;
    requireEvidence(profile === "production" || profile === "development", "asset_invalid");
    requireEvidence(expectedProfile === undefined || expectedProfile === profile, "profile_mismatch");
    requireEvidence(typeof extensionId === "string" && /^[a-p]{32}$/.test(extensionId) &&
        typeof extensionVersion === "string" && !!extensionVersion &&
        typeof revision === "string" && /^[0-9a-f]{64}$/.test(revision) &&
        Array.isArray(files) && files.length <= 512 &&
        new Set(files).size === files.length, "asset_invalid");
    // This generated flat asset set never includes path segments or device
    // aliases. Reject suspect names rather than following a descriptor path.
    requireEvidence(files.every(name => typeof name === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.endsWith(".") &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) &&
      name !== "nexum-installation.json"), "unsafe_asset_path");
    requireEvidence(files.includes("manifest.json") && files.includes("profile.js") &&
      files.includes("worker.js"), "asset_missing");

    const assets = new Map<string, Uint8Array | string>();
    let manifest: Record<string, unknown> | undefined;
    let total = 0;
    for (const name of [...files as string[]].sort()) {
      const bytes = await readOwnedBytes(name, 2 * 1024 * 1024);
      total += bytes.length;
      requireEvidence(total <= 8 * 1024 * 1024, "asset_invalid");
      if (name === "manifest.json") manifest = parse(bytes);
      if (name === "profile.js") {
        const source = profileSource(profile, extensionVersion);
        requireEvidence(bytes.equals(Buffer.from(source + revisionSource(revision))), "integrity_mismatch");
        assets.set(name, source);
      } else assets.set(name, bytes);
    }
    requireEvidence(manifest && typeof manifest.key === "string" && typeof manifest.name === "string" &&
      typeof manifest.version === "string", "asset_invalid");
    requireEvidence(manifest.version === extensionVersion && assetRevision(assets) === revision, "integrity_mismatch");
    const actualId = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)]
      .map(value => String.fromCharCode(97 + (value >> 4), 97 + (value & 15))).join("");
    requireEvidence(actualId === extensionId, "integrity_mismatch");

    // Compare with the actual package generation, not merely a self-consistent
    // descriptor left over from a different build.
    const expected = await observed(() => readFile(new URL("../../browser-extension/dist/" + profile + "/profile.js", import.meta.url)), "asset_read_failed");
    requireEvidence(expected.equals(Buffer.from(profileSource(profile, extensionVersion) + revisionSource(revision))), "build_mismatch");
    requireEvidence((await readOwnedBytes("nexum-installation.json")).equals(descriptor), "assets_changed");
    await checkDirectories();
    return { assetsReady: true, profile, directory, name: manifest.name, extensionVersion, extensionId };
  } catch (cause) {
    return { assetsReady: false, code: "browser_assets_unavailable",
      reason: cause instanceof InspectionFailure ? cause.reason : "inspection_failed" };
  }
}

const failureGuidance: Record<InstallationFailureReason, string> = {
  invalid_context: "The current Agent work or profile is unavailable or invalid. Verify the selected Agent and its Browser package initialization.",
  assets_not_prepared: "The expected stable asset directory is absent. Check whether the current Browser package prepared its assets.",
  asset_missing: "A required installation asset is missing. Check the current Browser package's asset preparation before loading an extension.",
  asset_invalid: "The asset descriptor or manifest is invalid, or an asset exceeds its validation limits. Check the current package and prepared assets.",
  unsafe_asset_path: "An asset path is redirected or unsafe. Do not follow it; check the current Agent's package-owned asset preparation.",
  profile_mismatch: "The prepared assets belong to a different profile. Verify the selected Agent and matching production/development package.",
  integrity_mismatch: "Prepared asset contents, version or extension identity do not match the recorded build. Check the current package's prepared assets.",
  build_mismatch: "The prepared assets do not match the current Browser package build. Check package initialization and asset preparation.",
  assets_changed: "The assets changed during inspection. Wait for package preparation to settle and check again.",
  asset_read_failed: "A required directory or asset could not be read. Check the current Agent's filesystem access and package preparation.",
  inspection_failed: "The asset inspection could not confirm its result. Check the current Agent's Browser lifecycle diagnostics.",
};

const label = (value: string): string => /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)
  ? JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
  : value;

/** Shared AI-readable facts and safe diagnostics; callers add task-specific steps. */
export function formatInstallationInspection(result: InstallationInspection): string {
  if (!result.assetsReady) {
    return ["Installation assets: unavailable", "Error: " + result.code, "Reason: " + result.reason,
      "Browser extension installation: unknown", failureGuidance[result.reason],
      "Do not guess an installation path or bypass permissions."].join("\n");
  }
  return ["Installation assets: ready (verified disk assets, not proof of installation)",
    "Browser extension installation: unknown", "Profile: " + label(result.profile),
    "Extension: " + label(result.name), "Extension version: " + label(result.extensionVersion),
    "Extension ID: " + label(result.extensionId), "Directory: " + label(result.directory)].join("\n");
}
