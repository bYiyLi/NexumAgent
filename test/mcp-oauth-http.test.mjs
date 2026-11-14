import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
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
const { AgentError } = await import(
  new URL("../contracts/errors.js", moduleUrl).href
);
const message = (id) => ({ jsonrpc: "2.0", id, method: "ping" });
const result = (id) => ({ jsonrpc: "2.0", id, result: {} });
const expired = "fixture-expired-access";
const refreshed = "fixture-refreshed-access";
const refreshToken = "fixture-refresh-token";

async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(description);
}

// This is a real local authorization server and resource server. The official
// transport owns OAuth discovery, form encoding, refresh and MCP retry.
async function oauthPeer(t, options = {}) {
  const requests = [];
  const control = {
    accessToken: refreshed,
    holdToken: options.holdToken,
    holdResourceMetadata: options.holdResourceMetadata ?? false,
    holdUnauthorized: options.holdUnauthorized ?? false,
  };
  const consumedRefreshTokens = new Set();
  let origin;
  const http = createServer(async (request, response) => {
    const item = {
      method: request.method,
      url: new URL(request.url, origin).href,
      path: new URL(request.url, origin).pathname,
      headers: request.headers,
      response,
      closed: false,
    };
    requests.push(item);
    response.once("close", () => {
      item.closed = true;
    });
    const json = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      item.body = Buffer.concat(chunks).toString();
      if (item.path === "/resource-metadata") {
        item.release = () =>
          json(200, {
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            scopes_supported: ["fixture"],
          });
        if (!control.holdResourceMetadata) item.release();
      } else if (item.path === "/.well-known/oauth-authorization-server") {
        json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["fixture", "offline_access"],
        });
      } else if (item.path === "/token") {
        item.form = Object.fromEntries(new URLSearchParams(item.body));
        if (options.tokenError) {
          json(400, options.tokenError);
          return;
        }
        if (
          options.rotateRefreshTokens &&
          consumedRefreshTokens.has(item.form.refresh_token)
        ) {
          json(400, {
            error: "invalid_grant",
            error_description:
              "The fixture refresh token was already consumed.",
          });
          return;
        }
        consumedRefreshTokens.add(item.form.refresh_token);
        const payload = JSON.stringify({
          access_token: refreshed,
          refresh_token: "fixture-rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "fixture offline_access",
        });
        item.release = () => {
          if (!response.headersSent)
            response.writeHead(200, { "content-type": "application/json" });
          response.end(
            response.headersSent && item.bodyStarted ? undefined : payload,
          );
        };
        if (control.holdToken === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write(payload);
          item.bodyStarted = true;
        } else if (control.holdToken !== "headers") item.release();
      } else if (item.path === "/mcp") {
        item.message = item.body ? JSON.parse(item.body) : null;
        if (item.headers.authorization !== `Bearer ${control.accessToken}`) {
          item.release = () => {
            response.writeHead(401, {
              "www-authenticate": `Bearer resource_metadata="${origin}/resource-metadata"`,
              "content-type": "text/plain",
            });
            response.end("The fixture access token has expired.");
          };
          if (!control.holdUnauthorized) item.release();
        } else if (item.method === "GET" || item.message?.id === 9) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": fixture keepalive\n\n");
        } else if (item.message?.method === "notifications/initialized") {
          response.writeHead(202).end();
        } else json(200, result(item.message.id));
      } else json(404, { error: "unknown_fixture_endpoint" });
    } catch {
      response.destroy();
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${http.address().port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  };
  t.after(close);
  return { origin, url: `${origin}/mcp`, requests, control, close };
}

