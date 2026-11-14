import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";

const dist = new URL(
  process.env.NEXUM_OAUTH_DIST ?? "../dist/",
  import.meta.url,
);
const [
  { OAuthProvider, OAuthSessionService },
  { CredentialVault },
  { AgentError },
] = await Promise.all([
  import(new URL("maintenance/oauth.js", dist)),
  import(new URL("maintenance/credentials.js", dist)),
  import(new URL("contracts/errors.js", dist)),
]);
const clientSecret = "synthetic-oauth-client-secret-48";
const clientId = "fixture-client";
let rsa;
function keys() {
  rsa ??= generateKeyPairSync("rsa", { modulusLength: 2048 });
  return rsa;
}
function jwt(claims) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "fixture-key" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys().privateKey).toString("base64url")}`;
}
function noSecret(
  value,
  values = [clientSecret, "synthetic-access-token", "synthetic-refresh-token"],
) {
  const serialized = inspect(value, { depth: 20 });
  for (const value of values) assert.equal(serialized.includes(value), false);
}
function safeFailure(error) {
  assert.ok(
    error instanceof AgentError,
    "a public failure must be an AgentError",
  );
  noSecret(error);
  assert.equal(
    error.cause,
    undefined,
    "raw provider/fetch errors must not be retained",
  );
  return true;
}
async function bounded(promise, ms = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Native fixture evidence did not settle.")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function json(response, value, status = 200, extra = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...extra });
  response.end(JSON.stringify(value));
}

async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-oauth-flows-")),
  );
  const vault = await CredentialVault.open(root);
  const controller = new AbortController();
  const hits = [],
    tokenCalls = [],
    codes = new Map(),
    targets = [];
  let issuer,
    deviceApproved = false,
    refreshReady,
    tokenHook;
  const binding = {
    owner: "user",
    agentId: "agent",
    profile: "development",
    target: "api",
    name: "crm",
    scheme: "oauth",
    service: "https://service.example",
    authRevision: "sha256:" + "a".repeat(64),
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, issuer);
    hits.push({ pathname: url.pathname, request, response });
    try {
      if (
        url.pathname === "/.well-known/openid-configuration" ||
        url.pathname === "/.well-known/oauth-authorization-server"
      ) {
        if (options.discovery)
          return options.discovery(request, response, metadata());
        return json(response, metadata());
      }
      if (url.pathname === "/jwks")
        return json(response, {
          keys: [
            {
              ...keys().publicKey.export({ format: "jwk" }),
              use: "sig",
              alg: "RS256",
              kid: "fixture-key",
            },
          ],
        });
      if (url.pathname === "/authorize") {
        const code = randomBytes(18).toString("base64url");
        codes.set(code, Object.fromEntries(url.searchParams));
        const callback = new URL(url.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", url.searchParams.get("state"));
        callback.searchParams.set("iss", issuer);
        response.writeHead(302, { Location: callback.href });
        response.end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      if (url.pathname === "/device") {
        return json(response, {
          device_code: "synthetic-private-device-code",
          user_code: "PUBLIC-CODE",
          verification_uri: `${issuer}/verify`,
          verification_uri_complete: `${issuer}/verify?user_code=PUBLIC-CODE`,
          expires_in: 60,
          interval: 1,
        });
      }
      if (url.pathname !== "/token")
        return json(response, { error: "unexpected_route" }, 400);
      const call = { form, headers: request.headers, request, response };
      tokenCalls.push(call);
      if (tokenHook) return await tokenHook(call);
      const method = options.clientAuthentication ?? "client_secret_basic";
      if (method === "client_secret_basic") {
        // RFC 6749 2.3.1 applies form encoding before HTTP Basic. Equivalent
        // percent escapes (including %2D) must be decoded before comparison.
        assert.match(
          request.headers.authorization,
          /^Basic [A-Za-z0-9+/]+=*$/i,
        );
        const decoded = Buffer.from(
          request.headers.authorization.slice(6),
          "base64",
        ).toString("utf8");
        const separator = decoded.indexOf(":");
        assert.ok(separator >= 0);
        const decode = (value) => decodeURIComponent(value.replace(/\+/g, " "));
        assert.equal(decode(decoded.slice(0, separator)), clientId);
        assert.equal(decode(decoded.slice(separator + 1)), clientSecret);
      }
      if (method === "client_secret_post") {
        assert.equal(form.get("client_secret"), clientSecret);
        assert.equal(form.get("client_id"), clientId);
      }
      if (method === "none") {
        assert.equal(form.get("client_id"), clientId);
        assert.equal(form.has("client_secret"), false);
        assert.equal(request.headers.authorization, undefined);
      }
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const original = codes.get(form.get("code"));
        assert.ok(
          original,
          "the authorization code must have been issued by this AS",
        );
        assert.equal(form.get("redirect_uri"), original.redirect_uri);
        const challenge = createHash("sha256")
          .update(form.get("code_verifier"))
          .digest("base64url");
        assert.equal(
          challenge,
          original.code_challenge,
          "the real token exchange must prove PKCE",
        );
        codes.delete(form.get("code"));
        const now = Math.floor(Date.now() / 1000);
        let idToken = original.scope?.split(" ").includes("openid")
          ? jwt({
              iss: issuer,
              aud: clientId,
              sub: "subject",
              iat: now,
              exp: now + 300,
              nonce: original.nonce,
              ...options.claims,
            })
          : undefined;
        if (idToken && options.badSignature) {
          const sections = idToken.split(".");
          sections[2] =
            (sections[2][0] === "A" ? "B" : "A") + sections[2].slice(1);
          idToken = sections.join(".");
        }
        return json(response, tokens(idToken));
      }
      if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        assert.equal(form.get("device_code"), "synthetic-private-device-code");
        if (!deviceApproved)
          return json(response, { error: "authorization_pending" }, 400);
        return json(response, tokens());
      }
      if (grant === "refresh_token") {
        assert.equal(form.get("refresh_token"), "synthetic-refresh-token");
        if (refreshReady) await refreshReady;
        return json(response, {
          ...tokens(),
          access_token: "synthetic-refreshed-access-token",
          refresh_token: "synthetic-rotated-refresh-token",
        });
      }
      assert.equal(grant, "client_credentials");
      return json(response, tokens());
    } catch (error) {
      if (!response.headersSent)
        json(
          response,
          { error: "fixture_assertion", message: error.message },
          500,
        );
      else response.destroy(error);
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  issuer = `http://127.0.0.1:${server.address().port}`;
  function metadata() {
    return {
      issuer,
      token_endpoint: `${issuer}/token`,
      authorization_endpoint: `${issuer}/authorize`,
      device_authorization_endpoint: `${issuer}/device`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "client_credentials",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "none",
      ],
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256"],
      authorization_response_iss_parameter_supported: true,
    };
  }
  function tokens(id_token) {
    return {
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh-token",
      token_type: options.tokenType ?? "Bearer",
      expires_in: 300,
      scope: options.scopes?.join(" ") ?? "read",
      ...(id_token ? { id_token } : {}),
    };
  }
  const config = {
    flow: "clientCredentials",
    issuer,
    clientId,
    scopes: ["read"],
    clientAuthentication: options.clientAuthentication ?? "client_secret_basic",
    allowHttp: true,
  };
  const scope = {
    caller: { principalId: "user", clientId: "host", grantId: "grant" },
    operationId: "operation",
    requestId: "maintenance-request",
    revision: 1,
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
    },
    authorize(target) {
      targets.push(target);
      assert.equal(target.type, "url");
      assert.equal(target.value.includes(clientSecret), false);
      assert.equal(new URL(target.value).origin, issuer);
    },
  };
  const ref = await vault.create(
    binding,
    options.clientAuthentication === "none" ? {} : { clientSecret },
  );
  const provider = new OAuthProvider(vault, {
    timeoutMs: 5000,
    maxResponseBytes: 1024 * 1024,
    maxRequestBytes: 256 * 1024,
    ...options.provider,
  });
  const sessions = new OAuthSessionService(provider, { root });
  function oauthBinding() {
    return {
      state: randomBytes(32).toString("base64url"),
      callbackUrl:
        "https://console.example/api/console/maintenance/oauth/callback",
      schemeId: "oauth",
      candidateRevision: "sha256:" + "b".repeat(64),
    };
  }
  async function callback(launch, binding) {
    const redirect = await fetch(launch.authorizationUrl, {
      redirect: "manual",
    });
    assert.equal(redirect.status, 302);
    const url = new URL(redirect.headers.get("location"));
    return {
      schemeId: binding.schemeId,
      candidateRevision: binding.candidateRevision,
      callback: {
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code"),
        issuer: url.searchParams.get("iss"),
      },
    };
  }
  t.after(async () => {
    controller.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    vault,
    binding,
    ref,
    provider,
    sessions,
    config,
    scope,
    controller,
    hits,
    tokenCalls,
    targets,
    issuer,
    metadata,
    oauthBinding,
    callback,
    approveDevice() {
      deviceApproved = true;
    },
    tokenHook(value) {
      tokenHook = value;
    },
    refreshGate(value) {
      refreshReady = value;
    },
  };
}

