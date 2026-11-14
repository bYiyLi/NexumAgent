import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";

const moduleUrl =
  process.env.NEXUM_DATA_PLANE_MODULE ??
  new URL("../dist/application/data-plane.js", import.meta.url).href;
const { AgentDataPlane } = await import(moduleUrl);
const { canonicalJson } = await import(
  new URL("../contracts/json.js", moduleUrl).href
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binding = {
  agentId: "agent_fixture",
  profile: "development",
  bootId: "boot_fixture",
  cloudEnvironment: "development",
  connectionId: "conn_fixture",
};
const token = "private_agent_credential_fixture";
const signal = () => AbortSignal.timeout(10_000);
const ref = (direction, purpose, bytes, extra = {}) => ({
  streamId: "stream_fixture",
  direction,
  purpose,
  expiresAt: new Date(Date.now() + 15_000).toISOString(),
  maxBytes: 2 * 1024 * 1024,
  mimeType: "application/octet-stream",
  ...(bytes === undefined ? {} : { size: bytes.length, sha256: sha(bytes) }),
  ...extra,
});
const code = (expected) => (cause) => cause?.code === expected;
async function collect(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function fixture(t, handler, options = {}) {
  const requests = [],
    sockets = new Set();
  let current = true,
    checks = 0;
  const server = createServer((request, response) => {
    requests.push(request);
    request.on("error", () => {});
    response.on("error", () => {});
    void Promise.resolve(handler(request, response)).catch(() =>
      response.destroy(),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const serverUrl = `http://127.0.0.1:${server.address().port}/nexum/`;
  const data = new AgentDataPlane({
    serverUrl,
    token,
    binding,
    assertCurrent() {
      checks++;
      if (!current) throw Error("revoked private context");
    },
    ...options,
  });
  return {
    data,
    serverUrl,
    requests,
    revoke() {
      current = false;
    },
    get checks() {
      return checks;
    },
  };
}

test("native GET preserves >64 KiB binary bytes, the URL prefix and exact authenticated headers", async (t) => {
  const bytes = Buffer.alloc(512 * 1024 + 17);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": bytes.length });
    response.end(bytes);
  });
  const input = ref("cloud-to-agent", "attachment", bytes);
  const stream = await f.data.openRead(input, signal());
  assert.deepEqual(await collect(stream.readable), bytes);
  await stream.closed;
  const request = f.requests[0];
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/nexum/agent/file-stream/stream_fixture");
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  assert.equal(request.headers["x-nexum-connection-id"], binding.connectionId);
  assert.equal(request.headers["x-nexum-agent-profile"], binding.profile);
  assert.equal(request.headers["x-nexum-agent-boot-id"], binding.bootId);
  assert.equal(request.headers["x-nexum-stream-purpose"], "attachment");
  assert.equal(request.headers["x-nexum-stream-direction"], "cloud-to-agent");
  assert.equal(request.headers["x-nexum-transfer-id"], undefined);
  assert.equal(request.headers["x-nexum-reservation-id"], undefined);
  assert.equal(request.url.includes(token), false);
  assert.equal(JSON.stringify(f.data).includes(token), false);
  assert.ok(f.checks > 2);
});

test("native PUT exposes a writable before HTTP acknowledgement and closed waits for real consumer ACK", async (t) => {
  const bytes = Buffer.alloc(512 * 1024 + 3, 0xff);
  const consumed = Promise.withResolvers(),
    acknowledge = Promise.withResolvers();
  const f = await fixture(t, async (request, response) => {
    assert.deepEqual(await collect(request), bytes);
    consumed.resolve();
    await acknowledge.promise;
    response.writeHead(204);
    response.end();
  });
  const stream = f.data.openWrite(
    ref("agent-to-cloud", "resource", bytes),
    signal(),
  );
  let physicallyClosed = false;
  void stream.closed.then(
    () => {
      physicallyClosed = true;
    },
    () => {},
  );
  try {
    stream.writable.write(bytes);
    stream.writable.end();
    await once(stream.writable, "finish");
    await consumed.promise;
    await immediate();
    assert.equal(physicallyClosed, false);
    assert.equal(f.requests[0].headers["content-length"], String(bytes.length));
    assert.equal(f.requests[0].method, "PUT");
  } finally {
    acknowledge.resolve();
  }
  await stream.closed;
  assert.equal(physicallyClosed, true);
});

test("GET applies native backpressure while the consumer is paused and drains the complete tail", async (t) => {
  const bytes = Buffer.alloc(1024 * 1024 + 11, 0xa5);
  let serverBackpressure = false;
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": bytes.length });
    serverBackpressure = !response.write(bytes);
    response.end();
  });
  const stream = await f.data.openRead(
    ref("cloud-to-agent", "host-response", bytes),
    signal(),
  );
  await immediate();
  assert.equal(serverBackpressure, true);
  assert.ok(stream.readable.readableLength <= 128 * 1024);
  assert.deepEqual(await collect(stream.readable), bytes);
  await stream.closed;
});

test("PUT propagates native writable backpressure and sends every queued byte after the real server resumes", async (t) => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x6b);
  const admitted = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = await fixture(t, async (request, response) => {
    request.pause();
    admitted.resolve();
    await release.promise;
    assert.deepEqual(await collect(request), bytes);
    response.writeHead(204);
    response.end();
  });
  const stream = f.data.openWrite(
    ref("agent-to-cloud", "resource", bytes),
    signal(),
  );
  let backpressure = false;
  try {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      if (!stream.writable.write(bytes.subarray(offset, offset + 64 * 1024)))
        backpressure = true;
    }
    stream.writable.end();
    await admitted.promise;
    assert.equal(backpressure, true);
  } finally {
    release.resolve();
  }
  await stream.closed;
});

