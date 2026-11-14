import { readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
import { createHash, createPublicKey } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function extensionId(key) {
  const der = createPublicKey({
    key: Buffer.from(key, "base64"),
    format: "der",
    type: "spki",
  }).export({ type: "spki", format: "der" });
  return [...createHash("sha256").update(der).digest().subarray(0, 16)]
    .flatMap((b) => [
      String.fromCharCode(97 + (b >> 4)),
      String.fromCharCode(97 + (b & 15)),
    ])
    .join("");
}
export async function buildExtensions(
  destination = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist"),
) {
  const source = path.dirname(fileURLToPath(import.meta.url));
  const release = JSON.parse(
    await readFile(path.join(source, "release-info.json"), "utf8"),
  );
  const { routeDefinitions } = await import("./router.js");
  await writeFile(
    path.join(source, "route-manifest.json"),
    JSON.stringify(
      routeDefinitions.map(({ method, needsTab, mutating }) => ({
        method,
        needsTab,
        mutating,
      })),
      null,
      2,
    ) + "\n",
  );
  const files = [
    "worker.js",
    "router.js",
    "page.js",
    "connection.js",
    "transport.js",
    "errors.js",
    "keyboard.js",
    "native-node.js",
    "clipboard.js",
    "frames.js",
    "evaluate.js",
    "visual.js",
    "page-data.js",
    "assets.js",
    "site-source.js",
  ];
  for (const [profile, info] of Object.entries(release.profiles)) {
    if (extensionId(info.key) !== info.extensionId || info.profile !== profile)
      throw new Error("Invalid fixed plugin identity.");
    const target = path.join(destination, profile);
    await mkdir(target, { recursive: true });
    for (const name of files)
      await copyFile(path.join(source, name), path.join(target, name));
    await writeFile(
      path.join(target, "profile.js"),
      `export const profile=${JSON.stringify(profile)};\nexport const extensionVersion=${JSON.stringify(release.extensionVersion)};\n`,
    );
    await writeFile(
      path.join(target, "manifest.json"),
      JSON.stringify(
        {
          manifest_version: 3,
          name:
            profile === "development"
              ? "Nexum browser (development)"
              : "Nexum browser",
          version: release.extensionVersion,
          key: info.key,
          minimum_chrome_version: "125",
          background: { service_worker: "worker.js", type: "module" },
          action: { default_title: "Nexum browser" },
          permissions: [
            "debugger",
            "tabs",
            "scripting",
            "storage",
            "alarms",
            "downloads",
            "history",
            "tabGroups",
            "bookmarks",
            "clipboardRead",
            "clipboardWrite",
            "webNavigation",
          ],
          host_permissions: ["http://*/*", "https://*/*"],
          content_security_policy: {
            extension_pages: `script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:${info.port};`,
          },
        },
        null,
        2,
      ) + "\n",
    );
  }
  return release;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildExtensions(process.argv[2]);
