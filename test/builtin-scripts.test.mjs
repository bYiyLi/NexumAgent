import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScriptCatalog, scriptHeader } from "../dist/runtime/scripts.js";
import { compileInputSchema } from "../dist/contracts/validation.js";
import { defaultBuiltins, ModuleLoader } from "../dist/runtime/modules.js";
import { CONTROL_OWNER, CONTROL_VERSION } from "../dist/runtime/platform-identity.js";

const names = [
  "file.list.js", "file.patch.js", "file.read.js", "file.search.js",
];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// These helpers inspect the actual rendered text in tests only; the runtime
// returns a single Markdown string, not a second structured representation.
function readReport(markdown) {
  assert.equal(typeof markdown, "string");
  if (markdown.startsWith("## ") && markdown.includes("\n\n## ")) {
    return { results: markdown.split(/\n\n(?=## )/).map(section => {
      const error = section.match(/\n\nError \(([^)]+)\):/);
      return error ? { ok: false, error: { code: error[1] } } : { ok: true, result: readReport(section) };
    }) };
  }
  const range = markdown.match(/^Lines (\d+)–(\d+)(?: \/ (\d+)| \(total unknown\)) · ([^\n]+)$/m);
  assert.ok(range, markdown);
  const continuation = markdown.match(/^Continue: startLine=(\d+) \(nextLine\), expectedRevision=([a-f0-9]{64})$/m);
  const errorReason = markdown.match(/^Read incomplete \(([^)]+)\)/m);
  const nextLine = continuation ? Number(continuation[1]) : null;
  return {
    startLine: Number(range[1]), endLine: Number(range[2]), totalLines: range[3] ? Number(range[3]) : null,
    encoding: range[4], text: [...markdown.matchAll(/^    \d+ \| ([^\n]*)/gm)].map(m => m[1]).join("\n"),
    sha256: markdown.match(/^SHA-256: ([a-f0-9]{64})$/m)?.[1] ?? null,
    nextLine, revision: continuation?.[2], truncated: Boolean(continuation || errorReason),
    reason: errorReason?.[1] ?? (markdown.includes("Output budget reached") ? "output_budget" : continuation ? "line_limit" : null)
  };
}
function listReport(markdown) {
  assert.equal(typeof markdown, "string");
  const entries = [];
  let parent = "";
  for (const line of markdown.split("\n")) {
    if (line.startsWith("      ")) {
      const raw = line.slice(6);
      const type = raw.endsWith("/") ? "directory" : raw.endsWith(" [symlink]") ? "symlink" : raw.endsWith(" [other]") ? "other" : "file";
      const name = raw.replace(/\/$| \[(?:symlink|other)\]$/g, "");
      entries.push({ name, path: parent === "." ? name : parent + "/" + name, type });
    } else if (line.startsWith("    ")) parent = line.slice(4, -1);
  }
  const reason = markdown.match(/Directory listing incomplete \(([^)]+)\)/)?.[1] ?? null;
  const total = markdown.match(/Directory listing complete: (\d+) matching entries/)?.[1];
  const nextOffset = markdown.match(/Continue with offset=(\d+) \(nextOffset\)/)?.[1];
  return { entries, total: total === undefined ? null : Number(total), truncated: reason !== null, reason, nextOffset: nextOffset === undefined ? null : Number(nextOffset) };
}

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
    compileInputSchema(script.metadata.scriptInputSchema)(input);
    return new AsyncFunction("context", "sh", script.code)({
      project: { root: project }, pwd: project, input,
    }, sh).then((result) => {
      // Git's sh.exec is mocked separately; file returns are actual values.
      if (name.startsWith("file.")) compileInputSchema(script.metadata.scriptOutputSchema)(result);
      return name === "file.read.js" ? readReport(result) : name === "file.list.js" ? listReport(result) : result;
    });
  };
  return { root, project, catalog, run };
}