test("client credentials use each configured real authentication method and keep tokens in the bound vault", async (t) => {
  for (const clientAuthentication of [
    "client_secret_basic",
    "client_secret_post",
    "none",
  ])
    await t.test(clientAuthentication, async (t) => {
      const f = await fixture(t, { clientAuthentication });
      const ref = await f.provider.prepareAuth(
        f.config,
        f.ref,
        f.binding,
        f.scope,
      );
      assert.equal(ref, f.ref);
      const record = await f.vault.read(ref, f.binding);
      assert.equal(record.tokens.access_token, "synthetic-access-token");
      assert.equal(record.tokens.token_type.toLowerCase(), "bearer");
      assert.ok(record.tokens.expiresAt > Date.now());
      assert.equal(
        await f.provider.getAccessToken(f.config, ref, f.binding, f.scope),
        "synthetic-access-token",
      );
      assert.equal(f.tokenCalls.length, 1);
      assert.ok(f.targets.length > 0);
    });
});

test("authorization code proves real PKCE, persists its private attempt and updates the original credential reference once", async (t) => {
  const f = await fixture(t);
  const config = { ...f.config, flow: "authorizationCode" };
  const binding = f.oauthBinding();
  const launch = await f.sessions.start(
    config,
    f.ref,
    f.binding,
    binding,
    f.scope,
  );
  assert.deepEqual(Object.keys(launch).sort(), [
    "authorizationUrl",
    "issuer",
    "requireIssuer",
  ]);
  noSecret(launch);
  const url = new URL(launch.authorizationUrl);
  assert.equal(url.searchParams.get("state"), binding.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge").length >= 43);
  assert.equal(url.searchParams.has("code_verifier"), false);
  assert.equal(url.searchParams.has("client_secret"), false);
  const completion = await f.callback(launch, binding);
  const restarted = new OAuthSessionService(f.provider, { root: f.root });
  assert.equal(
    await restarted.complete(config, f.ref, f.binding, completion, f.scope),
    f.ref,
  );
  assert.equal(
    (await f.vault.read(f.ref, f.binding)).tokens.access_token,
    "synthetic-access-token",
  );
  assert.equal(f.tokenCalls.length, 1);
  assert.equal(
    JSON.stringify(launch).includes(f.tokenCalls[0].form.get("code_verifier")),
    false,
  );
  await assert.rejects(
    restarted.complete(config, f.ref, f.binding, completion, f.scope),
    safeFailure,
  );
  assert.equal(
    f.tokenCalls.length,
    1,
    "a consumed authorization code cannot be redeemed twice",
  );
});

test("OIDC validates nonce, issuer and the real JWKS signature", async (t) => {
  await t.test("valid identity token", async (t) => {
    const f = await fixture(t, { scopes: ["openid", "read"] });
    const config = {
      ...f.config,
      flow: "authorizationCode",
      scopes: ["openid", "read"],
      oidc: true,
    };
    const binding = f.oauthBinding(),
      launch = await f.sessions.start(
        config,
        f.ref,
        f.binding,
        binding,
        f.scope,
      );
    assert.ok(new URL(launch.authorizationUrl).searchParams.get("nonce"));
    const completion = await f.callback(launch, binding);
    assert.equal(
      await f.sessions.complete(config, f.ref, f.binding, completion, f.scope),
      f.ref,
    );
    assert.ok(f.hits.some((hit) => hit.pathname === "/jwks"));
  });
  for (const [name, claims] of [
    ["wrong nonce", { nonce: "wrong-nonce" }],
    ["wrong ID token issuer", { iss: "https://unapproved.example" }],
    ["wrong audience", { aud: "another-client" }],
  ])
    await t.test(name, async (t) => {
      const f = await fixture(t, { claims, scopes: ["openid", "read"] });
      const config = {
        ...f.config,
        flow: "authorizationCode",
        scopes: ["openid", "read"],
        oidc: true,
      };
      const binding = f.oauthBinding(),
        launch = await f.sessions.start(
          config,
          f.ref,
          f.binding,
          binding,
          f.scope,
        ),
        completion = await f.callback(launch, binding);
      await assert.rejects(
        f.sessions.complete(config, f.ref, f.binding, completion, f.scope),
        safeFailure,
      );
      assert.equal((await f.vault.read(f.ref, f.binding)).tokens, undefined);
      assert.equal(f.tokenCalls.length, 1);
    });
});

test("state, issuer, candidate and owner bindings are checked before code redemption", async (t) => {
  for (const kind of [
    "state",
    "issuer",
    "candidate",
    "owner",
    "request",
    "revision",
    "scheme",
  ])
    await t.test(kind, async (t) => {
      const f = await fixture(t),
        config = { ...f.config, flow: "authorizationCode" },
        binding = f.oauthBinding();
      const launch = await f.sessions.start(
          config,
          f.ref,
          f.binding,
          binding,
          f.scope,
        ),
        completion = await f.callback(launch, binding);
      if (kind === "state") completion.callback.state = "different-state";
      if (kind === "issuer")
        completion.callback.issuer = "https://different-issuer.example";
      if (kind === "candidate")
        completion.candidateRevision = "sha256:" + "c".repeat(64);
      if (kind === "scheme") completion.schemeId = "another-scheme";
      const scope =
        kind === "owner"
          ? {
              ...f.scope,
              caller: { ...f.scope.caller, principalId: "another-owner" },
            }
          : kind === "request"
            ? { ...f.scope, requestId: "another-request" }
            : kind === "revision"
              ? { ...f.scope, revision: 2 }
              : f.scope;
      await assert.rejects(
        f.sessions.complete(config, f.ref, f.binding, completion, scope),
        safeFailure,
      );
      assert.equal(f.tokenCalls.length, 0);
      assert.equal((await f.vault.read(f.ref, f.binding)).tokens, undefined);
    });
});

test("interactive owner mismatch is rejected before vault access, discovery or an authorization attempt is created", async (t) => {
  const f = await fixture(t),
    config = { ...f.config, flow: "authorizationCode" },
    binding = f.oauthBinding();
  let reads = 0;
  const read = f.vault.read;
  t.mock.method(f.vault, "read", function (...args) {
    reads++;
    return Reflect.apply(read, this, args);
  });
  await assert.rejects(
    f.sessions.start(config, f.ref, f.binding, binding, {
      ...f.scope,
      caller: { ...f.scope.caller, principalId: "another-owner" },
    }),
    (error) => {
      safeFailure(error);
      assert.equal(error.code, "oauth_owner_mismatch");
      return true;
    },
  );
  assert.equal(reads, 0);
  assert.equal(f.hits.length, 0);
  assert.equal(f.tokenCalls.length, 0);
});

test("cached OAuth credentials still require the fresh business request scope before vault access", async (t) => {
  const f = await fixture(t);
  await f.provider.prepareAuth(f.config, f.ref, f.binding, f.scope);
  let reads = 0;
  const read = f.vault.read;
  t.mock.method(f.vault, "read", function (...args) {
    reads++;
    return Reflect.apply(read, this, args);
  });
  await assert.rejects(
    f.provider.getAccessToken(f.config, f.ref, f.binding, {
      signal: new AbortController().signal,
      assertCurrent() {
        throw new AgentError(
          "forbidden",
          "The new business grant was revoked.",
        );
      },
      authorize() {
        throw Error("A revoked request must not reach endpoint authorization.");
      },
    }),
    (error) => {
      safeFailure(error);
      assert.equal(error.code, "forbidden");
      return true;
    },
  );
  assert.equal(reads, 0);
  assert.equal(f.tokenCalls.length, 1);
});

test("device authorization returns only public instructions and polls the real device grant", async (t) => {
  const f = await fixture(t),
    config = { ...f.config, flow: "device" },
    binding = f.oauthBinding();
  const launch = await f.sessions.start(
    config,
    f.ref,
    f.binding,
    binding,
    f.scope,
  );
  assert.equal(launch.userCode, "PUBLIC-CODE");
  assert.ok(launch.verificationUri.startsWith(`${f.issuer}/verify`));
  assert.equal(
    JSON.stringify(launch).includes("synthetic-private-device-code"),
    false,
  );
  noSecret(launch);
  f.approveDevice();
  assert.equal(
    await f.sessions.complete(
      config,
      f.ref,
      f.binding,
      {
        schemeId: binding.schemeId,
        candidateRevision: binding.candidateRevision,
        callback: { state: binding.state },
      },
      f.scope,
    ),
    f.ref,
  );
  assert.equal(
    (await f.vault.read(f.ref, f.binding)).tokens.access_token,
    "synthetic-access-token",
  );
  assert.ok(
    f.tokenCalls.some(
      (call) =>
        call.form.get("grant_type") ===
        "urn:ietf:params:oauth:grant-type:device_code",
    ),
  );
});

test("device polling observes caller cancellation while no token request is ready", async (t) => {
  const f = await fixture(t),
    config = { ...f.config, flow: "device" },
    binding = f.oauthBinding();
  await f.sessions.start(config, f.ref, f.binding, binding, f.scope);
  const result = f.sessions.complete(
    config,
    f.ref,
    f.binding,
    {
      schemeId: binding.schemeId,
      candidateRevision: binding.candidateRevision,
      callback: { state: binding.state },
    },
    f.scope,
  );
  const rejection = assert.rejects(result, safeFailure);
  await new Promise((resolve) => setTimeout(resolve, 30));
  f.controller.abort(Error(`device cancellation ${clientSecret}`));
  await bounded(rejection);
  assert.equal((await f.vault.read(f.ref, f.binding)).tokens, undefined);
});

test("device authorization checks the actual complete verification URL before publishing an attempt", async (t) => {
  const f = await fixture(t),
    config = { ...f.config, flow: "device" },
    binding = f.oauthBinding();
  await assert.rejects(
    f.sessions.start(config, f.ref, f.binding, binding, {
      ...f.scope,
      authorize(target) {
        f.scope.authorize(target);
        if (new URL(target.value).searchParams.has("user_code"))
          throw new AgentError(
            "forbidden",
            "The complete verification URL is not authorized.",
          );
      },
    }),
    (error) => {
      safeFailure(error);
      assert.equal(error.code, "forbidden");
      return true;
    },
  );
  assert.equal(f.tokenCalls.length, 0);
  const attempts = path.join(f.root, "state", "maintenance", "oauth");
  assert.deepEqual(existsSync(attempts) ? readdirSync(attempts) : [], []);
});

test("expired tokens refresh once for concurrent callers and preserve the original ref with rotated refresh data", async (t) => {
  const f = await fixture(t);
  await f.provider.prepareAuth(f.config, f.ref, f.binding, f.scope);
  const saved = await f.vault.read(f.ref, f.binding);
  saved.tokens.expiresAt = 0;
  await f.vault.update(f.ref, f.binding, saved);
  const release = Promise.withResolvers();
  f.refreshGate(release.promise);
  const requests = Array.from({ length: 8 }, () =>
    f.provider.getAccessToken(f.config, f.ref, f.binding, f.scope),
  );
  await bounded(
    (async () => {
      while (
        !f.tokenCalls.some(
          (call) => call.form.get("grant_type") === "refresh_token",
        )
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
    })(),
  );
  release.resolve();
  assert.deepEqual(
    await Promise.all(requests),
    Array(8).fill("synthetic-refreshed-access-token"),
  );
  assert.equal(
    f.tokenCalls.filter(
      (call) => call.form.get("grant_type") === "refresh_token",
    ).length,
    1,
  );
  assert.equal(
    (await f.vault.read(f.ref, f.binding)).tokens.refresh_token,
    "synthetic-rotated-refresh-token",
  );
});

test("OIDC refresh keeps the verified original account and rejects a signed subject change", async (t) => {
  for (const changeSubject of [false, true])
    await t.test(
      changeSubject ? "changed account" : "same account",
      async (t) => {
        const f = await fixture(t, { scopes: ["openid", "read"] });
        const config = {
          ...f.config,
          flow: "authorizationCode",
          oidc: true,
          scopes: ["openid", "read"],
        };
        const binding = f.oauthBinding();
        const launch = await f.sessions.start(
          config,
          f.ref,
          f.binding,
          binding,
          f.scope,
        );
        await f.sessions.complete(
          config,
          f.ref,
          f.binding,
          await f.callback(launch, binding),
          f.scope,
        );
        const saved = await f.vault.read(f.ref, f.binding);
        assert.equal(saved.tokens.identity.subject, "subject");
        saved.tokens.expiresAt = 0;
        await f.vault.update(f.ref, f.binding, saved);
        f.tokenHook(({ response }) => {
          const now = Math.floor(Date.now() / 1000);
          return json(response, {
            access_token: "synthetic-refreshed-access-token",
            refresh_token: "synthetic-rotated-refresh-token",
            token_type: "Bearer",
            expires_in: 300,
            scope: "openid read",
            id_token: jwt({
              iss: f.issuer,
              aud: clientId,
              sub: changeSubject ? "different-subject" : "subject",
              iat: now,
              exp: now + 300,
            }),
          });
        });
        if (changeSubject) {
          await assert.rejects(
            f.provider.getAccessToken(config, f.ref, f.binding, f.scope),
            (error) => {
              safeFailure(error);
              assert.equal(error.code, "oauth_identity_mismatch");
              return true;
            },
          );
          assert.equal(
            (await f.vault.read(f.ref, f.binding)).tokens.access_token,
            "synthetic-access-token",
          );
        } else {
          assert.equal(
            await f.provider.getAccessToken(config, f.ref, f.binding, f.scope),
            "synthetic-refreshed-access-token",
          );
          const current = await f.vault.read(f.ref, f.binding);
          assert.deepEqual(current.tokens.identity, saved.tokens.identity);
        }
      },
    );
});

test("unsupported token types, explicit HTTP consent and current endpoint authorization fail safely", async (t) => {
  await t.test("PoP is not silently treated as Bearer", async (t) => {
    const f = await fixture(t, { tokenType: "DPoP" });
    await assert.rejects(
      f.provider.prepareAuth(f.config, f.ref, f.binding, f.scope),
      safeFailure,
    );
    assert.equal((await f.vault.read(f.ref, f.binding)).tokens, undefined);
  });
  await t.test("invalid signature", async (t) => {
    const f = await fixture(t, {
      badSignature: true,
      scopes: ["openid", "read"],
    });
    const config = {
      ...f.config,
      flow: "authorizationCode",
      scopes: ["openid", "read"],
      oidc: true,
    };
    const binding = f.oauthBinding(),
      launch = await f.sessions.start(
        config,
        f.ref,
        f.binding,
        binding,
        f.scope,
      ),
      completion = await f.callback(launch, binding);
    await assert.rejects(
      f.sessions.complete(config, f.ref, f.binding, completion, f.scope),
      safeFailure,
    );
    assert.equal((await f.vault.read(f.ref, f.binding)).tokens, undefined);
    assert.ok(f.hits.some((hit) => hit.pathname === "/jwks"));
  });
  await t.test("HTTP requires explicit configuration", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.provider.prepareAuth(
        { ...f.config, allowHttp: false },
        f.ref,
        f.binding,
        f.scope,
      ),
      safeFailure,
    );
    assert.equal(f.hits.length, 0);
  });
  await t.test(
    "revoked policy never fetches credentials from the endpoint",
    async (t) => {
      const f = await fixture(t),
        scope = {
          ...f.scope,
          authorize() {
            throw new AgentError("forbidden", `private ${clientSecret}`);
          },
        };
      await assert.rejects(
        f.provider.prepareAuth(f.config, f.ref, f.binding, scope),
        safeFailure,
      );
      assert.equal(f.hits.length, 0);
    },
  );
});

