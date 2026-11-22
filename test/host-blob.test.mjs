import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Blob, File } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeGoArguments, decodeGoResult } from "../dist/host/blob.js";

test("binary inputs and outputs use authorized file tickets and preserve ordinary JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexum-blob-test-"));
  const scope = { instanceId: "instance", runId: "run" };
  const uploads = new Map();
  let sequence = 0;
  const call = async (method, params) => {
    assert.equal(params.instanceId, scope.instanceId);
    assert.equal(params.runId, scope.runId);
    if (method === "blob.limits") return { inputBytes: 64 * 1024 * 1024, outputBytes: 64 * 1024 * 1024 };
    if (method === "blob.prepare") {
      const ticket = `ticket-${++sequence}`;
      const file = path.join(root, ticket);
      await writeFile(file, "", { mode: 0o600 });
      uploads.set(ticket, { file, kind: params.kind, originalName: params.originalName, originalType: params.originalType });
      return { ticket, path: file };
    }
    if (method === "blob.commit") {
      const transfer = uploads.get(params.ticket);
      const file = transfer.file;
      const body = await readFile(file);
      assert.equal(body.length, params.size);
      assert.equal(createHash("sha256").update(body).digest("hex"), params.sha256);
      await rm(file);
      uploads.delete(params.ticket);
      return { id: `resource-${params.ticket}`, name: params.name, contentType: params.contentType, kind: transfer.kind, ...(transfer.originalName === undefined ? {} : { originalName: transfer.originalName }), ...(transfer.originalType === undefined ? {} : { originalType: transfer.originalType }) };
    }
    if (method === "blob.open") {
      assert.equal(params.ref.id, "result");
      const ticket = `ticket-${++sequence}`;
      const file = path.join(root, ticket);
      const body = Buffer.from([4, 5, 6]);
      await writeFile(file, body, { mode: 0o600 });
      uploads.set(ticket, { file });
      return { ticket, path: file, size: body.length, sha256: createHash("sha256").update(body).digest("hex"), contentType: "application/octet-stream" };
    }
    if (method === "blob.release") {
      await rm(uploads.get(params.ticket).file);
      uploads.delete(params.ticket);
      return {};
    }
    throw new Error("unexpected call");
  };
  try {
    const buffer = new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4);
    const encoded = await encodeGoArguments([{ body: { file: new Blob([buffer]), spoof: { id: "result" } } }], scope, call, new AbortController().signal);
    assert.deepEqual(encoded.arguments, [{ body: { file: null, spoof: { id: "result" } } }]);
    assert.deepEqual(encoded.binaryInputs.map((item) => item.path), [[0, "body", "file"]]);
    const result = await decodeGoResult({ value: { status: 200, data: null }, binaryOutputs: [{ path: ["data"], ref: { id: "result" } }] }, scope, call, new AbortController().signal);
    assert.equal(result.status, 200);
    assert.deepEqual(new Uint8Array(await result.data.arrayBuffer()), new Uint8Array([4, 5, 6]));
    const rootValue = await decodeGoResult({ value: null, binaryOutputs: [{ path: [], ref: { id: "result" } }] }, scope, call, new AbortController().signal);
    assert.deepEqual(new Uint8Array(await rootValue.arrayBuffer()), new Uint8Array([4, 5, 6]));
    assert.equal(uploads.size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("binary output rejects non-null paths", async () => {
  const scope = { instanceId: "instance", runId: "run" };
  const call = async (method) => { if (method === "blob.limits") return { inputBytes: 1, outputBytes: 1 }; throw new Error("should not request a file"); };
  await assert.rejects(() => decodeGoResult({ value: { data: "ordinary" }, binaryOutputs: [{ path: ["data"], ref: { id: "x" } }] }, scope, call, new AbortController().signal));
});

test("binary output rejects corrupted data and releases the ticket", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexum-blob-corrupt-"));
  const file = path.join(root, "ticket");
  const scope = { instanceId: "instance", runId: "run" };
  let released = false;
  await writeFile(file, "corrupt", { mode: 0o600 });
  const call = async (method, params) => {
    if (method === "blob.limits") return { inputBytes: 64 * 1024 * 1024, outputBytes: 64 * 1024 * 1024 };
    if (method === "blob.open") return { ticket: "ticket", path: file, size: 7, sha256: "0".repeat(64), contentType: "application/octet-stream" };
    if (method === "blob.release") { assert.equal(params.ticket, "ticket"); released = true; return {}; }
    throw new Error("unexpected call");
  };
  try {
    await assert.rejects(() => decodeGoResult({ value: null, binaryOutputs: [{ path: [], ref: { id: "x" } }] }, scope, call, new AbortController().signal), /committed contents/);
    assert.equal(released, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("binary output rejects a type different from the issued reference", async () => {
  const scope = { instanceId: "instance", runId: "run" };
  let released = false;
  const call = async (method) => {
    if (method === "blob.limits") return { inputBytes: 64 * 1024 * 1024, outputBytes: 64 * 1024 * 1024 };
    if (method === "blob.open") return { ticket: "ticket", path: "/unused", size: 0, sha256: "0".repeat(64), contentType: "application/octet-stream", kind: "blob" };
    if (method === "blob.release") { released = true; return {}; }
    throw new Error("unexpected call");
  };
  await assert.rejects(() => decodeGoResult({ value: null, binaryOutputs: [{ path: [], ref: { id: "x", kind: "uint8array" } }] }, scope, call, new AbortController().signal), /metadata is invalid/);
  assert.equal(released, true);
});

test("invalid SDK data is rejected before any binary transfer starts", async () => {
  let calls = 0;
  const call = async () => { calls++; throw new Error("unexpected transfer"); };
  await assert.rejects(() => encodeGoArguments([new Blob(["content"]), undefined], { instanceId: "instance", runId: "run" }, call, new AbortController().signal));
  assert.equal(calls, 0);
});

test("binary transfers preserve the native value type and File metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexum-binary-kind-"));
  const scope = { instanceId: "instance", runId: "run" };
  const transfers = new Map();
  let sequence = 0;
  const call = async (method, params) => {
    if (method === "blob.limits") return { inputBytes: 64 * 1024 * 1024, outputBytes: 64 * 1024 * 1024 };
    if (method === "blob.prepare") {
      const ticket = String(++sequence);
      const file = path.join(root, ticket);
      await writeFile(file, "", { mode: 0o600 });
      transfers.set(ticket, { file, kind: params.kind, lastModified: params.lastModified, originalName: params.originalName, originalType: params.originalType });
      return { ticket, path: file };
    }
    if (method === "blob.commit") {
      const transfer = transfers.get(params.ticket);
      const bytes = await readFile(transfer.file);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), params.sha256);
      transfer.contentType = params.contentType;
      transfer.name = params.name;
      return { id: params.ticket, name: params.name, contentType: params.contentType, kind: transfer.kind, ...(transfer.lastModified === undefined ? {} : { lastModified: transfer.lastModified }), ...(transfer.originalName === undefined ? {} : { originalName: transfer.originalName }), ...(transfer.originalType === undefined ? {} : { originalType: transfer.originalType }) };
    }
    if (method === "blob.open") {
      const transfer = transfers.get(params.ref.id);
      const bytes = await readFile(transfer.file);
      return { ticket: params.ref.id, path: transfer.file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: transfer.contentType, kind: transfer.kind, ...(transfer.lastModified === undefined ? {} : { lastModified: transfer.lastModified }), ...(transfer.originalName === undefined ? {} : { originalName: transfer.originalName }), ...(transfer.originalType === undefined ? {} : { originalType: transfer.originalType }) };
    }
    if (method === "blob.release") return {};
    throw new Error("unexpected call");
  };
  const items = [new Blob(["test"]), new File(["test"], "test.bin", { lastModified: 123 }), new File(["test"], "\r\n", { lastModified: 0 }), new File(["test"], "", { lastModified: -1 }),
    Buffer.from([1,2,3,4,5,6,7,8]), new Uint8Array([1,2,3,4]), new Int8Array([1,2,3,4]),
    new Uint8ClampedArray([1,2,3,4]), new Int16Array([1,2]), new Uint16Array([1,2]),
    new Int32Array([1,2]), new Uint32Array([1,2]), new Float32Array([1,2]), new Float64Array([1,2]),
    new BigInt64Array([1n]), new BigUint64Array([1n]), new DataView(new ArrayBuffer(8)), new ArrayBuffer(8),
    ...(typeof Float16Array === "function" ? [new Float16Array([1,2])] : [])];
  try {
    for (const original of items) {
      const encoded = await encodeGoArguments([original], scope, call, new AbortController().signal);
      const ref = encoded.binaryInputs[0].ref;
      const restored = await decodeGoResult({ value: null, binaryOutputs: [{ path: [], ref }] }, scope, call, new AbortController().signal);
      assert.equal(restored.constructor, original.constructor);
      if (original instanceof Blob) assert.equal(restored.type, original.type);
      if (original instanceof File) { assert.equal(restored.name, original.name); assert.equal(restored.lastModified, original.lastModified); }
      const data = async (value) => value instanceof Blob ? Buffer.from(await value.arrayBuffer()) : value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      assert.deepEqual(await data(restored), await data(original));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("binary input obeys the trusted per-method limit above the default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexum-binary-limit-"));
  const file = path.join(root, "ticket");
  const bytes = new Uint8Array(64 * 1024 * 1024 + 1);
  bytes[0] = 1; bytes[bytes.length - 1] = 2;
  const scope = { instanceId: "instance", runId: "run", methodId: "approved-method" };
  let allowed = bytes.length, prepared = 0;
  const call = async (method, params) => {
    assert.equal(params.methodId, scope.methodId);
    if (method === "blob.limits") return { inputBytes: allowed, outputBytes: allowed };
    if (method === "blob.prepare") { prepared++; await writeFile(file, "", { mode: 0o600 }); return { ticket: "ticket", path: file }; }
    if (method === "blob.commit") {
      assert.equal(params.size, bytes.length);
      const fileBytes = await readFile(file);
      assert.equal(fileBytes.length, bytes.length);
      assert.equal(createHash("sha256").update(fileBytes).digest("hex"), params.sha256);
      return { id: "approved", name: params.name, contentType: params.contentType, kind: "uint8array" };
    }
    if (method === "blob.release") return {};
    throw new Error("unexpected call");
  };
  try {
    const result = await encodeGoArguments([bytes], scope, call, new AbortController().signal);
    assert.equal(result.binaryInputs[0].ref.kind, "uint8array");
    allowed = bytes.length - 1;
    await assert.rejects(() => encodeGoArguments([bytes], scope, call, new AbortController().signal), /approved byte budget/);
    assert.equal(prepared, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
