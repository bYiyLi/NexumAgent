import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";
import test from "node:test";

// Real loopback HTTP requests with the adapter's public native-resource port.
// This does not assert Cloud/Browser delivery or a third-party API's behavior.
const dist = new URL(
  process.env.NEXUM_OPENAPI_HTTP_DIST ?? "../dist/",
  import.meta.url,
);
const [{ executeOpenApiHttp, OpenApiHttpError }, { AgentError }] =
  await Promise.all([
    import(new URL("adapters/openapi-http.js", dist)),
    import(new URL("contracts/errors.js", dist)),
  ]);
const secret = "synthetic-http-protected-token-48";
const checkCode = (expected) => (value) => value?.code === expected;
const noSecret = (value) => {
  assert.equal(inspect(value, { depth: 20 }).includes(secret), false);
  assert.equal(JSON.stringify(value).includes(secret), false);
};
async function bounded(promise, timeout = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Timed out waiting for native fixture evidence.")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t, handler, options = {}) {
  const hits = [],
    registrations = [],
    targets = [],
    logs = [];
  const callController = new AbortController(),
    hostController = new AbortController();
  let authenticationCalls = 0,
    validationCalls = 0,
    authenticationHook,
    validator,
    denied = false;
  const server = createServer((request, response) => {
    const record = {
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      request,
      response,
    };
    hits.push(record);
    Promise.resolve()
      .then(() => handler(request, response, record))
      .catch((error) => {
        if (!response.destroyed) response.destroy(error);
      });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const resources = {
    async register({ kind, value }) {
      // A managed request must be cold until core has accepted its identity.
      assert.equal(authenticationCalls, 0);
      assert.equal(hits.length, 0);
      assert.ok(value.closed instanceof Promise);
      assert.equal(typeof value.dispose, "function");
      const controller = new AbortController();
      const record = {
        id: `res_${String(registrations.length + 1).padStart(32, "0")}`,
        kind,
        value,
        controller,
        closed: false,
        reports: [],
      };
      registrations.push(record);
      value.closed.then(
        () => {
          record.closed = true;
        },
        () => {
          record.rejected = true;
        },
      );
      await options.onRegister?.(record);
      return {
        id: record.id,
        kind,
        value,
        signal: controller.signal,
        report(details) {
          record.reports.push(details);
        },
      };
    },
    async get() {
      throw Error("HTTP request does not borrow another resource.");
    },
    async handoff() {
      throw Error("HTTP request must not silently hand off.");
    },
    async describe() {
      throw Error("Unused fixture method.");
    },
    async list() {
      throw Error("Unused fixture method.");
    },
  };
  const authorize = (target) => {
    targets.push({ ...target });
    if (denied) throw new AgentError("forbidden", `Denied ${secret}`);
    assert.equal(target.type, "url");
    assert.equal(target.value.includes(secret), false);
  };
  const host = {
    context: { agentId: "agent" },
    config: {},
    signal: hostController.signal,
    resources,
    authorize,
    log(entry) {
      logs.push(entry);
    },
  };
  const call = {
    context: {
      runId: "run_http",
      caller: { principalId: "user", clientId: "test", grantId: "grant" },
    },
    operationId: "op_http",
    signal: callController.signal,
    deadline: Date.now() + 30000,
    resources,
    authorize,
    log(entry) {
      logs.push(entry);
    },
    progress(entry) {
      logs.push(entry);
    },
    requestInput() {
      throw Error("Unexpected interaction.");
    },
  };
  const request = {
    url: `${base}/call?business=yes`,
    method: "GET",
    headers: new Headers({ "X-Original": "kept" }),
    body: null,
  };
  const limits = {
    requestBytes: 1024 * 1024,
    responseBytes: 1024 * 1024,
    requestTimeoutMs: 5000,
    ...options.limits,
  };
  const run = (extra) =>
    executeOpenApiHttp({
      request,
      host,
      call,
      operation: "example",
      limits,
      async authenticate(signal) {
        authenticationCalls++;
        assert.equal(registrations.length, 1);
        assert.equal(registrations[0].closed, false);
        assert.equal(hits.length, 0);
        if (authenticationHook) return await authenticationHook(signal);
        const url = new URL(request.url),
          headers = new Headers(request.headers);
        url.searchParams.set("api_key", secret);
        headers.set("Authorization", `Bearer ${secret}`);
        return {
          url: url.href,
          headers,
          secrets: [secret],
          sensitiveHeaders: ["x-private-response"],
        };
      },
      validateResponse(raw, mimeType) {
        validationCalls++;
        return validator?.(raw, mimeType);
      },
      ...extra,
    });
  const closed = async () => {
    await bounded(Promise.all(registrations.map((item) => item.value.closed)));
    assert.ok(registrations.every((item) => item.closed && !item.rejected));
  };
  t.after(async () => {
    callController.abort();
    hostController.abort();
    try {
      for (const item of registrations)
        if (!item.closed) await bounded(Promise.resolve(item.value.dispose()));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  return {
    base,
    hits,
    registrations,
    targets,
    logs,
    request,
    limits,
    run,
    closed,
    callController,
    hostController,
    host,
    call,
    auth(fn) {
      authenticationHook = fn;
    },
    validate(fn) {
      validator = fn;
    },
    deny() {
      denied = true;
    },
    get authenticationCalls() {
      return authenticationCalls;
    },
    get validationCalls() {
      return validationCalls;
    },
  };
}

test("cold registration precedes authentication; only the business URL is authorized and 202 is an ordinary single response", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(202, {
      "Content-Type": "application/json",
      "X-Public": "visible",
    });
    response.end('{"accepted":true}');
  });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), { accepted: true });
  assert.equal(result.headers["x-public"], "visible");
  assert.equal(f.registrations.length, 1);
  assert.equal(f.hits.length, 1);
  assert.equal(f.authenticationCalls, 1);
  assert.equal(f.validationCalls, 1);
  assert.equal(
    new URL(f.hits[0].url, f.base).searchParams.get("api_key"),
    secret,
  );
  assert.equal(f.hits[0].headers.authorization, `Bearer ${secret}`);
  assert.equal(f.hits[0].headers["x-original"], "kept");
  assert.ok(f.targets.length > 0);
  assert.ok(f.targets.every((target) => target.value === f.request.url));
  await f.closed();
  noSecret(result);
  noSecret(f.logs);
  noSecret(f.targets);
  noSecret(f.registrations.map((item) => item.reports));
});