test("four versioned file builtins are discovered through ScriptCatalog without overriding local scripts", (t) => {
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
  assert.ok(catalog.indexText().includes("nexum/file.read.js"));
  for (const name of ["nexum/git.status.js", "nexum/git.diff.js"]) {
    assert.ok(!discovered.entries.some((entry) => entry.scriptName === name));
    assert.ok(!catalog.select([]).items.some((entry) => entry.scriptName === name));
    assert.ok(!catalog.indexText().includes(name));
    assert.throws(() => catalog.resolve(name));
  }
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
  assert.deepEqual(listed.entries, [{ name: "example.txt", path: "src/example.txt", type: "file" }]);
  const search = await run("file.search.js", { path: "src", query: "SECOND" });
  assert.match(search, /## src\/example\.txt\n\n[\s\S]*> 2 \| second line/);
  const replaced = await run("file.patch.js", { patch: "*** Begin Patch\n*** Update File: src/example.txt\n@@\n-second line\n+updated\n*** End Patch" });
  assert.match(replaced, /M  "src\/example\.txt"/);
  assert.equal(readFileSync(path.join(project, "src", "example.txt"), "utf8"), "first line\nupdated\nthird line");
  await assert.rejects(run("file.patch.js", { patch: "*** Begin Patch\n*** Update File: src/example.txt\n@@\n-second line\n+wrong\n*** End Patch" }), /file_patch_conflict/);
  const created = await run("file.patch.js", { patch: "*** Begin Patch\n*** Add File: src/new.txt\n+hello\n*** End Patch" });
  assert.match(created, /A  "src\/new\.txt"/);
  assert.equal(readFileSync(path.join(project, "src", "new.txt"), "utf8"), "hello\n");
  await assert.rejects(run("file.patch.js", { patch: "*** Begin Patch\n*** Add File: src/new.txt\n+bad\n*** End Patch" }), /file_patch_conflict/);
  await run("file.patch.js", { patch: "*** Begin Patch\n*** Delete File: src/new.txt\n*** End Patch" });
  await assert.rejects(run("file.read.js", { path: "../outside.txt" }), /file_path_escape/);
  await assert.rejects(run("file.list.js", { path: ".." }), /file_path_escape/);
  await assert.rejects(run("file.patch.js", { patch: "*** Begin Patch\n*** Add File: ../outside.txt\n+bad\n*** End Patch" }), /file_path_escape/);
  writeFileSync(path.join(root, "outside.txt"), "secret");
  if (process.platform !== "win32") {
    symlinkSync(path.join(root, "outside.txt"), path.join(project, "src", "link.txt"));
    await assert.rejects(run("file.read.js", { path: "src/link.txt" }), /file_path_escape/);
    await assert.rejects(run("file.patch.js", { patch: "*** Begin Patch\n*** Delete File: src/link.txt\n*** End Patch" }), /file_path_escape/);
  }
  assert.match(await run("file.search.js", { path: "src", query: "secret" }), /No matches returned/);
});

test("file.read keeps single-file compatibility, LF line numbering and exact byte hashes", async (t) => {
  const { project, run } = fixture(t);
  const body = "first\r\nsecond\r\n";
  writeFileSync(path.join(project, "crlf.txt"), body);
  const page = await run("file.read.js", { path: "crlf.txt", startLine: 2, endLine: 2 });
  assert.deepEqual([page.text, page.totalLines, page.sha256, page.nextLine, page.reason], ["second\r", 3, sha(body), 3, "line_limit"]);
  const tail = await run("file.read.js", { path: "crlf.txt", startLine: page.nextLine, expectedRevision: page.revision });
  assert.deepEqual([tail.text, tail.endLine, tail.truncated, tail.sha256], ["", 3, false, sha(body)]);
  writeFileSync(path.join(project, "empty.txt"), "");
  const empty = await run("file.read.js", { path: "empty.txt" });
  assert.deepEqual([empty.text, empty.totalLines, empty.sha256, empty.nextLine], ["", 1, sha(""), null]);
  await assert.rejects(run("file.read.js", { path: "empty.txt", startLine: 2 }), /invalid_line_range/);
  await assert.rejects(run("file.read.js", { path: "empty.txt", startLine: 2, endLine: 1 }), /invalid_line_range/);
  assert.throws(() => run("file.read.js", { path: "empty.txt", files: [{ path: "empty.txt" }] }), { code: "invalid_arguments" });
  assert.throws(() => run("file.read.js", { files: [] }), { code: "invalid_arguments" });
  assert.throws(() => run("file.read.js", { files: [{ path: "empty.txt", encoding: "unknown" }] }), { code: "invalid_arguments" });
  const long = Array.from({ length: 220 }, (_, i) => "line " + (i + 1)).join("\n");
  writeFileSync(path.join(project, "long.txt"), long);
  const head = await run("file.read.js", { path: "long.txt" });
  assert.deepEqual([head.endLine, head.nextLine, head.totalLines, head.sha256], [200, 201, 220, sha(long)]);
  const rest = await run("file.read.js", { path: "long.txt", startLine: head.nextLine, expectedRevision: head.revision });
  assert.equal(head.text + "\n" + rest.text, long);
  assert.equal(rest.truncated, false);
});

test("file.read batches independent successes and bounded classified failures in order", async (t) => {
  const { project, run } = fixture(t);
  writeFileSync(path.join(project, "bad.txt"), Buffer.from([0xff, 0x01]));
  const batch = await run("file.read.js", { files: [
    { path: "src/example.txt", startLine: 2 },
    { path: "missing.txt" },
    { path: "bad.txt" },
    { path: "../outside.txt" },
    { path: "src/example.txt", startLine: 1, endLine: 1 },
  ] });
  assert.deepEqual(batch.results.map((item) => item.ok), [true, false, false, false, true]);
  assert.equal(batch.results[0].result.text, "second line\nthird line");
  assert.deepEqual(batch.results.slice(1, 4).map((item) => item.error.code), ["file_not_found", "file_not_text", "file_path_escape"]);
  assert.equal(batch.results[4].result.text, "first line");
});

test("file.read recognizes UTF BOMs and explicit legacy encodings without silent replacement", async (t) => {
  const { project, run } = fixture(t);
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("你好\n世界")]);
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("你好\n世界", "utf16le")]);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("你好\n世界", "utf16le").swap16()]);
  for (const [name, bytes, encoding] of [["utf8", utf8, "utf-8"], ["le", le, "utf-16le"], ["be", be, "utf-16be"]]) {
    writeFileSync(path.join(project, name), bytes);
    const read = await run("file.read.js", { path: name });
    assert.deepEqual([read.text, read.encoding, read.sha256], ["你好\n世界", encoding, sha(bytes)]);
  }
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  writeFileSync(path.join(project, "gbk.txt"), gbk);
  await assert.rejects(run("file.read.js", { path: "gbk.txt" }), /file_not_text/);
  assert.equal((await run("file.read.js", { path: "gbk.txt", encoding: "gbk" })).text, "你好");
  await assert.rejects(run("file.read.js", { path: "le", encoding: "utf-8" }), /file_not_text/);
  writeFileSync(path.join(project, "binary"), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(run("file.read.js", { path: "binary" }), /file_not_text/);
  writeFileSync(path.join(project, "invalid-utf16"), Buffer.from([0xff, 0xfe, 0x61]));
  await assert.rejects(run("file.read.js", { path: "invalid-utf16" }), /file_not_text/);
  const split = "x".repeat(65534) + "\n你好";
  writeFileSync(path.join(project, "split.txt"), split);
  const splitRead = await run("file.read.js", { path: "split.txt", startLine: 2 });
  assert.deepEqual([splitRead.text, splitRead.sha256], ["你好", sha(split)]);
});

