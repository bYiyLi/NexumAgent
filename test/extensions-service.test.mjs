import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { ExtensionServices } from "../dist/services/extensions.js";
import { ExtensionPackageLoader } from "../dist/extensions/package-loader.js";
import { ExtensionMaterials } from "../dist/extensions/materials.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine } from "../dist/runtime/engine.js";
import { DocumentCatalog } from "../dist/work/catalog.js";
import { WorkService } from "../dist/work/service.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { AgentError } from "../dist/contracts/errors.js";
import { canonicalJson } from "../dist/contracts/json.js";

const caller = {
  principalId: "user",
  clientId: "client",
  host: "fixture-host",
};
function write(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(
    filename,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
function box() {
  return {
    evaluations: 0,
    factories: 0,
    disposals: 0,
    calls: 0,
    hosts: [],
    resources: [],
    factoryEntered: Promise.withResolvers(),
    materialsEntered: Promise.withResolvers(),
    disposeEntered: Promise.withResolvers(),
    disposeDone: Promise.withResolvers(),
  };
}
function entered(marker, operation) {
  return Promise.race([
    marker.promise,
    operation.then(() => {
      throw new Error("The operation finished before the controlled phase.");
    }),
  ]);
}
async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-extension-service-")),
  );
  const work = path.join(root, "work"),
    key = `nexum-service:${randomUUID()}`;
  const controls = { alpha: box(), beta: box() },
    packages = {};
  globalThis[Symbol.for(key)] = controls;
  for (const tag of ["alpha", "beta"]) {
    const name = `@fixture/${tag}`,
      namespace = `${tag}SDK`,
      directory = path.join(work, "node_modules", "@fixture", tag);
    packages[tag] = { name, namespace, directory, control: controls[tag] };
    write(path.join(directory, "package.json"), {
      name,
      version: "1.0.0",
      type: "module",
      exports: {
        "./nexum": { types: "./extension.d.ts", import: "./extension.js" },
      },
      nexum: {
        apiVersion: 1,
        namespace,
        permissions: ["read"],
        docs: "./manual",
        instructions: "./rules.md",
        scripts: "./flows",
        skills: "./skills",
      },
    });
    write(
      path.join(directory, "extension.d.ts"),
      "export default function createExtension(host:unknown):unknown;\n",
    );
    write(
      path.join(directory, "manual/README.md"),
      `# ${namespace} authored guide\n[details](guide.md)\n`,
    );
    write(
      path.join(directory, "manual/guide.md"),
      `# ${namespace} details\nUse the actual SDK.\n`,
    );
    write(
      path.join(directory, "rules.md"),
      `# ${namespace} rules\nFollow this extension's rules.\n`,
    );
    write(
      path.join(directory, "skills/audit/SKILL.md"),
      `---\nname: audit\ndescription: Audit using ${namespace}.\n---\nRead references/check.txt.\n`,
    );
    write(
      path.join(directory, "skills/audit/references/check.txt"),
      `${namespace} retained reference`,
    );
    write(
      path.join(directory, "flows/report.js"),
      "/**\n" +
        JSON.stringify({
          scriptName: "report.js",
          scriptDesc: "Run the extension report",
          scriptWhenUse: "When a report is needed",
          scriptOpenDefault: true,
          scriptInputSchema: {
            type: "object",
            properties: {
              value: { type: "integer" },
              wait: { type: "boolean" },
            },
            required: ["value"],
            additionalProperties: false,
          },
        }) +
        `\n*/\nif(context.input.wait) await runtime.requestInput({message:"continue",inputSchema:{type:"null"}});\nreturn ${namespace}.echo({value:context.input.value});\n`,
    );
    write(
      path.join(directory, "extension.js"),
      `
const control=globalThis[Symbol.for(${JSON.stringify(key)})][${JSON.stringify(tag)}];
control.evaluations++;
export default async function createExtension(host){
  control.factories++;control.hosts.push(host);control.factoryEntered.resolve();
  if(control.factoryGate)await control.factoryGate.promise;
  if(control.hostResource){const closed=Promise.withResolvers();const ref=await host.resources.register({kind:'fixture.connection',value:{closed:closed.promise,dispose(){if(!control.holdHostClose||control.cleanup)closed.resolve();}}});control.resources.push({ref,closed});}
  if(control.factoryFailure)throw new Error('factory failed after registration');
  const object={type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false};
  return {methods:{
    echo:{description:'Echo validated input and actual caller',permissions:['read'],schemaDialect:'draft7',inputSchema:object,handle(input,call){control.calls++;return {value:input.value,caller:call.context.caller,endpoint:host.config.endpoint??null,instance:control.factories};}},
    open:{description:'Start a managed background session',permissions:['read'],schemaDialect:'draft7',inputSchema:{type:'object',additionalProperties:false},async handle(_input,call){const closed=Promise.withResolvers();const ref=await call.resources.register({kind:'fixture.session',value:{closed:closed.promise,dispose(){closed.resolve();}}});control.resources.push({ref,closed});await call.resources.handoff(ref.id);return {resourceId:ref.id};}},
    close:{description:'Close the original managed session',permissions:['read'],schemaDialect:'draft7',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},async handle(input,call){const ref=await call.resources.get(input.id);ref.value.dispose();await ref.value.closed;return {closed:true};}}
  },async dispose(){control.disposals++;control.disposeEntered.resolve();control.onDispose?.();if(control.disposeGate)await control.disposeGate.promise;if(control.disposeFailure&&!control.cleanup)throw new Error('dispose failed');control.disposeDone.resolve();}};
}
`,
    );
  }
  write(path.join(work, "package.json"), {
    type: "module",
    dependencies: Object.fromEntries(
      Object.values(packages).map((pkg) => [pkg.name, "1.0.0"]),
    ),
  });
  const approved = new Map(
    Object.values(packages).map((pkg) => [pkg.name, "1.0.0"]),
  );
  const enabled = new Set(approved.keys()),
    permissions = new Set(["read"]);
  const policy = { builtins: () => [], approvedPackages: () => approved };
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 25 }),
    policies = [];
  let allowed = true;
  const registry = new ExtensionRegistry(resources, {
    permissions,
    cleanupTimeoutMs: 25,
    authorize(value) {
      policies.push(value);
      if (!allowed && value.action !== "disable")
        throw new AgentError("forbidden", "Current permission was revoked.");
    },
    log() {},
    progress() {},
  });
  const modules = await ModuleLoader.create(work, store.bootId, policy);
  const loader = new ExtensionPackageLoader(registry, modules, {
    policy,
    permissions,
    enabled: () => enabled,
  });
  const materials = new ExtensionMaterials(work, options.materialLimits);
  const prepareMaterials = materials.prepare.bind(materials);
  materials.prepare = async (...args) => {
    const prepared = await prepareMaterials(...args);
    const control = Object.values(packages).find(
      (pkg) => pkg.name === args[0].packageName,
    ).control;
    control.materialsEntered.resolve(prepared);
    if (control.materialsGate) await control.materialsGate.promise;
    return prepared;
  };
  const services = new ExtensionServices(registry, loader, materials);
  const scripts = new ScriptCatalog(work, "agent", () =>
    materials.scriptSources(),
  );
  const catalog = new DocumentCatalog(work, scripts, policy);
  const refresh = catalog.refresh.bind(catalog);
  let catalogPause;
  const catalogPauses = [];
  catalog.refresh = async (...args) => {
    const pause = catalogPause;
    catalogPause = undefined;
    if (pause) {
      pause.entered.resolve();
      await pause.release.promise;
    }
    return refresh(...args);
  };
  const authorizeCaller = (who) => {
    if (
      who.principalId !== caller.principalId ||
      who.clientId !== caller.clientId
    )
      throw new AgentError("forbidden", "Wrong caller.");
  };
  const workService = new WorkService(store, scripts, catalog, {
    home: null,
    agent: {
      name: "Fixture Agent",
      version: "1",
      protocolVersion: "2",
      extensionApiVersion: "1",
    },
    authorize: authorizeCaller,
    async resolveProject() {
      throw new Error("Agent-only fixture has no Project");
    },
    materials: () => materials.published(),
  });
  const engine = new RunEngine(store, modules, scripts, {
    authorize: authorizeCaller,
    loadWork: (record) => workService.load(record),
    resources,
    leaseScript: (origin) =>
      origin.type === "extension" ? registry.lease(origin) : () => {},
    bindings: (current) => ({
      ...registry.bindings(current),
      runtime: { requestInput: current.requestInput },
    }),
    encodeResult: async (value) => ({
      content: [],
      data: value === undefined ? null : JSON.parse(canonicalJson(value)),
    }),
  });
  const pending = new Set(),
    runIds = new Set();
  const track = (promise) => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const open = () => workService.open(caller, { agentId: "agent" });
  const start = async (input) => {
    const context = await open();
    const accepted = await engine.start(caller, {
      contextId: context.contextId,
      ...input,
    });
    runIds.add(accepted.run.runId);
    return accepted;
  };
  const execute = async (script) => {
    const accepted = await start({ script, waitMs: 0 });
    return engine.observe(caller, accepted.run.runId, 30000);
  };
  t.after(async () => {
    allowed = true;
    for (const pause of catalogPauses) pause.release.resolve();
    for (const control of Object.values(controls)) {
      control.cleanup = true;
      control.factoryGate?.resolve();
      control.materialsGate?.resolve();
      control.disposeGate?.resolve();
      for (const item of control.resources) item.closed.resolve();
    }
    while (pending.size) await Promise.allSettled([...pending]);
    for (const id of runIds)
      if (store.getRun(id).endedAt === null) engine.cancel(caller, id);
    await Promise.allSettled(
      [...runIds].map((id) => engine.observe(caller, id, 30000)),
    );
    for (const item of services.list())
      await services.disable(item.name).catch(() => {});
    await workService.drain();
    await tick();
    delete globalThis[Symbol.for(key)];
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    packages,
    controls,
    approved,
    enabled,
    policies,
    store,
    resources,
    registry,
    loader,
    materials,
    services,
    scripts,
    catalog,
    workService,
    engine,
    open,
    start,
    execute,
    enable: (...args) => track(services.enable(...args)),
    disable: (...args) => track(services.disable(...args)),
    pauseCatalog() {
      const value = {
        entered: Promise.withResolvers(),
        release: Promise.withResolvers(),
      };
      catalogPause = value;
      catalogPauses.push(value);
      return value;
    },
    revoke() {
      allowed = false;
    },
    grant() {
      allowed = true;
    },
  };
}

