import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const cloudRoot = path.resolve(repository, "..");
const cloudManifest = path.join(cloudRoot, "package.json");
const cloudCheckout = path.basename(repository) === "agent" && existsSync(cloudManifest) &&
  JSON.parse(readFileSync(cloudManifest, "utf8")).name === "@nexum/workspace";
const scripts = ["file.read.js", "file.list.js", "file.search.js", "file.patch.js", "script.metadata.js", "resource.read.js", "sh.get.js", "sh.list.js", "sh.write.js", "sh.resize.js", "sh.signal.js", "sh.stop.js", "transfer.get.js", "transfer.list.js", "transfer.cancel.js"];
const retired = ["builtin/git.status.js", "builtin/git.diff.js"];
const required = [
  ...scripts.map((name) => "builtin/" + name),
  "skills/script-authoring/SKILL.md",
  "skills/script-authoring/references/authoring.md",
];

test("Node Host package includes the versioned builtin and recovery scripts in a standalone Agent checkout", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: repository, encoding: "utf8", timeout: 30000,
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const entries = new Set(pack.files.map(({ path }) => path));
  for (const name of required) assert.ok(entries.has(name), "not packaged: " + name);
  for (const name of retired) assert.ok(!entries.has(name), "retired script packaged: " + name);
});

// The portable archive is built by Cloud, not published by the Agent npm workflow.
// Keep this integration check in the actual parent checkout; the standalone
// Agent gate above checks the same required materials using its own package.
test("Cloud Node Host archive bundles the versioned builtin and recovery scripts", {
  skip: cloudCheckout ? false : "requires the Nexum Cloud superproject checkout",
}, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexum-builtin-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = path.join(root, "agent");
  const out = path.join(root, "out");
  mkdirSync(agent);
  mkdirSync(path.join(agent, "dist", "host"), { recursive: true });
  mkdirSync(path.join(agent, "contracts"), { recursive: true });
  writeFileSync(path.join(agent, "dist", "host", "main.js"), "");
  writeFileSync(path.join(agent, "contracts", "readme.txt"), "");
  cpSync(path.join(repository, "builtin"), path.join(agent, "builtin"), { recursive: true });
  cpSync(path.join(repository, "skills"), path.join(agent, "skills"), { recursive: true });
  for (const pkg of ["node-pty", "koffi"]) {
    const target = path.join(agent, "node_modules", pkg);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "package.json"), '{"name":"' + pkg + '"}');
  }
  for (const os of ["darwin", "linux", "win32"]) {
    for (const arch of ["arm64", "x64"]) {
      const koffi = path.join(agent, "node_modules", "@koromix", "koffi-" + os + "-" + arch);
      mkdirSync(koffi, { recursive: true });
      writeFileSync(path.join(koffi, "package.json"), '{"name":"fixture"}');
      mkdirSync(path.join(agent, "node_modules", "node-pty", "prebuilds", os + "-" + arch), { recursive: true });
    }
  }
  execFileSync(process.execPath, [path.join(cloudRoot, "scripts", "package-node-host.mjs"), agent, out, "1.2.3"]);
  const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "1.2.3");
  const archive = path.join(out, manifest.artifact.name);
  assert.ok(existsSync(archive));
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  for (const name of required) assert.ok(entries.includes("/" + name), "not packaged: " + name);
  for (const name of retired) assert.ok(!entries.includes("/" + name), "retired script packaged: " + name);
});
