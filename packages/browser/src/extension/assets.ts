import {
  readFile,
  mkdir,
  mkdtemp,
  readdir,
  lstat,
  rename,
  rm,
  copyFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtensionHost } from "@nexum/extension-api";
import { check, identifier, record } from "./protocol.js";

export interface PluginBuild {
  extensionId: string;
  extensionVersion: string;
  port: number;
  profile: "production" | "development";
  directory: string;
}
const pluginRoot = fileURLToPath(
  new URL("../../browser-extension/", import.meta.url),
);
/** Copies only this package's generated plugin, never installs it into a browser. */
export async function preparePlugin(
  host: ExtensionHost,
  signal: AbortSignal,
): Promise<PluginBuild> {
  signal.throwIfAborted();
  const profile = host.context.profile;
  check(
    profile === "production" || profile === "development",
    "PROFILE_MISMATCH",
    "This browser package needs an explicit supported Agent profile.",
  );
  const paths = host.context.paths;
  check(
    record(paths) &&
      typeof paths.work === "string" &&
      path.isAbsolute(paths.work),
    "INVALID_ARGUMENT",
    "The Agent work directory is unavailable.",
  );
  const release = JSON.parse(
    await readFile(path.join(pluginRoot, "release-info.json"), "utf8"),
  ) as {
    extensionVersion: string;
    protocolVersion: number;
    profiles: Record<string, PluginBuild & { key: string }>;
  };
  const build = release.profiles[profile];
  check(
    build &&
      build.profile === profile &&
      /^[a-p]{32}$/.test(build.extensionId) &&
      identifier(release.extensionVersion) &&
      release.protocolVersion === 1 &&
      build.port === (profile === "production" ? 43831 : 43832),
    "PROTOCOL_MISMATCH",
    "The matching plugin release metadata is unavailable.",
  );
  const source = path.join(pluginRoot, "dist", profile);
  const manifest = JSON.parse(
    await readFile(path.join(source, "manifest.json"), "utf8"),
  ) as { key: string; version: string };
  const extensionId = [
    ...createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest()
      .subarray(0, 16),
  ]
    .map((value) => String.fromCharCode(97 + (value >> 4), 97 + (value & 15)))
    .join("");
  check(
    manifest.key === build.key &&
      extensionId === build.extensionId &&
      manifest.version === release.extensionVersion,
    "PROTOCOL_MISMATCH",
    "The plugin manifest identity does not match this package release.",
  );
  const parent = path.join(paths.work, ".nexum-browser"),
    destination = path.join(parent, "extension");
  host.authorize({ type: "path", value: parent, access: "write" });
  await mkdir(parent, { recursive: true, mode: 0o700 });
  check(
    !(await lstat(parent)).isSymbolicLink(),
    "PERMISSION_DENIED",
    "The browser package directory cannot be a symbolic link.",
  );
  signal.throwIfAborted();
  const temporary = await mkdtemp(path.join(parent, ".plugin-"));
  let backup: string | undefined,
    committed = false;
  try {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      signal.throwIfAborted();
      check(
        entry.isFile() &&
          !entry.isSymbolicLink() &&
          !entry.name.startsWith("."),
        "PROTOCOL_MISMATCH",
        "The plugin build must contain regular owned files.",
      );
      await copyFile(
        path.join(source, entry.name),
        path.join(temporary, entry.name),
      );
    }
    signal.throwIfAborted();
    host.authorize({ type: "path", value: destination, access: "write" });
    try {
      check(
        !(await lstat(destination)).isSymbolicLink(),
        "PERMISSION_DENIED",
        "The stable plugin path cannot redirect elsewhere.",
      );
      backup = await mkdtemp(path.join(parent, ".previous-"));
      await rm(backup, { recursive: true });
      await rename(destination, backup);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    try {
      await rename(temporary, destination);
      committed = true;
    } catch (cause) {
      if (backup) await rename(backup, destination);
      backup = undefined;
      throw cause;
    }
    if (backup) await rm(backup, { recursive: true, force: true });
    signal.throwIfAborted();
    return {
      profile,
      port: build.port,
      extensionId: build.extensionId,
      extensionVersion: release.extensionVersion,
      directory: destination,
    };
  } finally {
    if (!committed) await rm(temporary, { recursive: true, force: true });
  }
}
