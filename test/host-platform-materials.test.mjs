import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { FixtureStore } from "./helpers/runtime-fixture.mjs";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { shExtension } from "../dist/sdk/sh.js";
import { preparePlatformMaterials } from "../dist/host/platform-materials.js";

test("platform Skill uses the actual Registry methods and replaces a single stable directory", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-platform-materials-")));
  const work = root;
  mkdirSync(work, { recursive: true });
  const store = new FixtureStore(root, { agentId: "agent", profile: "development", cloudEnvironment: "test" });
  const reserve = async () => ({ release() {} });
  const permissions = ["path", "resource", "sh.execute", "sh.read", "sh.control", "storage.reserve"];
  const registry = new ExtensionRegistry(new ResourceManager(store), {
    permissions: new Set(permissions), authorize() {}, log() {}, progress() {},
  });
  const origin = { type: "platform", owner: "nexum", namespace: "sh", version: "1", revision: "1" };
  const handle = await registry.prepare({ apiVersion: 1, origin, permissions }, shExtension);
  t.after(async () => {
    await registry.disable(handle);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const pending = await preparePlatformMaterials(work, "sh", handle, reserve);
  assert.equal(pending.material.path, path.join(work, "cache", "materials", "platform", "sh"));
  assert.equal(pending.material.skillId, "nexum/managed-processes");
  assert.equal(pending.material.origin, handle.origin);
  assert.match(readFileSync(pending.material.skillFile, "utf8"), /sh\["exec"\]/);
  const reference = readFileSync(path.join(pending.material.path, "references", "exec.md"), "utf8");
  assert.match(reference, /inputSchema/);
  assert.equal(pending.authored.skillId, "nexum/script-authoring");
  assert.match(readFileSync(pending.authored.skillFile, "utf8"), /name: script-authoring/);
  assert.ok(readFileSync(path.join(pending.authored.path, "references", "authoring.md"), "utf8").length > 0);
  pending.confirmPublished();
  assert.throws(() => pending.discard(), { code: "invalid_platform_source" });
  const abandoned = await preparePlatformMaterials(work, "sh", handle, reserve);
  abandoned.discard();
  assert.throws(() => abandoned.confirmPublished(), { code: "invalid_platform_source" });
  await assert.rejects(preparePlatformMaterials(work, "runtime", handle, reserve),
    { code: "invalid_platform_source" });
});

test("large method sets route through bounded groups and preserve named-object contracts", async () => {
  const { methodSkill } = await import("../dist/work/method-skills.js");
  const methods = Array.from({ length: 40 }, (_, i) => ({
    path: [i < 20 ? "tabs" : "frames", "method" + i],
    description: "Observed operation " + i,
    callStyle: "input-object",
    normalizes: true,
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
  }));
  const options = {
    name: "browser-operations",
    description: "Browser operations",
    origin: { type: "extension", owner: "browser", namespace: "browser", version: "1", revision: "1" },
    bindingPath: ["browser"],
    methods,
  };
  const { files } = methodSkill(options);
  const root = files.get("SKILL.md");
  assert.ok(root.includes("tabs") && root.includes("frames"));
  assert.ok(!root.includes("Observed operation 39"));
  const groups = [...files.keys()].filter((f) => f.startsWith("references/groups/"));
  assert.equal(groups.length, 2);
  const reference = [...files.values()].find((value) => value.includes('Observed operation 39') && value.includes('outputSchema'));
  assert.ok(reference.includes("显式命名字段对象"));
  assert.ok(reference.includes('"outputSchema":{"type":"string"}'));
  assert.ok(methodSkill({ ...options, methods: methods.slice(0, 2) }).files.get("SKILL.md").includes("Observed operation 1"));
});
