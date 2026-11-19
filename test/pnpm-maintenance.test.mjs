import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PnpmMaintenanceBackend } from "../dist/maintenance/pnpm.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ResourceManager } from "../dist/extensions/resources.js";

async function fixture(t) {
  const root = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-sdk-pnpm-")));
  await mkdir(path.join(root, "work"));
  await writeFile(path.join(root, "work", "package.json"), JSON.stringify({
    private: true, type: "module",
    dependencies: { "@nexum-hub/agent": "0.0.3-next.21" },
  }, null, 2) + "\n");
  const fakeCli = [
    "const fs = require(\"node:fs\"), path = require(\"node:path\");",
    "const args = process.argv.slice(2);",
    "const dir = args[args.indexOf(\"--dir\") + 1];",
    "const logFile = path.join(dir, \"calls.json\");",
    "const calls = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, \"utf8\")) : [];",
    "calls.push({ args, ci: process.env.CI, registry: process.env.npm_config_registry });",
    "fs.writeFileSync(logFile, JSON.stringify(calls));",
    "if (fs.existsSync(path.join(dir, \"fail-command\"))) process.exit(19);",
    "const manifest = JSON.parse(fs.readFileSync(path.join(dir, \"package.json\"), \"utf8\"));",
    "const deps = manifest.dependencies || {};",
    "const priorFile = path.join(dir, \"installed-names.json\");",
    "const prior = fs.existsSync(priorFile) ? JSON.parse(fs.readFileSync(priorFile, \"utf8\")) : [];",
    "const modules = path.join(dir, \"node_modules\");",
    "const versionsFile = path.join(dir, \"desired-versions.json\");",
    "const versions = fs.existsSync(versionsFile) ? JSON.parse(fs.readFileSync(versionsFile, \"utf8\")) : {};",
    "for (const name of prior) if (!Object.hasOwn(deps, name)) {",
    "  fs.rmSync(path.join(modules, ...name.split(\"/\")), { recursive: true, force: true });",
    "}",
    "for (const [name, spec] of Object.entries(deps)) {",
    "  const folder = path.join(modules, ...name.split(\"/\"));",
    "  fs.mkdirSync(folder, { recursive: true });",
    "  const version = spec === \"latest\" || spec === \"next\" ? (versions[name] || \"1.2.3\") : spec.replace(/^[~^]/, \"\");",
    "  fs.writeFileSync(path.join(folder, \"package.json\"), JSON.stringify({ name, version }));",
    "}",
    "fs.writeFileSync(priorFile, JSON.stringify(Object.keys(deps)));",
    "fs.writeFileSync(path.join(dir, \"pnpm-lock.yaml\"), \"lockfileVersion: 9\");",
  ].join("\n");
  const cli = process.platform === "win32"
    ? path.join(root, "runtime", "node_modules", "pnpm", "bin", "pnpm.cjs")
    : path.join(root, "runtime", "lib", "node_modules", "pnpm", "bin", "pnpm.cjs");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, fakeCli);
  const store = new SqliteStore(root, {
    agentId: "agent", profile: "development", cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store);
  t.after(async () => {
    await resources.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const guard = { busy: false, calls: 0 };
  const backend = new PnpmMaintenanceBackend({
    root, profile: "development", resources,
    async withPackageChanges(action) {
      guard.calls++;
      if (guard.busy) throw Object.assign(new Error("Work tree is busy"), { code: "module_busy" });
      return action();
    },
  });
  const scope = {
    operationId: "op_" + "1".repeat(32),
    caller: { principalId: "test", clientId: "test", grantId: "test" },
    signal: new AbortController().signal,
    assertCurrent() {},
    authorize() {},
  };
  const manifest = async () => JSON.parse(
    await readFile(path.join(root, "work", "package.json"), "utf8"));
  const calls = async () => existsSync(path.join(root, "work", "calls.json"))
    ? JSON.parse(await readFile(path.join(root, "work", "calls.json"), "utf8")) : [];
  return { root, backend, scope, manifest, calls, guard };
}

test("SDK approval immediately installs the requested package into the existing work tree", async (t) => {
  const f = await fixture(t);
  const intent = {
    target: "package", method: "packages.install", action: "install",
    name: "@nexum-hub/browser", version: "0.0.3-next.21",
  };
  const pending = await f.backend.prepare(intent, f.scope);
  assert.equal((await f.manifest()).dependencies["@nexum-hub/browser"], undefined,
    "SDK request creates no changes before page approval");
  assert.equal((await f.calls()).length, 0, "preparation never runs pnpm");
  assert.equal(pending.summary.version, "0.0.3-next.21");
  const result = await f.backend.apply(intent, pending, f.scope);
  assert.equal(result.changed, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.package.installedVersion, "0.0.3-next.21");
  assert.equal((await f.manifest()).dependencies["@nexum-hub/browser"], "0.0.3-next.21");
  assert.equal((await f.manifest()).dependencies["@nexum-hub/agent"], "0.0.3-next.21");
  assert.equal(existsSync(path.join(f.root, "state", "maintenance", "packages.json")), false);
  assert.equal(existsSync(path.join(f.root, "work", "package-lock.json")), false);
  assert.equal(existsSync(path.join(f.root, "work", "pnpm-lock.yaml")), true);
  assert.equal(existsSync(path.join(f.root, "work", "node_modules", "@nexum-hub", "browser", "package.json")), true);
  const calls = await f.calls();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("install"));
  assert.equal(calls[0].ci, "true");
  assert.equal(calls[0].registry, "https://registry.npmjs.org/");
});

test("SDK update and remove do not bind future versions to the first approval", async (t) => {
  const f = await fixture(t);
  const initial = {
    target: "package", method: "packages.install", action: "install",
    name: "example-package",
  };
  await f.backend.apply(initial, await f.backend.prepare(initial, f.scope), f.scope);
  assert.equal((await f.manifest()).dependencies["example-package"], "latest");
  const update = { ...initial, method: "packages.update", action: "update" };
  const same = await f.backend.apply(update, await f.backend.prepare(update, f.scope), f.scope);
  assert.equal(same.changed, false);
  assert.equal(same.restartRequired, false, "Reinstalling the same bytes needs no restart");
  assert.equal(same.package.installedVersion, "1.2.3");
  assert.ok((await f.calls()).some((call) => call.args.includes("update")));
  await writeFile(path.join(f.root, "work", "desired-versions.json"),
    JSON.stringify({ "example-package": "2.0.0" }));
  const upgraded = await f.backend.apply(update, await f.backend.prepare(update, f.scope), f.scope);
  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.restartRequired, true);
  assert.equal(upgraded.package.installedVersion, "2.0.0");
  const remove = { ...initial, method: "packages.remove", action: "remove" };
  const removed = await f.backend.apply(remove, await f.backend.prepare(remove, f.scope), f.scope);
  assert.equal(removed.package.installedVersion, null);
  assert.equal(removed.restartRequired, true);
  assert.equal(existsSync(path.join(f.root, "work", "node_modules", "example-package")), false);
  assert.equal((await f.manifest()).dependencies["example-package"], undefined);
  assert.equal((await f.manifest()).dependencies["@nexum-hub/agent"], "0.0.3-next.21");
});