test("file.read streams large files, keeps line boundaries and does not invent a whole-file hash", async (t) => {
  const { project, run } = fixture(t);
  const line = "文".repeat(40);
  const body = (line + "\n").repeat(12000);
  writeFileSync(path.join(project, "large.txt"), body);
  const page = await run("file.read.js", { path: "large.txt" });
  assert.ok(page.endLine < 200 && page.endLine > 0);
  assert.deepEqual([page.reason, page.nextLine, page.totalLines, page.sha256], ["output_budget", page.endLine + 1, null, null]);
  assert.equal(page.text, Array(page.endLine).fill(line).join("\n"));
  const next = await run("file.read.js", { path: "large.txt", startLine: page.nextLine, endLine: page.nextLine + 2, expectedRevision: page.revision });
  assert.equal(next.text, Array(3).fill(line).join("\n"));
  const tail = await run("file.read.js", { path: "large.txt", startLine: 11999 });
  assert.deepEqual([tail.totalLines, tail.sha256, tail.text, tail.truncated], [12001, sha(body), line + "\n" + line + "\n", false]);
  writeFileSync(path.join(project, "huge-line.txt"), "ok\n" + "x".repeat(20000) + "\nlast");
  const first = await run("file.read.js", { path: "huge-line.txt" });
  assert.deepEqual([first.text, first.nextLine, first.reason], ["ok", 2, "output_budget"]);
  await assert.rejects(run("file.read.js", { path: "huge-line.txt", startLine: 2 }), /file_output_too_large/);
  assert.equal((await run("file.read.js", { path: "huge-line.txt", startLine: 3 })).text, "last");
  writeFileSync(path.join(project, "escaped.txt"), ("\t".repeat(1000) + "\n").repeat(20));
  const escaped = await run("file.read.js", { path: "escaped.txt" });
  assert.ok(Buffer.byteLength(escaped.text) <= 12 * 1024);
  assert.equal(escaped.nextLine, escaped.endLine + 1);
});

