import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

const moduleUrl = process.env.NEXUM_MCP_HTTP_TEST_MODULE
  ? new URL(
      process.env.NEXUM_MCP_HTTP_TEST_MODULE,
      pathToFileURL(`${process.cwd()}/`),
    )
  : process.env.NEXUM_MCP_ADAPTER_TEST_MODULE
    ? new URL(
        "mcp-http.js",
        new URL(
          process.env.NEXUM_MCP_ADAPTER_TEST_MODULE,
          pathToFileURL(`${process.cwd()}/`),
        ),
      )
    : new URL("../dist/adapters/mcp-http.js", import.meta.url);
const { ManagedHttpTransport } = await import(moduleUrl.href);

const message = (id) => ({ jsonrpc: "2.0", id, method: "ping" });
const result = (id) => ({ jsonrpc: "2.0", id, result: {} });
const frame = (id) => `data: ${JSON.stringify(result(id))}\n\n`;
async function until(predicate, text) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(text);
}
async function peer(t, handle) {
  const requests = [];
  const http = createServer(async (request, response) => {
    const item = {
      verb: request.method,
      headers: request.headers,
      closed: false,
    };
    requests.push(item);
    response.once("close", () => {
      item.closed = true;
    });
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      item.message = body ? JSON.parse(body) : null;
      item.response = response;
      await handle(item, response);
    } catch {
      response.destroy();
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, requests };
}
function managed(t, url, options = {}) {
  const resource = new ManagedHttpTransport({
    url,
    maxMessageBytes: 1024,
    authorize() {},
    ...options,
  });
  t.after(() => resource.dispose());
  return resource;
}

test("HTTP resource is cold and authorizes every native fetch with configured static headers", async (t) => {
  const server = await peer(t, (item, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result(item.message.id)));
  });
  const authorized = [],
    received = [];
  const resource = managed(t, server.url, {
    headers: { Authorization: "Bearer lifecycle-fixture" },
    authorize: (url) => authorized.push(url),
  });
  await delay(20);
  assert.deepEqual(authorized, []);
  assert.deepEqual(server.requests, []);
  await resource.transport.start();
  assert.equal(server.requests.length, 0);
  resource.transport.onmessage = (value) => received.push(value);
  await resource.run(new AbortController().signal, () =>
    resource.transport.send(message(1)),
  );
  await resource.run(new AbortController().signal, () =>
    resource.transport.send(message(2)),
  );
  assert.deepEqual(authorized, [server.url, server.url]);
  assert.equal(
    server.requests.every(
      (item) => item.headers.authorization === "Bearer lifecycle-fixture",
    ),
    true,
  );
  assert.deepEqual(
    received.map((item) => item.id),
    [1, 2],
  );
  await resource.transport.close();
  await resource.closed;
  await assert.rejects(
    resource.run(new AbortController().signal, async () => {}),
  );
});

test("dispose cancels a native request before response headers and waits for its fetch rejection", async (t) => {
  const server = await peer(t, () => {});
  const resource = managed(t, server.url);
  await resource.transport.start();
  const operation = resource.run(new AbortController().signal, () =>
    resource.transport.send(message(1)),
  );
  const rejected = assert.rejects(operation);
  await until(
    () => server.requests[0]?.message,
    "The pending native fetch must reach the peer",
  );
  await resource.dispose();
  await resource.closed;
  await rejected;
  await until(
    () => server.requests[0].closed,
    "The peer must observe the request connection closing",
  );
});

