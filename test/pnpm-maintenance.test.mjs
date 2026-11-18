import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PnpmMaintenanceBackend } from "../dist/maintenance/pnpm.js";

async function fixture(t) {
  const root = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-sdk-pnpm-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "work"));
  await writeFile(path.join(root, "work", "package.json"), JSON.stringify({
    private: true, type: "module",
    dependencies: { "@nexum-hub/agent": "0.0.3-next.21" },
  }, null, 2) + "\n");
  const backend = new PnpmMaintenanceBackend({ root, profile: "development" });
  const scope = {
    operationId: "op-test",
    caller: { principalId: "test", clientId: "test", grantId: "test" },
    signal: new AbortController().signal,
    assertCurrent() {},
    authorize() {},
  };
  const manifest = async () => JSON.parse(
    await readFile(path.join(root, "work", "package.json"), "utf8"));
  return { root, backend, scope, manifest };
}

test("SDK consent changes only one dependency declaration, never creates an approval gate", async (t) => {
  const f = await fixture(t);
  const intent = {
    target: "package", method: "packages.install", action: "install",
    name: "@nexum-hub/browser", version: "0.0.3-next.21",
  };
  const pending = await f.backend.prepare(intent, f.scope);
  assert.equal((await f.manifest()).dependencies["@nexum-hub/browser"], undefined,
    "SDK request creates no changes before page approval");
  assert.equal(pending.summary.version, "0.0.3-next.21");
  const result = await f.backend.apply(intent, pending, f.scope);
  assert.equal(result.changed, true);
  assert.equal(result.restartRequired, true);
  assert.equal((await f.manifest()).dependencies["@nexum-hub/browser"], "0.0.3-next.21");
  assert.equal((await f.manifest()).dependencies["@nexum-hub/agent"], "0.0.3-next.21");
  assert.equal(existsSync(path.join(f.root, "state", "maintenance", "packages.json")), false);
  assert.equal(existsSync(path.join(f.root, "work", "package-lock.json")), false);
  assert.equal(existsSync(path.join(f.root, "work", "pnpm-lock.yaml")), false,
    "Only the OS bootstrap owns dependency installation and lockfile updates");
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
  assert.equal(same.restartRequired, true, "An explicit SDK retry may request a new startup");
  const remove = { ...initial, method: "packages.remove", action: "remove" };
  await f.backend.apply(remove, await f.backend.prepare(remove, f.scope), f.scope);
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
