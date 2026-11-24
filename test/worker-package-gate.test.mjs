import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ModuleLoader } from "../dist/runtime/modules.js";

test("approved npm mutation is blocked while a live Run Worker may import its dependency tree", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "nexum-worker-gate-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const work = scratch;
  await mkdir(work, { recursive: true });
  await writeFile(path.join(work, "package.json"), '{"private":true,"type":"module"}');
  const loader = await ModuleLoader.create(
    work, "boot_" + randomUUID().replaceAll("-", ""), {
      builtins: () => [],
      approvedPackages: () => new Map(),
    },
  );
  const abort = new AbortController();
  const execute = await loader.compileIsolated(
    "while(true) {}", { context: {} }, { signal: abort.signal },
  );
  const current = execute();
  void current.catch(() => {});
  await assert.rejects(loader.withPackageChanges(async () => 1), {
    code: "module_busy",
  });
  abort.abort(new Error("fixture only"));
  await assert.rejects(current);
  assert.equal(await loader.withPackageChanges(async () => 7), 7,
    "Only the confirmed worker exit releases npm mutation admission");
});
