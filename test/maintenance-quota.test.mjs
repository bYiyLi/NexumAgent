import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

// These are local Core/storage/native-Git integrations, not Cloud or Browser acceptance.
const dist = new URL(
  process.env.NEXUM_MAINTENANCE_DIST ?? "../dist/",
  import.meta.url,
);
const [
  { CredentialVault, privateMaintenanceWrite },
  { MaintenanceRequests, maintenanceIntent },
  { ConfigurationMaintenanceBackend },
  { ExtensionEnablement, NpmMaintenanceBackend },
  { ApprovedPackageCatalog },
  { SqliteStore },
  { callerKey },
  { AgentError },
  { ModuleLoader },
  { ResourceManager },
  { ExtensionRegistry },
  { ExtensionPackageLoader },
  { ExtensionMaterials },
  { ExtensionServices },
  { WorkGitMaintenance },
  { OAuthProvider, OAuthSessionService },
] = await Promise.all(
  [
    "maintenance/credentials.js",
    "maintenance/requests.js",
    "maintenance/configuration.js",
    "maintenance/npm.js",
    "application/packages.js",
    "storage/sqlite.js",
    "contracts/caller.js",
    "contracts/errors.js",
    "runtime/modules.js",
    "extensions/resources.js",
    "extensions/registry.js",
    "extensions/package-loader.js",
    "extensions/materials.js",
    "services/extensions.js",
    "maintenance/work-git.js",
    "maintenance/oauth.js",
  ].map((file) => import(new URL(file, dist))),
);
const clone = (value) => JSON.parse(JSON.stringify(value));
const secret = "synthetic-private-maintenance-quota-secret";
const caller = {
  principalId: "owner",
  clientId: "quota-test",
  grantId: "grant",
};
const binding = {
  agentId: "agent",
  profile: "development",
  cloudEnvironment: "test",
};
function fixture(t) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-maintenance-quota-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(
    path.join(work, "package.json"),
    '{"private":true,"type":"module"}',
  );
  const store = new SqliteStore(root, binding),
    context = store.openWork({
      callerKey: callerKey(caller),
      pwd: work,
      snapshotRef: "unused",
    });
  const run = store.acceptRun({
    callerKey: callerKey(caller),
    contextId: context.contextId,
    sourceKind: "inline",
    source: {},
  }).run;
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  let denied = false,
    sequence = 0,
    outstanding = 0;
  const sizes = [],
    releases = [];
  const reserve = async (bytes) => {
    assert.ok(Number.isSafeInteger(bytes) && bytes > 0);
    sizes.push(bytes);
    if (denied)
      throw new AgentError(
        "storage_quota_exceeded",
        "Managed storage is full.",
      );
    outstanding++;
    let released = false;
    return {
      release() {
        assert.equal(released, false);
        released = true;
        outstanding--;
        releases.push(bytes);
      },
    };
  };
  const scope = () => ({
    caller,
    runId: run.runId,
    pwd: work,
    operationId: `op_scope_${++sequence}`,
    signal: new AbortController().signal,
    assertCurrent() {},
    authorize() {},
  });
  return {
    root,
    work,
    store,
    scope,
    reserve,
    sizes,
    releases,
    get outstanding() {
      return outstanding;
    },
    deny: (value) => (denied = value),
  };
}
function allFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? allFiles(path.join(root, entry.name))
      : [path.join(root, entry.name)],
  );
}