function snapshot(view, pkg, present) {
  assert.equal(
    view.agent.instructions.some(
      (item) => item.instructionId === `${pkg.namespace}/instructions`,
    ),
    present,
  );
  assert.equal(
    view.agent.skills.some((item) => item.skillId === `${pkg.namespace}/audit`),
    present,
  );
  assert.equal(
    view.agent.scripts.items.some(
      (item) => item.scriptName === `${pkg.namespace}/report.js`,
    ),
    present,
  );
  assert.equal(
    view.agent.docs.content.includes(`[${pkg.namespace}](<`),
    present,
  );
}
async function visible(f, pkg, present) {
  snapshot(await f.open(), pkg, present);
  const result = await f.execute(`return typeof ${pkg.namespace};`);
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.result.data, present ? "object" : "undefined");
}

test("all five contributions publish together, equivalent concurrent enables share one action, and an in-flight open keeps its old generation", async (t) => {
  const f = await fixture(t),
    pkg = f.packages.alpha,
    control = pkg.control;
  const pause = f.pauseCatalog(),
    oldOpen = f.open();
  await entered(pause.entered, oldOpen);
  control.factoryGate = Promise.withResolvers();
  const first = f.enable(pkg.name, { endpoint: "approved", mode: 1 }),
    same = f.enable(pkg.name, { mode: 1, endpoint: "approved" });
  assert.equal(first, same);
  await entered(control.factoryEntered, first);
  assert.equal(control.evaluations, 1);
  assert.equal(control.factories, 1);
  assert.throws(() => f.enable(pkg.name, { endpoint: "other" }), {
    code: "extension_busy",
  });
  assert.throws(() => f.disable(pkg.name), { code: "extension_busy" });
  await visible(f, pkg, false);
  control.factoryGate.resolve();
  const enabled = await first;
  assert.equal((await same).extensionId, enabled.extensionId);
  assert.equal(enabled.status, "enabled");
  pause.release.resolve();
  snapshot(await oldOpen, pkg, false);
  await visible(f, pkg, true);
  const report = await f.execute(`return ${pkg.namespace}.echo({value:7});`);
  assert.equal(report.run.status, "succeeded");
  assert.equal(report.result.data.value, 7);
  assert.match(readFileSync(enabled.docs, "utf8"), /方法与脚本/);
  assert.equal(control.factories, 1);
});

