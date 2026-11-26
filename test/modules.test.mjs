import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Console as NativeConsole } from "node:console";
import { Writable } from "node:stream";
import test from "node:test";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { errorInlineBytes } from "../dist/contracts/error-data.js";

async function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-modules-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = root;
  const modules = path.join(work, "modules");
  const pkg = path.join(work, "node_modules", "fixture");
  mkdirSync(modules, { recursive: true });
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    path.join(work, "package.json"),
    JSON.stringify({ type: "module", dependencies: { fixture: "1.0.0" } }),
  );
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      type: "module",
      exports: { import: "./index.mjs", require: "./index.cjs" },
    }),
  );
  writeFileSync(
    path.join(pkg, "index.mjs"),
    'import {createHash} from "node:crypto";export const format="import";let count=0;export const increment=()=>++count;export const hash=()=>createHash("sha256").update("x").digest("hex");',
  );
  writeFileSync(path.join(pkg, "index.cjs"), 'exports.format="require";');
  writeFileSync(path.join(pkg, "private.mjs"), "export const hidden=true;");
  writeFileSync(path.join(modules, "helper.mjs"), "export const value=7;");
  writeFileSync(path.join(modules, "helper.cjs"), "exports.value=8;");
  writeFileSync(path.join(modules, "data.json"), '{"n":9}');
  let builtins = ["path", "fs"];
  const packages = new Map([["fixture", "1.0.0"]]);
  const loader = await ModuleLoader.create(work, "boot_test", {
    builtins: () => builtins,
    approvedPackages: () => packages,
  });
  return {
    root,
    work,
    modules,
    pkg,
    packages,
    loader,
    builtins: (next) => {
      builtins = next;
    },
  };
}

test("direct imports and require use native conditions; transitive package dependencies stay within the approved trust scope", async (t) => {
  const { loader } = await fixture(t);
  const uses = [];
  const value = await loader.execute(
    `
    const pkg = await import("fixture");
    const fs = await import("fs/promises");
    return { import:pkg.format, require:require("fixture").format, hash:pkg.hash(), fs:typeof fs.readFile,
      resolved:require.resolve("fixture"), cache:typeof require.cache };
  `,
    { context: {} },
    { onModule: (use) => uses.push(use) },
  );
  assert.equal(value.import, "import");
  assert.equal(value.require, "require");
  assert.equal(value.hash.length, 64);
  assert.equal(value.fs, "function");
  assert.match(value.resolved, /index\.cjs$/);
  assert.equal(value.cache, "undefined");
  assert.equal(
    uses.find((use) => use.packageName === "fixture").version,
    "1.0.0",
  );
  assert.equal(
    uses.find((use) => use.kind === "builtin").specifier,
    "node:fs/promises",
  );
  await assert.rejects(
    loader.execute('return await import("node:crypto")', {}),
    { code: "module_not_allowed" },
  );
  await assert.rejects(
    loader.execute('return await import("fixture/private.mjs")', {}),
    { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
  );
});

test("approved npm and Node native types remain usable across execution realms", async (t) => {
  const { loader, work, pkg, builtins } = await fixture(t);
  builtins(["assert", "buffer", "crypto", "events", "fs", "path", "stream", "util"]);
  writeFileSync(path.join(pkg, "index.cjs"), `
    const { types } = require("node:util");
    exports.make = () => ({ array: [1, 2], object: { answer: 42 },
      map: new Map([["a", 7]]), set: new Set([3, 4]), date: new Date(1234),
      buffer: Buffer.from([0, 255]), view: new Uint8Array([8, 9]),
      error: new TypeError("fixture"), promise: Promise.resolve(17) });
    exports.consume = (x) => ({
      array: Array.isArray(x.array), map: types.isMap(x.map),
      set: types.isSet(x.set), date: types.isDate(x.date),
      view: types.isUint8Array(x.view), error: types.isNativeError(x.error),
      data: x.array[0] + x.map.get("a") + x.view[0] });
  `);
  const execute = await loader.compileIsolated(`
    const pkg = require("fixture");
    const a = require("node:assert/strict");
    const types = require("node:util").types;
    const { Readable } = require("node:stream");
    const { createHash } = require("node:crypto");
    const fs = require("node:fs/promises");
    const path = require("node:path");
    const n = pkg.make();
    a.ok(Array.isArray(n.array));
    a.equal(n.array.join(","), "1,2");
    a.equal(n.object.answer, 42);
    a.equal(n.map.get("a"), 7);
    a.equal([...n.set].join(","), "3,4");
    a.equal(n.date.getTime(), 1234);
    a.ok(types.isNativeError(n.error));
    a.equal(n.error.message, "fixture");
    a.equal(await n.promise, 17);
    a.ok(Buffer.isBuffer(n.buffer));
    a.ok(types.isUint8Array(n.view));
    a.equal(n.view.join(","), "8,9");
    const file = path.join(context.pwd, "realm-fixture.bin");
    await fs.writeFile(file, n.buffer);
    a.equal(Buffer.compare(await fs.readFile(file), n.buffer), 0);
    const hash = createHash("sha256");
    for await (const chunk of Readable.from([n.buffer, Buffer.from(n.view)])) hash.update(chunk);
    let strictComparison;
    try { a.deepEqual(n.array, [1, 2]); strictComparison = "equal"; }
    catch (error) { a.equal(error.code, "ERR_ASSERTION"); strictComparison = "different-prototype"; }
    // Strict prototype identity is not a business-value compatibility contract.
    return { strictComparison, digest: hash.digest("hex"), guest: pkg.consume({
      array: [1], map: new Map([["a", 2]]), set: new Set([4]),
      date: new Date(0), view: new Uint8Array([3]), error: new Error("guest")
    }) };
  `, { context: { pwd: work } });
  try {
    const result = await execute();
    assert.ok(["equal", "different-prototype"].includes(result.strictComparison));
    assert.equal(result.digest.length, 64);
    assert.deepEqual({ ...result.guest }, {
      array: true, map: true, set: true, date: true, view: true, error: true, data: 6,
    });
  } finally {
    await execute.close();
  }
});

test("static import resolution uses current native conditions without evaluating or pinning a package version", async (t) => {
  const { loader, pkg, packages } = await fixture(t);
  writeFileSync(
    path.join(pkg, "index.mjs"),
    'throw new Error("must not evaluate during inspection");',
  );
  assert.equal(
    loader.resolveImport("fixture"),
    pathToFileURL(path.join(pkg, "index.mjs")).href,
  );
  assert.throws(() => loader.resolveImport("fixture/private.mjs"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
  packages.delete("fixture");
  assert.throws(() => loader.resolveImport("fixture"), {
    code: "module_not_allowed",
  });
  packages.set("fixture", "2.0.0");
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "2.0.0",
      type: "module",
      exports: { import: "./index.mjs", require: "./index.cjs" },
    }),
  );
  writeFileSync(path.join(pkg, "index.mjs"), 'export const version="2.0.0";');
  assert.equal(
    await loader.execute('return (await import("fixture")).version;', {}),
    "2.0.0",
  );
});

