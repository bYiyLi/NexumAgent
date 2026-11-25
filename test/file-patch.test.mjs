import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { compileInputSchema } from "../dist/contracts/validation.js";
import { defaultBuiltins, ModuleLoader } from "../dist/runtime/modules.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const wrap = (...lines) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-patch-test-")));
  const project = path.join(root, "project");
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ScriptCatalog(root, "agent");
  const script = catalog.resolve("nexum/file.patch.js");
  const validate = compileInputSchema(script.metadata.scriptInputSchema);
  const validateResult = compileInputSchema(script.metadata.scriptOutputSchema);
  const logs = [];
  const put = (name, contents) => {
    const target = path.join(project, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const get = name => readFileSync(path.join(project, name), "utf8");
  const exists = name => existsSync(path.join(project, name));
  async function run(patch, overrides = {}) {
    logs.length = 0;
    const input = { patch };
    validate(input);
    // Fault injection replaces only the fs import in a test-local copy.
    // The actual script, parser, match logic and filesystem operations run.
    const source = Object.keys(overrides).length
      ? script.code.replace('const fs = await import("node:fs/promises");', "const fs = injectedFS;")
      : script.code;
    if (Object.keys(overrides).length) assert.notEqual(source, script.code);
    const result = await new AsyncFunction("context", "console", "injectedFS", source)(
      { project: { root: project }, pwd: project, input },
      { log: text => logs.push(text) },
      { ...fsp, ...overrides },
    );
    validateResult(result);
    return result;
  }
  const assertClean = () => assert.ok(!readdirSync(project, { recursive: true }).some(name => String(name).includes(".nexum-patch-")));
  return { root, project, script, validate, run, logs, put, get, exists, assertClean };
}

test("file.patch uses only the Codex patch parameter, with a text output contract", t => {
  const { validate, script } = fixture(t);
  assert.doesNotThrow(() => validate({ patch: wrap("*** Add File: a", "+text") }));
  for (const invalid of [{}, { patch: "" }, { patch: 2 }, { path: "a", operation: "delete" }, { patch: "x", expectedSha256: "x" }]) {
    assert.throws(() => validate(invalid), { code: "invalid_arguments" });
  }
  assert.equal(script.metadata.scriptOutputSchema.type, "string");
});

test("one Codex patch adds, updates, deletes and moves files; creates nested directories", async t => {
  const f = fixture(t);
  f.put("src/a.txt", "head\nold\nend\n");
  f.put("gone.txt", "delete me");
  f.put("old.txt", "move me\n");
  const result = await f.run(wrap(
    "*** Update File: src/a.txt", "@@", " head", "-old", "+new", " end",
    "*** Add File: new/deep/空 格.txt", "+你好", "+",
    "*** Delete File: gone.txt",
    "*** Update File: old.txt", "*** Move to: new/moved.txt", "@@", "-move me", "+moved",
    "*** Add File: empty.txt"
  ));
  assert.match(result, /Patch applied successfully/);
  assert.match(result, /5 file operations verified/);
  assert.match(result, /M  "src\/a.txt"/);
  assert.match(result, /R  "old.txt" -> "new\/moved.txt"/);
  assert.equal(f.get("src/a.txt"), "head\nnew\nend\n");
  assert.equal(f.get("new/deep/空 格.txt"), "你好\n\n");
  assert.equal(f.get("empty.txt"), "");
  assert.equal(f.get("new/moved.txt"), "moved\n");
  assert.equal(f.exists("old.txt"), false);
  assert.equal(f.exists("gone.txt"), false);
  f.assertClean();
});

test("several hunks use original-file order, named context anchors and true EOF", async t => {
  const f = fixture(t);
  f.put("a.txt", "repeat\nsection A\nold\nsection B\nold\nrepeat\n");
  const result = await f.run(wrap("*** Update File: a.txt",
    "@@ section A", "-old", "+one",
    "@@ section B", "-old", "+two",
    "@@", "-repeat", "+tail", "*** End of File"));
  assert.match(result, /M  "a.txt"/);
  assert.equal(f.get("a.txt"), "repeat\nsection A\none\nsection B\ntwo\ntail\n");
});

test("context lines preserve actual whitespace and mixed original line endings", async t => {
  const f = fixture(t);
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  f.put("mixed.txt", Buffer.concat([bom, Buffer.from("  keep  \r\nold\nlast\r\n")]));
  await f.run(wrap("*** Update File: mixed.txt", "@@", " keep", "-old", "+新", " last"));
  assert.deepEqual(readFileSync(path.join(f.project, "mixed.txt")), Buffer.concat([bom, Buffer.from("  keep  \r\n新\r\nlast\r\n")]));
  f.put("unterminated.txt", "head\r\nlast");
  await f.run(wrap("*** Update File: unterminated.txt", "@@", "-last", "+end", "*** End of File"));
  assert.equal(f.get("unterminated.txt"), "head\r\nend");
  await f.run(wrap("*** Update File: unterminated.txt", "@@", "+added"));
  assert.equal(f.get("unterminated.txt"), "head\r\nend\r\nadded");
  f.put("empty.txt", "");
  await f.run(wrap("*** Update File: empty.txt", "@@", "+first"));
  assert.equal(f.get("empty.txt"), "first\n");
});

test("matching passes prefer exact, trailing whitespace, trim, then Unicode punctuation", async t => {
  const f = fixture(t);
  const examples = [
    ["exact", "  line\nline\n", "line", "  line\nnew\n"],
    ["rstrip", "line  \t\nother\n", "line", "new\nother\n"],
    ["trim", "   line \t\nother\n", "line", "new\nother\n"],
    ["punct", "“hello”—it’s\u00a0ok\nother\n", '"hello"-it\\\'s ok'.replace("\\'", "'"), "new\nother\n"]
  ];
  for (const [name, original, oldLine, expected] of examples) {
    f.put(name, original);
    await f.run(wrap("*** Update File: " + name, "@@", "-" + oldLine, "+new"));
    assert.equal(f.get(name), expected, name);
  }
});

test("first and last line replacement, addition-only append, blank lines and literal markers", async t => {
  const f = fixture(t);
  f.put("text", "first\n\nmiddle\n*** Update File: literal\nlast\n");
  await f.run(wrap("*** Update File: text", "-first", "+FIRST", " ",
    "@@", " *** Update File: literal", "-last", "+LAST", "*** End of File"));
  assert.equal(f.get("text"), "FIRST\n\nmiddle\n*** Update File: literal\nLAST\n");
  await f.run(wrap("*** Update File: text", "@@", "+*** End Patch"));
  assert.equal(f.get("text"), "FIRST\n\nmiddle\n*** Update File: literal\nLAST\n*** End Patch\n");
  f.put("blank", "head\nlast\n");
  await f.run(wrap("*** Update File: blank", "@@", "-last", "+tail", " ", "*** End of File"));
  assert.equal(f.get("blank"), "head\ntail\n");
});

test("move-only preserves exact bytes; delete operates on regular files", async t => {
  const f = fixture(t);
  const bytes = Buffer.from([0, 255, 13, 10]);
  f.put("old.bin", bytes);
  await f.run(wrap("*** Update File: old.bin", "*** Move to: moved.bin"));
  assert.equal(f.exists("old.bin"), false);
  assert.deepEqual(readFileSync(path.join(f.project, "moved.bin")), bytes);
  await f.run(wrap("*** Delete File: moved.bin"));
  assert.equal(f.exists("moved.bin"), false);
  f.assertClean();
});

test("no-op update is reported without replacing the original inode", async t => {
  const f = fixture(t);
  f.put("same", "same\n");
  const before = statSync(path.join(f.project, "same"), { bigint: true });
  const result = await f.run(wrap("*** Update File: same", "@@", "-same", "+same"));
  assert.match(result, /=  "same"/);
  assert.equal(statSync(path.join(f.project, "same"), { bigint: true }).ino, before.ino);
});

test("invalid syntax is rejected before any writes", async t => {
  const f = fixture(t);
  const bad = [
    "*** Add File: a\n+yes",
    "*** Begin Patch\n*** Add File: a\n+yes",
    wrap(), wrap("*** Unknown File: a", "+x"),
    wrap("*** Add File: a", "not prefixed"),
    wrap("*** Update File: a"),
    wrap("*** Update File: a", "@@"),
    wrap("*** Update File: a", "@@", "*** End of File"),
    wrap("*** Update File: a", "@@", "-old", "*** End of File", "+bad"),
    wrap("*** Delete File: a", "+bad"),
    wrap("*** Environment ID: other", "*** Add File: a", "+x"),
    wrap("*** Add File: a", "+\0"),
    wrap("*** Add File: a", "+\ud800"),
    wrap("*** Add File: a", "+yes") + "\nmore",
  ];
  for (const patch of bad) {
    await assert.rejects(f.run(patch), /invalid_patch/);
    assert.match(f.logs.join("\n"), /No file or directory writes were attempted/);
    assert.deepEqual(readdirSync(f.project), []);
  }
});

test("all files are checked before writing: missing, ambiguous, wrong EOF, duplicates and too-long patterns", async t => {
  const f = fixture(t);
  f.put("a", "dup\nmid\ndup\nlast\n");
  const original = f.get("a");
  const bad = [
    ["*** Update File: a", "@@", "-missing", "+new"],
    ["*** Update File: a", "@@", "-dup", "+new"],
    ["*** Update File: a", "@@", "-mid", "+new", "*** End of File"],
    ["*** Update File: a", "@@", "-dup", "-mid", "-dup", "-last", "-extra", "+new"],
    ["*** Update File: a", "@@ nope", "-last", "+new"],
    ["*** Update File: a", "@@", "-last", "+new", "@@", "-mid", "+new"],
    ["*** Delete File: absent"],
    ["*** Add File: a", "+overwrite"],
    ["*** Update File: a", "*** Move to: existing"],
    ["*** Update File: a", "@@", "-last", "+new", "*** Delete File: a"],
    ["*** Add File: new", "+x", "*** Add File: new/sub", "+y"],
  ];
  f.put("existing", "do not overwrite");
  for (const body of bad) {
    await assert.rejects(f.run(wrap("*** Add File: pending/deep/file", "+must not write", ...body)), /file_patch_conflict/);
    assert.match(f.logs.join("\n"), /No file or directory writes were attempted/);
    assert.equal(f.get("a"), original);
    assert.equal(f.exists("pending"), false);
    assert.equal(f.get("existing"), "do not overwrite");
    f.assertClean();
  }
});

test("ambiguous normalized context rejects instead of choosing the first match", async t => {
  const f = fixture(t);
  f.put("a", "    line\n  line\n");
  await assert.rejects(f.run(wrap("*** Update File: a", "@@", "-line", "+new")), /file_patch_conflict/);
  assert.match(f.logs.join("\n"), /ambiguous expected lines/);
  assert.equal(f.get("a"), "    line\n  line\n");
});

test("duplicate named anchors are rejected while precise context disambiguates repeated lines", async t => {
  const f = fixture(t);
  f.put("a", "section\nold\nmiddle\nsection\nold\nlast\n");
  await assert.rejects(f.run(wrap("*** Update File: a", "@@ section", "-old", "+new")), /file_patch_conflict/);
  assert.match(f.logs.join("\n"), /ambiguous context anchor/);
  await f.run(wrap("*** Update File: a", "@@", " middle", " section", "-old", "+new", " last"));
  assert.equal(f.get("a"), "section\nold\nmiddle\nsection\nnew\nlast\n");
});

test("CRLF patch transport, Windows-relative separators and trailing spaces in content", async t => {
  const f = fixture(t);
  f.put("src/a.txt", "old\r\n");
  const patch = wrap("*** Update File: src\\a.txt", "@@", "-old", "+new  ", "*** Add File: src/空 格.txt", "+content  ").replaceAll("\n", "\r\n");
  await f.run(patch);
  assert.equal(f.get("src/a.txt"), "new  \r\n");
  assert.equal(f.get("src/空 格.txt"), "content  \n");
});

test("strict path checks reject traversal, absolute paths, aliases, metadata and device names", async t => {
  const f = fixture(t);
  f.put("a", "unchanged");
  for (const name of ["../outside", "/absolute", "C:\\absolute", "C:relative", "\\\\host\\share\\file", ".git/config", ".GIT/hooks/pre-commit", "src/.platform-controls/x", "CON.txt", "x:stream", "file.", "file ", "dir//file", ".nexum-patch-other"]) {
    await assert.rejects(f.run(wrap("*** Add File: " + name, "+no")), /file_path_escape/);
    assert.equal(f.get("a"), "unchanged");
    assert.deepEqual(readdirSync(f.project), ["a"]);
  }
  await assert.rejects(f.run(wrap("*** Add File: ./A", "+x", "*** Add File: a", "+y")), /file_patch_conflict/);
  await assert.rejects(f.run(wrap("*** Update File: a", "*** Move to: ../out")), /file_path_escape/);
});

test("links, Junctions, directory targets and multiply-linked originals are rejected", async t => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "a"), "protected");
  symlinkSync(outside, path.join(f.project, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.run(wrap("*** Update File: linked/a", "@@", "-protected", "+bad")), /file_path_escape/);
  await assert.rejects(f.run(wrap("*** Add File: linked/new", "+bad")), /file_path_escape/);
  await assert.rejects(f.run(wrap("*** Delete File: linked")), /file_path_escape/);
  f.put("inside", "original");
  linkSync(path.join(f.project, "inside"), path.join(f.project, "alias"));
  await assert.rejects(f.run(wrap("*** Update File: inside", "@@", "-original", "+bad")), /file_patch_conflict/);
  assert.equal(f.get("inside"), "original");
  assert.equal(readFileSync(path.join(outside, "a"), "utf8"), "protected");
  assert.equal(existsSync(path.join(outside, "new")), false);
});