test("file.read reports an exhausted scan budget instead of a fabricated empty page", async (t) => {
  const { project, run } = fixture(t);
  const filename = path.join(project, "far.txt");
  writeFileSync(filename, Buffer.alloc(32 * 1024 * 1024 + 1, 120));
  await assert.rejects(run("file.read.js", { path: "far.txt", startLine: 2 }), /file_read_budget/);
});

test("file.read refuses changed revisions, links, Windows-style escapes and non-files", async (t) => {
  const { root, project, run, catalog } = fixture(t);
  const filename = path.join(project, "src", "example.txt");
  const first = await run("file.read.js", { path: "src/example.txt", endLine: 1 });
  writeFileSync(filename, "changed\nnew line");
  await assert.rejects(run("file.read.js", { path: "src/example.txt", expectedRevision: first.revision }), /file_changed/);
  // A deterministic real mutation after reading the first chunk must invalidate
  // the result, including its complete-file SHA-256.
  let changed = false;
  class MutatingDecoder extends TextDecoder {
    decode(...args) {
      if (!changed) { changed = true; writeFileSync(filename, "changed again, different length"); }
      return super.decode(...args);
    }
  }
  const script = catalog.resolve("nexum/file.read.js");
  await assert.rejects(new AsyncFunction("context", "TextDecoder", script.code)({ project: { root: project }, pwd: project, input: { path: "src/example.txt" } }, MutatingDecoder), /file_changed/);
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(outside, path.join(project, "link"), process.platform === "win32" ? "junction" : "dir");
  for (const target of ["link/secret.txt", "C:\\outside", "C:outside", "../outside/secret.txt", outside]) {
    await assert.rejects(run("file.read.js", { path: target }), /file_path_escape/);
  }
  await assert.rejects(run("file.read.js", { path: "src" }), /file_not_text/);
});

test("file.list uses bounded breadth-first traversal, scoped globs and explicit paths", async (t) => {
  const { project, run } = fixture(t);
  mkdirSync(path.join(project, "src", "nested"));
  mkdirSync(path.join(project, "node_modules"));
  writeFileSync(path.join(project, "src", "nested", "文档.go"), "");
  writeFileSync(path.join(project, "src", "other_test.go"), "");
  writeFileSync(path.join(project, "node_modules", "hidden.go"), "");
  writeFileSync(path.join(project, "a.go"), "");
  const root = await run("file.list.js");
  assert.deepEqual(root.entries.map((entry) => entry.path), ["a.go", "node_modules", "src"]);
  assert.equal(root.total, 3);
  assert.equal(root.truncated, false);
  const filtered = await run("file.list.js", { depth: 3, include: ["**/*.go"], exclude: ["**/*_test.go"] });
  assert.deepEqual(filtered.entries.map((entry) => entry.path), ["a.go", "src/nested/文档.go"]);
  assert.equal(filtered.total, 2);
  const pruned = await run("file.list.js", { depth: 3, exclude: ["src/nested"] });
  assert.ok(!pruned.entries.some((entry) => entry.path.includes("nested")));
  assert.equal((await run("file.list.js", { path: "node_modules" })).entries[0].path, "node_modules/hidden.go");
  const noMatches = await run("file.list.js", { depth: 3, include: ["**/*.rs"] });
  assert.deepEqual([noMatches.entries, noMatches.total, noMatches.truncated], [[], 0, false]);
  assert.throws(() => run("file.list.js", { depth: 9 }), { code: "invalid_arguments" });
  assert.throws(() => run("file.list.js", { offset: -1 }), { code: "invalid_arguments" });
});