test("transfer HTTP endpoints are tied to the actual supplied reservation and never send it in the URL", async (t) => {
  const bytes = Buffer.from("actual transfer");
  const f = await fixture(t, (request, response) => {
    if (request.method === "GET") response.end(bytes);
    else {
      request.resume();
      request.on("end", () => {
        response.writeHead(204);
        response.end();
      });
    }
  });
  const claim = {
    transferId: "tr_actual",
    reservationId: "reservation_actual",
  };
  const stream = await f.data.openRead(
    ref("cloud-to-agent", "transfer", bytes),
    signal(),
    claim,
  );
  assert.deepEqual(await collect(stream.readable), bytes);
  await stream.closed;
  assert.equal(f.requests[0].headers["x-nexum-transfer-id"], claim.transferId);
  assert.equal(
    f.requests[0].headers["x-nexum-reservation-id"],
    claim.reservationId,
  );
  assert.equal(f.requests[0].url.includes(claim.reservationId), false);
  await assert.rejects(
    f.data.openRead(ref("cloud-to-agent", "transfer", bytes), signal()),
    code("invalid_stream_reference"),
  );
  await assert.rejects(
    f.data.openRead(
      ref("cloud-to-agent", "attachment", bytes),
      signal(),
      claim,
    ),
    code("invalid_stream_reference"),
  );
  await assert.rejects(
    f.data.openRead(ref("cloud-to-agent", "transfer", bytes), signal(), {
      transferId: undefined,
      reservationId: undefined,
    }),
    code("invalid_stream_reference"),
  );
  assert.equal(f.requests.length, 1);
});

test("every fixed outbound purpose including maintenance uses the same raw HTTP channel", async (t) => {
  const bytes = Buffer.from("fixed bytes");
  const seen = [];
  const f = await fixture(t, async (request, response) => {
    assert.deepEqual(await collect(request), bytes);
    seen.push(request.headers["x-nexum-stream-purpose"]);
    response.writeHead(204);
    response.end();
  });
  for (const purpose of [
    "resource",
    "host-request",
    "result-meta",
    "maintenance",
  ])
    await f.data.sendFixedBody(
      ref("agent-to-cloud", purpose, bytes),
      bytes,
      signal(),
    );
  assert.deepEqual(seen, [
    "resource",
    "host-request",
    "result-meta",
    "maintenance",
  ]);
});

test("fixed JSON uses canonical bytes and maintenance supports inbound JSON through the same path", async (t) => {
  const value = { z: [1, true, null], a: "中文" };
  const bytes = Buffer.from(canonicalJson(value));
  const f = await fixture(t, async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Length": bytes.length });
      response.end(bytes);
    } else {
      assert.deepEqual(await collect(request), bytes);
      response.writeHead(204);
      response.end();
    }
  });
  await f.data.writeJson(
    ref("agent-to-cloud", "maintenance", bytes),
    value,
    signal(),
  );
  assert.deepEqual(
    await f.data.readJson(
      ref("cloud-to-agent", "maintenance", bytes),
      signal(),
    ),
    value,
  );
});

test("GET validates actual checksum and closed retains the same verified failure", async (t) => {
  const bytes = Buffer.alloc(256 * 1024, 1);
  const f = await fixture(t, (_request, response) => response.end(bytes));
  const stream = await f.data.openRead(
    ref("cloud-to-agent", "attachment", bytes, { sha256: "0".repeat(64) }),
    signal(),
  );
  await assert.rejects(collect(stream.readable), code("checksum_mismatch"));
  await assert.rejects(stream.closed, code("checksum_mismatch"));
});