function providerFor(server, options = {}) {
  const callback = `${server.origin}/callback`;
  const state = {
    tokens:
      options.tokens === null
        ? undefined
        : {
            access_token: expired,
            refresh_token: refreshToken,
            token_type: "Bearer",
            scope: "fixture offline_access",
            issuer: server.origin,
            ...options.tokens,
          },
    saved: [],
    invalidations: [],
    redirects: [],
    verifier: undefined,
    discovery: undefined,
  };
  const provider = {
    redirectUrl: callback,
    clientMetadata: {
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "fixture offline_access",
    },
    clientInformation: () => ({
      client_id: "fixture-client",
      issuer: server.origin,
    }),
    tokens: () => state.tokens,
    saveTokens(value) {
      state.tokens = structuredClone(value);
      state.saved.push(structuredClone(value));
    },
    invalidateCredentials(scope) {
      state.invalidations.push(scope);
      if (scope === "all" || scope === "tokens") state.tokens = undefined;
      if (scope === "all" || scope === "discovery") state.discovery = undefined;
    },
    state: () => "fixture-oauth-state",
    saveCodeVerifier(value) {
      state.verifier = value;
    },
    codeVerifier: () => state.verifier,
    discoveryState: () => state.discovery,
    saveDiscoveryState(value) {
      state.discovery = structuredClone(value);
    },
    redirectToAuthorization(url) {
      state.redirects.push(new URL(url));
      throw new AgentError(
        "maintenance_auth_required",
        "The fixture requires explicit user consent.",
      );
    },
  };
  return { provider, state };
}

function managed(t, server, provider, options = {}) {
  const authorized = [],
    received = [];
  const resource = new ManagedHttpTransport({
    url: server.url,
    authProvider: provider,
    maxMessageBytes: 8192,
    authorize(url) {
      authorized.push(url);
      options.authorize?.(url);
    },
  });
  resource.transport.onmessage = (value) => received.push(value);
  resource.transport.onerror = () => {};
  t.after(async () => {
    await resource.dispose();
    await resource.closed;
  });
  return { resource, authorized, received };
}

test("official OAuth refresh waits for the real token body and retries the MCP request with the saved token", async (t) => {
  const server = await oauthPeer(t, { holdToken: "body" });
  const { provider, state } = providerFor(server);
  assert.throws(
    () =>
      new ManagedHttpTransport({
        url: server.url,
        authProvider: provider,
        headers: { Authorization: "Bearer fixture-static-secret" },
        maxMessageBytes: 8192,
        authorize() {},
      }),
    { code: "invalid_mcp_config" },
  );
  const { resource, authorized, received } = managed(t, server, provider);
  assert.deepEqual(server.requests, []);
  assert.deepEqual(authorized, []);
  await resource.transport.start();
  let settled = false;
  const operation = resource
    .run(new AbortController().signal, () =>
      resource.transport.send(message(1)),
    )
    .finally(() => {
      settled = true;
    });
  void operation.catch(() => {});
  try {
    await until(
      () =>
        server.requests.some(
          (item) => item.path === "/token" && item.bodyStarted,
        ),
      "The official SDK must issue a real refresh-token POST",
    );
    const token = server.requests.find((item) => item.path === "/token");
    assert.equal(settled, false);
    assert.equal(state.saved.length, 0);
    assert.equal(token.closed, false);
    assert.equal(token.method, "POST");
    assert.equal(token.form.grant_type, "refresh_token");
    assert.equal(token.form.refresh_token, refreshToken);
    assert.equal(token.form.client_id, "fixture-client");
    assert.equal(token.form.resource, server.url);
    token.release();
    await operation;
    assert.deepEqual(received, [result(1)]);
    assert.equal(state.tokens.access_token, refreshed);
    assert.equal(state.tokens.issuer, server.origin);
    assert.equal(state.redirects.length, 0);
    assert.deepEqual(
      authorized,
      server.requests.map((item) => item.url),
    );
    const calls = server.requests.filter((item) => item.path === "/mcp");
    assert.deepEqual(
      calls.map((item) => item.headers.authorization),
      [`Bearer ${expired}`, `Bearer ${refreshed}`],
    );
    assert.ok(
      server.requests
        .filter((item) => item.path !== "/mcp")
        .every((item) => item.headers.authorization === undefined),
    );
    await until(
      () => server.requests.every((item) => item.closed),
      "Challenge, discovery, token and retry bodies must really close",
    );
  } finally {
    for (const item of server.requests.filter((item) => item.path === "/token"))
      if (!item.response.destroyed && !item.response.writableEnded)
        item.release?.();
    await resource.dispose();
    await Promise.allSettled([operation]);
  }
});

