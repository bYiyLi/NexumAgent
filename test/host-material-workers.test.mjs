import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MaterialWorkers } from "../dist/host/material-workers.js";
import { HostService } from "../dist/host/service.js";
import { prepareSourceMaterials } from "../dist/host/source-materials.js";

test("material Worker admits local source Skills only from their exact Go source snapshot", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-source-guidance-")));
  const work = root; mkdirSync(work, { recursive: true });
  const binding = { agentId: "agent", profile: "development", cloudEnvironment: "development" };
  const caller = { principalId: "user", clientId: "client" };
  const source = { kind: "mcp", objectId: "source_issues", name: "github", revision: "actual_revision",
    approvalRevision: "approved_revision", instanceId: "source_instance", methods: [{ id: "method_read", operation: "tools/read",
      metadata: { name: "tools/read", path: ["tool_read"], description: "Read fixture data.", normalizes: true,
        permissions: ["mcp.use"], schemaDialect: "2020-12", inputSchema: { type: "object" } } }] };
  const prepared = prepareSourceMaterials("host", { instanceId: "host", source, version: "1", description: "Fixture source." });
  const directory = path.join(work, "cache/materials/adapters/mcp/source/revision");
  for (const file of prepared.files) {
    const filename = path.join(directory, file.name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, file.content);
  }
  const skill = { skillId: "nexum/" + prepared.metadata.name, name: prepared.metadata.name,
    description: prepared.metadata.description, path: directory, skillFile: path.join(directory, "SKILL.md"),
    origin: prepared.origin, scope: { type: "agent", root: work } };
  let serial = 0;
  const call = async (method) => {
    if (method === "work.authorize") return { authorized: true };
    if (method === "work.canUseScript") return { allowed: false };
    if (method === "work.storage.reserve") return { reservation: `reservation_${++serial}` };
    if (method === "work.storage.release") return { released: true };
    if (method === "work.materials.hold") return { hold: `hold_${++serial}` };
    if (method === "work.materials.release") return { released: true };
    if (method === "work.materials.liveRefs") return { refs: [] };
    throw new Error(`unexpected ${method}`);
  };
  const workers = new MaterialWorkers(root, binding, "boot", "host", null,
    { name: "Agent", version: "1", protocolVersion: "2" }, call);
  t.after(async () => { await workers.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (ticket, current) => ({ instanceId: "host", ticket, caller,
    context: { caller, connection: { ...binding, bootId: "boot" }, authorization: {} },
    input: { agentId: "agent" }, previous: null, project: null, pwd: work, scriptUsage: [],
    sourceSnapshot: [{ source: current, materials: { instructions: [], skills: [skill], scriptSources: [],
      goSourceOrigins: [prepared.origin] } }] });
  const result = await workers.prepare(request("source_exact", source), new AbortController().signal);
  assert.ok(result.view.agent.skills.some((item) => item.skillId === skill.skillId));
  await workers.release({ instanceId: "host", ticket: "source_exact", committed: false });
  for (const [index, current] of [{ ...source, objectId: "another_source" }, { ...source, revision: "another_revision" },
    { ...source, approvalRevision: "" }].entries()) {
    await assert.rejects(workers.prepare(request(`source_wrong_${index}`, current), new AbortController().signal),
      { code: "invalid_material_source" });
  }
});

test("material Worker calls Go for live authority, quota and snapshot retention", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-material-worker-")));
  const work = root; mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "AGENTS.md"), "Worker instructions\n");
  const binding = { agentId: "agent", profile: "development", cloudEnvironment: "development" };
  const caller = { principalId: "user", clientId: "client" };
  const requests = [];
  const held = new Set();
  let serial = 0;
  const call = async (method, input) => {
    requests.push(method);
    assert.equal(input.instanceId, "host");
    assert.equal(input.ticket, "material_1");
    if (method === "work.authorize") return { authorized: true };
    if (method === "work.canUseScript") return { allowed: true };
    if (method === "work.storage.reserve") { const reservation = `res_${++serial}`; held.add(reservation); return { reservation }; }
    if (method === "work.storage.release") { assert.equal(held.delete(input.reservation), true); return { released: true }; }
    if (method === "work.materials.hold") { assert.ok(input.directory.startsWith(path.join(work, "tmp", "contexts"))); held.add("hold_1"); return { hold: "hold_1" }; }
    if (method === "work.materials.release") { assert.equal(held.delete(input.hold), true); return { released: true }; }
    if (method === "work.materials.liveRefs") return { refs: [] };
    throw new Error(`unexpected ${method}`);
  };
  const workers = new MaterialWorkers(root, binding, "boot", "host", null,
    { name: "Agent", version: "1", protocolVersion: "2" }, call);
  t.after(async () => { await workers.close(); rmSync(root, { recursive: true, force: true }); });
  const instruction = { instructionId: "platform:note", kind: "platform", path: null,
    scope: { type: "agent", root: work },
    origin: { type: "platform", owner: "nexum", namespace: "sh", version: "1", revision: "r1" },
    content: "Published platform instructions\n", truncated: false };
  const request = { instanceId: "host", ticket: "material_1", caller,
    context: { caller, connection: { ...binding, bootId: "boot" }, authorization: {} },
    input: { agentId: "agent" }, previous: null, project: null, pwd: work,
    scriptUsage: [], sourceSnapshot: [{ source: {}, materials: { instructions: [instruction], skills: [], scriptSources: [] } }] };
  const result = await workers.prepare(request, new AbortController().signal);
  assert.ok(result.view.agent.instructions.some((item) => item.content === "Worker instructions\n"));
  assert.ok(result.view.agent.instructions.some((item) => item.content === "Published platform instructions\n"));
  assert.equal(JSON.parse(readFileSync(path.join(root, result.ref), "utf8")).agentId, "agent");
  await workers.release({ instanceId: "host", ticket: "material_1", committed: false });
  assert.equal(existsSync(path.join(root, result.ref)), false);
  assert.equal(held.size, 0);
  assert.ok(requests.includes("work.authorize"));
  assert.ok(requests.includes("work.materials.hold"));
  assert.ok(requests.includes("work.materials.release"));
});

