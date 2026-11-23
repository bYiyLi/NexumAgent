import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { MaterialSession } from "../dist/host/materials.js";
import { MaterialRPC } from "../dist/host/material-rpc.js";
import { createMaterialFactory } from "../dist/host/material-factory.js";
import { selectorKey } from "../dist/work/discovery.js";

const caller = { principalId: "user", clientId: "client" };

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-material-host-")));
  const work = root;
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "AGENTS.md"), "Work instructions\n");
  const scripts = new ScriptCatalog(work, "agent");
  writeFileSync(path.join(scripts.local, "find.js"), `/**
{"scriptName":"find.js","scriptDesc":"Find a record","scriptWhenUse":"When searching","scriptInputSchema":{"type":"object"},"scriptOpenDefault":true}
*/\nreturn 1;\n`);
  let allowed = true;
  let holds = 0;
  let waitForReserve = async () => {};
  const workOptions = {
    home: null,
    agent: { name: "Agent", version: "1", protocolVersion: "2" },
    authorize: () => { if (!allowed) throw new Error("forbidden"); },
    resolveProject: async () => { throw new Error("unknown project"); },
    scriptUsage: () => [],
    canUseScript: () => true,
    reserve: async () => { await waitForReserve(); return { release() {} }; },
    materialRetention: { hold: async () => { holds++; return { release() { holds--; } }; } },
  };
  const session = new MaterialSession({
    root,
    binding: { agentId: "agent", profile: "development", cloudEnvironment: "development" },
    bootId: "boot",
    scripts,
    policy: { builtins: () => ["fs"], approvedPackages: () => new Map() },
  });
  t.after(() => { session.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, work, session, workOptions, scripts, setAllowed(value) { allowed = value; },
    setReserve(value) { waitForReserve = value; }, holds: () => holds };
}

test("Go-owned work prepares the existing snapshot without opening SQLite", async (t) => {
  const f = fixture(t);
  const prepared = await f.session.prepare("prepare_1", caller, { agentId: "agent" }, null, new AbortController().signal, f.workOptions);
  const bundle = JSON.parse(readFileSync(path.join(f.root, prepared.ref), "utf8"));
  assert.equal(bundle.agentId, "agent");
  assert.equal(bundle.bootId, "boot");
  assert.equal(bundle.view.pwd, path.join(f.work, "scripts"));
  assert.equal(bundle.view.agent.instructions[0].content, "Work instructions\n");
  assert.equal(bundle.view.agent.scripts.items[0].scriptName, "find.js");
  assert.equal(f.holds(), 1);
  assert.equal(existsSync(path.join(f.root, "state", "runtime.sqlite")), false);
  f.session.release(prepared.ticket, true);
  assert.equal(f.holds(), 0);
  assert.equal(existsSync(path.join(f.root, prepared.ref)), true);
});

test("cancellation during preparation discards the eventual snapshot", async (t) => {
  const f = fixture(t);
  let resume;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  f.setReserve(async () => { entered(); await gate; });
  const preparation = f.session.prepare("slow", caller, { agentId: "agent" }, null, new AbortController().signal, f.workOptions);
  await waiting;
  f.session.release("slow", false);
  resume();
  await assert.rejects(preparation);
  assert.equal(f.holds(), 0);
  assert.equal(readdirSync(path.join(f.work, "tmp", "contexts")).length, 0);
});

test("rejected, cancelled and explicitly discarded snapshots do not persist", async (t) => {
  const f = fixture(t);
  f.session.release("cancel_early", false);
  await assert.rejects(f.session.prepare("cancel_early", caller, { agentId: "agent" }, null, new AbortController().signal, f.workOptions));
  f.setAllowed(false);
  await assert.rejects(f.session.prepare("denied", caller, { agentId: "agent" }, null, new AbortController().signal, f.workOptions));
  f.setAllowed(true);
  const prepared = await f.session.prepare("discard", caller, { agentId: "agent" }, null, new AbortController().signal, f.workOptions);
  f.session.release(prepared.ticket, false);
  assert.equal(existsSync(path.join(f.root, prepared.ref)), false);
  assert.equal(f.holds(), 0);
  assert.equal(readdirSync(path.join(f.work, "tmp", "contexts")).length, 0);
});

test("material RPC rejects missing authority and returns a real prepared snapshot", async (t) => {
  const f = fixture(t);
  const request = { instanceId: "host", ticket: "rpc_1", caller,
    context: { caller, connection: { agentId: "agent" }, authorization: {} },
    input: { agentId: "agent" }, previous: null, project: null, pwd: f.work, scriptUsage: [] };
  const unavailable = new MaterialRPC("host");
  await assert.rejects(unavailable.prepare(request, new AbortController().signal), { code: "materials_unavailable" });
  for (let i = 0; i < 1025; i++) {
    const ticket = `unavailable_${i}`;
    await assert.rejects(unavailable.prepare({ ...request, ticket }, new AbortController().signal));
    unavailable.release({ instanceId: "host", ticket, committed: false });
  }
  const rpc = new MaterialRPC("host", async () => ({ session: f.session, options: f.workOptions }));
  const result = await rpc.prepare(request, new AbortController().signal);
  assert.equal(result.ticket, "rpc_1");
  assert.ok(existsSync(path.join(f.root, result.ref)));
  assert.throws(() => rpc.release({ instanceId: "other", ticket: "rpc_1", committed: true }));
  rpc.release({ instanceId: "host", ticket: "rpc_1", committed: false });
  assert.equal(existsSync(path.join(f.root, result.ref)), false);
  rpc.close();
});

