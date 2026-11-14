import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readdirSync,
  statSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
const dist = new URL(
  process.env.NEXUM_MCP_OAUTH_DIST ?? "../dist/",
  import.meta.url,
);
const [
  { McpOAuthService, validateMcpOAuthConfig },
  { CredentialVault },
  { ManagedHttpTransport },
  { canonicalJson },
  { AgentError },
] = await Promise.all([
  import(new URL("adapters/mcp-oauth.js", dist)),
  import(new URL("maintenance/credentials.js", dist)),
  import(new URL("adapters/mcp-http.js", dist)),
  import(new URL("contracts/json.js", dist)),
  import(new URL("contracts/errors.js", dist)),
]);
const clientSecret = "synthetic-mcp-client-secret",
  accessToken = "synthetic-mcp-access",
  refreshToken = "synthetic-mcp-refresh";
const digest = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
async function until(predicate, message) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(message);
}
function safe(error) {
  assert.ok(error instanceof AgentError);
  assert.equal(error.cause, undefined);
  for (const value of [
    clientSecret,
    accessToken,
    refreshToken,
    "synthetic-provider-secret",
  ])
    assert.equal(inspect(error).includes(value), false);
  return true;
}
async function fixture(t, options = {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-mcp-oauth-")),
    ),
    vault = await CredentialVault.open(root);
  const hits = [],
    tokens = [],
    codes = new Map(),
    targets = [];
  let origin,
    tokenHook,
    rejected = false,
    validAccess = accessToken,
    nextCode = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    hits.push({ path: url.pathname, headers: req.headers, closed: false });
    const hit = hits.at(-1);
    res.once("close", () => (hit.closed = true));
    const json = (value, status = 200, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.includes("oauth-protected-resource"))
      return json({
        resource: origin + "/service",
        authorization_servers: [origin],
        scopes_supported: ["read"],
      });
    if (
      url.pathname === "/.well-known/oauth-authorization-server" &&
      options.missingMetadata
    )
      return json({}, 404);
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json({
        issuer: origin,
        authorization_endpoint: options.insecureAuthorization
          ? "http://login.invalid/authorize"
          : origin + "/authorize",
        token_endpoint: origin + "/token",
        registration_endpoint: origin + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        authorization_response_iss_parameter_supported: true,
      });
    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("resource"), origin + "/service");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const code = `code-${++nextCode}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge"),
        redirect: url.searchParams.get("redirect_uri"),
      });
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("iss", origin);
      res.writeHead(302, { location: callback.href });
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (url.pathname === "/register")
      return json({
        ...JSON.parse(body),
        client_id: "dynamic-fixture",
        client_secret: clientSecret,
      });
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body),
        call = { form, headers: req.headers, response: res, closed: false };
      tokens.push(call);
      res.once("close", () => (call.closed = true));
      if (tokenHook) {
        await tokenHook(call);
        if (res.destroyed || res.writableEnded) return;
      }
      if (rejected)
        return json(
          {
            error: "invalid_grant",
            error_description: "synthetic-provider-secret",
          },
          400,
        );
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code"));
        codes.delete(form.get("code"));
        if (!code)
          return json(
            {
              error: "invalid_grant",
              error_description: "synthetic-provider-secret",
            },
            400,
          );
        assert.equal(
          createHash("sha256")
            .update(form.get("code_verifier"))
            .digest("base64url"),
          code.challenge,
        );
        assert.equal(form.get("redirect_uri"), code.redirect);
      } else assert.equal(form.get("refresh_token"), refreshToken);
      assert.equal(form.get("resource"), origin + "/service");
      if (options.authMethod === "client_secret_post") {
        assert.equal(req.headers.authorization, undefined);
        assert.equal(form.get("client_id"), "fixture");
        assert.equal(form.get("client_secret"), clientSecret);
      } else
        assert.equal(
          req.headers.authorization,
          `Basic ${Buffer.from(`${options.dynamic ? "dynamic-fixture" : "fixture"}:${clientSecret}`).toString("base64")}`,
        );
      validAccess =
        form.get("grant_type") === "refresh_token"
          ? "synthetic-refreshed-access"
          : accessToken;
      return json({
        access_token: validAccess,
        token_type: "Bearer",
        refresh_token: refreshToken,
        scope: "read",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/service/mcp") {
      if (options.sourceHeader)
        assert.equal(req.headers["x-mcp-private"], "synthetic-source-header");
      if (req.headers.authorization !== `Bearer ${validAccess}`)
        return json({}, 401, {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/service/mcp"`,
        });
      const value = JSON.parse(body);
      return json({ jsonrpc: "2.0", id: value.id, result: {} });
    }
    json({}, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const config = {
    clientMetadata: {
      client_name: "MCP OAuth fixture",
      token_endpoint_auth_method: options.authMethod ?? "client_secret_basic",
    },
    ...(options.dynamic ? {} : { clientInformation: { client_id: "fixture" } }),
    scope: "read",
    issuer: origin,
  };
  const binding = {
    owner: "user",
    agentId: "agent",
    profile: "development",
    target: "mcp",
    name: "fixture",
    scheme: "oauth",
    service: origin + "/service/mcp",
    authRevision: digest(config),
  };
  const ref = await vault.create(binding, {
    clientSecret: options.dynamic ? "superseded-private-secret" : clientSecret,
  });
  const controller = new AbortController();
  let current = true,
    denied;
  const scope = {
    caller: { principalId: "user", clientId: "fixture" },
    operationId: "op",
    requestId: "request-1",
    revision: 1,
    signal: controller.signal,
    assertCurrent() {
      if (!current)
        throw new AgentError("permission_denied", "synthetic-provider-secret");
    },
    authorize(target) {
      targets.push(target);
      if (denied?.(target))
        throw new AgentError("permission_denied", "synthetic-provider-secret");
    },
  };
  const service = new McpOAuthService(vault, options.timeoutMs ?? 3000);
  let state = 0;
  const authorization = () => ({
    state: `state-${++state}`,
    callbackUrl:
      "https://platform.example/api/console/maintenance/oauth/callback",
    schemeId: "oauth",
    candidateRevision: "a".repeat(64),
  });
  async function begin() {
    const auth = authorization(),
      launch = await service.start(config, ref, binding, auth, scope);
    return { auth, launch };
  }
  async function grant(attempt) {
    const res = await fetch(attempt.launch.authorizationUrl, {
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    const callback = new URL(res.headers.get("location"));
    return {
      schemeId: attempt.auth.schemeId,
      candidateRevision: attempt.auth.candidateRevision,
      callback: {
        state: callback.searchParams.get("state"),
        code: callback.searchParams.get("code"),
        issuer: callback.searchParams.get("iss"),
      },
    };
  }
  return {
    root,
    vault,
    config,
    binding,
    ref,
    scope,
    service,
    origin,
    hits,
    tokens,
    targets,
    controller,
    begin,
    grant,
    setHook(fn) {
      tokenHook = fn;
    },
    setRejected(value) {
      rejected = value;
    },
    setCurrent(value) {
      current = value;
    },
    deny(fn) {
      denied = fn;
    },
    expire() {
      validAccess = "expired";
    },
  };
}

test("MCP OAuth configuration validates public fields without network or secret-bearing work config", () => {
  for (const value of [
    {
      clientInformation: { client_id: "fixture", client_secret: clientSecret },
    },
    { tokens: { access_token: accessToken } },
    { clientMetadata: { access_token: accessToken } },
    { scope: "read\nwrite" },
    { clientMetadataUrl: "http://example.test/client.json" },
    { clientMetadataUrl: "https://user:secret@example.test/client.json" },
  ])
    assert.throws(() => validateMcpOAuthConfig(value));
  assert.deepEqual(
    validateMcpOAuthConfig({
      clientInformation: { client_id: "fixture" },
      scope: "read write",
    }),
    { clientInformation: { client_id: "fixture" }, scope: "read write" },
  );
});

test("real MCP consent retains PKCE, issuer and parent resource, private tokens survive reload and bind to the live source", async (t) => {
  const f = await fixture(t),
    attempt = await f.begin();
  assert.equal(attempt.launch.requireIssuer, true);
  assert.equal(
    f.hits.some((hit) => hit.path === "/authorize"),
    false,
  );
  assert.equal(
    await f.service.ready(f.config, f.ref, f.binding, f.scope),
    false,
  );
  const input = await f.grant(attempt);
  assert.equal(
    await f.service.complete(f.config, f.ref, f.binding, input, f.scope),
    f.ref,
  );
  assert.equal(f.tokens.length, 1);
  assert.equal(
    await f.service.ready(f.config, f.ref, f.binding, f.scope),
    true,
  );
  await assert.rejects(
    f.service.complete(f.config, f.ref, f.binding, input, f.scope),
    (error) => safe(error) && error.code === "mcp_oauth_state_invalid",
  );
  assert.equal(f.tokens.length, 1);
  const reloaded = new McpOAuthService(f.vault),
    factory = await reloaded.provider(f.config, f.ref, f.binding, f.scope);
  f.setCurrent(false); // The finished approval scope must never be reused.
  let live = true;
  const hostController = new AbortController();
  const host = {
    context: { agentId: "agent", profile: "development" },
    signal: hostController.signal,
    authorize() {
      if (!live)
        throw new AgentError("permission_denied", "Revoked live source.");
    },
  };
  assert.throws(
    () =>
      factory({
        ...host,
        context: { agentId: "agent", profile: "production" },
      }),
    (error) => error.code === "mcp_oauth_binding_invalid",
  );
  const provider = factory(host);
  assert.equal((await provider.tokens()).access_token, accessToken);
  const resource = new ManagedHttpTransport({
    url: f.binding.service,
    maxMessageBytes: 4096,
    authProvider: provider,
    authorize() {
      host.authorize();
    },
  });
  t.after(() => resource.dispose());
  await resource.transport.start();
  f.expire();
  await resource.run(new AbortController().signal, () =>
    resource.transport.send({ jsonrpc: "2.0", id: 1, method: "ping" }),
  );
  assert.equal(f.tokens.length, 2);
  assert.equal(
    (await provider.tokens()).access_token,
    "synthetic-refreshed-access",
  );
  live = false;
  await assert.rejects(
    provider.tokens(),
    (error) => error.code === "permission_denied",
  );
  const files = readdirSync(path.join(f.root, "state/maintenance/credentials"));
  assert.equal(files.length, 1);
  const file = path.join(f.root, "state/maintenance/credentials", files[0]);
  if (process.platform !== "win32")
    assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(readFileSync(file, "utf8").includes(clientSecret), true);
  assert.equal(readdirSync(f.root).includes("work"), false);
});

test("wrong issuer/state/candidate and rejected codes cannot replay a token exchange or leak provider diagnostics", async (t) => {
  const f = await fixture(t),
    attempt = await f.begin(),
    input = await f.grant(attempt);
  for (const changed of [
    { ...input, callback: { ...input.callback, state: "wrong" } },
    { ...input, candidateRevision: "b".repeat(64) },
  ])
    await assert.rejects(
      f.service.complete(f.config, f.ref, f.binding, changed, f.scope),
      (error) => safe(error) && error.code === "mcp_oauth_state_invalid",
    );
  assert.equal(f.tokens.length, 0);
  await assert.rejects(
    f.service.complete(
      f.config,
      f.ref,
      f.binding,
      {
        ...input,
        callback: { ...input.callback, issuer: f.origin + "/other" },
      },
      f.scope,
    ),
    safe,
  );
  assert.equal(f.tokens.length, 0);
  const second = await f.begin(),
    next = await f.grant(second);
  f.setRejected(true);
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  await assert.rejects(
    f.service.complete(f.config, f.ref, f.binding, next, f.scope),
    safe,
  );
  assert.equal(f.tokens.length, 1);
  assert.deepEqual(warnings, []);
  await assert.rejects(
    f.service.complete(f.config, f.ref, f.binding, next, f.scope),
    safe,
  );
  assert.equal(f.tokens.length, 1);
});

test("a replaced OAuth attempt cannot receive a late code exchange result or lose its new PKCE verifier", async (t) => {
  const f = await fixture(t),
    first = await f.begin(),
    input = await f.grant(first);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  f.setHook(() => held);
  const completing = f.service.complete(
    f.config,
    f.ref,
    f.binding,
    input,
    f.scope,
  );
  const rejected = assert.rejects(
    completing,
    (error) => safe(error) && error.code === "mcp_oauth_state_invalid",
  );
  await until(
    () => f.tokens.length === 1,
    "The first real exchange must reach the token endpoint",
  );
  const second = await f.begin();
  release();
  await rejected;
  const stored = await f.vault.read(f.ref, f.binding);
  assert.equal(stored.mcpOAuth.attempt.state, second.auth.state);
  assert.equal(stored.mcpOAuth.attempt.phase, "pending");
  assert.equal(stored.mcpOAuth.tokens, undefined);
  assert.ok(stored.mcpOAuth.verifier);
  f.setHook(undefined);
  const next = await f.grant(second);
  await f.service.complete(f.config, f.ref, f.binding, next, f.scope);
  assert.equal(
    await f.service.ready(f.config, f.ref, f.binding, f.scope),
    true,
  );
});

test("cancelling a real code exchange closes native I/O and leaves its one-use callback unrepeatable", async (t) => {
  const f = await fixture(t),
    attempt = await f.begin(),
    input = await f.grant(attempt);
  f.setHook(async (call) => {
    call.response.writeHead(200, { "content-type": "application/json" });
    call.response.write('{"access_token":"');
    await new Promise((resolve) => call.response.once("close", resolve));
  });
  const completing = f.service.complete(
    f.config,
    f.ref,
    f.binding,
    input,
    f.scope,
  );
  const rejected = assert.rejects(
    completing,
    (error) => safe(error) && error.code === "mcp_oauth_cancelled",
  );
  await until(
    () => f.tokens.length === 1,
    "The code exchange must enter actual native I/O",
  );
  f.controller.abort();
  await rejected;
  await until(
    () => f.tokens[0].closed,
    "The aborted native token response must really close",
  );
  const current = { ...f.scope, signal: new AbortController().signal };
  await assert.rejects(
    f.service.complete(f.config, f.ref, f.binding, input, current),
    (error) => safe(error) && error.code === "mcp_oauth_state_invalid",
  );
  assert.equal(f.tokens.length, 1);
});

test("current authorization rejects a token target before contact and never exposes policy diagnostics", async (t) => {
  const f = await fixture(t),
    attempt = await f.begin(),
    input = await f.grant(attempt);
  f.deny((target) => target.value === `${f.origin}/token`);
  await assert.rejects(
    f.service.complete(f.config, f.ref, f.binding, input, f.scope),
    (error) => safe(error) && error.code === "permission_denied",
  );
  assert.equal(f.tokens.length, 0);
  await assert.rejects(
    f.service.ready(f.config, f.ref, f.binding, {
      ...f.scope,
      caller: { ...f.scope.caller, principalId: "another-owner" },
    }),
    (error) => safe(error) && error.code === "mcp_oauth_binding_invalid",
  );
});

test("a native OAuth deadline or oversized body closes its actual token response without publishing credentials", async (t) => {
  const f = await fixture(t),
    first = await f.begin(),
    input = await f.grant(first);
  f.setHook(async (call) => {
    call.response.writeHead(200, { "content-type": "application/json" });
    call.response.write('{"access_token":"');
    await new Promise((resolve) => call.response.once("close", resolve));
  });
  const deadline = new AbortController();
  const timerMock = t.mock.method(
    AbortSignal,
    "timeout",
    () => deadline.signal,
  );
  const completing = f.service.complete(
    f.config,
    f.ref,
    f.binding,
    input,
    f.scope,
  );
  const rejected = assert.rejects(
    completing,
    (error) => safe(error) && error.code === "mcp_oauth_timeout",
  );
  await until(
    () => f.tokens.length === 1,
    "The native deadline must act on an actual token response",
  );
  deadline.abort(
    new DOMException("Controlled elapsed deadline.", "TimeoutError"),
  );
  await rejected;
  await until(
    () => f.tokens[0].closed,
    "The timed out token response must actually close",
  );
  timerMock.mock.restore();
  const second = await f.begin(),
    next = await f.grant(second);
  f.setHook(async (call) => {
    call.response.writeHead(200, { "content-type": "application/json" });
    call.response.write(`{"access_token":"${"x".repeat(1024 * 1024 + 1)}`);
    await new Promise((resolve) => call.response.once("close", resolve));
  });
  await assert.rejects(
    f.service.complete(f.config, f.ref, f.binding, next, f.scope),
    (error) => safe(error) && error.code === "mcp_oauth_response_too_large",
  );
  await until(
    () => f.tokens[1].closed,
    "The oversized token response must actually close",
  );
  assert.equal(
    (await f.vault.read(f.ref, f.binding)).mcpOAuth.tokens,
    undefined,
  );
});

test("a configured Post client authentication method survives the official SDK's Basic preference", async (t) => {
  const f = await fixture(t, { authMethod: "client_secret_post" }),
    attempt = await f.begin(),
    input = await f.grant(attempt);
  await f.service.complete(f.config, f.ref, f.binding, input, f.scope);
  assert.equal(f.tokens.length, 1);
  assert.equal(f.tokens[0].headers.authorization, undefined);
  const factory = await f.service.provider(f.config, f.ref, f.binding, f.scope);
  const provider = factory({
    context: { agentId: "agent", profile: "development" },
    signal: new AbortController().signal,
    authorize() {},
  });
  assert.equal(
    (await provider.clientInformation()).token_endpoint_auth_method,
    "client_secret_post",
  );
});

test("discovery cannot return a non-loopback HTTP authorization page or register a client before endpoint validation", async (t) => {
  const f = await fixture(t, { insecureAuthorization: true });
  await assert.rejects(
    f.begin(),
    (error) => safe(error) && error.code === "mcp_oauth_insecure_endpoint",
  );
  assert.equal(
    f.hits.some((hit) =>
      ["/register", "/authorize", "/token"].includes(hit.path),
    ),
    false,
  );
  assert.equal(
    await f.service.ready(f.config, f.ref, f.binding, f.scope),
    false,
  );
});

test("legacy dynamic client registration saves its returned private secret instead of reusing an unrelated configured secret", async (t) => {
  const f = await fixture(t, { dynamic: true }),
    attempt = await f.begin(),
    input = await f.grant(attempt);
  assert.equal(f.hits.filter((hit) => hit.path === "/register").length, 1);
  await f.service.complete(f.config, f.ref, f.binding, input, f.scope);
  assert.equal(
    await f.service.ready(f.config, f.ref, f.binding, f.scope),
    true,
  );
  const factory = await f.service.provider(f.config, f.ref, f.binding, f.scope);
  const provider = factory({
    context: { agentId: "agent", profile: "development" },
    signal: new AbortController().signal,
    authorize() {},
  });
  assert.equal(
    (await provider.clientInformation()).client_id,
    "dynamic-fixture",
  );
  assert.equal(
    (await provider.clientInformation()).client_secret,
    clientSecret,
  );
});

test("a finished RPC observation drains its unused authentication body even when the original caller signal stays live", async (t) => {
  const f = await fixture(t),
    attempt = await f.begin(),
    input = await f.grant(attempt);
  await f.service.complete(f.config, f.ref, f.binding, input, f.scope);
  const factory = await f.service.provider(f.config, f.ref, f.binding, f.scope);
  const provider = factory({
    context: { agentId: "agent", profile: "development" },
    signal: new AbortController().signal,
    authorize() {},
  });
  const resource = new ManagedHttpTransport({
    url: f.binding.service,
    maxMessageBytes: 4096,
    authProvider: provider,
    authorize() {},
  });
  t.after(() => resource.dispose());
  await resource.transport.start();
  f.expire();
  f.setHook(async (call) => {
    call.response.writeHead(200, { "content-type": "application/json" });
    call.response.write('{"access_token":"');
    await new Promise((resolve) => call.response.once("close", resolve));
  });
  const caller = new AbortController();
  let sending;
  await assert.rejects(
    resource.run(caller.signal, async () => {
      sending = resource.transport.send({
        jsonrpc: "2.0",
        id: 71,
        method: "ping",
      });
      void sending.catch(() => {});
      await until(
        () => f.tokens.length === 2,
        "The actual refresh must be holding its native response",
      );
      throw new AgentError(
        "fixture_request_timeout",
        "The SDK request observation expired.",
      );
    }),
    (error) => error.code === "fixture_request_timeout",
  );
  await assert.rejects(sending);
  assert.equal(caller.signal.aborted, false);
  await until(
    () => f.tokens[1].closed,
    "Unused authentication I/O must close when its only observation ends",
  );
  f.setHook(undefined);
  await resource.run(caller.signal, () =>
    resource.transport.send({ jsonrpc: "2.0", id: 72, method: "ping" }),
  );
  assert.equal(f.tokens.length, 3);
});

test("OAuth keeps configured MCP headers at the source endpoint and never forwards them to the same-origin authorization server", async (t) => {
  const f = await fixture(t, { sourceHeader: true }),
    attempt = await f.begin(),
    input = await f.grant(attempt);
  await f.service.complete(f.config, f.ref, f.binding, input, f.scope);
  const factory = await f.service.provider(f.config, f.ref, f.binding, f.scope),
    provider = factory({
      context: { agentId: "agent", profile: "development" },
      signal: new AbortController().signal,
      authorize() {},
    });
  const resource = new ManagedHttpTransport({
    url: f.binding.service,
    maxMessageBytes: 4096,
    authProvider: provider,
    headers: { "X-MCP-Private": "synthetic-source-header" },
    authorize() {},
  });
  t.after(() => resource.dispose());
  await resource.transport.start();
  f.expire();
  await resource.run(new AbortController().signal, () =>
    resource.transport.send({ jsonrpc: "2.0", id: 81, method: "ping" }),
  );
  assert.equal(f.tokens.length, 2);
  assert.equal(
    f.hits
      .filter((hit) => hit.path !== "/service/mcp")
      .every((hit) => hit.headers["x-mcp-private"] === undefined),
    true,
  );
  assert.equal(
    f.hits
      .filter((hit) => hit.path === "/service/mcp")
      .every(
        (hit) => hit.headers["x-mcp-private"] === "synthetic-source-header",
      ),
    true,
  );
});

test("the official legacy authorization endpoint fallback keeps its original discovery binding through code exchange and refresh", async (t) => {
  const f = await fixture(t, { missingMetadata: true }),
    attempt = await f.begin(),
    input = await f.grant(attempt);
  assert.equal(attempt.launch.requireIssuer, false);
  await f.service.complete(f.config, f.ref, f.binding, input, f.scope);
  const factory = await f.service.provider(f.config, f.ref, f.binding, f.scope),
    provider = factory({
      context: { agentId: "agent", profile: "development" },
      signal: new AbortController().signal,
      authorize() {},
    });
  const resource = new ManagedHttpTransport({
    url: f.binding.service,
    maxMessageBytes: 4096,
    authProvider: provider,
    authorize() {},
  });
  t.after(() => resource.dispose());
  await resource.transport.start();
  f.expire();
  await resource.run(new AbortController().signal, () =>
    resource.transport.send({ jsonrpc: "2.0", id: 91, method: "ping" }),
  );
  assert.equal(f.tokens.length, 2);
  assert.equal(
    await f.service.ready(f.config, f.ref, f.binding, f.scope),
    true,
  );
});