test("an OAuth provider without consent returns maintenance_auth_required without opening the authorization endpoint", async (t) => {
  const server = await oauthPeer(t);
  const { provider, state } = providerFor(server, { tokens: null });
  const { resource } = managed(t, server, provider);
  await resource.transport.start();
  await assert.rejects(
    resource.run(new AbortController().signal, () =>
      resource.transport.send(message(1)),
    ),
    { code: "maintenance_auth_required" },
  );
  // Runtime may reject before the interactive provider callback. PKCE and
  // authorization-code continuation belong to the maintenance OAuth tests.
  assert.equal(state.saved.length, 0);
  assert.equal(
    server.requests.some((item) =>
      ["/authorize", "/token"].includes(item.path),
    ),
    false,
  );
  await until(
    () => server.requests.every((item) => item.closed),
    "A denied consent flow must release every actual HTTP body",
  );
});

test("OAuth discovery rechecks each target after authority is revoked and the same transport remains reusable", async (t) => {
  const server = await oauthPeer(t, { holdResourceMetadata: true });
  const { provider, state } = providerFor(server);
  let allowed = true;
  const { resource, authorized, received } = managed(t, server, provider, {
    authorize() {
      if (!allowed)
        throw new AgentError(
          "fixture_authority_revoked",
          "Fixture authority was revoked.",
        );
    },
  });
  await resource.transport.start();
  const operation = resource.run(new AbortController().signal, () =>
    resource.transport.send(message(1)),
  );
  const rejected = assert.rejects(operation, {
    code: "fixture_authority_revoked",
  });
  await until(
    () =>
      server.requests.some(
        (item) => item.path === "/resource-metadata" && item.release,
      ),
    "Protected-resource discovery must be in flight before revocation",
  );
  const metadata = server.requests.find(
    (item) => item.path === "/resource-metadata",
  );
  allowed = false;
  metadata.release();
  await rejected;
  assert.equal(state.saved.length, 0);
  assert.equal(
    server.requests.some((item) => item.path === "/token"),
    false,
  );
  assert.ok(
    authorized.some((url) =>
      url.endsWith("/.well-known/oauth-authorization-server"),
    ),
  );
  assert.equal(
    server.requests.some(
      (item) => item.path === "/.well-known/oauth-authorization-server",
    ),
    false,
  );
  await until(
    () => metadata.closed,
    "Revoked discovery must release its real response body",
  );
  allowed = true;
  server.control.holdResourceMetadata = false;
  await resource.run(new AbortController().signal, () =>
    resource.transport.send(message(2)),
  );
  assert.deepEqual(received, [result(2)]);
});

