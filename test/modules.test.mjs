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

async function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-modules-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, "work");
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
