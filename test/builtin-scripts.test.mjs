import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { compileInputSchema } from "../dist/contracts/validation.js";
import { defaultBuiltins, ModuleLoader } from "../dist/runtime/modules.js";
import { CONTROL_OWNER, CONTROL_VERSION } from "../dist/runtime/platform-identity.js";

const names = [
  "file.list.js", "file.patch.js", "file.read.js", "file.search.js",
  "git.diff.js", "git.status.js",
];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-builtin-")));
  const project = path.join(root, "project");
  const work = root;
  mkdirSync(project);
  mkdirSync(work, { recursive: true });
  mkdirSync(path.join(project, "src"));
  writeFileSync(path.join(project, "src", "example.txt"), "first line\nsecond line\nthird line");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ScriptCatalog(work, "agent");
  const run = (name, input = {}, sh = {}) => {
    const script = catalog.resolve("nexum/" + name);
    return new AsyncFunction("context", "sh", script.code)({
      project: { root: project }, pwd: project, input,
    }, sh).then((result) => {
      // Git's sh.exec is mocked separately; file returns are actual values.
      if (name.startsWith("file.")) compileInputSchema(script.metadata.scriptOutputSchema)(result);
      return result;
    });
  };
  return { root, project, catalog, run };
}

test("six versioned builtins are discovered through ScriptCatalog without overriding local scripts", (t) => {
  const { catalog } = fixture(t);
  assert.equal(CONTROL_OWNER, "nexum");
  const discovered = catalog.discover();
  for (const name of names) {
    const full = "nexum/" + name;
    const entry = discovered.entries.find((item) => item.scriptName === full);
    assert.ok(entry, `missing ${full}`);
    assert.equal(entry.scriptOpenDefault, true);
    assert.equal(entry.origin.type, "platform");
    assert.equal(entry.origin.owner, CONTROL_OWNER);
    assert.equal(entry.origin.version, CONTROL_VERSION);
    assert.equal(entry.origin.revision, sha(readFileSync(entry.path)));
    assert.deepEqual(catalog.resolve(full).metadata.scriptInputSchema, entry.scriptInputSchema);
  }
  assert.equal(discovered.warnings.length, 0);
  assert.ok(catalog.select([]).items.some((item) => item.scriptName === "nexum/file.read.js"));
  assert.match(catalog.indexText(), /nexum\/git\.status\.js/);
  assert.throws(() => catalog.resolve("file.read.js"));
  assert.throws(() => catalog.resolve("nexum/unknown.js"));
  assert.throws(() => catalog.resolve("nexum/file.read.js", () => false), { code: "script_forbidden" });
});

test("file scripts read, list, search and patch with bounded project access", async (t) => {
  const { root, project, run } = fixture(t);
  const before = readFileSync(path.join(project, "src", "example.txt"));
  const file = await run("file.read.js", { path: "src/example.txt", startLine: 2, endLine: 3 });
  assert.deepEqual([file.startLine, file.endLine, file.totalLines], [2, 3, 3]);
  assert.equal(file.text, "second line\nthird line");
  assert.equal(file.sha256, sha(before));
  const listed = await run("file.list.js", { path: "src" });
  assert.deepEqual(listed.entries, [{ name: "example.txt", type: "file" }]);
  const search = await run("file.search.js", { path: "src", query: "SECOND" });
  assert.deepEqual(search.matches.map((item) => [item.path, item.line]), [["src/example.txt", 2]]);
  const replaced = await run("file.patch.js", {
    path: "src/example.txt", operation: "replace", expectedSha256: file.sha256,
    oldText: "second line", newText: "updated",
  });
  assert.equal(replaced.beforeSha256, file.sha256);
  assert.equal(readFileSync(path.join(project, "src", "example.txt"), "utf8"), "first line\nupdated\nthird line");
  await assert.rejects(run("file.patch.js", {
    path: "src/example.txt", operation: "replace", expectedSha256: file.sha256,
    oldText: "updated", newText: "wrong",
  }), /SHA-256 mismatch/);
  const created = await run("file.patch.js", { path: "src/new.txt", operation: "create", newText: "hello" });
  assert.equal(created.sha256, sha("hello"));
  await assert.rejects(run("file.patch.js", { path: "src/new.txt", operation: "create", newText: "bad" }), /create requires/);
  await run("file.patch.js", { path: "src/new.txt", operation: "delete", expectedSha256: created.sha256 });
  await assert.rejects(run("file.read.js", { path: "../outside.txt" }), /file_path_escape/);
  await assert.rejects(run("file.list.js", { path: ".." }), /file_path_escape/);
  await assert.rejects(run("file.patch.js", { path: "../outside.txt", operation: "create", newText: "bad" }), /file_path_escape/);
  writeFileSync(path.join(root, "outside.txt"), "secret");
  if (process.platform !== "win32") {
    symlinkSync(path.join(root, "outside.txt"), path.join(project, "src", "link.txt"));
    await assert.rejects(run("file.read.js", { path: "src/link.txt" }), /file_path_escape/);
    await assert.rejects(run("file.patch.js", { path: "src/link.txt", operation: "delete", expectedSha256: sha("secret") }), /file_path_escape/);
  }
  assert.equal((await run("file.search.js", { path: "src", query: "secret" })).matches.length, 0);
});

test("Git scripts use the existing managed sh command, not a second execution engine", async (t) => {
  const { project, run } = fixture(t);
  const calls = [];
  const sh = { exec: async (options) => {
    calls.push(options);
    return { status: "succeeded", exitCode: 0, output: "ok" };
  } };
  assert.equal((await run("git.status.js", {}, sh)).output, "ok");
  assert.equal((await run("git.diff.js", { cached: true, stat: true, path: "src/example.txt" }, sh)).output, "ok");
  assert.deepEqual(calls.map((item) => item.command), ["git", "git"]);
  assert.ok(calls.every((item) => item.cwd === project && item.check === true));
  assert.deepEqual(calls[1].args, ["diff", "--no-ext-diff", "--cached", "--stat", "--", "src/example.txt"]);
  await assert.rejects(run("git.diff.js", { path: "../secret.txt" }, sh), /git_path_escape/);
  assert.equal(calls.length, 2);
});

test("named builtin file reads execute in the real isolated Node Worker", async (t) => {
  const { catalog, project, root } = fixture(t);
  const work = root;
  mkdirSync(path.join(work, "modules"));
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const loader = await ModuleLoader.create(work, "builtin_workertest", {
    builtins: () => defaultBuiltins,
    approvedPackages: () => new Map(),
  });
  const script = catalog.resolve("nexum/file.read.js");
  const execute = await loader.compileIsolated(script.code, {
    context: { project: { root: project }, pwd: project, input: { path: "src/example.txt" } },
  });
  try {
    const result = await execute();
    assert.equal(result.text, "first line\nsecond line\nthird line");
    await execute.flushCallbacks();
    await execute.audit();
  } finally {
    await execute.close();
  }
});