test("JSON and +json preserve all scalar values; text and binary keep their real representations", async (t) => {
  for (const data of [false, 0, null, "", "hello", [1, 2]])
    await t.test(`JSON ${JSON.stringify(data)}`, async (t) => {
      const f = await fixture(t, (_request, response) => {
        response.writeHead(200, {
          "Content-Type": "application/problem+json; charset=utf-8",
        });
        response.end(JSON.stringify(data));
      });
      const result = await f.run();
      assert.deepEqual(result.data, data);
      await f.closed();
    });
  for (const mime of ["text/plain", "application/xml", "application/yaml"])
    await t.test(mime, async (t) => {
      const f = await fixture(t, (_request, response) => {
        response.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` });
        response.end("中文 <value>ok</value>\n");
      });
      assert.equal((await f.run()).data, "中文 <value>ok</value>\n");
      await f.closed();
    });
  await t.test("binary", async (t) => {
    const bytes = Buffer.from([0, 255, 1, 2, 3]);
    const f = await fixture(t, (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(bytes);
    });
    const result = await f.run();
    assert.ok(result.data instanceof Blob);
    assert.deepEqual(Buffer.from(await result.data.arrayBuffer()), bytes);
    await f.closed();
  });
});

test("response validation sees original data before exact secret redaction and sensitive header removal", async (t) => {
  const original = {
    token: secret,
    nested: [`prefix ${secret} suffix`],
    [`key-${secret}`]: "value",
  };
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `session=${secret}`,
      Authorization: `Bearer ${secret}`,
      "X-Private-Response": secret,
      "X-Public": "visible",
    });
    response.end(JSON.stringify(original));
  });
  let validated;
  f.validate((raw, mimeType) => {
    validated = structuredClone(raw.data);
    assert.equal(mimeType, "application/json");
  });
  const result = await f.run();
  assert.deepEqual(validated, original);
  assert.equal(result.redacted, true);
  noSecret(result);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers.authorization, undefined);
  assert.equal(result.headers["x-private-response"], undefined);
  assert.equal(result.headers["x-public"], "visible");
  await f.closed();
  noSecret(f.logs);
});

test("non-2xx errors retain a safe typed response after validation without retaining provider causes", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(422, {
      "Content-Type": "application/json",
      "Set-Cookie": secret,
    });
    response.end(JSON.stringify({ reason: secret }));
  });
  let checked = false;
  f.validate((raw) => {
    checked = true;
    assert.equal(raw.status, 422);
    assert.equal(raw.data.reason, secret);
  });
  await assert.rejects(f.run(), (value) => {
    assert.ok(value instanceof OpenApiHttpError);
    assert.equal(value.code, "api_http_error");
    assert.equal(value.response.status, 422);
    assert.equal(value.response.ok, false);
    assert.equal(value.response.redacted, true);
    assert.equal(value.cause, undefined);
    noSecret(value);
    noSecret(value.response);
    assert.ok(
      Object.keys(value.details).every((key) =>
        ["operation", "dispatched", "effect", "status"].includes(key),
      ),
    );
    return true;
  });
  assert.equal(checked, true);
  await f.closed();
  noSecret(f.logs);
});

test("redirects are not followed or treated as remote task continuations", async (t) => {
  const f = await fixture(t, (request, response) => {
    if (request.url.startsWith("/follow")) {
      response.end("must not be reached");
      return;
    }
    response.writeHead(302, { Location: `/follow?token=${secret}` });
    response.end("redirect");
  });
  await assert.rejects(f.run(), (value) => {
    assert.equal(value.code, "api_redirect_not_allowed");
    noSecret(value);
    return true;
  });
  assert.equal(f.hits.length, 1);
  await f.closed();
});

test("authentication cannot change the approved origin/path, and permission denial is safe", async (t) => {
  for (const change of ["origin", "path"])
    await t.test(change, async (t) => {
      const f = await fixture(t, (_request, response) =>
        response.end("unexpected"),
      );
      f.auth(async () => ({
        url:
          change === "origin" ? "http://127.0.0.1:1/other" : `${f.base}/other`,
        headers: new Headers(),
        secrets: [secret],
        sensitiveHeaders: [],
      }));
      await assert.rejects(f.run(), checkCode("api_auth_target_changed"));
      assert.equal(f.hits.length, 0);
      await f.closed();
    });
  await t.test("denied", async (t) => {
    const f = await fixture(t, (_request, response) =>
      response.end("unexpected"),
    );
    f.deny();
    await assert.rejects(f.run(), (value) => {
      assert.equal(value.code, "forbidden");
      noSecret(value);
      return true;
    });
    assert.equal(f.hits.length, 0);
    await f.closed();
  });
});

test("boolean or asynchronous authorization callbacks fail closed before authentication and dispatch", async (t) => {
  for (const [name, authorize] of [
    ["boolean", () => true],
    ["async", async () => {}],
  ])
    await t.test(name, async (t) => {
      const f = await fixture(t, (_request, response) =>
        response.end("unexpected"),
      );
      await assert.rejects(
        f.run({ host: { ...f.host, authorize } }),
        (value) => {
          noSecret(value);
          assert.equal(value.details.dispatched, false);
          return true;
        },
      );
      assert.equal(f.authenticationCalls, 0);
      assert.equal(f.hits.length, 0);
      await f.closed();
    });
});

test("call, instance and resource cancellation during delayed headers join native cleanup before returning", async (t) => {
  for (const source of ["call", "host", "resource"])
    await t.test(source, async (t) => {
      const arrived = Promise.withResolvers(),
        serverClosed = Promise.withResolvers();
      const f = await fixture(t, (_request, response) => {
        response.once("close", serverClosed.resolve);
        arrived.resolve();
      });
      const task = f.run();
      const rejection = assert.rejects(task, (value) => {
        assert.equal(value.code, "api_request_cancelled");
        noSecret(value);
        assert.ok(f.registrations.every((item) => item.closed));
        return true;
      });
      await bounded(arrived.promise);
      const reason = Error(`Cancelled ${secret}`);
      if (source === "call") f.callController.abort(reason);
      else if (source === "host") f.hostController.abort(reason);
      else f.registrations[0].controller.abort(reason);
      await bounded(rejection);
      await f.closed();
      await bounded(serverClosed.promise);
      assert.equal(f.hits.length, 1);
      noSecret(f.logs);
    });
});

test("timeout covers authentication and delayed headers without leaking the supplied reason", async (t) => {
  await t.test("headers", async (t) => {
    const f = await fixture(t, () => {}, { limits: { requestTimeoutMs: 80 } });
    await assert.rejects(f.run(), checkCode("api_request_timeout"));
    await f.closed();
  });
  await t.test("authentication", async (t) => {
    const f = await fixture(
      t,
      (_request, response) => response.end("unexpected"),
      { limits: { requestTimeoutMs: 40 } },
    );
    f.auth(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(Error(`auth ${secret}`)),
            { once: true },
          );
        }),
    );
    await assert.rejects(f.run(), (value) => {
      assert.equal(value.code, "api_request_timeout");
      noSecret(value);
      return true;
    });
    assert.equal(f.hits.length, 0);
    await f.closed();
  });
});

test("cancellation while the real response reader awaits its next chunk joins stream and socket closure", async (t) => {
  const firstChunk = Promise.withResolvers(),
    serverClosed = Promise.withResolvers();
  let reads = 0;
  const originalRead = ReadableStreamDefaultReader.prototype.read;
  t.mock.method(
    ReadableStreamDefaultReader.prototype,
    "read",
    function (...args) {
      reads++;
      const result = Reflect.apply(originalRead, this, args);
      void result.then(
        (part) => {
          if (!part.done && part.value?.byteLength) firstChunk.resolve();
        },
        () => {},
      );
      return result;
    },
  );
  const f = await fixture(t, (_request, response) => {
    response.once("close", serverClosed.resolve);
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.write(Buffer.from("first response chunk"));
  });
  const pending = f.run();
  const rejection = assert.rejects(pending, (value) => {
    assert.equal(value.code, "api_request_cancelled");
    assert.ok(f.registrations.every((item) => item.closed));
    noSecret(value);
    return true;
  });
  await bounded(firstChunk.promise);
  assert.ok(
    reads >= 2,
    "the native reader consumed a chunk and began its next read",
  );
  assert.ok(
    f.registrations[0].reports.some((item) => item.state === "reading"),
  );
  f.callController.abort();
  await bounded(rejection);
  await f.closed();
  await bounded(serverClosed.promise);
  assert.equal(f.hits.length, 1);
});

test("actual response bytes, declared size and decompressed bytes enforce the response limit", async (t) => {
  for (const mode of ["declared", "chunked", "compressed"])
    await t.test(mode, async (t) => {
      const f = await fixture(
        t,
        (_request, response) => {
          if (mode === "declared") {
            response.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": 1000,
            });
            response.end(Buffer.alloc(1000));
          } else if (mode === "compressed") {
            const body = gzipSync(Buffer.alloc(4096, 65));
            response.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Encoding": "gzip",
              "Content-Length": body.length,
            });
            response.end(body);
          } else {
            response.writeHead(200, {
              "Content-Type": "application/octet-stream",
            });
            response.write(Buffer.alloc(400));
            setImmediate(() => response.end(Buffer.alloc(400)));
          }
        },
        { limits: { responseBytes: 512 } },
      );
      await assert.rejects(f.run(), checkCode("api_response_too_large"));
      await f.closed();
      assert.equal(f.hits.length, 1);
    });
});

test("an earlier caller cancellation keeps its reason while delayed authentication settles after the timeout", async (t) => {
  const entered = Promise.withResolvers();
  const f = await fixture(
    t,
    (_request, response) => response.end("unexpected"),
    { limits: { requestTimeoutMs: 40 } },
  );
  f.auth(
    (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            setTimeout(() => reject(Error(`delayed provider ${secret}`)), 80),
          { once: true },
        );
        entered.resolve();
      }),
  );
  const task = f.run();
  const rejection = assert.rejects(task, (value) => {
    assert.equal(value.code, "api_request_cancelled");
    noSecret(value);
    return true;
  });
  await entered.promise;
  f.callController.abort(Error(`caller ${secret}`));
  assert.equal(f.registrations[0].closed, false);
  await bounded(rejection);
  await f.closed();
  assert.equal(f.hits.length, 0);
});

test("request body bytes are bounded before dispatch, and slow upload cancellation closes the request", async (t) => {
  await t.test("oversize", async (t) => {
    const f = await fixture(
      t,
      (_request, response) => response.end("unexpected"),
      { limits: { requestBytes: 512 } },
    );
    f.request.method = "POST";
    f.request.body = new Blob([Buffer.alloc(1024)]);
    await assert.rejects(f.run(), checkCode("api_request_too_large"));
    assert.equal(f.hits.length, 0);
    await f.closed();
  });
  await t.test("slow upload", async (t) => {
    const arrived = Promise.withResolvers(),
      ended = Promise.withResolvers();
    let serverRequest;
    const f = await fixture(
      t,
      (request, response) => {
        serverRequest = request;
        response.once("close", ended.resolve);
        request.once("data", () => {
          request.pause();
          arrived.resolve();
        });
      },
      { limits: { requestBytes: 20 * 1024 * 1024 } },
    );
    f.request.method = "POST";
    f.request.body = new Blob([Buffer.alloc(16 * 1024 * 1024)]);
    const task = f.run(),
      rejection = assert.rejects(task, checkCode("api_request_cancelled"));
    await bounded(arrived.promise);
    f.callController.abort();
    serverRequest.resume();
    await bounded(rejection);
    await f.closed();
    await bounded(ended.promise);
    assert.equal(f.hits.length, 1);
  });
});

test("binary token reflection is rejected, invalid JSON/UTF-8 and validator errors stay safe", async (t) => {
  for (const mode of ["binary", "json", "utf8", "validator"])
    await t.test(mode, async (t) => {
      const f = await fixture(t, (_request, response) => {
        response.writeHead(200, {
          "Content-Type":
            mode === "binary"
              ? "application/octet-stream"
              : mode === "utf8"
                ? "text/plain"
                : "application/json",
        });
        response.end(
          mode === "binary"
            ? Buffer.from(`binary ${secret}`)
            : mode === "json"
              ? `{"bad":${secret}`
              : mode === "utf8"
                ? Buffer.from([255, 254])
                : JSON.stringify({ value: secret }),
        );
      });
      if (mode === "validator")
        f.validate((raw) => {
          assert.equal(raw.data.value, secret);
          throw Error(`bad schema ${secret}`);
        });
      await assert.rejects(f.run(), (value) => {
        assert.equal(
          value.code,
          mode === "binary"
            ? "api_sensitive_response"
            : mode === "validator"
              ? "api_invalid_response"
              : "api_response_encoding",
        );
        noSecret(value);
        assert.equal(value.cause, undefined);
        return true;
      });
      await f.closed();
      noSecret(f.logs);
    });
});

test("authentication and actual network failures are not retried or retained as raw causes", async (t) => {
  await t.test("authentication", async (t) => {
    const f = await fixture(t, (_request, response) =>
      response.end("unexpected"),
    );
    f.auth(async () => {
      throw Error(`provider ${secret}`);
    });
    await assert.rejects(f.run(), (value) => {
      assert.equal(value.code, "api_authentication_failed");
      assert.equal(value.cause, undefined);
      noSecret(value);
      return true;
    });
    assert.equal(f.hits.length, 0);
    assert.equal(f.authenticationCalls, 1);
    await f.closed();
  });
  await t.test("network", async (t) => {
    const f = await fixture(t, (request) => request.socket.destroy());
    await assert.rejects(f.run(), (value) => {
      assert.equal(value.code, "api_network_error");
      assert.equal(value.cause, undefined);
      noSecret(value);
      return true;
    });
    assert.equal(f.hits.length, 1);
    await f.closed();
  });
});
