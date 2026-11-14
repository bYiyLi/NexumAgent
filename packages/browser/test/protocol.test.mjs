import assert from "node:assert/strict";
import test from "node:test";
import {
  BinaryInbox,
  data,
  pack,
  frames,
  unpack,
  limits,
  permissionDenied,
} from "../dist/extension/protocol.js";
const binding = { actionId: "action", operationId: "operation", generation: 1 };
function transport(value) {
  const payload = pack(value, binding),
    inbox = new BinaryInbox();
  for (const stream of payload.streams) {
    inbox.begin(stream.meta, () => true);
    for (const frame of frames(stream.meta, stream.bytes)) inbox.push(frame);
    inbox.end(stream.meta);
  }
  return unpack(
    payload.value,
    payload.attachments,
    payload.valueStream,
    inbox,
    binding,
  );
}

test("real byte and large JSON frames preserve data without enumerating binary metadata or losing dictionary keys", () => {
  let calls = 0;
  const image = Buffer.alloc(10 * 1024 * 1024, 17);
  Object.defineProperty(image, "private", {
    get() {
      calls++;
      throw new Error("private getter");
    },
  });
  const source = JSON.parse('{"__proto__":{"safe":true},"text":"a"}');
  source.image = image.subarray(3, -5);
  source.large = "\0".repeat(200000);
  const result = transport(source);
  assert.equal(calls, 0);
  assert.equal(result.image.length, image.length - 8);
  assert.equal(result.image[0], 17);
  assert.equal(result.large, source.large);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.deepEqual(result.__proto__, { safe: true });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});
test("binary ordering, ownership, completion, hash and encoded control budgets reject without partial values", () => {
  const payload = pack(Buffer.from("exact bytes"), binding),
    stream = payload.streams[0],
    parts = [...frames(stream.meta, stream.bytes)];
  const wrong = new BinaryInbox();
  assert.throws(() => wrong.begin(stream.meta, () => false), {
    code: "PROTOCOL_MISMATCH",
  });
  const pending = new BinaryInbox();
  pending.begin(stream.meta, () => true);
  assert.throws(() => pending.take(stream.meta.streamId, binding), {
    code: "PROTOCOL_MISMATCH",
  });
  const unordered = Buffer.from(parts[0]),
    length = unordered.readUInt32BE(0),
    header = JSON.parse(unordered.subarray(4, 4 + length));
  header.sequence = 3;
  const encoded = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(encoded.length);
  assert.throws(
    () =>
      pending.push(
        Buffer.concat([prefix, encoded, unordered.subarray(4 + length)]),
      ),
    { code: "PROTOCOL_MISMATCH" },
  );
  const corrupt = new BinaryInbox();
  corrupt.begin(stream.meta, () => true);
  const part = Buffer.from(parts[0]);
  part[part.length - 1] ^= 1;
  corrupt.push(part);
  assert.throws(() => corrupt.end(stream.meta), { code: "PROTOCOL_MISMATCH" });
  assert.throws(() => data("\0".repeat(limits.controlBytes / 4)), {
    code: "OUTPUT_TOO_LARGE",
  });
  assert.throws(
    () =>
      pack(
        {
          get hidden() {
            throw new Error("getter must not run");
          },
        },
        binding,
      ),
    { code: "INVALID_ARGUMENT" },
  );
});
test("completed streams are not counted as active and cancelled streams can drain without retaining output", () => {
  const input = Array.from({ length: 12 }, (_, i) => Buffer.from([i]));
  const result = transport(input);
  assert.deepEqual(
    result.map((value) => value[0]),
    Array.from({ length: 12 }, (_, i) => i),
  );
  const payload = pack(Buffer.alloc(100000, 9), binding),
    stream = payload.streams[0],
    inbox = new BinaryInbox(),
    parts = [...frames(stream.meta, stream.bytes)];
  inbox.begin(stream.meta, () => true);
  inbox.push(parts[0]);
  inbox.discard(binding.actionId);
  inbox.push(parts[1]);
  inbox.end(stream.meta);
  assert.throws(() => inbox.take(stream.meta.streamId, binding), {
    code: "PROTOCOL_MISMATCH",
  });
});

test("per-item read denials omit only real authorization denials and keep source configuration failures actionable", () => {
  assert.equal(
    permissionDenied(
      Object.assign(new Error("denied"), { code: "permission_denied" }),
    ),
    true,
  );
  class SourceConfigError extends Error {
    code = "permission_denied";
  }
  assert.equal(permissionDenied(new SourceConfigError("bad policy")), false);
  let getters = 0;
  assert.equal(
    permissionDenied(
      Object.defineProperty(new Error("denied"), "code", {
        get() {
          getters++;
          return "permission_denied";
        },
      }),
    ),
    false,
  );
  assert.equal(getters, 0);
  assert.equal(
    permissionDenied(
      new Proxy(
        {},
        {
          get() {
            getters++;
          },
        },
      ),
    ),
    false,
  );
  assert.equal(getters, 0);
});
