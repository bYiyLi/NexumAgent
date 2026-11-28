import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareRelease } from "./prepare-release.mjs";

const version = "0.1.0-next.2026112803";
const profile = "development";
const signScript = fileURLToPath(new URL("./sign-update.mjs", import.meta.url));
function fixture(t, nested = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexum-release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const downloads = path.join(root, "artifacts");
  const output = path.join(root, "packages");
  const paths = [];
  for (const osName of ["darwin", "windows"]) for (const arch of ["amd64", "arm64"]) {
    const dir = path.join(downloads, "desktop-" + osName + "-" + arch, ...(nested ? [profile, "release"] : []));
    fs.mkdirSync(dir, { recursive: true });
    const name = "NexumDesktopDev-" + version + "-" + osName + "-" + arch + (osName === "darwin" ? ".dmg" : "-installer.exe");
    const payload = Buffer.from(osName + "/" + arch);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    fs.writeFileSync(path.join(dir, name), payload);
    fs.writeFileSync(path.join(dir, name + ".sha256"), sha256 + "  " + name + "\n");
    fs.writeFileSync(path.join(dir, name + ".metadata.json"), JSON.stringify({ os: osName, arch, name, size: payload.length, sha256, binarySha256: "a".repeat(64) }) + "\n");
    paths.push({ dir, name });
  }
  return { downloads, output, paths };
}
for (const nested of [true, false]) test("stage and sign four verified " + (nested ? "nested" : "flat") + " native archives", t => {
  const f = fixture(t, nested);
  assert.equal(prepareRelease(f.downloads, f.output, version, profile), 12);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
  const signed = spawnSync(process.execPath, [signScript], {
    cwd: f.output,
    env: { ...process.env, VERSION: version, PROFILE: profile, NEXUM_UPDATE_PUBLIC_KEY: key, NEXUM_UPDATE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") },
    encoding: "utf8",
  });
  assert.equal(signed.status, 0, signed.stderr);
  const manifest = fs.readFileSync(path.join(f.output, "update.json"));
  const sig = Buffer.from(fs.readFileSync(path.join(f.output, "update.json.sig"), "utf8"), "base64");
  assert.ok(verify(null, manifest, publicKey, sig));
  assert.equal(JSON.parse(manifest).assets.length, 4);
});
for (const [label, mutate] of [
  ["missing file", f => fs.unlinkSync(path.join(f.paths[0].dir, f.paths[0].name))],
  ["unexpected file", f => fs.writeFileSync(path.join(f.paths[0].dir, "extra"), "x")],
  ["altered package", f => fs.appendFileSync(path.join(f.paths[0].dir, f.paths[0].name), "x")],
  ["unexpected artifact", f => fs.mkdirSync(path.join(f.downloads, "desktop-extra"))],
  ["other profile", f => fs.renameSync(path.dirname(f.paths[0].dir), path.join(path.dirname(path.dirname(f.paths[0].dir)), "production"))],
]) test("reject " + label + " without staging", t => {
  const f = fixture(t);
  mutate(f);
  assert.throws(() => prepareRelease(f.downloads, f.output, version, profile));
  assert.equal(fs.existsSync(f.output), false);
});
test("reject existing staging directory", t => {
  const f = fixture(t);
  fs.mkdirSync(f.output);
  assert.throws(() => prepareRelease(f.downloads, f.output, version, profile));
  assert.deepEqual(fs.readdirSync(f.output), []);
});