test("failed native initialization retains its real unfinished cleanup owner for explicit disable even after package revocation", async (t) => {
  const f = await fixture(t),
    good = f.packages.beta,
    bad = f.packages.alpha;
  await f.enable(good.name);
  bad.control.hostResource = true;
  bad.control.holdHostClose = true;
  bad.control.factoryFailure = true;
  await assert.rejects(f.enable(bad.name), {
    code: "extension_initialization_failed",
  });
  assert.equal(bad.control.resources.length, 1);
  assert.equal(
    f.store.getResource(bad.control.resources[0].ref.id).closedAt,
    null,
  );
  assert.ok(
    f.services.get(bad.name),
    "the actual cleanup owner must remain reachable",
  );
  assert.notEqual(f.services.get(bad.name).status, "enabled");
  await visible(f, bad, false);
  await visible(f, good, true);
  const unaffected = await f.execute(
    `return ${good.namespace}.echo({value:19});`,
  );
  assert.equal(unaffected.run.status, "succeeded");
  assert.equal(unaffected.result.data.value, 19);
  f.enabled.delete(bad.name);
  f.approved.delete(bad.name);
  bad.control.resources[0].closed.resolve();
  await tick();
  assert.equal((await f.disable(bad.name)).status, "disabled");
  assert.equal(f.services.get(bad.name), null);
  assert.equal(bad.control.factories, 1);
  await visible(f, good, true);
});