test("invalid UTF-8 and NUL text updates fail without changing other files", async t => {
  const f = fixture(t);
  for (const [name, bytes] of [["legacy", Buffer.from([0xff, 0x81])], ["binary.dat", Buffer.from([65, 0, 66])]]) {
    f.put(name, bytes);
    await assert.rejects(f.run(wrap("*** Add File: untouched", "+a", "*** Update File: " + name, "@@", "+b")), /file_not_text/);
    assert.equal(f.exists("untouched"), false);
    assert.deepEqual(readFileSync(path.join(f.project, name)), bytes);
  }
});

test("bounded patch bytes, file bytes and operation counts fail before writes", async t => {
  const f = fixture(t);
  f.put("huge", Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  await assert.rejects(f.run(wrap("*** Update File: huge", "@@", "+b")), /file_too_large/);
  const oversized = wrap("*** Add File: wide", "+" + "文".repeat(400000));
  // The public input gate can reject before the script itself is dispatched.
  await assert.rejects(f.run(oversized), /byte budget|file_too_large/);
  // Exercise the script's independent UTF-8 byte guard too.
  await assert.rejects(new AsyncFunction("context", "console", f.script.code)({ project: { root: f.project }, pwd: f.project, input: { patch: oversized } }, { log() {} }), /file_too_large/);
  const many = Array.from({ length: 65 }, (_, i) => ["*** Add File: f" + i, "+x"]).flat();
  await assert.rejects(f.run(wrap(...many)), /file_patch_budget/);
  assert.deepEqual(readdirSync(f.project), ["huge"]);
});

test("concurrent source change after staging is detected; no overwrite, cleanup confirmed", async t => {
  const f = fixture(t);
  f.put("a", "old\n");
  let mutated = false;
  await assert.rejects(f.run(wrap("*** Update File: a", "@@", "-old", "+new"), {
    async open(name, flags, mode) {
      const fd = await fsp.open(name, flags, mode);
      if (!mutated && flags === "wx") {
        mutated = true;
        f.put("a", "external edit\n");
      }
      return fd;
    }
  }), /file_patch_partial/);
  assert.equal(f.get("a"), "external edit\n");
  assert.match(f.logs.join("\n"), /file changed since preflight/);
  assert.match(f.logs.join("\n"), /different bytes present/);
  f.assertClean();
});

test("add destination race does not overwrite a concurrent winner", async t => {
  const f = fixture(t);
  await assert.rejects(f.run(wrap("*** Add File: a", "+ours"), {
    async link(source, destination) {
      writeFileSync(destination, "external winner\n", { flag: "wx" });
      return fsp.link(source, destination);
    }
  }), /file_patch_partial/);
  assert.equal(f.get("a"), "external winner\n");
  assert.match(f.logs.join("\n"), /different bytes present/);
  f.assertClean();
});

test("staged byte corruption is rejected before original publication", async t => {
  const f = fixture(t);
  f.put("a", "old\n");
  await assert.rejects(f.run(wrap("*** Update File: a", "@@", "-old", "+new"), {
    async open(name, flags, mode) {
      const fd = await fsp.open(name, flags, mode);
      if (flags !== "wx") return fd;
      return {
        stat: fd.stat.bind(fd), writeFile: fd.writeFile.bind(fd),
        chmod: fd.chmod.bind(fd), sync: fd.sync.bind(fd),
        async close() {
          await fd.close();
          writeFileSync(name, "corrupted staging bytes\n");
        }
      };
    }
  }), /file_patch_partial/);
  assert.equal(f.get("a"), "old\n");
  assert.match(f.logs.join("\n"), /Staged bytes changed before publication/);
  f.assertClean();
});

test("parent-directory replacement fails closed without following the new link", async t => {
  const f = fixture(t);
  f.put("src/a", "old\n");
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "a"), "outside\n");
  let redirected = false;
  await assert.rejects(f.run(wrap("*** Update File: src/a", "@@", "-old", "+new"), {
    async open(name, flags, mode) {
      const fd = await fsp.open(name, flags, mode);
      if (flags === "wx" && !redirected) {
        redirected = true;
        // Rename only after closing the temporary descriptor, including on
        // Windows where an open descriptor may block directory replacement.
        return {
          stat: fd.stat.bind(fd), writeFile: fd.writeFile.bind(fd),
          chmod: fd.chmod.bind(fd), sync: fd.sync.bind(fd),
          async close() {
            await fd.close();
            await fsp.rename(path.join(f.project, "src"), path.join(f.project, "held"));
            await fsp.symlink(outside, path.join(f.project, "src"), process.platform === "win32" ? "junction" : "dir");
          }
        };
      }
      return fd;
    }
  }), /file_patch_partial/);
  assert.equal(readFileSync(path.join(outside, "a"), "utf8"), "outside\n");
  assert.equal(f.get("held/a"), "old\n");
  assert.match(f.logs.join("\n"), /parent is not a real directory/);
  assert.match(f.logs.join("\n"), /Temporary file cleanup unverified/);
});