test("SSE headers do not complete a call and its final SDK result releases a body the server keeps open", async (t) => {
  const server = await peer(t, (item, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": waiting for result\n\n");
  });
  const resource = managed(t, server.url);
  const received = Promise.withResolvers();
  resource.transport.onmessage = (value) => received.resolve(value);
  await resource.transport.start();
  let ended = false;
  const operation = resource
    .run(new AbortController().signal, async () => {
      await resource.transport.send(message(1));
      return received.promise;
    })
    .then(() => {
      ended = true;
    });
  await until(
    () => server.requests[0]?.message,
    "The SSE POST should reach the peer",
  );
  await delay(20);
  assert.equal(ended, false);
  server.requests[0].response.write(frame(1));
  await operation;
  assert.equal(ended, true);
  await until(
    () => server.requests[0].closed,
    "The final result must release the still-open POST body",
  );
  await resource.dispose();
  await resource.closed;
});

test("call cancellation closes only its POST while a shared GET, another call and cancellation notification survive", async (t) => {
  const server = await peer(t, (item, response) => {
    if (item.verb === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": shared keepalive\n\n");
    } else if (item.message.id === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": waiting\n\n");
    } else if (item.message.id === 2) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result(2)));
    } else response.writeHead(202).end();
  });
  const resource = managed(t, server.url);
  resource.transport.onerror = () => {};
  await resource.transport.start();
  const controller = new AbortController(),
    continueCall = Promise.withResolvers();
  const first = resource.run(controller.signal, async () => {
    await resource.transport.send(message(1));
    await continueCall.promise;
    await resource.transport.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });
  });
  const rejected = assert.rejects(first, { message: "fixture cancellation" });
  await resource.run(new AbortController().signal, () =>
    resource.transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  );
  await until(
    () => server.requests.some((item) => item.verb === "GET"),
    "The SDK must start its shared GET",
  );
  await until(
    () => server.requests.some((item) => item.message?.id === 1),
    "The first POST must start",
  );
  controller.abort(new Error("fixture cancellation"));
  continueCall.resolve();
  await rejected;
  await resource.run(new AbortController().signal, () =>
    resource.transport.send(message(2)),
  );
  const get = server.requests.find((item) => item.verb === "GET");
  assert.equal(get.closed, false);
  assert.ok(
    server.requests.some(
      (item) => item.message?.method === "notifications/cancelled",
    ),
  );
  await until(
    () => server.requests.find((item) => item.message?.id === 1)?.closed,
    "Cancelled POST must physically close",
  );
  await resource.dispose();
  await resource.closed;
  await until(() => get.closed, "Instance disposal must close the shared GET");
});

test("SSE request recovery GET retains call ownership for final-result release and external cancellation", async (t) => {
  const server = await peer(t, (item, response) => {
    if (item.verb === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": request recovery\n\n");
    } else if (item.message.id === 3) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result(3)));
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`id: recovery-${item.message.id}\ndata:\n\n`);
    }
  });
  const resource = managed(t, server.url);
  const firstResult = Promise.withResolvers(),
    thirdResult = Promise.withResolvers();
  resource.transport.onmessage = (value) => {
    if (value.id === 1) firstResult.resolve(value);
    if (value.id === 3) thirdResult.resolve(value);
  };
  resource.transport.onerror = () => {};
  await resource.transport.start();
  const first = resource.run(new AbortController().signal, async () => {
    await resource.transport.send(message(1));
    await firstResult.promise;
  });
  await until(
    () =>
      server.requests.some(
        (item) => item.headers["last-event-id"] === "recovery-1",
      ),
    "The official SDK must resume the first POST through GET",
  );
  const resumedFirst = server.requests.find(
    (item) => item.headers["last-event-id"] === "recovery-1",
  );
  resumedFirst.response.write(frame(1));
  await first;
  await until(
    () => resumedFirst.closed,
    "The final result must close its own recovery GET without disposing the shared transport",
  );
  const controller = new AbortController();
  const second = resource.run(controller.signal, async () => {
    await resource.transport.send(message(2), {
      requestSignal: controller.signal,
    });
    await new Promise((_, reject) =>
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      ),
    );
  });
  const rejected = assert.rejects(second, {
    message: "cancel recovered request",
  });
  await until(
    () =>
      server.requests.some(
        (item) => item.headers["last-event-id"] === "recovery-2",
      ),
    "The second call must own a real recovery GET before cancellation",
  );
  const resumedSecond = server.requests.find(
    (item) => item.headers["last-event-id"] === "recovery-2",
  );
  controller.abort(new Error("cancel recovered request"));
  await rejected;
  await until(
    () => resumedSecond.closed,
    "Cancellation must close this request's actual recovery GET",
  );
  await resource.run(new AbortController().signal, () =>
    resource.transport.send(message(3)),
  );
  assert.equal((await thirdResult.promise).id, 3);
});