test("real material preparation failure publishes no fragments and explicit cleanup retry leaves another package intact", async (t) => {
  const f = await fixture(t, { materialLimits: { maxBytes: 65536 } }),
    good = f.packages.beta,
    bad = f.packages.alpha;
  await f.enable(good.name);
  write(path.join(bad.directory, "manual/guide.md"), "x".repeat(70000));
  bad.control.disposeFailure = true;
  await assert.rejects(f.enable(bad.name), (error) => {
    assert.equal(error.code, "extension_publication_failed");
    assert.equal(error.cause.code, "extension_material_too_large");
    assert.equal(error.details.cleanup.status, "stopping");
    return true;
  });
  assert.equal(f.services.get(bad.name).status, "stopping");
  await visible(f, bad, false);
  await visible(f, good, true);
  const unaffected = await f.execute(
    `return ${good.namespace}.echo({value:23});`,
  );
  assert.equal(unaffected.run.status, "succeeded");
  assert.equal(unaffected.result.data.value, 23);
  bad.control.disposeFailure = false;
  assert.equal((await f.disable(bad.name)).status, "disabled");
  assert.equal(bad.control.disposals, 2);
  assert.equal(f.services.get(bad.name), null);
  await visible(f, good, true);
});

test("a real named-script lease and a handed-off business resource independently refuse disable without withdrawing contributions", async (t) => {
  const f = await fixture(t),
    pkg = f.packages.alpha;
  await f.enable(pkg.name);
  const waiting = await f.start({
    scriptName: `${pkg.namespace}/report.js`,
    input: { value: 3, wait: true },
    waitMs: 30000,
  });
  assert.equal(waiting.run.status, "waiting_input");
  await assert.rejects(f.disable(pkg.name), { code: "extension_busy" });
  await visible(f, pkg, true);
  const done = await f.engine.input(caller, {
    agentId: "agent",
    runId: waiting.run.runId,
    waitId: waiting.wait.waitId,
    input: null,
    waitMs: 30000,
  });
  assert.equal(done.run.status, "succeeded");
  const opened = await f.execute(`return await ${pkg.namespace}.open();`);
  assert.equal(opened.run.status, "succeeded");
  const id = opened.result.data.resourceId;
  assert.equal(f.store.getResource(id).lifetime, "background");
  await assert.rejects(f.disable(pkg.name), { code: "extension_busy" });
  await visible(f, pkg, true);
  assert.equal(
    (
      await f.execute(
        `return await ${pkg.namespace}.close({id:${JSON.stringify(id)}});`,
      )
    ).run.status,
    "succeeded",
  );
  assert.notEqual(f.store.getResource(id).closedAt, null);
  assert.equal((await f.disable(pkg.name)).status, "disabled");
});