test("unsupported no-clobber publication reports failure without writing a destination", async t => {
  const f = fixture(t);
  await assert.rejects(f.run(wrap("*** Add File: new/a", "+ours"), {
    async link() { throw Object.assign(Error("injected unsupported filesystem"), { code: "ENOTSUP" }); }
  }), /file_patch_partial/);
  assert.equal(f.exists("new/a"), false);
  assert.equal(f.exists("new"), true);
  assert.match(f.logs.join("\n"), /Created directories \(not automatically removed\):\n"new"/);
  f.assertClean();
});

test("multi-file I/O failure distinguishes verified, current and not attempted", async t => {
  const f = fixture(t);
  f.put("a", "old\n"); f.put("b", "old\n"); f.put("c", "old\n");
  await assert.rejects(f.run(wrap(
    "*** Update File: a", "@@", "-old", "+new",
    "*** Update File: b", "@@", "-old", "+new",
    "*** Update File: c", "@@", "-old", "+new"
  ), {
    async rename(from, to) {
      if (path.basename(to) === "b") throw Object.assign(Error("injected I/O failure"), { code: "EIO" });
      return fsp.rename(from, to);
    }
  }), /file_patch_partial/);
  assert.deepEqual([f.get("a"), f.get("b"), f.get("c")], ["new\n", "old\n", "old\n"]);
  const log = f.logs.join("\n");
  assert.match(log, /Previously verified operations:\nM  "a"/);
  assert.match(log, /Current operation: M  "b"\n"b": original bytes present/);
  assert.match(log, /Not attempted:\nM  "c"/);
  f.assertClean();
});

