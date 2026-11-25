import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isolatedExtensionFactory, isolatedHandlerNormalizes } from "../dist/extensions/worker-bridge.js";
import { AgentError } from "../dist/contracts/errors.js";

async function fixture(t, source, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexum-extension-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = path.join(dir, "extension.mjs");
  await writeFile(entry, source);
  const abort = new AbortController();
  const events = [];
  const host = {
    context: { agentId: "test", paths: { work: dir } },
    config: {},
    signal: abort.signal,
    resources: {},
    storage: {},
    authorize() {},
    log() {},
  };
  const factory = isolatedExtensionFactory(pathToFileURL(entry).href, {
    onEvent: (phase, code) => events.push({ phase, code }),
    ...options,
  });
  return { dir, host, abort, factory, events };
}

test("revoking approval during native top-level import blocks the factory before effects", {
  timeout: 15000,
}, async (t) => {
  const markerDir = await mkdtemp(path.join(tmpdir(), "nexum-import-gate-"));
  t.after(() => rm(markerDir, { recursive: true, force: true }));
  const marker = path.join(markerDir, "factory-executed");
  let permitted = true;
  let checks = 0;
  const f = await fixture(t, [
    'import { writeFileSync } from "node:fs";',
    "await new Promise((resolve) => setTimeout(resolve, 120));",
    "export default function () {",
    "  writeFileSync(" + JSON.stringify(marker) + ', "executed");',
    "  return { methods: {} };",
    "}",
  ].join("\n"), {
    async verifyAfterImport() {
      checks++;
      if (!permitted)
        throw new AgentError("extension_not_enabled",
          "The previously approved package is no longer enabled.");
    },
  });
  const pending = f.factory(f.host);
  // The Worker must not run the factory even though it was permitted before
  // the top-level await; the real Core decision occurs after import returns.
  setTimeout(() => { permitted = false; }, 35);
  await assert.rejects(pending, { code: "extension_not_enabled" });
  assert.equal(checks, 1);
  assert.equal(existsSync(marker), false,
    "a revoked extension may not execute any factory effects");
  assert.ok(f.events.some((event) => event.phase === "import_denied"));
});

function invocation(signal = new AbortController().signal) {
  return {
    signal,
    context: { runId: "run_fixture", pwd: "/tmp" },
    operationId: "op_fixture",
    deadline: Date.now() + 10000,
    resources: {},
    storage: {},
    output: {},
    authorize() {},
    log() {},
    progress() {},
  };
}

test("extension normalizers cannot weaken the original Core Schema gate", {
  timeout: 15000,
}, async (t) => {
  const markerDir = await mkdtemp(path.join(tmpdir(), "nexum-core-gate-"));
  t.after(() => rm(markerDir, { recursive: true, force: true }));
  const marker = path.join(markerDir, "executed");
  const source = [
    'import { writeFileSync } from "node:fs";',
    "const method = {",
    '  description: "Validated method", permissions: [], schemaDialect: "draft7",',
    '  inputSchema: { type: "object",',
    '    properties: { value: { type: "integer" } },',
    '    required: ["value"], additionalProperties: false },',
    "  normalize(args) { return args[0]; },",
    "  handle(input) {",
    "    writeFileSync(" + JSON.stringify(marker) + ", String(input.value));",
    "    return { value: input.value };",
    "  },",
    "};",
    "export default function () {",
    "  setTimeout(() => { method.inputSchema = { type: 'object' }; }, 35);",
    "  return { methods: { inspect: method } };",
    "}",
  ].join("\n");
  const f = await fixture(t, source);
  const instance = await f.factory(f.host);
  try {
    assert.equal(isolatedHandlerNormalizes(instance.methods.inspect.handle), true);
    await new Promise((resolve) => setTimeout(resolve, 90));
    await assert.rejects(
      instance.methods.inspect.handle({
        __nexumWorkerArgs: [{ value: "not-an-integer" }],
      }, invocation()),
    );
    assert.equal(existsSync(marker), false,
      "a Worker changing its Schema must not bypass Core validation");
    const valid = await instance.methods.inspect.handle({
      __nexumWorkerArgs: [{ value: 7 }],
    }, invocation());
    assert.equal(valid.value, 7);
    assert.equal(await readFile(marker, "utf8"), "7");
  } finally {
    await instance.dispose();
  }
});