test("accepted disable withdraws all five before disposal while old open and reading snapshots remain whole", async (t) => {
  const f = await fixture(t),
    pkg = f.packages.alpha,
    control = pkg.control;
  const enabled = await f.enable(pkg.name);
  const old = await f.open(),
    skill = old.agent.skills.find(
      (item) => item.skillId === `${pkg.namespace}/audit`,
    );
  const oldDoc = readFileSync(enabled.docs, "utf8");
  const pause = f.pauseCatalog(),
    opening = f.open();
  await entered(pause.entered, opening);
  control.disposeGate = Promise.withResolvers();
  control.onDispose = () => {
    control.observed = f.materials
      .published()
      .skills.some((item) => item.skillId === skill.skillId);
  };
  const stopping = f.disable(pkg.name),
    same = f.disable(pkg.name);
  assert.equal(stopping, same);
  await entered(control.disposeEntered, stopping);
  assert.equal(control.observed, false);
  assert.throws(() => f.enable(pkg.name), { code: "extension_busy" });
  assert.equal((await stopping).status, "stopping");
  pause.release.resolve();
  snapshot(await opening, pkg, true);
  await visible(f, pkg, false);
  assert.equal(readFileSync(enabled.docs, "utf8"), oldDoc);
  assert.equal(
    (
      await f.workService.readMaterial(
        caller,
        old.contextId,
        skill.skillId,
        "references/check.txt",
      )
    ).bytes.toString(),
    `${pkg.namespace} retained reference`,
  );
  assert.match(
    (
      await f.workService.readMaterial(
        caller,
        old.contextId,
        `${pkg.namespace}/instructions`,
      )
    ).bytes.toString(),
    /extension's rules/,
  );
  control.disposeGate.resolve();
  await control.disposeDone.promise;
  assert.equal((await f.disable(pkg.name)).status, "disabled");
  assert.equal(f.services.get(pkg.name), null);
});