test("file.list paginates matching entries with no cursor or guessed totals", async (t) => {
  const { project, run } = fixture(t);
  mkdirSync(path.join(project, "many"));
  for (let i = 0; i < 5005; i++) writeFileSync(path.join(project, "many", "f" + String(i).padStart(4, "0")), "");
  const first = await run("file.list.js", { path: "many" });
  assert.deepEqual([first.entries.length, first.total, first.reason, first.nextOffset], [200, null, "limit", 200]);
  const second = await run("file.list.js", { path: "many", offset: first.nextOffset });
  const nearEnd = await run("file.list.js", { path: "many", offset: 4800 });
  const last = await run("file.list.js", { path: "many", offset: nearEnd.nextOffset });
  assert.deepEqual([second.entries.length, second.nextOffset, nearEnd.nextOffset, last.entries.length, last.total, last.nextOffset, last.truncated], [200, 400, 5000, 5, 5005, null, false]);
  assert.equal(new Set([...first.entries, ...second.entries, ...nearEnd.entries, ...last.entries].map((entry) => entry.path)).size, 605);
  assert.equal(last.entries.at(-1).name, "f5004");
  const filtered = await run("file.list.js", { path: "many", include: ["f00[01]?"], offset: 10, limit: 10 });
  assert.deepEqual(filtered.entries.map((entry) => entry.name), Array.from({ length: 10 }, (_, i) => "f001" + i));
  const pastEnd = await run("file.list.js", { path: "many", offset: 6000 });
  assert.deepEqual([pastEnd.entries, pastEnd.total, pastEnd.nextOffset], [[], 5005, null]);
});

test("file.list bounds output bytes and gives a usable offset", async (t) => {
  const { project, run } = fixture(t);
  const dir = path.join(project, "long");
  mkdirSync(dir);
  for (let i = 0; i < 150; i++) writeFileSync(path.join(dir, String(i).padStart(3, "0") + "文".repeat(55)), "");
  const page = await run("file.list.js", { path: "long", limit: 500 });
  assert.equal(page.reason, "output_budget");
  assert.ok(page.entries.length > 0 && page.entries.length < 150);
  assert.ok(Buffer.byteLength(page.entries.map(entry => entry.name).join("\n")) <= 12 * 1024);
  assert.equal(page.nextOffset, page.entries.length);
  const next = await run("file.list.js", { path: "long", offset: page.nextOffset, limit: 500 });
  assert.ok(next.entries[0].name > page.entries.at(-1).name);
});