test("PUT rejects a mismatched actual checksum rather than treating HTTP or Writable finish as success", async (t) => {
  const bytes = Buffer.alloc(256 * 1024, 2);
  const f = await fixture(t, async (request, response) => {
    await collect(request);
    response.writeHead(204);
    response.end();
  });
  const stream = f.data.openWrite(
    ref("agent-to-cloud", "resource", bytes, { sha256: "0".repeat(64) }),
    signal(),
  );
  await assert.rejects(
    pipeline(Readable.from([bytes]), stream.writable),
    code("checksum_mismatch"),
  );
  await assert.rejects(stream.closed, code("checksum_mismatch"));
});

test("declared and actual lengths are bounded independently, including chunked streams", async (t) => {
  const bytes = Buffer.alloc(128 * 1024, 3);
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.write(bytes);
    response.end();
  });
  const stream = await f.data.openRead(
    ref("cloud-to-agent", "attachment", undefined, { maxBytes: 64 * 1024 }),
    signal(),
  );
  await assert.rejects(collect(stream.readable), code("resource_exhausted"));
  await assert.rejects(stream.closed, code("resource_exhausted"));
  const short = await f.data.openRead(
    ref("cloud-to-agent", "attachment", undefined, { size: bytes.length + 1 }),
    signal(),
  );
  await assert.rejects(collect(short.readable), code("stream_size_mismatch"));
  await assert.rejects(short.closed, code("stream_size_mismatch"));
});

test("an HTTP length that conflicts with a fixed ref is rejected before returning its body", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": "1" });
    response.end("x");
  });
  await assert.rejects(
    f.data.openRead(
      ref("cloud-to-agent", "attachment", Buffer.from("xx")),
      signal(),
    ),
    code("stream_size_mismatch"),
  );
});

test("early response socket closure is a real failure and never a truncated successful read", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": 256 * 1024 });
    response.write(Buffer.alloc(128 * 1024));
    setImmediate(() => response.destroy());
  });
  const stream = await f.data.openRead(
    ref("cloud-to-agent", "attachment", undefined, { size: 256 * 1024 }),
    signal(),
  );
  await assert.rejects(collect(stream.readable));
  await assert.rejects(stream.closed, code("stream_closed"));
});

test("abort while waiting for the real PUT response closes all local native handles", async (t) => {
  const received = Promise.withResolvers();
  const f = await fixture(t, async (request) => {
    await collect(request);
    received.resolve();
  });
  const bytes = Buffer.alloc(128 * 1024, 4),
    controller = new AbortController();
  const stream = f.data.openWrite(
    ref("agent-to-cloud", "resource", bytes),
    controller.signal,
  );
  await pipeline(Readable.from([bytes]), stream.writable);
  await received.promise;
  controller.abort(new Error(`private ${token}`));
  await assert.rejects(
    stream.closed,
    (cause) =>
      cause.code === "stream_cancelled" &&
      !JSON.stringify(cause).includes(token),
  );
});

test("abort before GET response headers settles only after the actual request closes", async (t) => {
  const admitted = Promise.withResolvers();
  const f = await fixture(t, () => {
    admitted.resolve();
  });
  const controller = new AbortController();
  const opening = f.data.openRead(
    ref("cloud-to-agent", "attachment", undefined),
    controller.signal,
  );
  await admitted.promise;
  controller.abort();
  await assert.rejects(opening, code("stream_cancelled"));
});

test("an active GET consumer abort rejects body and closure instead of keeping a pending transport", async (t) => {
  const first = Promise.withResolvers();
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.write(Buffer.alloc(32 * 1024));
    first.resolve();
  });
  const controller = new AbortController();
  const stream = await f.data.openRead(
    ref("cloud-to-agent", "attachment", undefined),
    controller.signal,
  );
  await first.promise;
  controller.abort();
  await assert.rejects(collect(stream.readable), code("stream_cancelled"));
  await assert.rejects(stream.closed, code("stream_cancelled"));
});

test("an early successful HTTP response cannot confirm an unfinished outbound body", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const stream = f.data.openWrite(
    ref("agent-to-cloud", "resource", Buffer.alloc(128 * 1024)),
    signal(),
  );
  await assert.rejects(stream.closed, code("stream_closed"));
});