test("material RPC handles a cancellation before or during dependency preparation", async (t) => {
  const f = fixture(t);
  const request = { instanceId: "host", ticket: "rpc_2", caller,
    context: { caller, connection: { agentId: "agent" }, authorization: {} },
    input: { agentId: "agent" }, previous: null, project: null, pwd: f.work, scriptUsage: [] };
  let start;
  let resume;
  const entered = new Promise((resolve) => { start = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const rpc = new MaterialRPC("host", async () => {
    start();
    await gate;
    return { session: f.session, options: f.workOptions };
  });
  const pending = rpc.prepare(request, new AbortController().signal);
  await entered;
  rpc.release({ instanceId: "host", ticket: "rpc_2", committed: false });
  resume();
  await assert.rejects(pending);
  rpc.release({ instanceId: "host", ticket: "rpc_3", committed: false });
  await assert.rejects(rpc.prepare({ ...request, ticket: "rpc_3" }, new AbortController().signal));
  rpc.close();
});

test("material factory binds real services and checks the trusted Agent boot", async (t) => {
  const f = fixture(t);
  let materialReads = 0;
  const binding = { agentId: "agent", profile: "development", cloudEnvironment: "development" };
  const factory = createMaterialFactory({ root: f.root, binding, bootId: "boot", scripts: f.scripts,
    policy: { builtins: () => ["fs"], approvedPackages: () => new Map() },
    home: null, agent: f.workOptions.agent, reserve: f.workOptions.reserve,
    materialRetention: f.workOptions.materialRetention,
    authorize: (_request, caller, target) => f.workOptions.authorize(caller, target),
    materials: () => { materialReads++; return { instructions: [], skills: [] }; },
    canUseScript: () => true,
  });
  const callerContext = { caller, connection: { ...binding, bootId: "boot" }, authorization: {} };
  const request = { instanceId: "host", ticket: "factory_1", caller, context: callerContext,
    input: { agentId: "agent" }, previous: null, project: null, pwd: f.work, scriptUsage: [] };
  const rpc = new MaterialRPC("host", factory);
  const result = await rpc.prepare(request, new AbortController().signal);
  assert.ok(materialReads > 0);
  assert.equal(result.view.agent.scripts.items[0].scriptName, "find.js");
  rpc.release({ instanceId: "host", ticket: "factory_1", committed: false });
  await assert.rejects(rpc.prepare({ ...request, ticket: "factory_2", context: {
    ...callerContext, connection: { ...callerContext.connection, bootId: "wrong" },
  } }, new AbortController().signal), { code: "runtime_binding_mismatch" });
  rpc.close();
});

test("material factory rejects asynchronous or boolean authorization callbacks", async (t) => {
  const f = fixture(t);
  const binding = { agentId: "agent", profile: "development", cloudEnvironment: "development" };
  const request = { instanceId: "host", ticket: "unsafe_1", caller,
    context: { caller, connection: { ...binding, bootId: "boot" }, authorization: {} },
    input: { agentId: "agent" }, previous: null, project: null, pwd: f.work, scriptUsage: [] };
  for (const authorize of [async () => {}, () => true]) {
    const factory = createMaterialFactory({ root: f.root, binding, bootId: "boot", scripts: f.scripts,
      policy: { builtins: () => ["fs"], approvedPackages: () => new Map() },
      home: null, agent: f.workOptions.agent, reserve: f.workOptions.reserve,
      materialRetention: f.workOptions.materialRetention,
      authorize, materials: () => ({ instructions: [], skills: [] }), canUseScript: () => true,
    });
    const rpc = new MaterialRPC("host", factory);
    await assert.rejects(rpc.prepare(request, new AbortController().signal), { code: "authorization_configuration" });
    rpc.close();
  }
});

test("project materials preserve visibility selectors from the Go work scope", async (t) => {
  const f = fixture(t);
  const projectRoot = path.join(f.root, "project");
  mkdirSync(projectRoot);
  const instruction = path.join(projectRoot, "AGENTS.md");
  writeFileSync(instruction, "Project instructions\n");
  const binding = { agentId: "agent", profile: "development", cloudEnvironment: "development" };
  const factory = createMaterialFactory({ root: f.root, binding, bootId: "boot", scripts: f.scripts,
    policy: { builtins: () => ["fs"], approvedPackages: () => new Map() },
    home: null, agent: f.workOptions.agent, reserve: f.workOptions.reserve,
    materialRetention: f.workOptions.materialRetention,
    authorize: (_request, caller, target) => f.workOptions.authorize(caller, target),
    materials: () => ({ instructions: [], skills: [] }), canUseScript: () => true,
  });
  const rpc = new MaterialRPC("host", factory);
  const context = { caller, connection: { ...binding, bootId: "boot" }, authorization: { projectId: "p" } };
  const request = { instanceId: "host", ticket: "project_1", caller, context,
    input: { agentId: "agent", projectId: "p" }, previous: null,
    project: { projectId: "p", name: "Project", root: projectRoot, description: "",
      disabledItems: [{ kind: "instruction", key: selectorKey("instruction", instruction) }] },
    pwd: projectRoot, scriptUsage: [] };
  const result = await rpc.prepare(request, new AbortController().signal);
  assert.equal(result.view.project.root, projectRoot);
  assert.equal(result.view.project.instructions.length, 0);
  rpc.release({ instanceId: "host", ticket: "project_1", committed: false });
  rpc.close();
});