test("file.list respects actual nested Git ignore rules and does not silently bypass failures", async (t) => {
  const { project, run } = fixture(t);
  const init = spawnSync("git", ["init", "-q"], { cwd: project, encoding: "utf8" });
  assert.equal(init.status, 0, init.error?.message ?? init.stderr);
  writeFileSync(path.join(project, ".gitignore"), "*.tmp\nignored/\n!ignored/keep.go\n");
  mkdirSync(path.join(project, "ignored"));
  writeFileSync(path.join(project, "ignored", "keep.go"), "");
  writeFileSync(path.join(project, "src", ".gitignore"), "!keep.tmp\n/nested.log\n");
  writeFileSync(path.join(project, "src", "keep.tmp"), "");
  writeFileSync(path.join(project, "src", "drop.tmp"), "");
  writeFileSync(path.join(project, "src", "忽略.tmp"), "");
  writeFileSync(path.join(project, "src", "nested.log"), "");
  writeFileSync(path.join(project, "src", "保留.txt"), "");
  const calls = [];
  const sh = { exec: async (options) => {
    calls.push(options);
    const env = { ...process.env };
    for (const [key, value] of Object.entries(options.env)) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    const result = spawnSync(options.command, options.args, { cwd: options.cwd, env, input: options.input, timeout: options.timeoutMs });
    assert.ifError(result.error);
    return { exitCode: result.status, outputComplete: true, hasMoreOutput: false, truncated: false,
      output: [{ stream: "stdout", data: result.stdout }] };
  } };
  const result = await run("file.list.js", { depth: 3 }, sh);
  assert.equal(result.truncated, false, JSON.stringify(result));
  assert.ok(result.entries.some((entry) => entry.path === "src/keep.tmp"));
  assert.ok(result.entries.some((entry) => entry.path === "src/保留.txt"));
  assert.ok(!result.entries.some((entry) => ["ignored", "ignored/keep.go", "src/drop.tmp", "src/忽略.tmp", "src/nested.log"].includes(entry.path)));
  assert.ok(!result.entries.some((entry) => entry.path.startsWith(".git/")));
  assert.ok(calls.length >= 2);
  const sub = await run("file.list.js", { path: "src" }, sh);
  assert.ok(sub.entries.some((entry) => entry.name === "keep.tmp"));
  assert.ok(!sub.entries.some((entry) => entry.name === "drop.tmp"));
  const unfiltered = await run("file.list.js", { depth: 3, respectGitignore: false });
  assert.ok(unfiltered.entries.some((entry) => entry.path === "ignored/keep.go"));
  const incomplete = await run("file.list.js", {}, { exec: async () => ({ exitCode: 0, outputComplete: false }) });
  assert.deepEqual([incomplete.reason, incomplete.total, incomplete.nextOffset, incomplete.entries], ["gitignore_unavailable", null, null, []]);
});

test("file.list reports incomplete enumeration without a false next offset", async (t) => {
  const { project, run } = fixture(t);
  const dir = path.join(project, "over-budget");
  mkdirSync(dir);
  for (let i = 0; i < 20001; i++) writeFileSync(path.join(dir, String(i).padStart(5, "0")), "");
  const result = await run("file.list.js", { path: "over-budget", limit: 1 });
  assert.ok(["scan_budget", "time_budget"].includes(result.reason), JSON.stringify(result));
  assert.deepEqual([result.truncated, result.total, result.nextOffset], [true, null, null]);
});

test("file.list never traverses symlink or Junction directories and rejects escaped inputs", async (t) => {
  const { root, project, run } = fixture(t);
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "hidden"), "");
  symlinkSync(outside, path.join(project, "link"), process.platform === "win32" ? "junction" : "dir");
  symlinkSync(path.join(project, "src"), path.join(project, "inside-link"), process.platform === "win32" ? "junction" : "dir");
  const result = await run("file.list.js", { depth: 3 });
  assert.equal(result.entries.find((entry) => entry.path === "link").type, "symlink");
  assert.ok(!result.entries.some((entry) => entry.path.startsWith("link/") || entry.path.startsWith("inside-link/")));
  for (const target of ["link", "inside-link", "../outside", "C:\\outside", "C:outside", outside]) {
    await assert.rejects(run("file.list.js", { path: target }), /file_path_escape/);
  }
});


