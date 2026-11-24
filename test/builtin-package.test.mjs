import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const scripts = ["file.read.js", "file.list.js", "file.search.js", "file.patch.js", "git.status.js", "git.diff.js", "sh.get.js", "sh.list.js", "sh.write.js", "sh.resize.js", "sh.signal.js", "sh.stop.js", "transfer.get.js", "transfer.list.js", "transfer.cancel.js"];

test("Node Host archive bundles the versioned builtin and recovery scripts", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexum-builtin-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = path.join(root, "agent");
  const out = path.join(root, "out");
  mkdirSync(agent);
  mkdirSync(path.join(agent, "dist", "host"), { recursive: true });
  mkdirSync(path.join(agent, "contracts"), { recursive: true });
  writeFileSync(path.join(agent, "dist", "host", "main.js"), "");
  writeFileSync(path.join(agent, "contracts", "readme.txt"), "");
  cpSync(path.join(repository, "agent", "builtin"), path.join(agent, "builtin"), { recursive: true });
  cpSync(path.join(repository, "agent", "skills"), path.join(agent, "skills"), { recursive: true });
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
  execFileSync(process.execPath, [path.join(repository, "scripts", "package-node-host.mjs"), agent, out, "1.2.3"]);
  const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "1.2.3");
  const archive = path.join(out, manifest.artifact.name);
  assert.ok(existsSync(archive));
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  for (const name of scripts) assert.ok(entries.includes("/builtin/" + name), "not packaged: " + name);
  assert.ok(entries.includes("/skills/script-authoring/SKILL.md"));
  assert.ok(entries.includes("/skills/script-authoring/references/authoring.md"));
});