test("private credential and fixed JSON writes reject before creating files, release only after real persistence, and never expose secret bytes in quota errors", async (t) => {
  const f = fixture(t),
    vault = await CredentialVault.open(f.root, { reserve: f.reserve });
  f.deny(true);
  const reject = await vault
    .create({ owner: "owner", target: "api" }, { token: secret })
    .catch((value) => value);
  assert.equal(reject.code, "storage_quota_exceeded");
  assert.equal(JSON.stringify(reject).includes(secret), false);
  assert.deepEqual(
    readdirSync(path.join(f.root, "state", "maintenance", "credentials")),
    [],
  );
  await assert.rejects(
    privateMaintenanceWrite(
      f.root,
      ["new-private", "value.json"],
      { token: secret },
      true,
      f.reserve,
    ),
    { code: "storage_quota_exceeded" },
  );
  assert.equal(
    existsSync(path.join(f.root, "state", "maintenance", "new-private")),
    false,
  );
  f.deny(false);
  const ref = await vault.create(
    { owner: "owner", target: "api" },
    { token: secret },
  );
  assert.equal(f.outstanding, 0);
  assert.equal(f.releases.length, 1);
  await vault.update(
    ref,
    { owner: "owner", target: "api" },
    { token: "rotated" },
  );
  assert.deepEqual(await vault.read(ref, { owner: "owner", target: "api" }), {
    token: "rotated",
  });
  assert.equal(f.outstanding, 0);
  assert.ok(
    !allFiles(f.root).some((file) =>
      path.basename(file).startsWith(".private-"),
    ),
  );
});

test("Extension enablement and private approved-package evidence cannot change memory or disk when admission refuses", async (t) => {
  const f = fixture(t),
    enablement = await ExtensionEnablement.open(f.root, { reserve: f.reserve });
  f.deny(true);
  await assert.rejects(enablement.set("fixture", true, {}, null), {
    code: "storage_quota_exceeded",
  });
  assert.equal(enablement.get("fixture"), null);
  assert.equal(
    existsSync(path.join(f.root, "state", "maintenance", "extensions.json")),
    false,
  );
  const catalog = await ApprovedPackageCatalog.open(f.root, binding, {
    reserve: f.reserve,
  });
  const manifest = JSON.stringify({ dependencies: { fixture: "1.0.0" } }),
    lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/fixture": { version: "1.0.0" } },
    });
  writeFileSync(path.join(f.work, "package.json"), manifest);
  writeFileSync(path.join(f.work, "package-lock.json"), lock);
  await assert.rejects(
    catalog.accept({
      target: { name: "fixture", action: "install", version: "1.0.0" },
      manifest,
      lock,
    }),
    { code: "storage_quota_exceeded" },
  );
  assert.equal(catalog.approvedPackages().size, 0);
  f.deny(false);
  await enablement.set("fixture", true, {}, null);
  await catalog.accept({
    target: { name: "fixture", action: "install", version: "1.0.0" },
    manifest,
    lock,
  });
  assert.equal(catalog.approvedPackages().get("fixture"), "1.0.0");
  assert.equal(f.outstanding, 0);
});

function authority() {
  const records = new Map();
  let creates = 0;
  return {
    records,
    get creates() {
      return creates;
    },
    async create(identity, input) {
      const requestId = "maint_req_" + ++creates,
        time = new Date().toISOString();
      const view = {
        ...clone(input),
        requestId,
        agentId: identity.agentId,
        profile: identity.profile,
        status: "pending",
        revision: 1,
        createdAt: time,
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        approvalUrl: `https://cloud.example/authorize/maintenance/${requestId}`,
      };
      delete view.requestKey;
      delete view.originRunId;
      records.set(requestId, view);
      return clone(view);
    },
    async get(_identity, id) {
      return clone(records.get(id));
    },
    async decision(identity, id) {
      return this.get(identity, id);
    },
    async beginExecution(_identity, input) {
      const view = records.get(input.requestId);
      view.execution = {
        operationId: input.operationId,
        startedAt: new Date().toISOString(),
      };
      return clone(view);
    },
    approve(id) {
      const view = records.get(id),
        time = new Date().toISOString();
      Object.assign(view, {
        status: "approved",
        decidedAt: time,
        decision: {
          status: "approved",
          revision: view.revision,
          candidateRevision: view.candidateRevision,
          decidedAt: time,
          decisionId: "decision-" + id,
        },
      });
      delete view.approvalUrl;
    },
  };
}
function backend(apply) {
  return {
    async prepare() {
      return {
        objectId: null,
        baseRevision: null,
        payload: { private: secret },
        authStatus: "not_required",
        summary: {
          changeKinds: ["package"],
          permissions: [],
          version: "1.0.0",
          namespace: null,
          restartMayBeRequired: false,
        },
      };
    },
    async verify() {},
    apply,
  };
}

