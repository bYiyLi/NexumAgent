import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { CONTROL_OWNER, CONTROL_VERSION, FIXED_CONTROL_SCRIPTS, materializeControlScripts, qualifyControlScript } from "../dist/runtime/control-scripts.js";

test("control imports are read-only and materialization preserves the nine actual platform definitions", (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-control-materials-")));
  const work = root;
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const imported = spawnSync(process.execPath, ["--input-type=module"], {
    cwd: work, encoding: "utf8",
    input: `await import(${JSON.stringify(new URL("../dist/runtime/control-scripts.js", import.meta.url).href)});`,
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.deepEqual(readdirSync(work), ["package.json"]);
  const sources = materializeControlScripts(work);
  const scripts = new ScriptCatalog(work, "agent", () => sources);
  assert.equal(FIXED_CONTROL_SCRIPTS.length, 9);
  assert.equal(sources.length, 2);
  for (const spec of FIXED_CONTROL_SCRIPTS) {
    const snapshot = qualifyControlScript(scripts, spec.name);
    assert.equal(snapshot.code, spec.code);
    assert.equal(snapshot.origin.revision, spec.revision);
    assert.equal(snapshot.origin.owner, CONTROL_OWNER);
    assert.equal(snapshot.origin.version, CONTROL_VERSION);
    assert.equal(snapshot.origin.type, "platform");
    assert.equal(snapshot.metadata.scriptOpenDefault, true);
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.metadata.scriptInputSchema));
  }
});
