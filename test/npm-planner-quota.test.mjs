import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// Actual bundled npm/Arborist, local HTTP registry, native child lifecycle and
// bounded root-file persistence. No Cloud, publication or installed profile use.
const dist = new URL(
  process.env.NEXUM_MAINTENANCE_DIST ?? "../dist/",
  import.meta.url,
);
const [
  { NpmMaintenanceBackend, ExtensionEnablement },
  { maintenanceIntent },
  { SqliteStore },
  { ResourceManager },
  { ExtensionRegistry },
  { ExtensionPackageLoader },
  { ExtensionMaterials },
  { ExtensionServices },
  { ModuleLoader },
  { ApprovedPackageCatalog },
  { AgentError },
] = await Promise.all(
  [
    "maintenance/npm.js",
    "maintenance/requests.js",
    "storage/sqlite.js",
    "extensions/resources.js",
    "extensions/registry.js",
    "extensions/package-loader.js",
    "extensions/materials.js",
    "services/extensions.js",
    "runtime/modules.js",
    "application/packages.js",
    "contracts/errors.js",
  ].map((file) => import(new URL(file, dist))),
);
const execute = promisify(execFile),
  name = "nexum-bounded-planner-fixture",
  MiB = 1024 * 1024;
const cli =
  process.platform === "win32"
    ? path.join(
        path.dirname(process.execPath),
        "node_modules/npm/bin/npm-cli.js",
      )
    : path.resolve(
        path.dirname(process.execPath),
        "../lib/node_modules/npm/bin/npm-cli.js",
      );