test("candidate storage failure never creates a Cloud approval, and approved execution is refused before its operation or side effect", async (t) => {
  const f = fixture(t),
    cloud = authority();
  let applies = 0;
  const requests = new MaintenanceRequests(
    f.store,
    cloud,
    backend(async () => {
      applies++;
      return { changed: true, restartRequired: false };
    }),
    { approvalOrigin: "https://cloud.example", reserve: f.reserve },
  );
  f.deny(true);
  await assert.rejects(
    requests.bind(f.scope()).packages.install({ name: "fixture" }),
    { code: "storage_quota_exceeded" },
  );
  assert.equal(cloud.creates, 0);
  assert.equal(
    existsSync(path.join(f.root, "state", "maintenance", "candidates")),
    false,
  );
  f.deny(false);
  const created = await requests
    .bind(f.scope())
    .packages.install({ name: "fixture" });
  cloud.approve(created.requestId);
  f.deny(true);
  await assert.rejects(requests.execute(created.requestId, f.scope()), {
    code: "storage_quota_exceeded",
  });
  assert.equal(applies, 0);
  assert.equal(f.store.getMaintenanceOperation(created.requestId), null);
  f.deny(false);
  const result = await requests.execute(created.requestId, f.scope());
  assert.equal(result.execution.status, "succeeded");
  assert.equal(applies, 1);
  assert.equal(f.outstanding, 0);
});