test("material release waits for an in-flight Go authorization and cleans the candidate", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-material-cancel-")));
  const work = root; mkdirSync(work, { recursive: true });
  const binding = { agentId: "agent", profile: "development", cloudEnvironment: "development" };
  const caller = { principalId: "user", clientId: "client" };
  const seen = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const held = new Set();
  let serial = 0;
  const call = async (method, input) => {
    if (method === "work.authorize") { seen.resolve(); await gate.promise; return { authorized: true }; }
    if (method === "work.canUseScript") return { allowed: true };
    if (method === "work.storage.reserve") { const reservation = `res_${++serial}`; held.add(reservation); return { reservation }; }
    if (method === "work.storage.release") { held.delete(input.reservation); return { released: true }; }
    if (method === "work.materials.hold") { held.add("hold"); return { hold: "hold" }; }
    if (method === "work.materials.release") { held.delete(input.hold); return { released: true }; }
    if (method === "work.materials.liveRefs") return { refs: [] };
    throw new Error(`unexpected ${method}`);
  };
  const workers = new MaterialWorkers(root, binding, "boot", "host", null,
    { name: "Agent", version: "1", protocolVersion: "2" }, call);
  t.after(async () => { gate.resolve(); await workers.close(); rmSync(root, { recursive: true, force: true }); });
  const request = { instanceId: "host", ticket: "material_2", caller,
    context: { caller, connection: { ...binding, bootId: "boot" }, authorization: {} },
    input: { agentId: "agent" }, previous: null, project: null, pwd: work,
    scriptUsage: [], sourceSnapshot: [] };
  const pending = workers.prepare(request, new AbortController().signal);
  void pending.catch(() => {});
  await seen.promise;
  const release = workers.release({ instanceId: "host", ticket: "material_2", committed: false });
  gate.resolve();
  await release;
  await assert.rejects(pending);
  assert.equal(held.size, 0);
});