test("cancelling OAuth refresh closes its native headers or body without stopping a shared GET or another request", async (t) => {
  for (const holdToken of ["headers", "body"]) {
    const server = await oauthPeer(t, { holdToken });
    server.control.accessToken = expired;
    const { provider, state } = providerFor(server);
    const { resource, received } = managed(t, server, provider);
    await resource.transport.start();
    await resource.run(new AbortController().signal, () =>
      resource.transport.send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    );
    await until(
      () => server.requests.some((item) => item.method === "GET"),
      "The SDK must establish its actual shared GET before refresh",
    );
    const shared = server.requests.find((item) => item.method === "GET");
    const otherResult = Promise.withResolvers();
    resource.transport.onmessage = (value) => {
      received.push(value);
      if (value.id === 9) otherResult.resolve(value);
    };
    const other = resource.run(new AbortController().signal, async () => {
      await resource.transport.send(message(9));
      return otherResult.promise;
    });
    void other.catch(() => {});
    const controller = new AbortController();
    let operation;
    try {
      await until(
        () => server.requests.some((item) => item.message?.id === 9),
        "An independent request must have a real open SSE response",
      );
      server.control.accessToken = refreshed;
      operation = resource.run(controller.signal, () =>
        resource.transport.send(message(1)),
      );
      const rejected = assert.rejects(operation, {
        message: "cancel fixture OAuth refresh",
      });
      await until(
        () =>
          server.requests.some((item) => item.path === "/token" && item.form),
        "The actual OAuth token exchange must begin before cancellation",
      );
      const token = server.requests.find((item) => item.path === "/token");
      controller.abort(new Error("cancel fixture OAuth refresh"));
      await rejected;
      await until(
        () => token.closed,
        "Cancellation must close the token request's actual native exchange",
      );
      assert.equal(shared.closed, false);
      const otherRequest = server.requests.find(
        (item) => item.message?.id === 9,
      );
      assert.equal(otherRequest.closed, false);
      assert.equal(state.saved.length, 0);
      assert.equal(
        server.requests.some((item) => item.path === "/authorize"),
        false,
      );
      server.control.holdToken = undefined;
      await resource.run(new AbortController().signal, () =>
        resource.transport.send(message(2)),
      );
      otherRequest.response.write(`data: ${JSON.stringify(result(9))}\n\n`);
      assert.deepEqual(await other, result(9));
      assert.ok(received.some((value) => value.id === 2));
      assert.equal(shared.closed, false);
      await resource.dispose();
      await resource.closed;
      await until(
        () => shared.closed && otherRequest.closed,
        "Only instance disposal may stop the shared HTTP listener",
      );
    } finally {
      controller.abort(new Error("fixture cleanup"));
      otherResult.resolve(result(9));
      await resource.dispose();
      await Promise.allSettled([other, ...(operation ? [operation] : [])]);
    }
  }
});

test("concurrent 401 responses share one refresh instead of reusing a rotating refresh token", async (t) => {
  const server = await oauthPeer(t, {
    holdUnauthorized: true,
    holdToken: "body",
    rotateRefreshTokens: true,
  });
  const { provider, state } = providerFor(server);
  const { resource, received } = managed(t, server, provider);
  await resource.transport.start();
  const operations = [1, 2].map((id) =>
    resource.run(new AbortController().signal, () =>
      resource.transport.send(message(id)),
    ),
  );
  const settled = Promise.allSettled(operations);
  try {
    await until(
      () =>
        server.requests.filter((item) => item.path === "/mcp" && item.release)
          .length === 2,
      "Both actual MCP requests must carry the same expired access token before either challenge is released",
    );
    for (const item of server.requests.filter((item) => item.path === "/mcp"))
      item.release();
    server.control.holdUnauthorized = false;
    await until(
      () =>
        server.requests.some(
          (item) => item.path === "/token" && item.bodyStarted,
        ),
      "The shared refresh must own an actual token response before release",
    );
  } finally {
    server.control.holdToken = undefined;
    for (const item of server.requests.filter((item) => item.path === "/token"))
      item.release?.();
  }
  const outcomes = await settled;
  const tokenRequests = server.requests.filter(
    (item) => item.path === "/token",
  );
  assert.equal(
    outcomes.every((outcome) => outcome.status === "fulfilled"),
    true,
    JSON.stringify({
      outcomes: outcomes.map((outcome) => ({
        status: outcome.status,
        code: outcome.reason?.code,
      })),
      tokenRequests: tokenRequests.length,
      invalidations: state.invalidations,
    }),
  );
  assert.equal(tokenRequests.length, 1);
  assert.deepEqual(received.map((value) => value.id).sort(), [1, 2]);
  assert.equal(state.redirects.length, 0);
});