test("accepted execution keeps its settlement reservation across actual asynchronous work; later pressure does not block safe error/detail persistence", async (t) => {
  const f = fixture(t),
    cloud = authority(),
    entered = Promise.withResolvers(),
    close = Promise.withResolvers();
  const requests = new MaintenanceRequests(
    f.store,
    cloud,
    backend(async () => {
      assert.equal(f.outstanding, 1);
      entered.resolve();
      await close.promise;
      throw new Error(secret);
    }),
    { approvalOrigin: "https://cloud.example", reserve: f.reserve },
  );
  const created = await requests
    .bind(f.scope())
    .packages.install({ name: "fixture" });
  cloud.approve(created.requestId);
  const executing = requests.execute(created.requestId, f.scope());
  await entered.promise;
  f.deny(true);
  assert.equal(f.outstanding, 1);
  assert.equal(
    f.store.getMaintenanceOperation(created.requestId).endedAt,
    null,
  );
  close.resolve();
  const result = await executing;
  assert.equal(result.execution.status, "failed");
  assert.equal(f.outstanding, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const record = f.store.getMaintenanceOperation(created.requestId);
  assert.ok(record.endedAt !== null);
  const detail = readFileSync(path.join(f.root, record.detailRef), "utf8");
  assert.equal(detail.includes(secret), false);
  assert.equal(
    (await requests.get(created.requestId, f.scope())).execution.status,
    "failed",
  );
});

test("configuration planning and apply reserve before private/public mutations or activation, with rollback space held until publication", async (t) => {
  const f = fixture(t),
    vault = await CredentialVault.open(f.root, { reserve: f.reserve });
  let activations = 0;
  const options = {
    root: f.root,
    agentId: binding.agentId,
    profile: binding.profile,
    credentials: vault,
    runtimeScope: () => f.scope(),
    reserve: f.reserve,
    activation: {
      async prepare() {
        activations++;
        assert.ok(f.outstanding > 0);
        return {
          publish() {
            assert.ok(f.outstanding > 0);
          },
          async dispose() {},
        };
      },
      async remove() {},
    },
  };
  const config = await ConfigurationMaintenanceBackend.open(options),
    intent = maintenanceIntent(
      "mcp.add",
      {
        name: "fixture",
        config: {
          transport: "stdio",
          command: process.execPath,
          args: ["--version"],
        },
      },
      f.work,
    );
  f.deny(true);
  await assert.rejects(config.prepare(intent, f.scope()), {
    code: "storage_quota_exceeded",
  });
  assert.equal(activations, 0);
  assert.ok(
    !allFiles(f.root).some(
      (file) =>
        file.includes("/configurations/candidates/") && file.endsWith(".json"),
    ),
  );
  f.deny(false);
  const prepared = await config.prepare(intent, f.scope());
  f.deny(true);
  await assert.rejects(config.apply(intent, prepared, f.scope()), {
    code: "storage_quota_exceeded",
  });
  assert.equal(activations, 0);
  assert.equal(existsSync(path.join(f.work, "mcp.json")), false);
  f.deny(false);
  assert.equal((await config.apply(intent, prepared, f.scope())).changed, true);
  assert.equal(activations, 1);
  assert.equal(f.outstanding, 0);
  assert.ok(existsSync(path.join(f.work, "mcp.json")));
});

test("real npm planning rejects quota before starting the native producer or writing a private plan", async (t) => {
  const f = fixture(t),
    resources = new ResourceManager(f.store),
    registry = new ExtensionRegistry(resources, {
      permissions: new Set(),
      authorize() {},
    });
  const approved = new Map(),
    policy = { builtins: () => [], approvedPackages: () => approved },
    modules = await ModuleLoader.create(f.work, f.store.bootId, policy);
  const enablement = await ExtensionEnablement.open(f.root, {
      reserve: f.reserve,
    }),
    packages = new ExtensionPackageLoader(registry, modules, {
      policy,
      permissions: new Set(),
      enabled: () => enablement.enabled(),
    });
  const extensions = new ExtensionServices(
    registry,
    packages,
    new ExtensionMaterials(f.work),
  );
  const npm = new NpmMaintenanceBackend({
    root: f.root,
    modules,
    extensions,
    enablement,
    npmCli: path.join(f.root, "must-not-run-npm.js"),
    reserve: f.reserve,
    refreshPackages() {},
  });
  f.deny(true);
  await assert.rejects(
    npm.prepare(
      maintenanceIntent(
        "packages.install",
        { name: "fixture", version: "1.0.0" },
        f.work,
      ),
      f.scope(),
    ),
    { code: "storage_quota_exceeded" },
  );
  assert.equal(
    existsSync(path.join(f.root, "state", "maintenance", "npm")),
    false,
  );
  assert.equal(f.outstanding, 0);
});

function environment(root) {
  const variables = {
    ...process.env,
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
  };
  return {
    platform: process.platform,
    variables,
    shell: null,
    source: process.platform === "win32" ? "windows-user" : "login-shell",
    discoveredAt: Date.now(),
    cwd: root,
  };
}
test("native Git rejects storage before initialization and retains its reservation through fixed-input snapshot and real commit", async (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, "home"));
  mkdirSync(path.join(f.work, "scripts"));
  writeFileSync(
    path.join(f.work, "scripts", "task.js"),
    "export const value=1;\n",
  );
  if (process.platform !== "win32")
    chmodSync(path.join(f.work, "scripts", "task.js"), 0o755);
  f.deny(true);
  const refused = await new WorkGitMaintenance(f.root, {
    environment: environment(f.root),
    reserve: f.reserve,
  }).initialize();
  assert.equal(refused.status, "failed");
  assert.equal(refused.reason, "storage_quota_exceeded");
  assert.equal(refused.stateSaved, false);
  assert.equal(existsSync(path.join(f.work, ".git")), false);
  f.deny(false);
  const saved = await new WorkGitMaintenance(f.root, {
    environment: environment(f.root),
    reserve: f.reserve,
  }).initialize();
  assert.equal(saved.status, "committed", JSON.stringify(saved));
  assert.equal(f.outstanding, 0);
  const content = execFileSync(
    "git",
    ["-C", f.work, "show", "HEAD:scripts/task.js"],
    { encoding: "utf8" },
  );
  assert.equal(content, "export const value=1;\n");
  if (process.platform !== "win32")
    assert.match(
      execFileSync(
        "git",
        ["-C", f.work, "ls-tree", "HEAD", "scripts/task.js"],
        { encoding: "utf8" },
      ),
      /^100755 /,
    );
  assert.ok(
    !readdirSync(path.join(f.root, "state")).some((name) =>
      name.startsWith("work-git-"),
    ),
  );
});

