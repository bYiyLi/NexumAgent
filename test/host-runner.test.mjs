import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindGoScope, HostRunner } from "../dist/host/runner.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { File } from "node:buffer";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nexum-host-runner-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work");
  await mkdir(path.join(work, "modules"), { recursive: true });
  await writeFile(path.join(work, "package.json"), '{"private":true,"type":"module"}');
  const loader = await ModuleLoader.create(work, `boot_${randomUUID()}`, {
    builtins: () => ["path"],
    approvedPackages: () => new Map(),
  });
  const runner = new HostRunner(loader);
  t.after(() => runner.close());
  return { loader, runner };
}

function run(runId, code, bindings = {}) {
  return {
    runId, code, bindings,
    context: { runId },
    onRootReturned() {},
    async settleOperations() {},
  };
}

test("host executes a Run using its admitted bindings and existing module policy", async (t) => {
  const { runner } = await fixture(t);
  let calls = 0;
  const input = run("run_1", `
    const path = await import("node:path");
    return { runId: context.runId, path: path.basename("/a/b"), result: await sdk.double(4) };
  `, { sdk: { double: async (value) => { calls += 1; return value * 2; } } });
  let rootReturned = 0;
  let settlements = 0;
  input.onRootReturned = () => { rootReturned += 1; };
  input.settleOperations = async () => { settlements += 1; };
  assert.deepEqual({ ...await runner.start(input) }, { runId: "run_1", path: "b", result: 8 });
  assert.equal(calls, 1);
  assert.equal(rootReturned, 1);
  assert.equal(settlements, 3);
  await assert.rejects(runner.start(run("run_2", 'return await import("node:fs");')),
    { code: "module_not_allowed" });
});

test("Worker SDK calls and results preserve nested Buffer, File, Blob and byte view types", async (t) => {
  const { runner } = await fixture(t);
  const originalFile = new File(["file body"], "report.txt", { type: "text/plain", lastModified: 1234 });
  const supplied = { file: originalFile, buffer: Buffer.from([1, 2, 3]),
    blob: new Blob(["blob"]), view: new Uint8Array([4, 5]) };
  const input = run("run_binary", `
    const received = await sdk.read();
    return await sdk.echo({ nested: [received.file, received.buffer, received.blob, received.view] });
  `, { sdk: {
    read: async () => supplied,
    echo: async (value) => {
      const [file, buffer, blob, view] = value.nested;
      assert.ok(file instanceof File);
      assert.equal(file.name, "report.txt");
      assert.equal(file.lastModified, 1234);
      assert.equal(file.type, "text/plain");
      assert.equal(await file.text(), "file body");
      assert.ok(Buffer.isBuffer(buffer));
      assert.deepEqual([...buffer], [1, 2, 3]);
      assert.ok(blob instanceof Blob);
      assert.equal(blob instanceof File, false);
      assert.ok(view instanceof Uint8Array);
      assert.equal(Buffer.isBuffer(view), false);
      return value;
    },
  } });
  const result = await runner.start(input);
  const [file, buffer, blob, view] = result.nested;
  assert.ok(file instanceof File);
  assert.equal(file.name, "report.txt");
  assert.equal(file.lastModified, 1234);
  assert.ok(Buffer.isBuffer(buffer));
  assert.deepEqual([...buffer], [1, 2, 3]);
  assert.ok(blob instanceof Blob);
  assert.equal(blob instanceof File, false);
  assert.ok(view instanceof Uint8Array);
  assert.equal(Buffer.isBuffer(view), false);
});

test("Worker File transport preserves empty and multiline native names", async (t) => {
  const { runner } = await fixture(t);
  const names = ["", "line\nname.txt"];
  const result = await runner.start(run("run_filenames", `
    const files = await sdk.files();
    return await sdk.echo({ files });
  `, { sdk: {
    files: async () => names.map((name) => new File(["x"], name, { lastModified: 0 })),
    echo: async (value) => value,
  } }));
  assert.deepEqual(result.files.map((file) => file.name), names);
  assert.deepEqual(result.files.map((file) => file.lastModified), [0, 0]);
  assert.deepEqual(result.files.map((file) => file.type), ["", ""]);
});

test("Worker guest callbacks retain binary types in both directions", async (t) => {
  const { runner } = await fixture(t);
  const result = await runner.start(run("run_binary_callback", `
    return await sdk.callback(async (input) => ({ file: input.file, buffer: input.buffer }));
  `, { sdk: { callback: async (callback) => {
    const value = await callback({ file: new File(["x"], "callback.txt", { lastModified: 9 }),
      buffer: Buffer.from([7, 8]) });
    assert.ok(value.file instanceof File);
    assert.equal(value.file.lastModified, 9);
    assert.ok(Buffer.isBuffer(value.buffer));
    return { name: value.file.name, bytes: [...value.buffer] };
  } } }));
  assert.deepEqual({ ...result }, { name: "callback.txt", bytes: [7, 8] });
});

test("cancellation closes the Worker before releasing its package-change gate", async (t) => {
  const { loader, runner } = await fixture(t);
  const ready = Promise.withResolvers();
  const running = runner.start(run("run_3", "await sdk.ready(); while (true) {}", {
    sdk: { ready: () => ready.resolve() },
  }));
  await ready.promise;
  assert.throws(() => runner.start(run("run_3", "return 0")), { code: "run_already_active" });
  await assert.rejects(loader.withPackageChanges(async () => {}), { code: "module_busy" });
  assert.equal(runner.cancel("run_3"), true);
  await assert.rejects(running, { code: "run_cancelled" });
  assert.equal(runner.cancel("run_3"), false);
  assert.equal(await loader.withPackageChanges(async () => 7), 7);
});