test("current connection authority is rechecked after admission and before the next actual bytes", async (t) => {
  const release = Promise.withResolvers();
  const f = await fixture(t, async (_request, response) => {
    response.writeHead(200);
    response.write("first");
    await release.promise;
    response.end("last");
  });
  const stream = await f.data.openRead(
    ref("cloud-to-agent", "attachment", undefined),
    signal(),
  );
  const iterator = stream.readable[Symbol.asyncIterator]();
  try {
    assert.equal((await iterator.next()).value.toString(), "first");
    f.revoke();
  } finally {
    release.resolve();
  }
  await assert.rejects(iterator.next(), code("invalid_connection_binding"));
  await assert.rejects(stream.closed, code("invalid_connection_binding"));
});

test("non-2xx and redirects are rejected without following or exposing response contents", async (t) => {
  for (const status of [302, 401, 500])
    await t.test(String(status), async (t) => {
      const f = await fixture(t, (_request, response) => {
        response.writeHead(status, {
          Location: `http://127.0.0.1:1/private?token=${token}`,
        });
        response.end(`secret ${token}`);
      });
      await assert.rejects(
        f.data.openRead(
          ref("cloud-to-agent", "attachment", undefined),
          signal(),
        ),
        (cause) =>
          cause.code === "stream_http_error" &&
          !JSON.stringify(cause).includes(token),
      );
      assert.equal(f.requests.length, 1);
      const stream = f.data.openWrite(
        ref("agent-to-cloud", "resource", Buffer.alloc(0)),
        signal(),
      );
      stream.writable.end();
      await assert.rejects(stream.closed, code("stream_http_error"));
      assert.equal(f.requests.length, 2);
    });
});

test("HTTP protocol upgrades are rejected and their actual upgraded socket is destroyed", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(101, { Connection: "Upgrade", Upgrade: "private" });
    response.end();
  });
  await assert.rejects(
    f.data.openRead(ref("cloud-to-agent", "attachment", undefined), signal()),
    code("stream_http_error"),
  );
});

test("wrong direction, wrong current binding, header injection and URL-bearing refs cannot open a socket", async (t) => {
  const f = await fixture(t, (_request, response) => response.end());
  for (const mutation of [
    { streamId: "../private" },
    { streamId: "stream\r\nInjected: true" },
    { purpose: "unknown" },
    { sha256: "bad" },
    { url: `https://invalid/?token=${token}` },
    { headers: { Authorization: token } },
    { mimeType: "text/plain\r\nInjected: yes" },
  ]) {
    await assert.rejects(
      f.data.openRead(
        ref("cloud-to-agent", "attachment", undefined, mutation),
        signal(),
      ),
      (cause) =>
        cause.code === "invalid_stream_reference" &&
        !JSON.stringify(cause).includes(token),
    );
  }
  await assert.rejects(
    f.data.openRead(ref("agent-to-cloud", "resource", undefined), signal()),
    code("stream_direction_mismatch"),
  );
  f.revoke();
  await assert.rejects(
    f.data.openRead(ref("cloud-to-agent", "attachment", undefined), signal()),
    code("invalid_connection_binding"),
  );
  assert.equal(f.requests.length, 0);
  assert.throws(
    () =>
      new AgentDataPlane({
        serverUrl: f.serverUrl,
        token: "a\r\nb",
        binding,
        assertCurrent() {},
      }),
    code("invalid_configuration"),
  );
  assert.throws(
    () =>
      new AgentDataPlane({
        serverUrl: f.serverUrl,
        token,
        binding: { ...binding, connectionId: "a\r\nb" },
        assertCurrent() {},
      }),
    code("invalid_connection_binding"),
  );
});

test("expired and pre-aborted refs do not open a socket, and active deadline closes a stalled stream", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.write("x");
  });
  await assert.rejects(
    f.data.openRead(
      ref("cloud-to-agent", "attachment", undefined, {
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }),
      signal(),
    ),
    code("stream_timeout"),
  );
  await assert.rejects(
    f.data.openRead(
      ref("cloud-to-agent", "attachment", undefined),
      AbortSignal.abort(),
    ),
    code("stream_cancelled"),
  );
  assert.equal(f.requests.length, 0);
  const stream = await f.data.openRead(
    ref("cloud-to-agent", "attachment", undefined, {
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    }),
    signal(),
  );
  await assert.rejects(collect(stream.readable), code("stream_timeout"));
  await assert.rejects(stream.closed, code("stream_timeout"));
});