test("Git never lets a source that grew after storage estimation become an unbounded native object", async (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, "home"));
  mkdirSync(path.join(f.work, "scripts"));
  const file = path.join(f.work, "scripts", "growing.js");
  writeFileSync(file, "short");
  const result = await new WorkGitMaintenance(f.root, {
    environment: environment(f.root),
    async reserve(bytes) {
      const ticket = await f.reserve(bytes);
      writeFileSync(file, "x".repeat(50000));
      return ticket;
    },
  }).initialize();
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "snapshot_source_changed");
  assert.equal(f.outstanding, 0);
  assert.throws(() =>
    execFileSync("git", ["-C", f.work, "rev-parse", "--verify", "HEAD"], {
      stdio: "pipe",
    }),
  );
  assert.ok(
    !readdirSync(path.join(f.root, "state")).some((name) =>
      name.startsWith("work-git-"),
    ),
  );
});

test("interactive OAuth carries the same private-storage quota and cannot return an authorization launch without its durable attempt", async (t) => {
  const f = fixture(t),
    vault = await CredentialVault.open(f.root, { reserve: f.reserve });
  let issuer;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        issuer,
        token_endpoint: issuer + "/token",
        authorization_endpoint: issuer + "/authorize",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const binding = {
    owner: caller.principalId,
    agentId: "agent",
    profile: "development",
    target: "api",
    name: "fixture",
    scheme: "oauth",
    service: "https://service.example",
    authRevision: "sha256:" + "a".repeat(64),
  };
  const ref = await vault.create(binding, { clientSecret: secret }),
    provider = new OAuthProvider(vault),
    sessions = new OAuthSessionService(provider, {
      root: f.root,
      reserve: f.reserve,
    });
  const config = {
    flow: "authorizationCode",
    issuer,
    clientId: "fixture",
    scopes: ["read"],
    clientAuthentication: "client_secret_post",
    allowHttp: true,
  };
  const input = {
    state: "trusted-unique-state-for-quota",
    callbackUrl: "https://console.example/oauth/callback",
    schemeId: "oauth",
    candidateRevision: "sha256:" + "b".repeat(64),
  };
  const scope = {
    ...f.scope(),
    requestId: "maint_req_oauthquota",
    revision: 1,
  };
  f.deny(true);
  await assert.rejects(
    sessions.start(config, ref, binding, input, scope),
    (error) => {
      assert.equal(error.code, "storage_quota_exceeded");
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
  assert.deepEqual(
    allFiles(path.join(f.root, "state", "maintenance", "oauth")),
    [],
  );
  f.deny(false);
  const launch = await sessions.start(config, ref, binding, input, scope);
  assert.equal(
    new URL(launch.authorizationUrl).searchParams.get("state"),
    input.state,
  );
  assert.equal(f.outstanding, 0);
  assert.ok(
    allFiles(path.join(f.root, "state", "maintenance", "oauth")).some((file) =>
      file.endsWith(".json"),
    ),
  );
});
