import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
const base =
  process.env.NEXUM_APPLICATION_MODULE ??
  new URL("../dist/application/runtime.js", import.meta.url).href;
const { AgentCatalog } = await import(new URL("catalog.js", base).href);
async function fixture(t) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-catalog-")),
    ),
    project = path.join(root, "project"),
    second = path.join(root, "second");
  mkdirSync(project);
  mkdirSync(second);
  const events = [],
    catalog = new AgentCatalog(async (data) => {
      events.push(data);
    });
  t.after(async () => {
    await catalog.close();
    rmSync(root, { recursive: true, force: true });
  });
  const item = (projectId, root) => ({
    projectId,
    root,
    name: projectId,
    projectContextVisibility: { disabledItems: [] },
  });
  const sync = (projects, extra = {}) =>
    catalog.sync(
      {
        generation: "generation_one",
        page: 0,
        complete: true,
        projects,
        allowedRoots: [root],
        ...extra,
      },
      new AbortController().signal,
    );
  return { root, project, second, events, catalog, item, sync };
}
test("catalog summaries come from actual README contents and registered root identities", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    path.join(f.project, "README.md"),
    "# Actual project\nSummary from disk.\n",
  );
  await f.sync([
    f.item("project_one", f.project),
    f.item("project_two", f.second),
  ]);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].projects[0].status, "ok");
  assert.match(f.events[0].projects[0].description, /Actual project/);
  assert.match(f.events[0].projects[0].revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(f.events[0].projects[1].status, "missing");
  assert.equal(f.catalog.project("project_one").root, f.project);
});
test("an online native filesystem watch refreshes changed README text without a catalog re-open", async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.project, "README.md"), "before\n");
  await f.sync([f.item("project_one", f.project)]);
  writeFileSync(path.join(f.project, "README.md"), "after actual write\n");
  for (
    let count = 0;
    count < 100 &&
    !f.events.some((event) =>
      event.projects.some((item) =>
        item.description?.includes("after actual write"),
      ),
    );
    count++
  )
    await delay(25);
  assert.ok(
    f.events.some((event) =>
      event.projects.some((item) =>
        item.description?.includes("after actual write"),
      ),
    ),
  );
  assert.ok(f.events.at(-1).sequence > f.events[0].sequence);
});
test("only a complete ordered generation replaces catalog roots, and revoked roots are unavailable", async (t) => {
  const f = await fixture(t);
  await f.sync([f.item("old", f.project)]);
  await f.sync([f.item("new_one", f.second)], {
    generation: "generation_two",
    complete: false,
  });
  assert.equal(f.catalog.project("old").root, f.project);
  assert.equal(f.catalog.project("new_one"), undefined);
  await assert.rejects(
    f.sync([], { generation: "generation_two", page: 2 }),
    (cause) => cause.code === "catalog_page_mismatch",
  );
  await f.sync([], { generation: "generation_two", page: 1, allowedRoots: [] });
  assert.equal(f.catalog.project("old"), undefined);
  assert.equal(f.events.at(-1).projects[0].status, "unavailable");
});