test("manually edited package.json is not rejected by a stored approval record", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "work", "package.json");
  const data = await f.manifest();
  data.dependencies["manually-installed"] = "^2.0.0";
  await writeFile(file, JSON.stringify(data, null, 2) + "\n");
  const intent = {
    target: "package", method: "packages.install", action: "install",
    name: "another-package", version: "^3.0.0",
  };
  const request = await f.backend.prepare(intent, f.scope);
  assert.equal(request.summary.version, "^3.0.0");
  const changed = await f.manifest();
  changed.dependencies["from-user-edit"] = "1.0.0";
  await writeFile(file, JSON.stringify(changed, null, 2) + "\n");
  await assert.rejects(f.backend.apply(intent, request, f.scope),
    { code: "npm_plan_changed" }, "Only this SDK request detects concurrent edits");
  assert.equal((await f.manifest()).dependencies["from-user-edit"], "1.0.0");
  await assert.rejects(f.backend.prepare({ ...intent, name: "@nexum-hub/agent" }, f.scope),
    { code: "invalid_package" }, "Agent Core is owned by Cloud, not the SDK");
});

test("Development packages start on next but later upgrades do not need re-approval", async (t) => {
  const f = await fixture(t);
  const intent = {
    target: "package", method: "packages.install", action: "install",
    name: "@nexum-hub/browser",
  };
  const request = await f.backend.prepare(intent, f.scope);
  assert.equal(request.summary.version, "next");
  await f.backend.apply(intent, request, f.scope);
  assert.equal((await f.manifest()).dependencies["@nexum-hub/browser"], "next");
});

test("failed pnpm installation is not reported as a successful approved maintenance", async (t) => {
  const f = await fixture(t);
  const intent = {
    target: "package", method: "packages.install", action: "install",
    name: "example-package", version: "1.0.0",
  };
  const candidate = await f.backend.prepare(intent, f.scope);
  await writeFile(path.join(f.root, "work", "fail-command"), "1");
  await assert.rejects(f.backend.apply(intent, candidate, f.scope),
    { code: "pnpm_command_failed" });
  assert.equal((await f.calls()).length, 1);
  assert.equal(existsSync(path.join(f.root, "work", "node_modules", "example-package")), false);
  assert.equal((await f.manifest()).dependencies["example-package"], "1.0.0",
    "The confirmed declaration remains as partial state for diagnosis");
});

test("a busy work tree rejects approved installation before touching the manifest", async (t) => {
  const f = await fixture(t);
  const intent = {
    target: "package", method: "packages.install", action: "install",
    name: "example-package", version: "1.0.0",
  };
  const candidate = await f.backend.prepare(intent, f.scope);
  f.guard.busy = true;
  await assert.rejects(f.backend.apply(intent, candidate, f.scope),
    { code: "module_busy" });
  assert.equal(f.guard.calls, 1);
  assert.equal((await f.calls()).length, 0);
  assert.equal((await f.manifest()).dependencies["example-package"], undefined);
});