const token = "synthetic-private-registry-token-planner";
function put(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
async function fixture(t, fundingBytes = 0) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-bounded-planner-")),
    ),
    work = path.join(root, "work"),
    source = path.join(root, "source");
  const marker = path.join(root, "install-marker"),
    userconfig = path.join(root, "npmrc"),
    globalconfig = path.join(root, "global-npmrc");
  put(path.join(work, "package.json"), {
    name: "private-work",
    version: "1.0.0",
    private: true,
    type: "module",
    description: "保留非依赖业务字段😀",
  });
  put(userconfig, "");
  put(globalconfig, "");
  const env = {
    npm_config_cache: path.join(root, "cache"),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    NEXUM_NPM_TEST_MARKER: marker,
  };
  put(path.join(source, "package.json"), {
    name,
    version: "1.0.0",
    main: "index.cjs",
    scripts: { install: "node install.cjs" },
  });
  put(path.join(source, "index.cjs"), "module.exports = 17;\n");
  put(
    path.join(source, "install.cjs"),
    "require('node:fs').appendFileSync(process.env.NEXUM_NPM_TEST_MARKER,'installed\\n');\n",
  );
  const packed = await execute(
    process.execPath,
    [cli, "pack", "--ignore-scripts", "--json"],
    { cwd: source, env: { ...process.env, ...env } },
  );
  const archive = readFileSync(
      path.join(source, JSON.parse(packed.stdout)[0].filename),
    ),
    integrity =
      "sha512-" + createHash("sha512").update(archive).digest("base64");
  let base,
    requests = 0,
    authenticated = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    authenticated++;
    if (new URL(request.url, "http://fixture").pathname === `/${name}`) {
      const metadata = {
        name,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name,
            version: "1.0.0",
            hasInstallScript: true,
            scripts: { install: "node install.cjs" },
            ...(fundingBytes
              ? {
                  funding: {
                    type: "individual",
                    url: "https://funding.example/" + "x".repeat(fundingBytes),
                  },
                }
              : {}),
            dist: { tarball: `${base}/${name}/-/fixture.tgz`, integrity },
          },
        },
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(metadata));
    } else if (request.url === `/${name}/-/fixture.tgz`) {
      response.setHeader("content-type", "application/octet-stream");
      response.end(archive);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // pnpm test exports its registry as npm_config_registry, which takes
  // precedence over .npmrc. Keep every native request in this fixture.
  env.npm_config_registry = base;
  put(
    path.join(work, ".npmrc"),
    `registry=${base}/\n//127.0.0.1:${server.address().port}/:_authToken=${token}\n`,
  );
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store),
    registry = new ExtensionRegistry(resources, {
      permissions: new Set(),
      authorize() {},
    });
  const approved = new Map(),
    policy = { builtins: () => [], approvedPackages: () => approved };
  const modules = await ModuleLoader.create(work, store.bootId, policy),
    enablement = await ExtensionEnablement.open(root);
  const packages = new ExtensionPackageLoader(registry, modules, {
    policy,
    permissions: new Set(),
    enabled: () => enablement.enabled(),
  });
  const extensions = new ExtensionServices(
      registry,
      packages,
      new ExtensionMaterials(work),
    ),
    catalog = await ApprovedPackageCatalog.open(root, {
      agentId: "agent",
      profile: "development",
    });
  let outstanding = 0,
    acceptedBytes = 0;
  const reserve = async (bytes) => {
    outstanding += bytes;
    acceptedBytes += bytes;
    let released = false;
    return {
      release() {
        assert.equal(released, false);
        released = true;
        outstanding -= bytes;
      },
    };
  };
  const options = {
    root,
    modules,
    extensions,
    enablement,
    npmCli: cli,
    env,
    reserve,
    async refreshPackages(snapshot) {
      await catalog.accept(snapshot);
      approved.clear();
      for (const [key, value] of catalog.approvedPackages())
        approved.set(key, value);
    },
  };
  const backend = new NpmMaintenanceBackend(options),
    observedLockSizes = [],
    controller = new AbortController();
  const observe = () => {
    const directory = path.join(root, "state", "maintenance", "npm");
    if (!existsSync(directory)) return;
    for (const plan of readdirSync(directory)) {
      const file = path.join(directory, plan, "package-lock.json");
      if (existsSync(file)) observedLockSizes.push(statSync(file).size);
    }
  };
  const scope = {
    caller: { principalId: "owner", clientId: "planner", grantId: "grant" },
    operationId: "op_" + "1".repeat(32),
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
      observe();
    },
    authorize() {
      controller.signal.throwIfAborted();
    },
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    env,
    marker,
    scope,
    backend,
    options,
    observedLockSizes,
    controller,
    source,
    setFunding(bytes) {
      fundingBytes = bytes;
    },
    get outstanding() {
      return outstanding;
    },
    get acceptedBytes() {
      return acceptedBytes;
    },
    get requests() {
      return requests;
    },
    get authenticated() {
      return authenticated;
    },
    intent(action = "install") {
      return maintenanceIntent(
        `packages.${action}`,
        { name, ...(action === "remove" ? {} : { version: "1.0.0" }) },
        work,
      );
    },
  };
}

test("official npm configuration/auth and in-memory Arborist produce a >1MiB valid lock; only the parent saves it and actual approved install runs once", async (t) => {
  const f = await fixture(t, 2 * MiB),
    intent = f.intent();
  const before = readFileSync(path.join(f.work, "package.json"), "utf8"),
    plan = await f.backend.prepare(intent, f.scope);
  assert.ok(Buffer.byteLength(plan.payload.lock) > MiB);
  assert.ok(Buffer.byteLength(plan.payload.lock) < 32 * MiB);
  assert.equal(
    plan.payload.npmSource.npmVersion,
    JSON.parse(
      readFileSync(path.resolve(path.dirname(cli), "../package.json"), "utf8"),
    ).version,
  );
  assert.match(plan.payload.npmSource.revision, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(plan.summary).includes(token), false);
  assert.equal(readFileSync(path.join(f.work, "package.json"), "utf8"), before);
  assert.equal(existsSync(path.join(f.work, "package-lock.json")), false);
  assert.equal(existsSync(f.marker), false);
  assert.equal(
    JSON.parse(plan.payload.manifest).description,
    "保留非依赖业务字段😀",
  );
  assert.equal(JSON.parse(plan.payload.manifest)._id, undefined);
  assert.ok(f.observedLockSizes.some((size) => size > MiB));
  assert.equal(f.outstanding, 0);
  const result = await f.backend.apply(intent, plan, f.scope);
  assert.equal(result.package.installedVersion, "1.0.0");
  assert.equal(readFileSync(f.marker, "utf8"), "installed\n");
  assert.equal(
    readFileSync(path.join(f.work, "package-lock.json"), "utf8"),
    plan.payload.lock,
  );
  assert.equal(f.requests, f.authenticated);
  assert.equal(f.outstanding, 0);
});

