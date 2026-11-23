import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FixtureStore } from "./helpers/runtime-fixture.mjs";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { platformFactories, platformMethodProjection, platformNamespaces, platformSkill } from "../dist/sdk/platform.js";

test("platform registry and host readiness share the same supported namespaces", () => {
  assert.deepEqual([...platformNamespaces], Object.keys(platformFactories(() => null)));
  assert.equal(platformNamespaces.includes("output"), false);
});

test("platform Skills and Go projections use actual prepared Registry methods", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-platform-")));
  mkdirSync(path.join(root, "work"));
  const store = new FixtureStore(root, { agentId: "agent", profile: "development", cloudEnvironment: "test" });
  const permissions = ["runtime.input", "maintenance.execute", "state.agent.read", "state.agent.write", "state.user.read", "state.user.write"];
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
  const factories = platformFactories(() => null);
  for (const namespace of ["runtime", "state"]) {
    const handle = await registry.prepare({ apiVersion: 1, origin: {
    type: "platform", owner: "nexum", namespace, version: "1", revision: "1",
    }, permissions }, factories[namespace]);
    registry.publish(handle);
    handles.push(handle);
    const { generated } = platformSkill(namespace, handle);
    const projection = platformMethodProjection(namespace, handle);
    assert.equal(projection.length, handle.methods.length);
    assert.deepEqual(projection.map((method) => method.metadata), [...handle.methods]);
    assert.ok(projection.every((method) => method.id.startsWith("platform_") && method.operation));
    assert.equal(new Set(projection.map((method) => method.id)).size, projection.length);
    const skill = generated.files.get("SKILL.md");
    assert.ok(skill.includes(`${namespace}[`));
    assert.throws(() => platformSkill(namespace === "runtime" ? "state" : "runtime", handle),
      { code: "invalid_platform_source" });
  }
});