test("file.search groups text matches, deduplicates overlapping context and pages by matching line", async (t) => {
  const { project, run } = fixture(t);
  writeFileSync(path.join(project, "src", "find.go"), "before\nAlpha beta\nBETA\nbetween\nalpha\nlast");
  writeFileSync(path.join(project, "src", "skip_test.go"), "alpha");
  const input = { query: ["alpha", "beta"], path: "src", include: ["**/*.go"], exclude: ["**/*_test.go"], limit: 2, contextLines: 1 };
  const first = await run("file.search.js", input);
  assert.equal(typeof first, "string");
  assert.match(first, /## src\/find\.go/);
  assert.match(first, /> 2 \| Alpha beta \[matched: alpha, beta\]/);
  assert.match(first, /> 3 \| BETA \[matched: beta\]/);
  assert.equal(first.match(/3 \| BETA/g)?.length, 1);
  assert.match(first, /1 \| before/);
  assert.match(first, /4 \| between/);
  assert.match(first, /offset=2 \(nextOffset\)/);
  assert.doesNotMatch(first, /skip_test\.go/);
  const second = await run("file.search.js", { ...input, offset: 2 });
  assert.match(second, /> 5 \| alpha/);
  assert.match(second, /Search complete.*3 matching lines/);
  assert.doesNotMatch(second, /nextOffset/);
  const sensitive = await run("file.search.js", { query: "BETA", caseSensitive: true, path: "src/find.go", contextLines: 0 });
  assert.match(sensitive, /> 3 \| BETA/);
  assert.doesNotMatch(sensitive, /> 2 \|/);
  assert.match(await run("file.search.js", { query: ".*", path: "src/find.go" }), /No matches returned/);
});

test("file.search finds long-line and cross-chunk matches, UTF BOM and explicit legacy encoding", async (t) => {
  const { project, run } = fixture(t);
  writeFileSync(path.join(project, "big.txt"), "x".repeat(65534) + "NEEDLE" + "y".repeat(400000) + "\nending");
  const big = await run("file.search.js", { query: "NEEDLE", path: "big.txt", contextLines: 1 });
  assert.match(big, /> 1 \| …x+NEEDLEy*…/);
  assert.match(big, /2 \| ending/);
  assert.ok(big.length < 2000);
  const utf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("第一行\n你好", "utf16le")]);
  writeFileSync(path.join(project, "utf16.txt"), utf);
  assert.match(await run("file.search.js", { query: "你好", path: "utf16.txt" }), /> 2 \| 你好/);
  writeFileSync(path.join(project, "gbk.txt"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  assert.match(await run("file.search.js", { query: "你好", path: "gbk.txt", encoding: "gbk" }), /> 1 \| 你好/);
  assert.match(await run("file.search.js", { query: "你好", path: "gbk.txt" }), /coverage is incomplete/);
  writeFileSync(path.join(project, "binary"), Buffer.concat([Buffer.from("NEEDLE\n"), Buffer.from([0, 1])]));
  const binary = await run("file.search.js", { query: "NEEDLE", path: "binary" });
  assert.match(binary, /No matches returned.*Skipped 1/);
  assert.doesNotMatch(binary, /> 1 \|/);
});

test("file.search respects Git filtering and reports unavailable ignore checks", async (t) => {
  const { project, run } = fixture(t);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  writeFileSync(path.join(project, ".gitignore"), "*.tmp\n");
  writeFileSync(path.join(project, "src", ".gitignore"), "!keep.tmp\n");
  writeFileSync(path.join(project, "src", "keep.tmp"), "needle");
  writeFileSync(path.join(project, "src", "drop.tmp"), "needle");
  const sh = { exec: async options => {
    const env = { ...process.env };
    for (const [key, value] of Object.entries(options.env)) {
      if (value === null) delete env[key]; else env[key] = value;
    }
    const result = spawnSync(options.command, options.args, { cwd: options.cwd, env, input: options.input, timeout: options.timeoutMs });
    assert.ifError(result.error);
    return { exitCode: result.status, outputComplete: true, hasMoreOutput: false, truncated: false, output: [{ stream: "stdout", data: result.stdout }] };
  }};
  const filtered = await run("file.search.js", { query: "needle", include: ["**/*.tmp"] }, sh);
  assert.match(filtered, /## src\/keep\.tmp/);
  assert.doesNotMatch(filtered, /drop\.tmp/);
  const all = await run("file.search.js", { query: "needle", include: ["**/*.tmp"], respectGitignore: false });
  assert.match(all, /## src\/drop\.tmp/);
  const failed = await run("file.search.js", { query: "needle" }, { exec: async () => ({ exitCode: 0, outputComplete: false }) });
  assert.match(failed, /Search incomplete \(gitignore_unavailable\)/);
  assert.match(failed, /No reliable nextOffset/);
});

test("file.search bounds output, preserves nextOffset and distinguishes scan exhaustion", async (t) => {
  const { project, run } = fixture(t);
  writeFileSync(path.join(project, "many.txt"), Array(100).fill("needle " + "文".repeat(120)).join("\n"));
  const page = await run("file.search.js", { query: "needle", path: "many.txt", contextLines: 0, limit: 100 });
  assert.match(page, /Search incomplete \(output_budget\)/);
  assert.ok(Buffer.byteLength(page) <= 12 * 1024);
  const nextOffset = Number(page.match(/offset=(\d+) \(nextOffset\)/)?.[1]);
  assert.ok(nextOffset > 0 && nextOffset < 100);
  const next = await run("file.search.js", { query: "needle", path: "many.txt", offset: nextOffset, contextLines: 0, limit: 1 });
  assert.ok(next.includes("> " + (nextOffset + 1) + " | needle"));
  writeFileSync(path.join(project, "over.txt"), Buffer.alloc(32 * 1024 * 1024 + 1, 120));
  const exhausted = await run("file.search.js", { query: "not-found", path: "over.txt" });
  assert.match(exhausted, /Search incomplete \((?:scan_budget|time_budget)\)/);
  assert.match(exhausted, /No reliable nextOffset/);
  assert.doesNotMatch(exhausted, /Search complete/);
});

test("file.search rejects explicit link and escaped targets and never searches linked subtrees", async (t) => {
  const { root, project, run } = fixture(t);
  const outside = path.join(root, "outside-search");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(outside, path.join(project, "search-link"), process.platform === "win32" ? "junction" : "dir");
  assert.match(await run("file.search.js", { query: "secret" }), /No matches returned/);
  for (const target of ["search-link/secret.txt", "../outside-search", "C:\\outside", outside]) {
    await assert.rejects(run("file.search.js", { query: "secret", path: target }), /file_path_escape/);
  }
});

test("file.list and file.read actual results contain only compact text, not JSON field objects", async (t) => {
  const { catalog, project } = fixture(t);
  for (const [name, input] of [["file.list.js", { path: "src" }], ["file.read.js", { path: "src/example.txt" }]]) {
    const script = catalog.resolve("nexum/" + name);
    assert.equal(script.metadata.scriptOutputSchema.type, "string");
    const report = await new AsyncFunction("context", script.code)({ project: { root: project }, pwd: project, input });
    assert.equal(typeof report, "string");
    assert.doesNotMatch(report, /"entries":|"text":|"totalLines":|"truncated":/);
    assert.ok(report.includes("example.txt"));
  }
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
    assert.equal(typeof result, "string");
    assert.match(result, /^## src\/example\.txt\n\nLines 1–3 \/ 3 · utf-8\n\n    1 \| first line\n    2 \| second line\n    3 \| third line\n\nSHA-256: [a-f0-9]{64}$/);
    await execute.flushCallbacks();
    await execute.audit();
  } finally {
    await execute.close();
  }
});

test("named file.list executes with the real isolated Node Worker", async (t) => {
  const { catalog, project, root } = fixture(t);
  mkdirSync(path.join(root, "modules"));
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const loader = await ModuleLoader.create(root, "builtin_list_workertest", {
    builtins: () => defaultBuiltins,
    approvedPackages: () => new Map(),
  });
  const script = catalog.resolve("nexum/file.list.js");
  const execute = await loader.compileIsolated(script.code, {
    context: { project: { root: project }, pwd: project, input: { depth: 2, include: ["**/*.txt"] } },
  });
  try {
    const result = await execute();
    assert.equal(result, "    src/\n      example.txt\n\nDirectory listing complete: 1 matching entries.");
    compileInputSchema(script.metadata.scriptOutputSchema)(result);
    await execute.flushCallbacks();
    await execute.audit();
  } finally {
    await execute.close();
  }
});

test("all packaged script headers compile on Node and file search preserves literal keyword boundaries", () => {
  // All files are the actual package sources. Go checks the same corpus in
  // TestPackagedScriptContracts; the execution-time validator is independent.
  for (const dir of ["../builtin/","../packages/browser/scripts/"]) {
    const directory = new URL(dir, import.meta.url);
    const files = readdirSync(directory).filter(name => name.endsWith(".js"));
    assert.equal(files.length, dir.includes("browser") ? 4 : 16);
    for (const name of files) {
      const metadata = scriptHeader(readFileSync(new URL(name,directory),"utf8"));
      assert.equal(metadata.scriptName,name);
      if (name !== "file.search.js") continue;
      const validate = compileInputSchema(metadata.scriptInputSchema);
      for (const query of ["literal.*","中文",["a","b"]]) validate({query});
      for (const query of ["","a\0b","a\rb","a\nb",["ok","\0"],[]])
        assert.throws(() => validate({query}), {code:"invalid_arguments"});
    }
  }
});
