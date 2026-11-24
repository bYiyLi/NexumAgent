import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FixtureStore } from "./helpers/runtime-fixture.mjs";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { methodReferenceNames } from "../dist/work/method-skills.js";
import { platformSkill } from "../dist/sdk/platform.js";
import { shExtension } from "../dist/sdk/sh.js";
import { compileMethodSchema } from "../dist/contracts/validation.js";
import { normalizeLaunch } from "../dist/process/launch.js";

test("shell Skill uses actual prepared Registry methods", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-platform-")));
  mkdirSync(root, { recursive: true });
  const store = new FixtureStore(root, { agentId: "agent", profile: "development", cloudEnvironment: "test" });
  const permissions = ["path", "resource", "sh.execute", "sh.read", "sh.control", "storage.reserve"];
  const registry = new ExtensionRegistry(new ResourceManager(store), {
    permissions: new Set(permissions),
    authorize() {}, log() {}, progress() {},
  });
  const handles = [];
  t.after(async () => {
    for (const handle of handles.reverse()) await registry.disable(handle);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const contracts = new Map();
  for (const namespace of ["sh"]) {
    const handle = await registry.prepare({ apiVersion: 1, origin: {
    type: "platform", owner: "nexum", namespace, version: "1", revision: "1",
    }, permissions }, shExtension);
    registry.publish(handle);
    handles.push(handle);
    const { generated } = platformSkill(namespace, handle);
    const skill = generated.files.get("SKILL.md");
    assert.ok(skill.includes(`${namespace}[`));
    assert.equal(generated.files.has("references/calling.md"), false);
    t.diagnostic(`sh: ${handle.methods.length} methods, ${[...generated.files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0)} total bytes, ${Buffer.byteLength(skill)} entry bytes`);
    for (const method of handle.methods) {
      const key = namespace + "." + method.path.join(".");
      const reference = generated.files.get(`references/${method.path.join(".")}.md`);
      assert.ok(skill.includes(`](references/${method.path.join(".")}.md)`), key);
      assert.ok(reference.includes(`调用：${key}(`), key);
      const json = reference.match(/```json\n([^]*?)\n```/)[1];
      assert.deepEqual(JSON.parse(json), method, key);
      assert.ok(Object.hasOwn(method, "outputSchema"), key);
      contracts.set(key, {
        input: compileMethodSchema(method.inputSchema, method.schemaDialect, method.schemas),
        output: compileMethodSchema(method.outputSchema, method.outputSchemaDialect ?? method.schemaDialect, method.schemas),
      });
    }
    assert.throws(() => platformSkill("runtime", handle),
      { code: "invalid_platform_source" });
  }
  assert.equal(contracts.size, 9);
  const valid = (method, side, value) => assert.doesNotThrow(() => contracts.get(method)[side](value), method);
  const invalid = (method, side, value) => assert.throws(() => contracts.get(method)[side](value), { code: "invalid_arguments" }, method);
  valid("sh.exec", "input", normalizeLaunch([{ command: "node", args: ["-v"] }], "exec"));
  invalid("sh.exec", "input", { command: "node", invented: true });
});

test("semantic method filenames are safe and independent of registration order", () => {
  const methods = [["exec"], ["get"], ["GET"], ["a", "b"], ["a.b"], ["CON"], ["errors"], ["../escape"], ["GET /customers"]].map(path => ({ path }));
  const names = methodReferenceNames(methods);
  assert.equal(names[0], "references/exec.md");
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length);
  for (const name of names) assert.match(name, /^references\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/);
  assert.deepEqual([...methodReferenceNames([...methods].reverse())].reverse(), names);
});