test("HostService exposes material Worker only with actual Agent metadata", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-material-host-service-")));
  const work = root; mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "AGENTS.md"), "Agent instructions\n");
  const binding = { agentId: "agent", profile: "development", cloudEnvironment: "development" };
  const caller = { principalId: "user", clientId: "client" };
  const held = new Set(); let serial = 0;
  const call = async (method, input) => {
    if (method === "work.authorize") return { authorized: true };
    if (method === "work.canUseScript") return { allowed: true };
    if (method === "work.storage.reserve") { const reservation = `res_${++serial}`; held.add(reservation); return { reservation }; }
    if (method === "work.storage.release") { assert.equal(held.delete(input.reservation), true); return { released: true }; }
    if (method === "work.materials.hold") { held.add("hold"); return { hold: "hold" }; }
    if (method === "work.materials.release") { assert.equal(held.delete(input.hold), true); return { released: true }; }
    if (method === "work.materials.liveRefs") return { refs: [] };
    throw new Error(`unexpected ${method}`);
  };
  const withoutMetadata = new HostService("host", call);
  const host = new HostService("host", call);
  t.after(async () => { await Promise.all([withoutMetadata.close(), host.close()]); rmSync(root, { recursive: true, force: true }); });
  await withoutMetadata.configure({ instanceId: "host", profileRoot: root, profile: "development", binding, bootId: "boot" });
  const context = { caller, connection: { ...binding, bootId: "boot" }, authorization: {} };
  const request = { instanceId: "host", ticket: "host_material", caller, context,
    input: { agentId: "agent" }, previous: null, project: null, pwd: work, scriptUsage: [], sourceSnapshot: [] };
  await assert.rejects(withoutMetadata.prepareMaterials(request, new AbortController().signal), { code: "materials_unavailable" });
  await host.configure({ instanceId: "host", profileRoot: root, profile: "development", binding,
    bootId: "boot", home: null, agent: { name: "Agent", version: "1", protocolVersion: "2" } });
  const result = await host.prepareMaterials(request, new AbortController().signal);
  assert.equal(result.view.agent.instructions[0].content, "Agent instructions\n");
  await host.releaseMaterials({ instanceId: "host", ticket: "host_material", committed: false });
  assert.equal(existsSync(path.join(root, result.ref)), false);
  assert.equal(held.size, 0);
});

test("material Worker shutdown reports an unconfirmed Go hold release", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-material-close-")));
  const work = root; mkdirSync(work, { recursive: true });
  const binding = { agentId: "agent", profile: "development", cloudEnvironment: "development" };
  const caller = { principalId: "user", clientId: "client" };
  let serial = 0;
  const call = async (method) => {
    if (method === "work.authorize") return { authorized: true };
    if (method === "work.canUseScript") return { allowed: true };
    if (method === "work.storage.reserve") return { reservation: `res_${++serial}` };
    if (method === "work.storage.release") return { released: true };
    if (method === "work.materials.hold") return { hold: "hold" };
    if (method === "work.materials.release") throw new Error("Go release failed");
    if (method === "work.materials.liveRefs") return { refs: [] };
    throw new Error(`unexpected ${method}`);
  };
  const workers = new MaterialWorkers(root, binding, "boot", "host", null,
    { name: "Agent", version: "1", protocolVersion: "2" }, call);
  t.after(async () => { await workers.close(); rmSync(root, { recursive: true, force: true }); });
  const request = { instanceId: "host", ticket: "material_3", caller,
    context: { caller, connection: { ...binding, bootId: "boot" }, authorization: {} },
    input: { agentId: "agent" }, previous: null, project: null, pwd: work,
    scriptUsage: [], sourceSnapshot: [] };
  await workers.prepare(request, new AbortController().signal);
  await assert.rejects(workers.close(), { name: "AggregateError" });
});