test("a real registry graph producing a >32MiB root lock is rejected before a generated lock reaches managed disk, and its native work actually settles", async (t) => {
  const f = await fixture(t, 33 * MiB),
    before = readFileSync(path.join(f.work, "package.json"), "utf8");
  await assert.rejects(f.backend.prepare(f.intent(), f.scope), (error) => {
    assert.equal(error.code, "npm_plan_too_large");
    assert.equal(JSON.stringify(error).includes(token), false);
    return true;
  });
  // assertCurrent is called after the actual native child close, before the
  // parent's failure/finally cleanup. An unbounded native lock save is visible here.
  assert.ok(f.observedLockSizes.every((size) => size <= 32 * MiB));
  assert.equal(existsSync(path.join(f.work, "package-lock.json")), false);
  assert.equal(existsSync(f.marker), false);
  assert.equal(readFileSync(path.join(f.work, "package.json"), "utf8"), before);
  assert.deepEqual(
    readdirSync(path.join(f.root, "state", "maintenance", "npm")),
    [],
  );
  assert.equal(f.outstanding, 0);
  assert.ok(f.acceptedBytes > 0);
  assert.ok(f.authenticated > 0);
});

test("native global/prefix configuration cannot move planning or approved installation outside the bound work", async (t) => {
  const f = await fixture(t),
    outside = path.join(f.root, "outside-prefix"),
    intent = f.intent();
  mkdirSync(outside);
  f.env.npm_config_global = "true";
  f.env.npm_config_prefix = outside;
  f.env.npm_config_workspaces = "true";
  const plan = await f.backend.prepare(intent, f.scope);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(existsSync(f.marker), false);
  assert.equal(existsSync(path.join(f.work, "node_modules")), false);
  const result = await f.backend.apply(intent, plan, f.scope);
  assert.equal(result.package.installedVersion, "1.0.0");
  assert.equal(readFileSync(f.marker, "utf8"), "installed\n");
  assert.equal(
    JSON.parse(
      readFileSync(path.join(f.work, "node_modules", name, "package.json")),
    ).version,
    "1.0.0",
  );
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(f.requests, f.authenticated);
  assert.equal(f.outstanding, 0);
});

test("approval evidence binds the actual npm distribution, and a distribution without its supported planning API fails explicitly", async (t) => {
  const f = await fixture(t),
    intent = f.intent(),
    plan = await f.backend.prepare(intent, f.scope);
  const copied = path.join(f.root, "another-npm"),
    npmRoot = path.resolve(path.dirname(cli), "..");
  cpSync(npmRoot, copied, { recursive: true });
  const other = new NpmMaintenanceBackend({
    ...f.options,
    npmCli: path.join(copied, "bin", "npm-cli.js"),
  });
  const before = readFileSync(path.join(f.work, "package.json"), "utf8");
  await assert.rejects(other.apply(intent, plan, f.scope), {
    code: "maintenance_precondition_changed",
  });
  assert.equal(readFileSync(path.join(f.work, "package.json"), "utf8"), before);
  assert.equal(existsSync(f.marker), false);
  assert.equal(f.outstanding, 0);
  const entry = path.join(
    copied,
    "node_modules",
    "@npmcli",
    "arborist",
    "lib",
    "arborist",
    "index.js",
  );
  writeFileSync(
    entry,
    readFileSync(entry, "utf8") +
      "\ndelete module.exports.prototype.lockfileString;\n",
  );
  await assert.rejects(other.prepare(intent, f.scope), {
    code: "npm_planner_unsupported",
  });
  assert.equal(readFileSync(path.join(f.work, "package.json"), "utf8"), before);
  assert.equal(existsSync(f.marker), false);
  assert.equal(f.outstanding, 0);
});
