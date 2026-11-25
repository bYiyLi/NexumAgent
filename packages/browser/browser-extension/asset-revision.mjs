import { createHash } from "node:crypto";

// Hash the named, exact build bytes in a stable order. The generated profile
// contributes its source before the revision declaration (no self-hash).
export function assetRevision(assets) {
  const entries = [...assets.keys()].sort().map((name) => [
    name, createHash("sha256").update(assets.get(name)).digest("hex"),
  ]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function profileSource(profile, extensionVersion) {
  return `export const profile=${JSON.stringify(profile)};\nexport const extensionVersion=${JSON.stringify(extensionVersion)};\n`;
}

export function revisionSource(revision) {
  return `export const assetRevision=${JSON.stringify(revision)};\n`;
}