test("fresh execution scopes preserve the one npm cache but expose no previous globals, private host locals or global cwd change", async (t) => {
  const { loader, work } = await fixture(t);
  const before = process.cwd();
  const hostSecret = "not injected";
  const original = { runId: "run_1", pwd: work, input: { value: 1 } };
  assert.equal(
    await loader.execute(
      'globalThis.leftover=42;return (await import("fixture")).increment();',
      { context: original },
    ),
    1,
  );
  assert.equal(
    await loader.execute('return (await import("fixture")).increment();', {
      context: { pwd: "/another" },
    }),
    2,
  );
  assert.equal(
    await loader.execute(
      'return typeof leftover+":"+typeof hostSecret+":"+typeof process;',
      {},
    ),
    "undefined:undefined:undefined",
  );
  await assert.rejects(
    loader.execute('context.runId="changed";return 1;', { context: original }),
    { name: "TypeError" },
  );
  await assert.rejects(
    loader.execute("context.input.value=2;return 1;", { context: original }),
    { name: "TypeError" },
  );
  assert.equal(original.input.value, 1);
  assert.equal(original.runId, "run_1");
  assert.equal(process.cwd(), before);
  assert.equal(hostSecret, "not injected");
});

test("the execution Console preserves native methods without exposing its private stream or host state", async (t) => {
  const { loader } = await fixture(t),
    chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  stream.reserve = () =>
    assert.fail("private allocation callback must not be callable");
  const logger = new NativeConsole({
    stdout: stream,
    stderr: stream,
    ignoreErrors: false,
  });
  logger.privateState = { manager: true };
  const originalLog = logger.log;
  const visible = await loader.execute(
    `
    console.group("native group");console.log("native output");console.groupEnd();
    console.count("native counter");console.count("native counter");
    console.log=()=>{};
    return {stream:typeof console._stdout,hostState:typeof console.privateState,
      constructor:typeof console.constructor,privateNames:Object.keys(console).filter(name=>name.startsWith("_"))};
  `,
    {},
    { console: logger },
  );
  assert.equal(visible.stream, "undefined");
  assert.equal(visible.hostState, "undefined");
  assert.equal(visible.constructor, "undefined");
  assert.equal(visible.privateNames.length, 0);
  assert.match(chunks.join(""), /native group\n  native output\n/);
  assert.match(chunks.join(""), /native counter: 1\nnative counter: 2\n/);
  assert.equal(logger.privateState.manager, true);
  assert.equal(logger.log, originalLog);
  await loader.execute(
    'console.log("next execution still logs");',
    {},
    { console: logger },
  );
  assert.match(chunks.join(""), /next execution still logs/);
});

