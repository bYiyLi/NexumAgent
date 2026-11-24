import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FixtureStore } from "./helpers/runtime-fixture.mjs";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { platformFactories, platformMethodProjection, platformNamespaces, platformSkill } from "../dist/sdk/platform.js";
import { maintenanceMethods } from "../dist/extensions/maintenance.js";
import { compileMethodSchema } from "../dist/contracts/validation.js";
import { normalizeLaunch } from "../dist/process/launch.js";

test("platform registry and host readiness share the same supported namespaces", () => {
  assert.deepEqual([...platformNamespaces], Object.keys(platformFactories(() => null)));
  assert.equal(platformNamespaces.includes("output"), false);
});

test("platform Skills and Go projections use actual prepared Registry methods", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-platform-")));
  mkdirSync(root, { recursive: true });
  const store = new FixtureStore(root, { agentId: "agent", profile: "development", cloudEnvironment: "test" });
  const permissions = ["runtime.input", "maintenance.execute", "state.agent.read", "state.agent.write", "state.user.read", "state.user.write",
    "path", "resource", "sh.execute", "sh.read", "sh.control", "storage.reserve",
    ...["createUpload", "createDownload", "get", "list", "cancel"].map(name => "transfer." + name),
    ...[...maintenanceMethods, "get", "list", "cancel"].map(name => "maintenance." + name)];
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
  const contracts = new Map();
  for (const namespace of platformNamespaces) {
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
    for (const [index, method] of handle.methods.entries()) {
      const key = namespace + "." + method.path.join(".");
      const reference = generated.files.get(`references/method-${index + 1}.md`);
      const json = reference.match(/```json\n([^]*?)\n```/)[1];
      assert.deepEqual(JSON.parse(json), method, key);
      assert.ok(Object.hasOwn(method, "outputSchema"), key);
      contracts.set(key, {
        input: compileMethodSchema(method.inputSchema, method.schemaDialect, method.schemas),
        output: compileMethodSchema(method.outputSchema, method.outputSchemaDialect ?? method.schemaDialect, method.schemas),
      });
    }
    assert.throws(() => platformSkill(namespace === "runtime" ? "state" : "runtime", handle),
      { code: "invalid_platform_source" });
  }
  assert.equal(contracts.size, 37);
  const valid = (method, side, value) => assert.doesNotThrow(() => contracts.get(method)[side](value), method);
  const invalid = (method, side, value) => assert.throws(() => contracts.get(method)[side](value), { code: "invalid_arguments" }, method);
  valid("runtime.requestInput", "output", { input: { answer: 42 }, attachments: [] });
  invalid("runtime.requestInput", "output", { answer: 42 });
  valid("runtime.sleep", "output", null);
  invalid("runtime.sleep", "output", {});
  valid("state.agent.get", "output", null);
  valid("state.agent.set", "output", { value: [1, true], version: 2, updatedAt: 123 });
  invalid("state.agent.delete", "output", { deleted: true, version: 2 });
  valid("sh.exec", "input", normalizeLaunch([{ command: "node", args: ["-v"] }], "exec"));
  invalid("sh.exec", "input", { command: "node", invented: true });
  valid("maintenance.mcp.add", "input", { repo: { command: "node", args: ["server.js"] } });
  valid("maintenance.mcp.add", "input", { repo: { type: "http", url: "https://fixture.invalid/mcp" } });
  invalid("maintenance.mcp.add", "input", { repo: { command: "node", url: "https://fixture.invalid" } });
  valid("maintenance.api.import", "input", { name: "demo", url: "https://fixture.invalid/openapi.json" });
  invalid("maintenance.api.import", "input", { name: "demo" });
  invalid("maintenance.api.import", "input", { name: "demo", url: "https://fixture.invalid/openapi.json", path: "/tmp/spec.json" });
  valid("maintenance.api.update", "input", { name: "demo", config: { limits: { requestTimeoutMs: 1000 } } });
  invalid("maintenance.api.update", "input", { name: "demo", config: { invented: true } });
  valid("maintenance.list", "output", { requests: [], nextCursor: null });
  invalid("maintenance.list", "output", { requests: [] });
  valid("transfer.list", "output", { transfers: [], nextCursor: null });
  invalid("transfer.get", "output", { transferId: "tr_fake" });
});
