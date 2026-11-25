import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { compileInputSchema } from "../dist/contracts/validation.js";
import { renderResourceText, resolveResourceRead } from "../dist/host/resource-read.js";
import { outputIntent } from "../dist/sdk/output.js";

const uri = "nexum://agents/fixture/resources/res_0123456789abcdef0123456789abcdef";
const descriptor = { uri, name: "notes.txt", mimeType: "text/plain" };
const source = (...chunks) => async visit => { for (const chunk of chunks) visit(Buffer.from(chunk)); };
const script = readFileSync(new URL("../builtin/resource.read.js", import.meta.url), "utf8");
const metadata = JSON.parse(script.slice(3, script.indexOf("\n*/")));
const validate = compileInputSchema(metadata.scriptInputSchema);
const execute = new (Object.getPrototypeOf(async function () {}).constructor)("context", "runtime", "transfer", script);

test("resource script uses exact URI and preserves native SDK and Offer identities", async () => {
  const calls = [], offer = {}, native = {};
  let value = { kind: "text", value: "hello" };
  const runtime = { readResource: async input => { calls.push(["read", input]); return value; } };
  const transfer = { createDownload: async input => { calls.push(["download", input]); return offer; } };
  const run = input => { validate(input); return execute({ input }, runtime, transfer); };
  assert.equal(await run({ uri }), "hello");
  assert.deepEqual(calls.splice(0), [["read", { uri, mode: "auto" }]]);
  assert.equal(await run({ uri, mode: "content", startLine: 2, endLine: 4 }), "hello");
  assert.deepEqual(calls.splice(0), [["read", { uri, mode: "content", startLine: 2, endLine: 4 }]]);
  value = { kind: "image", value: native };
  assert.equal(await run({ uri }), native);
  assert.deepEqual(calls.splice(0), [["read", { uri, mode: "auto" }]]);
  value = { kind: "file" };
  assert.equal(await run({ uri }), offer);
  assert.deepEqual(calls.splice(0), [["read", { uri, mode: "auto" }], ["download", { uri }]]);
  assert.equal(await run({ uri, mode: "download" }), offer);
  assert.deepEqual(calls.splice(0), [["download", { uri }]]);
  for (const input of [{}, { uri: "" }, { uri, mode: "download", startLine: 1 }, { uri, endLine: 0 }, { uri, mode: "raw" }, { uri, path: "/private" }]) {
    await assert.rejects(async () => run(input), { code: "invalid_arguments" });
  }
  assert.deepEqual(calls, []);
});

test("text rendering counts real lines across CRLF and split UTF-8 without truncating", async () => {
  const bytes = Buffer.from("first\r\n你好\n\nlast\r");
  const chunks = [...bytes].map(byte => Buffer.from([byte]));
  const full = await renderResourceText(source(...chunks), descriptor);
  assert.match(full, /Lines 1–4 \/ 4 · Complete/);
  assert.ok(full.endsWith("    1 | first\n    2 | 你好\n    3 | \n    4 | last\r"));
  const part = await renderResourceText(source(...chunks), descriptor, 2, 3);
  assert.match(part, /Lines 2–3 \/ 4/);
  assert.match(part, /    2 \| 你好\n    3 \| \n\nNextLine: 4$/);
  assert.doesNotMatch(part, /first|last/);
  assert.match(await renderResourceText(source(""), descriptor), /Lines 0–0 \/ 0 · Complete/);
  assert.match(await renderResourceText(source("a\n\n"), descriptor), /Lines 1–2 \/ 2/);
  assert.match(await renderResourceText(source("a\nb\n"), descriptor, 2, 999), /Lines 2–2 \/ 2/);
  await assert.rejects(renderResourceText(source("one"), descriptor, 2), { code: "resource_range_invalid" });
  await assert.rejects(renderResourceText(source("one"), descriptor, 2, 1), { code: "invalid_arguments" });
  await assert.rejects(renderResourceText(source("one\n", [255]), descriptor, 1, 1), { code: "invalid_resource_encoding" });
});

test("JSON is original UTF-8 text (even precision-sensitive numbers); ranges are ordinary text", async () => {
  const original = '\ufeff{\n  "large": 9007199254740993,\n  "x": "你好"\n}\n';
  const json = { ...descriptor, mimeType: "application/json" };
  assert.equal(await renderResourceText(source(original), json), original);
  const range = await renderResourceText(source(original), json, 2, 2);
  assert.match(range, /2 \|   "large": 9007199254740993,/);
  assert.match(range, /NextLine: 3$/);
});

test("resource plans use verified original identity, release staging and never copy media into a new resource", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexum-read-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "body");
  const bytes = Buffer.from("one\ntwo\nthree");
  await writeFile(file, bytes);
  const identity = { ...descriptor, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const plan = { kind: "text", resource: identity, ref: { id: uri, kind: "buffer", name: identity.name, contentType: identity.mimeType }, startLine: 2, endLine: 2 };
  const scope = { instanceId: "host", runId: "run", methodId: "method" };
  const calls = [];
  const call = async (method, input) => {
    calls.push([method, input]);
    if (method === "blob.open") return { ticket: "ticket", path: file, kind: "buffer", size: bytes.length, sha256: identity.sha256, contentType: identity.mimeType };
    if (method === "blob.release") return { released: true };
    if (method === "artifacts.metadata") return identity;
    throw Error(method);
  };
  const signal = new AbortController().signal;
  const result = await resolveResourceRead(plan, scope, call, signal, dir);
  assert.equal(result.kind, "text");
  assert.match(result.value, /2 \| two\n\nNextLine: 3$/);
  assert.equal(calls[0][0], "blob.open");
  assert.equal(calls[0][1].methodId, scope.methodId);
  assert.equal(calls[1][0], "blob.release");
  calls.length = 0;
  const media = await resolveResourceRead({ kind: "image", resource: { ...identity, mimeType: "image/png" } }, scope, call, signal, dir);
  assert.deepEqual(outputIntent(media.value).value, { uri, mimeType: "image/png" });
  assert.deepEqual(calls, []);
  await writeFile(file, Buffer.from("Xne\ntwo\nthree"));
  await assert.rejects(resolveResourceRead(plan, scope, call, signal, dir), { code: "invalid_resource" });
  assert.equal(calls.at(-1)[0], "blob.release");
});