test("live policy is checked on repeated cached imports in the same run and on cached require", async (t) => {
  const { loader, packages, builtins } = await fixture(t);
  await assert.rejects(
    loader.execute(
      'await import("fixture");revoke();return await import("fixture");',
      {
        revoke() {
          packages.clear();
        },
      },
    ),
    { code: "module_not_allowed" },
  );
  await assert.rejects(loader.execute('return require("fixture")', {}), {
    code: "module_not_allowed",
  });
  builtins(["fs/promises"]);
  assert.equal(
    await loader.execute(
      'return typeof (await import("node:fs/promises")).readFile',
      {},
    ),
    "function",
  );
  await assert.rejects(loader.execute('return await import("fs")', {}), {
    code: "module_not_allowed",
  });
  await assert.rejects(
    loader.execute('return await import("fs/not-real")', {}),
  );
});

test("npm packages require approval, a direct declaration, matching actual version and installed source", async (t) => {
  const { loader, work, pkg, packages } = await fixture(t);
  packages.set("fixture", "2.0.0");
  await assert.rejects(loader.execute('return await import("fixture")', {}), {
    code: "module_changed",
  });
  packages.set("fixture", "1.0.0");
  writeFileSync(path.join(work, "package.json"), '{"dependencies":{}}');
  await assert.rejects(loader.execute('return require("fixture")', {}), {
    code: "module_not_allowed",
  });
  writeFileSync(
    path.join(work, "package.json"),
    '{"dependencies":{"fixture":"1.0.0"}}',
  );
  assert.equal(
    await loader.execute('return (await import("fixture")).format', {}),
    "import",
  );
  const changed = {
    name: "fixture",
    version: "2.0.0",
    type: "module",
    exports: { import: "./index.mjs", require: "./index.cjs" },
  };
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify(changed));
  packages.set("fixture", "2.0.0");
  await assert.rejects(
    loader.execute('return (await import("fixture")).format', {}),
    { code: "module_restart_required" },
  );
});

test("file imports have a fixed work/modules base, preserve JSON/require semantics and reject escapes", async (t) => {
  const { loader, root, work, modules } = await fixture(t);
  assert.equal(
    await loader.execute('return (await import("./helper.mjs")).value', {
      context: { pwd: root },
    }),
    7,
  );
  assert.equal(
    await loader.execute('return require("./helper.cjs").value', {}),
    8,
  );
  assert.equal(
    await loader.execute(
      'return (await import("./data.json",{with:{type:"json"}})).default.n',
      {},
    ),
    9,
  );
  assert.equal(await loader.execute('return require("./data.json").n', {}), 9);
  const url = pathToFileURL(path.join(modules, "helper.mjs")).href;
  assert.equal(
    await loader.execute(
      `return (await import(${JSON.stringify(url)})).value`,
      {},
    ),
    7,
  );
  const outside = path.join(root, "private");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "private.mjs"), "export const secret=1;");
  symlinkSync(outside, path.join(modules, "escape"), "junction");
  await assert.rejects(
    loader.execute('return await import("./escape/private.mjs")', {}),
    { code: "module_not_allowed" },
  );
  writeFileSync(path.join(work, "private.mjs"), "export const secret=1;");
  await assert.rejects(
    loader.execute('return await import("../private.mjs")', {}),
    { code: "module_not_allowed" },
  );
  writeFileSync(path.join(modules, "helper.mjs"), "export const value=99;");
  await assert.rejects(
    loader.execute('return await import("./helper.mjs")', {}),
    { code: "module_restart_required" },
  );
});

