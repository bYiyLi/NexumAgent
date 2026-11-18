import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cloudManagedPackages } from "../dist/application/cloud-packages.js";

test("Cloud-managed work uses declared, installed pnpm packages without legacy approvals", async (t) => {
  const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), "nexum-cloud-pnpm-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work"), modules = path.join(work, "node_modules");
  const installed = path.join(modules, ".pnpm", "browser@1.2.3", "node_modules", "@nexum-hub", "browser");
  await mkdir(installed, { recursive: true });
  await mkdir(path.join(modules, "@nexum-hub"), { recursive: true });
  await writeFile(path.join(installed, "package.json"),
    '{"name":"@nexum-hub/browser","version":"1.2.3"}');
  await symlink(installed, path.join(modules, "@nexum-hub", "browser"));
  await writeFile(path.join(work, "package.json"), JSON.stringify({
    private: true, dependencies: {
      "@nexum-hub/agent": "0.0.3-next.22",
      "@nexum-hub/browser": "^1.2.0",
      "not-installed": "1.0.0",
    },
  }));
  const actual = cloudManagedPackages(root);
  assert.deepEqual([...actual], [["@nexum-hub/browser", "1.2.3"]]);
  assert.equal(actual.has("@nexum-hub/agent"), false,
    "Agent Core is not a user-callable npm extension");
  await writeFile(path.join(work, "package.json"), "{invalid");
  assert.equal(cloudManagedPackages(root).size, 0,
    "A bad manifest never becomes an import permission");
});