test("same-revision reenable creates a fresh instance and restores all contributions without re-evaluating native top level", async (t) => {
  const f = await fixture(t),
    pkg = f.packages.alpha;
  const first = await f.enable(pkg.name, { endpoint: "approved" });
  await assert.rejects(f.enable(pkg.name, { endpoint: "changed" }), {
    code: "extension_configuration_changed",
  });
  assert.equal(f.services.get(pkg.name).extensionId, first.extensionId);
  assert.equal(pkg.control.factories, 1);
  assert.equal((await f.disable(pkg.name)).status, "disabled");
  const second = await f.enable(pkg.name, { endpoint: "approved" });
  assert.notEqual(second.extensionId, first.extensionId);
  assert.equal(second.origin.revision, first.origin.revision);
  assert.equal(second.docs, first.docs);
  assert.equal(pkg.control.evaluations, 1);
  assert.equal(pkg.control.factories, 2);
  assert.equal(pkg.control.disposals, 1);
  await visible(f, pkg, true);
  const result = await f.execute(`return ${pkg.namespace}.echo({value:2});`);
  assert.equal(result.result.data.instance, 2);
});

test("source changes and enable or approval revocation after real material preparation prevent final publication", async (t) => {
  for (const scenario of ["source", "enabled", "approved"])
    await t.test(scenario, async (t) => {
      const f = await fixture(t),
        pkg = f.packages.alpha,
        control = pkg.control;
      control.materialsGate = Promise.withResolvers();
      const pending = f.enable(pkg.name);
      const prepared = await entered(control.materialsEntered, pending);
      assert.equal(
        readFileSync(prepared.entry, "utf8").includes(pkg.namespace),
        true,
      );
      if (scenario === "source")
        write(
          path.join(pkg.directory, "manual/guide.md"),
          "# Changed after snapshot\n",
        );
      if (scenario === "enabled") f.enabled.delete(pkg.name);
      if (scenario === "approved") f.approved.delete(pkg.name);
      control.materialsGate.resolve();
      await assert.rejects(pending, { code: "extension_publication_failed" });
      await visible(f, pkg, false);
      assert.equal(f.services.get(pkg.name), null);
      assert.equal(control.evaluations, 1);
      assert.equal(control.factories, 1);
      assert.equal(control.disposals, 1);
    });
});

test("the coordinated native factory preserves method schemas, fixed caller identity and current host authority", async (t) => {
  const f = await fixture(t),
    pkg = f.packages.alpha;
  await f.enable(pkg.name, { endpoint: "approved" });
  const result = await f.execute(`return ${pkg.namespace}.echo({value:11});`);
  assert.deepEqual(result.result.data.caller, caller);
  assert.equal(result.result.data.endpoint, "approved");
  const calls = pkg.control.calls;
  const invalid = await f.execute(
    `try{${pkg.namespace}.echo({value:"bad"});}catch(e){return e.code;}`,
  );
  assert.equal(invalid.result.data, "invalid_arguments");
  assert.equal(pkg.control.calls, calls);
  const context = await f.open();
  await assert.rejects(
    f.engine.start(
      { ...caller, principalId: "other" },
      {
        contextId: context.contextId,
        script: `return ${pkg.namespace}.echo({value:1});`,
        waitMs: 0,
      },
    ),
    { code: "forbidden" },
  );
  const host = pkg.control.hosts[0],
    target = { type: "path", value: f.work, access: "read" };
  assert.equal(host.context.runId, undefined);
  assert.equal(host.context.caller, undefined);
  host.authorize(target);
  assert(
    f.policies.some(
      (item) =>
        item.origin.namespace === pkg.namespace &&
        item.target?.value === f.work &&
        item.runId === undefined,
    ),
  );
  f.revoke();
  assert.throws(() => host.authorize(target), { code: "forbidden" });
  const denied = await f.execute(
    `try{${pkg.namespace}.echo({value:1});}catch(e){return e.code;}`,
  );
  assert.equal(denied.result.data, "forbidden");
  f.grant();
  await f.disable(pkg.name);
  assert.throws(() => host.authorize(target), {
    code: "extension_unavailable",
  });
});
