import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { FixtureStore } from "./helpers/runtime-fixture.mjs";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { MaterialRetention } from "../dist/runtime/material-retention.js";
import { stateExtension } from "../dist/sdk/state.js";
import { preparePlatformMaterials } from "../dist/host/platform-materials.js";

test("platform Skill uses the actual Registry methods and holds its prepared revision", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-platform-materials-")));
  const work = path.join(root, "work");
  mkdirSync(work);
  const store = new FixtureStore(root, { agentId: "agent", profile: "development", cloudEnvironment: "test" });
  const reserve = async () => ({ release() {} });
  const retention = new MaterialRetention(root, { reserve, liveSnapshotRefs: () => new Set() });
  const permissions = ["state.agent.read", "state.agent.write", "state.user.read", "state.user.write"];
  const registry = new ExtensionRegistry(new ResourceManager(store), {
    permissions: new Set(permissions), authorize() {}, log() {}, progress() {},
  });
  const origin = { type: "platform", owner: "nexum", namespace: "state", version: "1", revision: "1" };
  const handle = await registry.prepare({ apiVersion: 1, origin, permissions }, stateExtension);
  t.after(async () => {
    await registry.disable(handle);
    await retention.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const pending = await preparePlatformMaterials(work, "state", handle, retention, reserve);
  assert.equal(pending.material.skillId, "nexum/shared-state");
  assert.equal(pending.material.origin, handle.origin);
  assert.match(readFileSync(pending.material.skillFile, "utf8"), /state\["agent"\]\["get"\]/);
  const reference = readFileSync(path.join(pending.material.path, "references", "method-1.md"), "utf8");
  assert.match(reference, /inputSchema/);
  pending.confirmPublished();
  assert.throws(() => pending.discard(), { code: "invalid_platform_source" });
  const abandoned = await preparePlatformMaterials(work, "state", handle, retention, reserve);
  abandoned.discard();
  assert.throws(() => abandoned.confirmPublished(), { code: "invalid_platform_source" });
  await assert.rejects(preparePlatformMaterials(work, "runtime", handle, retention, reserve),
    { code: "invalid_platform_source" });
});
