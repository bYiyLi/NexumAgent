import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cloudManagedPackages } from "../dist/host/cloud-packages.js";

test("Go-managed work uses declared, installed pnpm packages without legacy approvals", async (t) => {
  const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), "nexum-cloud-pnpm-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = root, modules = path.join(work, "node_modules");
  const installed = path.join(modules, ".pnpm", "browser@1.2.3", "node_modules", "@nexum-hub", "browser");
  await mkdir(installed, { recursive: true });
  await mkdir(path.join(modules, "@nexum-hub"), { recursive: true });
  await writeFile(path.join(installed, "package.json"),
    '{"name":"@nexum-hub/browser","version":"1.2.3"}');
  await symlink(installed, path.join(modules, "@nexum-hub", "browser"));
  const retired = path.join(modules, ".pnpm", "retired-core", "node_modules", "@nexum-hub", "agent");
  await mkdir(retired, { recursive: true });
  await writeFile(path.join(retired, "package.json"), '{"name":"@nexum-hub/agent","version":"1.0.3"}');
  await symlink(retired, path.join(modules, "@nexum-hub", "agent"));
  await writeFile(path.join(work, "package.json"), JSON.stringify({
    private: true, dependencies: {
      "@nexum/node-host": "1.0.0",
      "@nexum-hub/agent": "1.0.3",
      "@nexum-hub/browser": "^1.2.0",
      "not-installed": "1.0.0",
    },
  }));
  const actual = cloudManagedPackages(root);
  assert.deepEqual([...actual], [["@nexum-hub/browser", "1.2.3"]]);
  assert.equal(actual.has("@nexum/node-host"), false,
    "The Node host is not a user-callable npm extension");
  assert.equal(actual.has("@nexum-hub/agent"), false,
    "The retired Core cannot reappear as an authorized work package");
  await writeFile(path.join(work, "package.json"), "{invalid");
  assert.throws(() => cloudManagedPackages(root), { code: "package_manifest_invalid" });
});