test("move failure after destination publication reports both files; no blind rollback", async t => {
  const f = fixture(t);
  f.put("source", "source\n");
  await assert.rejects(f.run(wrap("*** Update File: source", "*** Move to: destination"), {
    async unlink(name) {
      if (path.basename(name) === "source") throw Object.assign(Error("injected unlink error"), { code: "EACCES" });
      return fsp.unlink(name);
    }
  }), /file_patch_partial/);
  assert.equal(f.get("source"), "source\n");
  assert.equal(f.get("destination"), "source\n");
  assert.match(f.logs.join("\n"), /"source": original bytes present\n"destination": expected bytes present/);
  f.assertClean();
});

test("read-back catches corruption after rename and does not report verified success", async t => {
  const f = fixture(t);
  f.put("a", "old\n");
  await assert.rejects(f.run(wrap("*** Update File: a", "@@", "-old", "+new"), {
    async rename(from, to) {
      await fsp.rename(from, to);
      writeFileSync(to, "changed after publication\n");
    }
  }), /file_patch_partial/);
  assert.equal(f.get("a"), "changed after publication\n");
  assert.match(f.logs.join("\n"), /read-back verification failed/);
  assert.match(f.logs.join("\n"), /Previously verified operations:\n\(none\)/);
  f.assertClean();
});

test("actual isolated Node Worker applies a named patch and returns only compact Markdown", async t => {
  const f = fixture(t);
  f.put("a", "old\n");
  mkdirSync(path.join(f.root, "modules"));
  writeFileSync(path.join(f.root, "package.json"), '{"type":"module"}');
  const loader = await ModuleLoader.create(f.root, "patch_worker_test", {
    builtins: () => defaultBuiltins,
    approvedPackages: () => new Map(),
  });
  const execute = await loader.compileIsolated(f.script.code, {
    context: { project: { root: f.project }, pwd: f.project, input: { patch: wrap("*** Update File: a", "@@", "-old", "+new", "*** Add File: nested/b", "+ok") } },
  });
  try {
    const result = await execute();
    assert.match(result, /^Patch applied successfully\./);
    assert.match(result, /2 file operations verified/);
    assert.equal(f.get("a"), "new\n");
    assert.equal(f.get("nested/b"), "ok\n");
    await execute.flushCallbacks();
    await execute.audit();
  } finally { await execute.close(); }
});