test("JSON rejects invalid UTF-8 and oversize input instead of accepting replacement text or unbounded buffers", async (t) => {
  const bytes = Buffer.from([0x22, 0xff, 0x22]);
  const f = await fixture(t, (_request, response) => response.end(bytes), {
    maxJsonBytes: 32,
  });
  await assert.rejects(
    f.data.readJson(ref("cloud-to-agent", "host-response", bytes), signal()),
    code("invalid_stream_json"),
  );
  await assert.rejects(
    f.data.readJson(
      ref("cloud-to-agent", "host-response", Buffer.alloc(33)),
      signal(),
    ),
    code("resource_exhausted"),
  );
  assert.equal(f.requests.length, 1);
});

test("fixed bytes respect a Uint8Array view and reject bad fixed bodies before contacting Cloud", async (t) => {
  const source = Buffer.from("private-prefix/public/private-tail"),
    bytes = source.subarray(15, 21);
  const f = await fixture(t, async (request, response) => {
    assert.deepEqual(await collect(request), bytes);
    response.writeHead(204);
    response.end();
  });
  await f.data.sendFixedBody(
    ref("agent-to-cloud", "resource", bytes),
    bytes,
    signal(),
  );
  await assert.rejects(
    f.data.sendFixedBody(
      ref("agent-to-cloud", "resource", bytes, { sha256: "0".repeat(64) }),
      bytes,
      signal(),
    ),
    code("checksum_mismatch"),
  );
  await assert.rejects(
    f.data.sendFixedBody(
      ref("agent-to-cloud", "resource", bytes, { size: bytes.length + 1 }),
      bytes,
      signal(),
    ),
    code("stream_size_mismatch"),
  );
  assert.equal(f.requests.length, 1);
});

test("multiple trailing Server URL slashes retain the installation prefix without changing origin", async (t) => {
  const bytes = Buffer.from("prefix");
  const f = await fixture(t, (_request, response) => response.end(bytes));
  const data = new AgentDataPlane({
    serverUrl: f.serverUrl + "//",
    token,
    binding,
    assertCurrent() {},
  });
  const stream = await data.openRead(
    ref("cloud-to-agent", "attachment", bytes),
    signal(),
  );
  assert.deepEqual(await collect(stream.readable), bytes);
  await stream.closed;
  assert.equal(f.requests[0].url, "/nexum/agent/file-stream/stream_fixture");
});

test("reference accessors are rejected without invoking them or exposing their private errors", async (t) => {
  const f = await fixture(t, (_request, response) => response.end());
  const reference = ref("cloud-to-agent", "attachment", undefined);
  let reads = 0;
  Object.defineProperty(reference, "streamId", {
    enumerable: true,
    get() {
      reads++;
      throw Error(token);
    },
  });
  await assert.rejects(
    f.data.openRead(reference, signal()),
    code("invalid_stream_reference"),
  );
  assert.equal(reads, 0);
  assert.equal(f.requests.length, 0);
});

test("boolean and async current-authority callbacks fail closed before an HTTP request is created", async (t) => {
  const f = await fixture(t, (_request, response) => response.end());
  for (const assertCurrent of [
    () => false,
    () => true,
    async () => {},
    async () => {
      throw Error(token);
    },
  ]) {
    const data = new AgentDataPlane({
      serverUrl: f.serverUrl,
      token,
      binding,
      assertCurrent,
    });
    await assert.rejects(
      data.openRead(ref("cloud-to-agent", "attachment", undefined), signal()),
      code("invalid_connection_binding"),
    );
  }
  await immediate();
  assert.equal(f.requests.length, 0);
});

test("a fixed-size transfer PUT does not deliver HTTP EOF before the verified producer ends", async (t) => {
  const bytes = Buffer.alloc(132000, 0xff),
    reached = Promise.withResolvers(),
    ended = Promise.withResolvers();
  let received = 0,
    acknowledged = false;
  const f = await fixture(t, async (request, response) => {
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received === bytes.length) reached.resolve();
    });
    await once(request, "end");
    ended.resolve();
    acknowledged = true;
    response.writeHead(204);
    response.end();
  });
  const transfer = f.data.openWrite(
    ref("agent-to-cloud", "transfer", bytes),
    signal(),
    { transferId: "tr_actual", reservationId: "reservation_actual" },
  );
  let closed = false;
  void transfer.closed.then(
    () => {
      closed = true;
    },
    () => {},
  );
  transfer.writable.write(bytes);
  await reached.promise;
  await immediate();
  assert.equal(f.requests[0].headers["content-length"], undefined);
  assert.equal(f.requests[0].headers["transfer-encoding"], "chunked");
  assert.equal(acknowledged, false);
  assert.equal(closed, false);
  transfer.writable.end();
  await ended.promise;
  await transfer.closed;
  assert.equal(received, bytes.length);
  assert.equal(acknowledged, true);
});