test("cancelling the refresh initiator preserves the rotated token needed by another waiting call", async (t) => {
  const server = await oauthPeer(t, {
    holdUnauthorized: true,
    holdToken: "body",
    rotateRefreshTokens: true,
  });
  server.control.accessToken = expired;
  const { provider, state } = providerFor(server);
  const invocation = new AsyncLocalStorage();
  provider.addClientAuthentication = (headers, params) => {
    headers.set("x-fixture-operation", invocation.getStore());
    params.set("client_id", "fixture-client");
  };
  const { resource } = managed(t, server, provider);
  await resource.transport.start();
  await resource.run(new AbortController().signal, () =>
    resource.transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  );
  await until(
    () => server.requests.some((item) => item.method === "GET"),
    "The actual shared connection must exist before concurrent refresh",
  );
  const shared = server.requests.find((item) => item.method === "GET");
  server.control.accessToken = refreshed;
  const controllers = [new AbortController(), new AbortController()];
  const operations = controllers.map((controller, index) =>
    invocation.run(String(index), () =>
      resource.run(controller.signal, () =>
        resource.transport.send(message(index + 1)),
      ),
    ),
  );
  const settled = Promise.allSettled(operations);
  let initiator;
  try {
    await until(
      () =>
        server.requests.filter((item) => item.path === "/mcp" && item.release)
          .length === 2,
      "Both callers must receive actual old-token challenges",
    );
    for (const item of server.requests.filter(
      (item) => item.path === "/mcp" && item.release,
    ))
      item.release();
    server.control.holdUnauthorized = false;
    await until(
      () =>
        server.requests.some(
          (item) => item.path === "/token" && item.bodyStarted,
        ),
      "The authorization server must consume the refresh token before caller cancellation",
    );
    const token = server.requests.find((item) => item.path === "/token");
    initiator = Number(token.headers["x-fixture-operation"]);
    assert.ok(initiator === 0 || initiator === 1);
    controllers[initiator].abort(new Error("cancel refresh initiator"));
  } finally {
    server.control.holdToken = undefined;
    for (const item of server.requests.filter((item) => item.path === "/token"))
      item.release?.();
  }
  const outcomes = await settled;
  assert.equal(outcomes[initiator].status, "rejected");
  assert.equal(outcomes[initiator].reason.message, "cancel refresh initiator");
  assert.equal(
    outcomes[1 - initiator].status,
    "fulfilled",
    JSON.stringify({
      outcomes: outcomes.map((outcome) => ({
        status: outcome.status,
        code: outcome.reason?.code,
      })),
      tokenRequests: server.requests.filter((item) => item.path === "/token")
        .length,
      invalidations: state.invalidations,
    }),
  );
  assert.equal(state.tokens.access_token, refreshed);
  assert.equal(shared.closed, false);
  assert.equal(
    server.requests.filter((item) => item.path === "/token").length,
    1,
  );
});