test("host close joins active Workers and rejects future admission", async (t) => {
  const { runner } = await fixture(t);
  const ready = Promise.withResolvers();
  const running = runner.start(run("run_4", "await sdk.ready(); while (true) {}", {
    sdk: { ready: () => ready.resolve() },
  }));
  await ready.promise;
  const completion = assert.rejects(running, { code: "run_cancelled" });
  await runner.close();
  await completion;
  assert.throws(() => runner.start(run("run_5", "return 1")), { code: "host_closing" });
});

test("Go SDK bindings retain their issued identity and settle admitted calls", async (t) => {
  const { runner } = await fixture(t);
  const pending = Promise.withResolvers();
  const called = Promise.withResolvers();
  const controller = new AbortController();
  const scope = bindGoScope({
    instanceId: "host_1",
    runId: "run_6",
    methods: [
      { methodId: "method_1", path: ["github", "tool_list-issues"] },
      { methodId: "method_2", path: ["crm", "GET /customers/{id}"] },
    ],
  }, async (method, params) => {
    called.resolve({ method, params });
    return await pending.promise;
  }, controller.signal);
  const running = runner.start({
    ...run("run_6", 'return await github["tool_list-issues"]({ runId: "forged" });'),
    ...scope,
  });
  assert.deepEqual(await called.promise, {
    method: "sdk.call",
    params: { instanceId: "host_1", runId: "run_6", methodId: "method_1",
      arguments: [{ runId: "forged" }] },
  });
  pending.resolve({ value: { count: 1 }, binaryOutputs: [] });
  assert.deepEqual({ ...await running }, { count: 1 });
  assert.throws(() => scope.bindings.github["tool_list-issues"]({}),
    { code: "invocation_closed" });
});

test("failed execution joins operation cleanup and closes its Worker", async (t) => {
  const { loader, runner } = await fixture(t);
  const settled = Promise.withResolvers();
  const admission = Promise.withResolvers();
  let admissionClosed = 0;
  const input = run("run_7", 'throw new Error("failure");');
  input.onRootReturned = () => { admissionClosed += 1; admission.resolve(); };
  input.settleOperations = () => settled.promise;
  const running = runner.start(input);
  const failure = assert.rejects(running);
  await admission.promise;
  assert.equal(admissionClosed, 1);
  settled.resolve();
  await failure;
  assert.equal(await loader.withPackageChanges(async () => 7), 7);
});

test("a literal script throw preserves its useful message without leaking dynamic secrets", async (t) => {
  const { runner } = await fixture(t);
  await assert.rejects(
    runner.start(run("run_literal_error", 'throw new Error("读取配置失败");')),
    (error) => error.code === "script_execution_failed" && error.message === "读取配置失败",
  );
  await assert.rejects(
    runner.start(run("run_dynamic_error", 'const fragments=["private", "value"];throw new Error(fragments.join("-"));')),
    (error) => error.code === "script_execution_failed" && !error.message.includes("private-value"),
  );
  await assert.rejects(
    runner.start(run("run_secret_literal", 'throw new Error("token=private");')),
    (error) => error.code === "script_execution_failed" && !error.message.includes("token=private"),
  );
});

test("Go scope rejects path collisions and preserves prototype keys safely", () => {
  const controller = new AbortController();
  const scope = { instanceId: "host_1", runId: "run_8", methods: [
    { methodId: "one", path: ["github"] },
    { methodId: "two", path: ["github", "tool_list"] },
  ] };
  assert.throws(() => bindGoScope(scope, async () => null, controller.signal),
    { code: "invalid_run_scope" });
  scope.methods = [{ methodId: "one", path: ["__proto__", "tool_list"] }];
  const bound = bindGoScope(scope, async () => null, controller.signal);
  assert.equal(Object.getPrototypeOf(bound.bindings), null);
  assert.equal(typeof bound.bindings.__proto__.tool_list, "function");
  assert.equal(Object.prototype.tool_list, undefined);
});

test("OpenAPI fallback names with HTTP paths pass through the Worker binding", async (t) => {
  const { runner } = await fixture(t);
  const controller = new AbortController();
  const scope = bindGoScope({
    instanceId: "host_1", runId: "run_9",
    methods: [{ methodId: "api_1", path: ["crm", "GET /customers/{id}"] }],
  }, async (method, params) => ({ value: { method, ...params }, binaryOutputs: [] }), controller.signal);
  const result = await runner.start({
    ...run("run_9", 'return await crm["GET /customers/{id}"]({path:{id:3}});'),
    ...scope,
  });
  assert.equal(result.method, "sdk.call");
  assert.equal(result.methodId, "api_1");
  assert.equal(result.arguments[0].path.id, 3);
});

test("cancellation waits for admitted Go calls and closes admission immediately", async (t) => {
  const { runner } = await fixture(t);
  const called = Promise.withResolvers();
  const pending = Promise.withResolvers();
  const controller = new AbortController();
  const scope = bindGoScope({
    instanceId: "host_1", runId: "run_10",
    methods: [{ methodId: "tool_1", path: ["github", "tool_run"] }],
  }, async () => {
    called.resolve();
    await pending.promise;
    return { value: null, binaryOutputs: [] };
  }, controller.signal);
  const running = runner.start({
    ...run("run_10", "await github.tool_run({});"), ...scope,
  });
  const failed = assert.rejects(running, { code: "run_cancelled" });
  await called.promise;
  assert.equal(runner.cancel("run_10"), true);
  assert.throws(() => scope.bindings.github.tool_run({}), { code: "invocation_closed" });
  assert.equal(runner.cancel("run_10"), true);
  pending.resolve();
  await failed;
  assert.equal(runner.cancel("run_10"), false);
});