test("script body supports await and native errors, and the required VM option is checked before work initialization", async (t) => {
  const { loader, work } = await fixture(t);
  await assert.rejects(
    loader.execute('import fs from "node:fs";return fs;', {}),
    { name: "SyntaxError" },
  );
  await assert.rejects(
    loader.execute('return await import("https://example.com/code.mjs")', {}),
    { code: "invalid_module" },
  );
  const moduleUrl = new URL("../dist/runtime/modules.js", import.meta.url).href;
  const code = `import {ModuleLoader} from ${JSON.stringify(moduleUrl)};try{await ModuleLoader.create(${JSON.stringify(work)},"unused",{});}catch(e){console.log(e.code);}`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "runtime_configuration");
});

test("SDK roots must be identifiers while original tool names remain callable", async (t) => {
  const { loader } = await fixture(t);
  const observed = await loader.execute(
    'return await remote_api["tool_list-issues"]({repo:"demo"});',
    { context: {}, remote_api: { "tool_list-issues": async ({ repo }) => ({ repo }) } },
  );
  assert.equal(observed.repo, "demo");
  for (const name of ["remote-api", "remote.api", "1remote", "invalid key", "x".repeat(65), "CON", "nUl", "LPT1", "conin$"]) {
    await assert.rejects(loader.execute("return 1;", {
      context: {}, [name]: { ping: () => 1 },
    }), { code: "invalid_namespace" });
  }
});

test("a Worker rejects reserved device roots without blocking legal names", async (t) => {
  const { loader } = await fixture(t);
  for (const name of ["CON", "NUL", "LPT1", "CONOUT$"]) {
    await assert.rejects(loader.compileIsolated("return 1;", {
      context: {}, [name]: { ping: async () => 42 },
    }), { code: "worker_binding_invalid" });
  }
  const run = await loader.compileIsolated('return await $plugin["tool_list-issues"]({});', {
    context: {}, $plugin: { "tool_list-issues": async () => 42 },
  });
  try { assert.equal(await run(), 42); } finally { await run.close(); }
});

test("an actual Run Worker calls an approved SDK binding", async (t) => {
  const { loader } = await fixture(t);
  const run = await loader.compileIsolated(
    'return await remote_api["tool_ping"]({ count: 41 });',
    { context: {}, remote_api: { tool_ping: async ({ count }) => count + 1 } },
  );
  try {
    assert.equal(await run(), 42);
  } finally {
    await run.close();
  }
});

test("rethrowing an SDK-issued failure cannot change the recorded public diagnosis", async (t) => {
  const { loader } = await fixture(t);
  const { AgentError } = await import("../dist/contracts/errors.js");
  const code = "BROWSER_"+"X".repeat(200);
  const run = await loader.compileIsolated(`try { await fixture_error.fail(); } catch (error) {
    if (error.code !== context.code || error.details.effect !== "unknown" || error.details.retryable !== false) throw new Error("unexpected SDK diagnostic");
    error.code = "forged_code";
    error.message = "FORGED_MESSAGE";
    error.details.operationId = "forged_operation";
    error.details.effect = "none";
    error.details.retryable = true;
    throw error;
  }`,{context:{code},fixture_error:{fail:async()=>{throw new AgentError(code,"故障🙂".repeat(1024),{operationId:"op_original",effect:"unknown",dispatched:true,retryable:true,nested:{token:"PRIVATE_TOKEN"}});}}});
  try {
    await assert.rejects(run(), error=>{assert.equal(error.code,code);assert.equal(error.details.operationId,"op_original");assert.equal(error.details.effect,"unknown");assert.equal(error.details.retryable,false);assert.ok(Buffer.byteLength(error.message)<=errorInlineBytes);assert.doesNotMatch(JSON.stringify(error),/PRIVATE_TOKEN|FORGED_MESSAGE/);return true;});
  } finally {await run.close();}
});

test("ordinary Run Workers do not initialize the Host's Ajv dependency graph", async (t) => {
  const { loader, modules } = await fixture(t);
  // This is a trusted native test module, not a public guest cache API.
  // Ajv and its format plug-in are CJS and would appear in this actual
  // Worker's native cache if ModuleLoader imported the Host creator.
  writeFileSync(path.join(modules,"dependency-probe.cjs"),
    "module.exports=()=>Object.keys(require.cache).filter(p=>p.split(require('node:path').sep).some(n=>n==='ajv'||n==='ajv-formats'));");
  const execute = await loader.compileIsolated(`
    const inspect = require("./dependency-probe.cjs");
    const before = inspect();
    const value = await sdk.echo(42);
    return {before, after:inspect(), value};
  `, {context:{},sdk:{echo:async value=>value}});
  try {
    const result=await execute();
    assert.deepEqual(result.before,[]);
    assert.deepEqual(result.after,[]);
    assert.equal(result.value,42);
  } finally {await execute.close();}
});