test("OAuth token endpoint diagnostics do not escape through SDK warnings or public operation errors", async (t) => {
  const secret = "fixture-private-oauth-diagnostic";
  const server = await oauthPeer(t, {
    tokenError: { error: "server_error", error_description: secret },
  });
  const { provider } = providerFor(server);
  const { resource } = managed(t, server, provider);
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  await resource.transport.start();
  let failure;
  try {
    await resource.run(new AbortController().signal, () =>
      resource.transport.send(message(1)),
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(
    failure,
    "A failed actual token exchange must reject the operation",
  );
  assert.equal(String(failure.message).includes(secret), false);
  assert.equal(JSON.stringify(warnings).includes(secret), false);
  assert.equal(
    server.requests.filter((item) => item.path === "/token").length,
    1,
  );
  await until(
    () => server.requests.every((item) => item.closed),
    "A rejected token response must still close its real HTTP body",
  );
});

test("a late 401 for the previous token retries the saved generation without refreshing again", async (t) => {
  const server = await oauthPeer(t, {
    holdUnauthorized: true,
    rotateRefreshTokens: true,
  });
  const { provider, state } = providerFor(server);
  const { resource, received } = managed(t, server, provider);
  await resource.transport.start();
  const operations = [1, 2].map((id) =>
    resource.run(new AbortController().signal, () =>
      resource.transport.send(message(id)),
    ),
  );
  const settled = Promise.allSettled(operations);
  try {
    await until(
      () =>
        server.requests.filter((item) => item.path === "/mcp" && item.release)
          .length === 2,
      "Both old-token requests must reach the resource server before either challenge is released",
    );
    const first = server.requests.find((item) => item.message?.id === 1);
    const late = server.requests.find((item) => item.message?.id === 2);
    first.release();
    await operations[0];
    assert.equal(state.tokens.access_token, refreshed);
    assert.equal(state.saved.length, 1);
    assert.equal(late.closed, false);
    late.release();
    await operations[1];
    assert.equal(
      server.requests.filter((item) => item.path === "/token").length,
      1,
    );
    assert.equal(state.saved.length, 1);
    assert.deepEqual(received.map((value) => value.id).sort(), [1, 2]);
  } finally {
    for (const item of server.requests.filter(
      (item) => item.path === "/mcp" && item.release,
    ))
      if (!item.response.headersSent && !item.response.destroyed)
        item.release();
    await resource.dispose();
    await settled;
  }
});

test("stopping every refresh waiter drains the token body while only disposal closes the shared connection", async (t) => {
  const server = await oauthPeer(t, {
    holdUnauthorized: true,
    holdToken: "body",
    rotateRefreshTokens: true,
  });
  server.control.accessToken = expired;
  const { provider, state } = providerFor(server);
  const { resource } = managed(t, server, provider);
  let closed = false;
  void resource.closed.then(() => {
    closed = true;
  });
  await resource.transport.start();
  await resource.run(new AbortController().signal, () =>
    resource.transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  );
  await until(
    () => server.requests.some((item) => item.method === "GET"),
    "The instance must own an actual shared GET before the auth waiters start",
  );
  const shared = server.requests.find((item) => item.method === "GET");
  server.control.accessToken = refreshed;
  const controllers = [new AbortController(), new AbortController()];
  const operations = controllers.map((controller, index) =>
    resource.run(controller.signal, () =>
      resource.transport.send(message(index + 1)),
    ),
  );
  const settled = Promise.allSettled(operations);
  try {
    await until(
      () =>
        server.requests.filter((item) => item.path === "/mcp" && item.release)
          .length === 2,
      "Both real calls must be waiting on authentication",
    );
    for (const item of server.requests.filter(
      (item) => item.path === "/mcp" && item.release,
    ))
      item.release();
    server.control.holdUnauthorized = false;
    await until(
      () =>
        server.requests.some(
          (item) => item.path === "/token" && item.bodyStarted,
        ),
      "The shared token response must really be open before all callers stop",
    );
    controllers.forEach((controller, index) =>
      controller.abort(new Error(`stop OAuth waiter ${index}`)),
    );
    const outcomes = await settled;
    assert.ok(outcomes.every((outcome) => outcome.status === "rejected"));
    assert.deepEqual(
      outcomes.map((outcome) => outcome.reason.message),
      ["stop OAuth waiter 0", "stop OAuth waiter 1"],
    );
    const token = server.requests.find((item) => item.path === "/token");
    await until(
      () => token.closed,
      "The last waiter must cancel and drain the actual token body",
    );
    assert.equal(
      server.requests.filter((item) => item.path === "/token").length,
      1,
    );
    assert.equal(state.saved.length, 0);
    assert.equal(shared.closed, false);
    assert.equal(closed, false);
    await resource.dispose();
    await resource.closed;
    assert.equal(closed, true);
    await until(
      () => shared.closed,
      "Instance disposal must close its actual shared listener",
    );
  } finally {
    controllers.forEach((controller) =>
      controller.abort(new Error("fixture cleanup")),
    );
    await resource.dispose();
    await settled;
  }
});
