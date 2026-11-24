import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { CONTROL_OWNER, CONTROL_VERSION } from "../dist/runtime/platform-identity.js";

const controls = ["sh.get.js", "sh.list.js", "sh.write.js", "sh.resize.js", "sh.signal.js", "sh.stop.js", "transfer.get.js", "transfer.list.js", "transfer.cancel.js"];

test("recovery controls are immutable packaged builtins, not generated profile scripts", (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-control-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ScriptCatalog(root, "agent");
  const discovered = catalog.discover();
  assert.equal(discovered.warnings.length, 0);
  for (const filename of controls) {
    const name = "nexum/" + filename;
    const snapshot = catalog.resolve(name);
    assert.ok(discovered.entries.some(entry => entry.scriptName === name));
    assert.equal(snapshot.origin.owner, CONTROL_OWNER);
    assert.equal(snapshot.origin.version, CONTROL_VERSION);
    assert.equal(snapshot.origin.namespace, "nexum");
    assert.equal(snapshot.origin.revision, createHash("sha256").update(readFileSync(snapshot.path)).digest("hex"));
    assert.equal(snapshot.metadata.scriptOpenDefault, false);
    assert.ok(snapshot.metadata.scriptOutputSchema);
  }
  assert.equal(existsSync(path.join(root, ".platform-controls")), false);
});