test("Worker resources report with their registered owner across invocation lifetimes", {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t, [
    "let service, run;",
    "export default async function (host) {",
    "  const stopped = Promise.withResolvers();",
    "  service = await host.resources.register({kind:'browser-service', value:{",
    "    closed: stopped.promise, dispose(){stopped.resolve()}",
    "  }});",
    "  service.report({state:'listening'});",
    "  return {methods:{",
    "    begin:{description:'Begin',permissions:[],schemaDialect:'draft7',",
    "      inputSchema:{type:'object'},async handle(input,call){",
    "        const done=Promise.withResolvers();",
    "        run=await call.resources.register({kind:'browser.run',value:{",
    "          closed:done.promise,dispose(){",
    "            run.report({state:'physically_closed'});done.resolve()",
    "          }",
    "        }});",
    "        run.report({state:'controlling'});",
    "        return {id:run.id};",
    "      }",
    "    },",
    "    finish:{description:'Finish',permissions:[],schemaDialect:'draft7',",
    "      inputSchema:{type:'object'},handle(){",
    "        run.report({state:'closed'});",
    "        service.report({state:'healthy'});",
    "        return {ok:true};",
    "      }",
    "    },",
    "    borrow:{description:'Borrow',permissions:[],schemaDialect:'draft7',",
    "      inputSchema:{type:'object'},async handle(input,call){",
    "        try { await call.resources.get(service.id); return {allowed:true}; }",
    "        catch(error){return {code:error.code}}",
    "      }",
    "    }",
    "  }};",
    "}",
  ].join("\n"));
  const reports = [], registered = [];
  const register = (owner) => async ({ kind, value }) => {
    registered.push({ owner, kind, value });
    return {
      id: `res_${owner}`, kind, value,
      signal: new AbortController().signal,
      report(details) { reports.push({ owner, kind, ...details }); },
    };
  };
  f.host.resources = { register: register("host") };
  const first = invocation();
  first.resources = { register: register("call") };
  const instance = await f.factory(f.host);
  try {
    const started = await instance.methods.begin.handle({
      __nexumWorkerArgs: [{}],
    }, first);
    assert.equal(started.id, "res_call");
    const ended = await instance.methods.finish.handle({
      __nexumWorkerArgs: [{}],
    }, invocation());
    assert.equal(ended.ok, true);
    const borrow = await instance.methods.borrow.handle({
      __nexumWorkerArgs: [{}],
    }, invocation());
    assert.equal(borrow.code, "extension_worker_resource_unavailable",
      "the fix must not permit a call to borrow a host-owned controller");
    assert.deepEqual(reports, [
      { owner: "host", kind: "browser-service", state: "listening" },
      { owner: "call", kind: "browser.run", state: "controlling" },
      { owner: "call", kind: "browser.run", state: "closed" },
      { owner: "host", kind: "browser-service", state: "healthy" },
    ]);
    const coreRun = registered.find((r) => r.kind === "browser.run");
    assert.ok(coreRun, "the original Core must hold the run-owned resource");
    await coreRun.value.dispose();
    await coreRun.value.closed;
    assert.deepEqual(reports.at(-1), {
      owner: "call", kind: "browser.run", state: "physically_closed",
    }, "the Worker must report physical cleanup after its creating call ends");
  } finally {
    await instance.dispose();
  }
});

test("cancelled extension initialization terminates a hanging Worker promptly", {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t,
    "export default async function(){await new Promise(()=>{})}");
  const pending = f.factory(f.host);
  setTimeout(() => f.abort.abort(), 40);
  const started = performance.now();
  await assert.rejects(pending, { code: "extension_worker_aborted" });
  assert.ok(performance.now() - started < 2000);
  assert.ok(f.events.some((e) =>
    e.phase === "failed" && e.code === "extension_worker_aborted"));
});

test("crashing an extension method does not exit the Core process", {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t, [
    "export default function () {",
    "  return { methods: { crash: {",
    '    description: "Crash only this Worker", permissions: [], schemaDialect: "draft7",',
    '    inputSchema: { type: "object" },',
    "    handle() { process.exit(13); },",
    "  } } };",
    "}",
  ].join("\n"));
  const instance = await f.factory(f.host);
  await assert.rejects(
    instance.methods.crash.handle({ __nexumWorkerArgs: [{}] },
      invocation()),
    { code: "extension_worker_exited" },
  );
  assert.ok(f.events.some((e) =>
    e.phase === "failed" && e.code === "extension_worker_exited"));
  await instance.dispose();
});


test("extension effect diagnostics cross the worker without exposing arbitrary error text", async (t) => {
  const f = await fixture(t, `export default () => ({methods:{fail:{
    description:"Failure",permissions:[],schemaDialect:"draft7",inputSchema:{type:"object"},
    handle(){throw Object.assign(new Error("private path and secret"),{
      code:"TAB_ALREADY_CLAIMED",dispatched:false,effect:"none",retryable:false,
      target:{secret:"private target"}
    })}}}})`);
  const instance = await f.factory(f.host);
  try {
    await assert.rejects(instance.methods.fail.handle({__nexumWorkerArgs:[{}]},invocation()),
      error => {
        assert.equal(error.code,"TAB_ALREADY_CLAIMED");
        assert.match(error.message,/Another run/);
        assert.deepEqual(error.details,{dispatched:false,effect:"none",retryable:false,recovery:"wait_for_capacity"});
        assert.doesNotMatch(JSON.stringify(error),/private|secret/);
        return true;
      });
  } finally { await instance.dispose(); }
});

test("known reasons refine errors without passing untrusted diagnostic text or unsafe retry advice", async (t) => {
  const f=await fixture(t,`export default () => ({methods:{fail:{
    description:"Failure",permissions:[],schemaDialect:"draft7",inputSchema:{type:"object"},
    handle(input){throw Object.assign(new Error("private URL token"),{
      code:"INVALID_TARGET",reason:input.reason,dispatched:true,effect:"unknown",retryable:true
    })}}}})`);
  const instance=await f.factory(f.host);
  try {
    await assert.rejects(instance.methods.fail.handle({__nexumWorkerArgs:[{reason:"element_not_found"}]},invocation()),
      error => {assert.match(error.message,/did not match/);assert.deepEqual(error.details,
        {reason:"element_not_found",dispatched:true,effect:"unknown",retryable:false,recovery:"verify_effect"});return true;});
    await assert.rejects(instance.methods.fail.handle({__nexumWorkerArgs:[{reason:"private URL token"}]},invocation()),
      error => {assert.equal(error.details.reason,undefined);assert.doesNotMatch(JSON.stringify(error),/private|token/);return true;});
  } finally {await instance.dispose();}
});