test("native JSON body budget rejects an oversized response and cancels its actual body", async (t) => {
  const server = await peer(t, (item, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: item.message.id,
        result: { text: "x".repeat(400) },
      }),
    );
  });
  const resource = managed(t, server.url, { maxMessageBytes: 256 });
  resource.transport.onerror = () => {};
  await resource.transport.start();
  await assert.rejects(
    resource.run(new AbortController().signal, () =>
      resource.transport.send(message(1)),
    ),
    { code: "mcp_message_too_large" },
  );
  await until(
    () => server.requests[0]?.closed,
    "Oversized native body must close",
  );
  await resource.dispose();
  await resource.closed;
});

test("SSE limits each frame while allowing a long stream whose individual frames fit", async (t) => {
  const server = await peer(t, (item, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (item.message.id === 1) {
      for (let index = 0; index < 20; index++) {
        const ending = index % 3 === 0 ? "\r\n" : index % 3 === 1 ? "\r" : "\n";
        response.write(frame(index).replaceAll("\n", ending));
      }
      response.end(": final\n\n");
    } else response.write(`data: ${"x".repeat(300)}\n\n`);
  });
  const resource = managed(t, server.url, { maxMessageBytes: 256 });
  const received = [],
    errors = [],
    complete = Promise.withResolvers(),
    failed = Promise.withResolvers();
  resource.transport.onmessage = (value) => {
    received.push(value);
    if (received.length === 20) complete.resolve();
  };
  resource.transport.onerror = (error) => {
    errors.push(error);
    failed.resolve();
  };
  await resource.transport.start();
  await resource.run(new AbortController().signal, async () => {
    await resource.transport.send(message(1));
    await complete.promise;
  });
  await until(
    () => received.length === 20,
    "Every bounded SSE frame should reach the official SDK",
  );
  assert.deepEqual(errors, []);
  await resource.run(new AbortController().signal, async () => {
    await resource.transport.send(message(2));
    await failed.promise;
  });
  await until(
    () => errors.length > 0,
    "The official SDK must observe the oversized frame failure",
  );
  assert.match(errors[0].message, /configured message byte limit/);
  await until(
    () => server.requests[1]?.closed,
    "Oversized SSE frame must close the native body",
  );
});

test("redirects are rejected without contacting another URL and unauthenticated OAuth requests fail explicitly", async (t) => {
  const target = await peer(t, (_, response) => response.writeHead(204).end());
  const redirect = await peer(t, (_, response) =>
    response.writeHead(307, { location: target.url }).end(),
  );
  const resource = managed(t, redirect.url);
  await resource.transport.start();
  await assert.rejects(
    resource.run(new AbortController().signal, () =>
      resource.transport.send(message(1)),
    ),
  );
  assert.equal(target.requests.length, 0);
  const authentication = await peer(t, (_, response) => {
    response.writeHead(401, {
      "www-authenticate":
        'Bearer resource_metadata="https://invalid.example/metadata"',
    });
    response.write("private diagnostic body");
  });
  const unauthenticated = managed(t, authentication.url);
  await unauthenticated.transport.start();
  await assert.rejects(
    unauthenticated.run(new AbortController().signal, () =>
      unauthenticated.transport.send(message(1)),
    ),
    { code: "mcp_authentication_required" },
  );
  await until(
    () => authentication.requests[0]?.closed,
    "Unauthenticated response body must close",
  );
});
