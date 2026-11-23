import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HostPackagePolicy } from "../dist/host/package-policy.js";
import { ModuleLoader } from "../dist/runtime/modules.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nexum-host-package-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = root;
  await mkdir(path.join(work, "modules"), { recursive: true });
  const write = async (versions) => {
    const manifest = JSON.stringify({ private: true, type: "module", dependencies: versions });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: {
      "": { dependencies: versions },
      ...Object.fromEntries(Object.entries(versions).map(([name, version]) => [
        `node_modules/${name}`, { name, version },
      ])),
    } });
    await writeFile(path.join(work, "package.json"), manifest);
    await writeFile(path.join(work, "package-lock.json"), lock);
    for (const [name, version] of Object.entries(versions)) {
      const directory = path.join(work, "node_modules", name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "package.json"), JSON.stringify({
        name, version, type: "module", exports: "./index.js",
      }));
      await writeFile(path.join(directory, "index.js"), `export const value=${JSON.stringify(version)};`);
    }
    return { manifest, lock };
  };
  await write({ alpha: "1.0.0", beta: "1.0.0" });
  await write({ alpha: "1.0.0" });
  const policy = await HostPackagePolicy.open(root);
  const loader = await ModuleLoader.create(work, `boot_${randomUUID()}`, policy.policy);
  t.after(() => policy.close());
  return { root, work, write, policy, loader };
}

test("a Go package transaction blocks Workers and exposes only actual direct dependencies", async (t) => {
  const f = await fixture(t);
  assert.equal(f.policy.policy.approvedPackages().get("alpha"), "1.0.0");
  assert.equal(f.policy.policy.approvedPackages().has("beta"), false);
  const { transactionId } = await f.policy.begin(f.loader);
  await assert.rejects(f.policy.begin(f.loader), { code: "maintenance_busy" });
  await assert.rejects(f.loader.compileIsolated("return 1", { context: {} }), { code: "module_busy" });
  await assert.rejects(f.policy.finish("other"), { code: "maintenance_transaction_invalid" });
  await f.write({ alpha: "1.0.0", beta: "1.0.0" });
  assert.equal(f.policy.policy.approvedPackages().has("beta"), false);
  assert.deepEqual(await f.policy.finish(transactionId), { restartRequired: false });
  assert.equal(f.policy.policy.approvedPackages().get("beta"), "1.0.0");
  assert.equal(await f.loader.execute('return (await import("beta")).value;', { context: {} }), "1.0.0");
});

test("a changed npm tree after native package evaluation requires restart", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.loader.execute('return (await import("alpha")).value;', { context: {} }), "1.0.0");
  const noChange = await f.policy.begin(f.loader);
  assert.deepEqual(await f.policy.finish(noChange.transactionId), { restartRequired: false });
  const { transactionId } = await f.policy.begin(f.loader);
  await f.write({ alpha: "2.0.0" });
  assert.deepEqual(await f.policy.finish(transactionId), { restartRequired: true });
  assert.throws(() => f.loader.resolveImport("alpha"), { code: "module_restart_required" });
});

test("active Workers prevent package changes and host close releases pending admission", async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  const worker = await f.loader.compileIsolated("while (true) {}", { context: {} }, { signal: abort.signal });
  const running = worker();
  void running.catch(() => {});
  await assert.rejects(f.policy.begin(f.loader), { code: "module_busy" });
  abort.abort();
  await assert.rejects(running);
  await f.policy.begin(f.loader);
  await f.policy.close();
  await f.loader.withPackageChanges(async () => {});
  await assert.rejects(f.policy.begin(f.loader), { code: "maintenance_busy" });
  assert.equal(f.policy.policy.approvedPackages().size, 0);
});

test("an invalid work manifest disables npm admission after a package change", async (t) => {
  const f = await fixture(t);
  const { transactionId } = await f.policy.begin(f.loader);
  await writeFile(path.join(f.work, "package.json"), "{invalid", { mode: 0o600 });
  await assert.rejects(f.policy.finish(transactionId), { code: "package_manifest_invalid" });
  assert.equal(f.policy.policy.approvedPackages().size, 0);
  await f.loader.withPackageChanges(async () => {});
});