test("token endpoint redirects are not followed and cancellation joins the real HTTP close", async (t) => {
  await t.test("redirect", async (t) => {
    const f = await fixture(t);
    f.tokenHook(({ response }) => {
      response.writeHead(302, { Location: `${f.issuer}/unapproved` });
      response.end();
    });
    await assert.rejects(
      f.provider.prepareAuth(f.config, f.ref, f.binding, f.scope),
      safeFailure,
    );
    assert.equal(
      f.hits.some((hit) => hit.pathname === "/unapproved"),
      false,
    );
    assert.equal((await f.vault.read(f.ref, f.binding)).tokens, undefined);
  });
  await t.test("actual abort closure", async (t) => {
    const arrived = Promise.withResolvers(),
      closed = Promise.withResolvers(),
      f = await fixture(t);
    f.tokenHook(({ response }) => {
      response.once("close", closed.resolve);
      arrived.resolve();
    });
    const operation = f.provider.prepareAuth(
        f.config,
        f.ref,
        f.binding,
        f.scope,
      ),
      rejection = assert.rejects(operation, safeFailure);
    await bounded(arrived.promise);
    f.controller.abort(Error(`cancel ${clientSecret}`));
    await bounded(rejection);
    await bounded(closed.promise);
    assert.equal((await f.vault.read(f.ref, f.binding)).tokens, undefined);
  });
  await t.test(
    "actual oversized response cancels the open response stream",
    async (t) => {
      const closed = Promise.withResolvers(),
        f = await fixture(t, { provider: { maxResponseBytes: 4096 } });
      f.tokenHook(({ response }) => {
        response.once("close", closed.resolve);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"access_token":"' + "x".repeat(6000));
      });
      await assert.rejects(
        f.provider.prepareAuth(f.config, f.ref, f.binding, f.scope),
        safeFailure,
      );
      await bounded(closed.promise);
      assert.equal(f.tokenCalls.length, 1);
      assert.equal((await f.vault.read(f.ref, f.binding)).tokens, undefined);
    },
  );
});
