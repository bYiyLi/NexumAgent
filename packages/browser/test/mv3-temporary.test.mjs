import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserRouter } from "../browser-extension/router.js";

const binding = {
  bootId: "boot",
  browserId: "browser",
  browserSessionId: "session",
  connectionId: "connection",
  generation: 1,
};
function fixture(t) {
  const calls = [],
    tabs = new Map([
      [
        1,
        {
          id: 1,
          title: "User page",
          url: "https://user.example/",
          active: true,
        },
      ],
    ]),
    blocked = new Map();
  let next = 100,
    createGate;
  const chrome = {
    tabs: {
      async query() {
        return [...tabs.values()];
      },
      async get(id) {
        return tabs.get(id);
      },
      async update(id, value) {
        calls.push(["update", id, value]);
        return Object.assign(tabs.get(id), value);
      },
      async create(input) {
        calls.push(["create", input]);
        if (createGate) await createGate.promise;
        const tab = { ...input, id: next++, title: "Temporary page" };
        tabs.set(tab.id, tab);
        return tab;
      },
      async remove(id) {
        calls.push(["remove", id]);
        if (!tabs.has(id)) throw new Error("No tab with id");
        tabs.delete(id);
        blocked.get(id)?.resolve([
          {
            result: {
              ok: true,
              value: "Actual native observation settled after target close",
            },
          },
        ]);
      },
    },
    scripting: {
      async executeScript(input) {
        const result = Promise.withResolvers();
        blocked.set(input.target.tabId, result);
        calls.push(["script-start", input.target.tabId]);
        const value = await result.promise;
        calls.push(["script-settled", input.target.tabId]);
        return value;
      },
    },
  };
  const journals = [],
    router = createBrowserRouter(chrome, {
      persistOwned: async (records) => journals.push(structuredClone(records)),
    });
  router.start();
  router.bind(binding);
  const target = { ...binding };
  router.openLease({
    ...binding,
    leaseId: "lease",
    runId: "run",
    operationId: "open",
    target,
  });
  t.after(() => {
    createGate?.resolve();
    return router.dispose();
  });
  const call = (method, args = {}, selected = target) =>
    router.dispatch({
      ...binding,
      actionId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      leaseId: "lease",
      runId: "run",
      target: selected,
      method,
      args: { target: selected, ...args },
      budgetMs: 30000,
    });
  return {
    router,
    call,
    calls,
    tabs,
    journals,
    gate: () => (createGate = Promise.withResolvers()),
  };
}

test("temporary tabs remain inactive, cannot close user tabs, and their nonblocking close reaches a pending native observation", async (t) => {
  const f = fixture(t),
    tab = await f.call("tabs.createTemporary", {
      url: "https://fixture.example/page",
      options: { active: true },
    });
  assert.equal(tab.id, "100");
  assert.equal(
    f.calls.find(([method]) => method === "create")[1].active,
    false,
  );
  assert.equal(f.journals.at(-1)[0].temporary, true);
  await assert.rejects(f.call("tabs.closeTemporary", { id: "1" }), {
    code: "INVALID_TARGET",
  });
  assert.equal(f.tabs.has(1), true);
  const pending = f.call("playwright.domSnapshot", {}, tab.target);
  while (!f.calls.some(([method]) => method === "script-start"))
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    (await f.call("tabs.closeTemporary", { id: tab.id })).closed,
    true,
  );
  assert.match(await pending, /settled after target close/);
  assert.equal(
    f.calls.some(([method]) => method === "update"),
    false,
  );
  const steps = f.calls.map(([method]) => method);
  assert.ok(steps.indexOf("remove") < steps.indexOf("script-settled"));
  await f.router.endLease("lease");
  assert.equal(f.tabs.has(1), true);
  assert.equal(f.tabs.has(100), false);
});

test("lease cleanup closes only its temporary tabs before waiting native script settlement, including late actual creation", async (t) => {
  const f = fixture(t),
    tab = await f.call("tabs.createTemporary", {
      url: "https://fixture.example/page",
    });
  const pending = f.call("playwright.domSnapshot", {}, tab.target),
    rejected = assert.rejects(pending);
  while (!f.calls.some(([method]) => method === "script-start"))
    await new Promise((resolve) => setTimeout(resolve, 0));
  const closed = await f.router.endLease("lease");
  await rejected;
  assert.equal(closed.closed, true);
  assert.equal(f.tabs.has(1), true);
  assert.equal(f.tabs.has(100), false);
  const g = fixture(t),
    gate = g.gate(),
    creating = g.call("tabs.createTemporary", {
      url: "https://fixture.example/late",
    }),
    creationFailed = assert.rejects(creating);
  await new Promise((resolve) => setTimeout(resolve, 0));
  let settled = false;
  const ending = g.router.endLease("lease").then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  gate.resolve();
  await creationFailed;
  assert.equal((await ending).closed, true);
  assert.equal(g.tabs.has(100), false);
  assert.equal(g.tabs.has(1), true);
});
