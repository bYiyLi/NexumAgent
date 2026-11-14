import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  createBrowserRouter,
  routeDefinitions,
} from "../browser-extension/router.js";
import {
  BrowserBinaryInbox,
  packBrowserValue,
  browserFrames,
  unpackBrowserValue,
} from "../browser-extension/transport.js";

function event() {
  const values = new Set();
  return {
    addListener: (fn) => values.add(fn),
    removeListener: (fn) => values.delete(fn),
    emit: (...args) => {
      for (const fn of [...values]) fn(...args);
    },
    get size() {
      return values.size;
    },
  };
}
const binding = {
  profile: "development",
  bootId: "boot",
  browserId: "browser",
  browserSessionId: "session",
  connectionId: "connection",
  generation: 1,
};
function fixture(t, config = {}) {
  const calls = [],
    attached = new Set(),
    emitted = [];
  const tabs = new Map([
    [
      1,
      {
        id: 1,
        windowId: 10,
        active: true,
        status: "complete",
        title: "One",
        url: "https://user:pass@example.com/path?secret=1#part",
        groupId: -1,
      },
    ],
    [
      2,
      {
        id: 2,
        windowId: 10,
        active: false,
        status: "complete",
        title: "Two",
        url: "https://example.com/two",
        groupId: -1,
      },
    ],
    [
      3,
      {
        id: 3,
        windowId: 20,
        active: false,
        status: "complete",
        title: "Three",
        url: "https://example.com/three",
        groupId: -1,
      },
    ],
  ]);
  const onUpdated = event(),
    onRemoved = event(),
    onCreated = event(),
    onActivated = event(),
    onCommitted = event(),
    onDOMContentLoaded = event(),
    onCompleted = event(),
    onEvent = event(),
    onDetach = event();
  let next = 4,
    attachGate,
    detachGate,
    documentSequence = 0;
  const chrome = {
    runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
    tabs: {
      onUpdated,
      onRemoved,
      onCreated,
      onActivated,
      async query(query) {
        calls.push(["tabs.query", query]);
        return [...tabs.values()]
          .filter(
            (v) =>
              (query.active === undefined || v.active === query.active) &&
              (query.windowId === undefined || v.windowId === query.windowId),
          )
          .map((v) => ({ ...v }));
      },
      async get(id) {
        calls.push(["tabs.get", id]);
        if (!tabs.has(id)) throw new Error("No such tab");
        return { ...tabs.get(id) };
      },
      async update(id, input) {
        calls.push(["tabs.update", id, input]);
        const tab = tabs.get(id);
        if (!tab) throw new Error("No such tab");
        Object.assign(tab, input);
        if (input.url) {
          const details = {
            tabId: id,
            frameId: 0,
            url: input.url,
            documentId: `doc-${++documentSequence}`,
          };
          onCommitted.emit(details);
          onCompleted.emit(details);
        }
        return { ...tab };
      },
      async create(input) {
        calls.push(["tabs.create", input]);
        const tab = {
          id: next++,
          windowId: 10,
          title: "New",
          groupId: -1,
          status: "complete",
          url: input.url ?? "chrome://newtab/",
          active: input.active,
        };
        tabs.set(tab.id, tab);
        onCreated.emit(tab);
        return { ...tab };
      },
      async remove(id) {
        calls.push(["tabs.remove", id]);
        if (config.removeHook)
          return config.removeHook({ id, tabs, attached, onDetach, onRemoved });
        tabs.delete(id);
        if (attached.delete(id)) onDetach.emit({ tabId: id }, "target_closed");
        onRemoved.emit(id);
      },
      async group(input) {
        calls.push(["tabs.group", input]);
        return 7;
      },
      async ungroup(ids) {
        calls.push(["tabs.ungroup", ids]);
      },
      async move(id, input) {
        calls.push(["tabs.move", id, input]);
        return { ...tabs.get(id), ...input };
      },
      async reload(id) {
        calls.push(["tabs.reload", id]);
        const details = {
          tabId: id,
          frameId: 0,
          url: tabs.get(id).url,
          documentId: `doc-${++documentSequence}`,
        };
        onCommitted.emit(details);
        onCompleted.emit(details);
      },
      async goBack(id) {
        calls.push(["tabs.goBack", id]);
      },
      async goForward(id) {
        calls.push(["tabs.goForward", id]);
      },
    },
    webNavigation: { onCommitted, onDOMContentLoaded, onCompleted },
    downloads: {
      onCreated: event(),
      onChanged: event(),
      async search(query) {
        calls.push(["downloads.search", query]);
        return config.nativeDownloads ?? [];
      },
    },
    debugger: {
      onEvent,
      onDetach,
      async getTargets() {
        return [...attached].map((tabId) => ({ tabId, attached: true }));
      },
      async attach(source, version) {
        calls.push(["debugger.attach", source, version]);
        if (attachGate) await attachGate.promise;
        attached.add(source.tabId);
      },
      async detach(source) {
        calls.push(["debugger.detach", source]);
        if (detachGate) await detachGate.promise;
        attached.delete(source.tabId);
        onDetach.emit(source, "target_closed");
      },
      async sendCommand(source, method, params) {
        calls.push(["debugger.sendCommand", source, method, params]);
        if (method === "Page.getLayoutMetrics")
          return {
            cssVisualViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: 3840,
              clientHeight: 2160,
            },
          };
        if (method === "Page.captureScreenshot")
          return { data: Buffer.from([3, 7, 9]).toString("base64") };
        return { nativeMethod: method };
      },
    },
    scripting: {
      async executeScript(input) {
        calls.push(["scripting.executeScript", input]);
        return [
          {
            frameId: 0,
            result: {
              ok: true,
              value:
                input.args[0].command === "all"
                  ? [{ kind: "ref", ref: "actual-ref", pageVersion: 1 }]
                  : input.args[0].command === "count"
                    ? 3
                    : null,
            },
          },
        ];
      },
    },
    history: {
      async search(input) {
        calls.push(["history.search", input]);
        return [
          { url: "https://example.com/one", title: "One", lastVisitTime: 20 },
          { url: "https://example.com/two", title: "Two", lastVisitTime: 10 },
        ];
      },
    },
    windows: {
      async getAll(input) {
        calls.push(["windows.getAll", input]);
        return [
          { id: 10, focused: true, state: "normal", tabs: [...tabs.values()] },
        ];
      },
    },
    bookmarks: {
      async create(input) {
        calls.push(["bookmarks.create", input]);
        return { id: "bookmark", ...input };
      },
    },
  };
  const router = createBrowserRouter(chrome, {
    emit: (value) => emitted.push(value),
    ...(config.persistOwned ? { persistOwned: config.persistOwned } : {}),
    ...(config.visual ? { visual: config.visual } : {}),
  });
  t.after(async () => {
    attachGate?.resolve();
    detachGate?.resolve();
    await router.dispose().catch(() => {});
  });
  const target = (id = "1") => ({
    ...binding,
    ...(id === null ? {} : { tabId: id, pageVersion: router.version(id) }),
  });
  const open = (leaseId, id = "1", runId = leaseId) =>
    router.openLease({ ...binding, leaseId, runId, target: target(id) });
  const call = (
    method,
    args = {},
    { leaseId = "lease", id = "1", runId = leaseId, signal } = {},
  ) =>
    router.dispatch(
      {
        ...binding,
        actionId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        runId,
        leaseId,
        method,
        target: target(id),
        args: { ...(args.locator ? {} : { target: target(id) }), ...args },
        budgetMs: 1000,
      },
      signal,
    );
  return {
    router,
    chrome,
    calls,
    attached,
    emitted,
    target,
    open,
    call,
    setAttachGate: (value) => {
      attachGate = value;
    },
    setDetachGate: (value) => {
      detachGate = value;
    },
  };
}

test("native visual hooks receive the current run/target, precede pointer input and hold lease cleanup until their actual release", async (t) => {
  const events = [],
    gate = Promise.withResolvers();
  const visual = {
    async start(value) {
      events.push(["start", value]);
    },
    async beforeAction(value) {
      events.push(["beforeAction", value]);
      return { degraded: false };
    },
    async beforePointer(value) {
      events.push(["beforePointer", value]);
      return { degraded: false };
    },
    async markDeliverable(value) {
      events.push(["deliverable", value]);
      return { degraded: false };
    },
    async nameSession(value) {
      events.push(["name", value]);
      return { degraded: false };
    },
    async releaseTab(value) {
      events.push(["release", value]);
      await gate.promise;
      return { degraded: false };
    },
    async dispose() {
      events.push(["dispose"]);
    },
  };
  const f = fixture(t, { visual });
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  await f.router.startVisual("session", []);
  const native = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (...args) => {
    events.push(["native", args[1]]);
    return native(...args);
  };
  await f.call("cua.click", { x: 10, y: 20 });
  const pointer = events.find((entry) => entry[0] === "beforePointer")[1];
  assert.equal(pointer.runId, "lease");
  assert.equal(pointer.leaseId, "lease");
  assert.equal(pointer.target.tabId, "1");
  assert.equal(pointer.target.pageVersion, 1);
  assert.deepEqual(pointer.point, { x: 10, y: 20 });
  assert.equal(pointer.wait, true);
  assert.ok(
    events.findIndex((entry) => entry[0] === "beforePointer") <
      events.findIndex(
        (entry) =>
          entry[0] === "native" && entry[1] === "Input.dispatchMouseEvent",
      ),
  );
  await f.call("browsers.nameSession", { name: "Native task" }, { id: null });
  await f.call("tab.markDeliverable");
  assert.equal(
    events.find((entry) => entry[0] === "deliverable")[1].target
      .browserSessionId,
    "session",
  );
  let closed = false;
  const closing = f.router.endLease("lease").then(() => (closed = true));
  await delay(2);
  assert.equal(closed, false);
  assert.throws(() => f.open("another"), { code: "TAB_ALREADY_CLAIMED" });
  const release = events.find((entry) => entry[0] === "release")[1];
  assert.equal(release.signal, undefined);
  assert.equal(release.result, false);
  gate.resolve();
  await closing;
  assert.equal(closed, true);
});

test("a failed decorative hook cannot replay or suppress a native action, while an unapplied explicit deliverable is an error", async (t) => {
  const visual = {
    async beforeAction() {
      throw Error("unavailable");
    },
    async beforePointer() {
      throw Error("unavailable");
    },
    async markDeliverable() {
      return { degraded: true };
    },
    async releaseTab() {
      return { degraded: false };
    },
    async dispose() {},
  };
  const f = fixture(t, { visual });
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  await f.call("cua.click", { x: 10, y: 20 });
  assert.equal(
    f.calls.filter(
      (entry) =>
        entry[0] === "debugger.sendCommand" &&
        entry[2] === "Input.dispatchMouseEvent" &&
        entry[3].type === "mousePressed",
    ).length,
    1,
  );
  assert.ok(f.emitted.some((entry) => entry.event === "visual_degraded"));
  await assert.rejects(f.call("tab.markDeliverable"), {
    code: "CAPABILITY_NOT_ALLOWED",
  });
});

test("dev logs enable the actual Runtime domain, normalize Chrome warning and filter since by native emission timestamp", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  await f.call("dev.logs");
  assert.ok(
    f.calls.some(
      (value) =>
        value[0] === "debugger.sendCommand" && value[2] === "Runtime.enable",
    ),
  );
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "Runtime.consoleAPICalled", {
    type: "warning",
    timestamp: 1000,
    args: [{ value: "old warning" }],
  });
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "Runtime.consoleAPICalled", {
    type: "warning",
    timestamp: 2000,
    args: [{ value: "new warning" }],
  });
  const logs = await f.call("dev.logs", {
    options: { levels: ["warn"], since: 1500 },
  });
  assert.deepEqual(logs, [
    {
      level: "warn",
      message: "new warning",
      timestamp: new Date(2000).toISOString(),
    },
  ]);
  assert.equal(
    (
      await f.call("dev.logs", {
        options: { levels: ["warning"], since: 1500 },
      })
    ).length,
    1,
  );
});

test("router construction is cold; complete native snapshots strip discovery secrets and native IDs stay configuration-local", async (t) => {
  const f = fixture(t);
  assert.equal(f.chrome.tabs.onUpdated.size, 0);
  assert.deepEqual(f.calls, []);
  f.router.start();
  f.router.bind(binding);
  f.open("lease", null);
  const snapshot = await f.router.snapshot();
  assert.equal(snapshot.length, 3);
  assert.equal(snapshot[0].url, "https://example.com/path");
  const created = await f.call(
    "tabs.new",
    { url: "https://example.com/new", options: { active: false } },
    { id: null },
  );
  assert.equal(created.id, "4");
  assert.equal(created.target.browserSessionId, "session");
  assert.deepEqual(f.calls.find((v) => v[0] === "tabs.create")[1], {
    url: "https://example.com/new",
    active: false,
  });
  await assert.rejects(
    f.router.dispatch({
      ...binding,
      target: { ...f.target(), generation: 2 },
      leaseId: "lease",
      runId: "lease",
      method: "tabs.list",
      args: {},
      budgetMs: 100,
    }),
    { code: "STALE_REF" },
  );
});

test("run locks reject conflicting management changes before any group mutation and preserve prior reservations", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("one", "1");
  f.open("two", "2");
  assert.throws(() => f.open("third", "1"), { code: "TAB_ALREADY_CLAIMED" });
  await assert.rejects(
    f.call(
      "management.tabs.group",
      { options: { tabIds: ["2", "1"] } },
      { leaseId: "two", id: null },
    ),
    { code: "TAB_ALREADY_CLAIMED" },
  );
  assert.equal(
    f.calls.some((v) => v[0] === "tabs.group"),
    false,
  );
  assert.throws(() => f.open("third", "2"), { code: "TAB_ALREADY_CLAIMED" });
  await f.router.endLease("one");
  await assert.rejects(
    f.call(
      "management.tabs.group",
      { options: { tabIds: ["2", "3"] } },
      { leaseId: "two", id: null },
    ),
    { code: "INVALID_TARGET" },
  );
  const group = await f.call(
    "management.tabs.group",
    { options: { tabIds: ["1", "2"] } },
    { leaseId: "two", id: null },
  );
  assert.deepEqual(group, { groupId: "7" });
  assert.deepEqual(
    f.calls.find((v) => v[0] === "tabs.group")[1].tabIds,
    [1, 2],
  );
});

test("an attached native control stays owned until actual detach confirms cleanup; late attach cannot reopen a stopped lease", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const result = await f.call("cdp.send", {
    method: "Network.getCookies",
    params: {},
  });
  assert.equal(result.nativeMethod, "Network.getCookies");
  assert.equal(f.calls.filter((v) => v[0] === "debugger.attach").length, 1);
  const gate = Promise.withResolvers();
  f.setDetachGate(gate);
  let closed = false;
  const closing = f.router.endLease("lease").then((v) => {
    closed = true;
    return v;
  });
  await delay(5);
  assert.equal(closed, false);
  assert.throws(() => f.open("other"), { code: "TAB_ALREADY_CLAIMED" });
  gate.resolve();
  assert.equal((await closing).closed, true);
  assert.equal(f.attached.size, 0);
  assert.throws(() => f.open("lease"), { code: "INVALID_TARGET" });
  f.open("late");
  const attach = Promise.withResolvers();
  f.setAttachGate(attach);
  f.setDetachGate(undefined);
  const pending = f.call(
    "cdp.send",
    { method: "Runtime.enable" },
    { leaseId: "late" },
  );
  await delay(0);
  const stop = f.router.endLease("late");
  attach.resolve();
  await assert.rejects(pending, { code: "INVALID_TARGET" });
  assert.equal((await stop).closed, true);
  assert.equal(f.attached.size, 0);
  assert.equal(
    f.calls.filter(
      (v) => v[0] === "debugger.sendCommand" && v[2] === "Runtime.enable",
    ).length,
    0,
  );
});

test("both ordinary close entries confirm native input/stream/viewport cleanup, close only their target and keep another attached tab usable", async (t) => {
  for (const method of ["tab.close", "management.tabs.close"])
    await t.test(method, async (t) => {
      const f = fixture(t);
      f.router.start();
      f.router.bind(binding);
      f.open("lease", "1");
      f.open("lease", "2");
      await f.call("cdp.send", { method: "Runtime.enable" }, { id: "2" });
      await f.call("cdp.send", {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "Shift" },
      });
      await f.call("cdp.send", {
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", button: "left", x: 10, y: 20 },
      });
      await f.call("tab.setViewport", { size: { width: 900, height: 600 } });
      const original = f.chrome.debugger.sendCommand;
      let allowClose = false;
      f.chrome.debugger.sendCommand = async (...args) => {
        const result = await original(...args);
        if (args[1] === "Page.printToPDF")
          return { stream: "owned-native-stream" };
        if (args[1] === "IO.read") throw Error("Native stream read failed");
        if (args[1] === "IO.close" && !allowClose)
          throw Error("Native stream close unconfirmed");
        return result;
      };
      const plan = await f.call("content.plan", {
        method: "tab.exportFile",
        options: { format: "pdf" },
      });
      await assert.rejects(
        f.call("tab.exportFile", {
          planId: plan.id,
          options: { format: "pdf" },
        }),
        /close unconfirmed/,
      );
      allowClose = true;
      await f.call(
        method,
        method === "tab.close" ? {} : { id: "1" },
        method === "tab.close" ? {} : { id: null },
      );
      const remove = f.calls.findIndex((value) => value[0] === "tabs.remove");
      for (const native of ["IO.close", "Emulation.clearDeviceMetricsOverride"])
        assert.ok(
          f.calls.some(
            (value, index) =>
              index < remove &&
              value[0] === "debugger.sendCommand" &&
              value[1].tabId === 1 &&
              value[2] === native,
          ),
        );
      assert.ok(
        f.calls.some(
          (value, index) =>
            index < remove &&
            value[0] === "debugger.sendCommand" &&
            value[2] === "Input.dispatchKeyEvent" &&
            value[3].type === "keyUp",
        ),
      );
      assert.ok(
        f.calls.some(
          (value, index) =>
            index < remove &&
            value[0] === "debugger.sendCommand" &&
            value[2] === "Input.dispatchMouseEvent" &&
            value[3].type === "mouseReleased",
        ),
      );
      assert.equal(await f.call("tab.title", {}, { id: "2" }), "Two");
      assert.equal(f.attached.has(2), true);
      assert.equal(f.attached.has(1), false);
      assert.equal(
        f.emitted.some((value) => value.event === "user_takeover"),
        false,
      );
      await assert.rejects(f.call("tab.title"), { code: "INVALID_TARGET" });
    });
});

test("failed native close rolls back only its marker and cannot swallow a later real detach or release the original owner", async (t) => {
  const f = fixture(t, {
    removeHook: async () => {
      throw Error("Native removal refused");
    },
  });
  f.router.start();
  f.router.bind(binding);
  f.open("lease", "1");
  f.open("lease", "2");
  await f.call("cdp.send", { method: "Runtime.enable" });
  await assert.rejects(f.call("tab.close"), /removal refused/);
  assert.equal(await f.call("tab.title"), "One");
  assert.throws(() => f.open("other", "1"), { code: "TAB_ALREADY_CLAIMED" });
  f.attached.delete(1);
  f.chrome.debugger.onDetach.emit({ tabId: 1 }, "target_closed");
  await assert.rejects(f.call("tab.title", {}, { id: "2" }), {
    code: "USER_TAKEOVER",
  });
});

test("an unconfirmed native key release prevents removal and keeps the original target owned until cleanup can really succeed", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  await f.call("cdp.send", {
    method: "Input.dispatchKeyEvent",
    params: { type: "keyDown", key: "Shift" },
  });
  const original = f.chrome.debugger.sendCommand;
  let blocked = true;
  f.chrome.debugger.sendCommand = async (...args) => {
    if (
      blocked &&
      args[1] === "Input.dispatchKeyEvent" &&
      args[2].type === "keyUp"
    )
      throw Error("Native key release is unconfirmed");
    return original(...args);
  };
  await assert.rejects(f.call("tab.close"), /release is unconfirmed/);
  assert.equal(
    f.calls.some((value) => value[0] === "tabs.remove"),
    false,
  );
  assert.throws(() => f.open("other"), { code: "TAB_ALREADY_CLAIMED" });
  assert.equal(await f.call("tab.title"), "One");
  blocked = false;
  await f.call("tab.close");
  assert.equal(f.calls.filter((value) => value[0] === "tabs.remove").length, 1);
});

test("a user cancellation concurrent with an owned close still revokes the run; delayed expected target_closed after success does not", async (t) => {
  await t.test("real user cancellation", async (t) => {
    const f = fixture(t, {
      removeHook: async ({ id, tabs, attached, onDetach, onRemoved }) => {
        attached.delete(id);
        onDetach.emit({ tabId: id }, "canceled_by_user");
        tabs.delete(id);
        onRemoved.emit(id);
      },
    });
    f.router.start();
    f.router.bind(binding);
    f.open("lease", "1");
    f.open("lease", "2");
    await f.call("cdp.send", { method: "Runtime.enable" });
    await assert.rejects(f.call("tab.close"), { code: "USER_TAKEOVER" });
    await assert.rejects(f.call("tab.title", {}, { id: "2" }), {
      code: "USER_TAKEOVER",
    });
  });
  await t.test("late target closed", async (t) => {
    let late;
    const f = fixture(t, {
      removeHook: async ({ id, tabs, attached, onDetach, onRemoved }) => {
        tabs.delete(id);
        attached.delete(id);
        onRemoved.emit(id);
        late = () => onDetach.emit({ tabId: id }, "target_closed");
      },
    });
    f.router.start();
    f.router.bind(binding);
    f.open("lease", "1");
    f.open("lease", "2");
    await f.call("cdp.send", { method: "Runtime.enable" });
    await f.call("tab.close");
    late();
    assert.equal(await f.call("tab.title", {}, { id: "2" }), "Two");
    assert.equal(
      f.emitted.some((value) => value.event === "user_takeover"),
      false,
    );
  });
});

test("native screenshot defaults produce byte results, locator collections preserve exact query scope, and user detach fences old writes", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const bytes = await f.call("tab.screenshot");
  assert.deepEqual([...bytes], [3, 7, 9]);
  const capture = f.calls.find(
    (v) => v[0] === "debugger.sendCommand" && v[2] === "Page.captureScreenshot",
  )[3];
  assert.equal(capture.format, "jpeg");
  assert.equal(capture.quality, 80);
  assert.equal(capture.clip.scale, 0.5);
  const locator = {
    target: f.target(),
    framePath: [],
    query: { kind: "selector", selector: "button" },
  };
  const rows = await f.call("locator.all", { locator });
  assert.deepEqual(rows[0].framePath, []);
  assert.equal(rows[0].query.kind, "ref");
  assert.equal(rows[0].target.tabId, "1");
  f.chrome.debugger.onDetach.emit({ tabId: 1 }, "canceled_by_user");
  await assert.rejects(
    f.call("cua.type", { options: { text: "must not reach browser" } }),
    { code: "USER_TAKEOVER" },
  );
  assert.equal(
    f.emitted.some((v) => v.event === "user_takeover"),
    true,
  );
});

test("binary data crosses exact subviews with bounded chunks, validates hash and rejects out-of-order or unrelated streams", async () => {
  const binding = {
    actionId: "action",
    operationId: "operation",
    generation: 1,
  };
  const original = new Uint8Array(140000);
  original.fill(7);
  original[70000] = 9;
  const packed = await packBrowserValue(
    { picture: original.subarray(3, 139997), long: "x".repeat(600000) },
    binding,
  );
  assert.ok(packed.valueStream);
  const inbox = new BrowserBinaryInbox();
  for (const { meta, bytes } of packed.streams) {
    inbox.begin(meta, (candidate) => candidate.actionId === binding.actionId);
    for (const frame of browserFrames(meta, bytes)) {
      assert.ok(frame.byteLength <= 65536 + 4100);
      inbox.push(frame);
    }
    await inbox.end(meta);
  }
  const copied = unpackBrowserValue(
    packed.value,
    packed.attachments,
    packed.valueStream,
    inbox,
    binding,
  );
  assert.deepEqual(copied.picture, original.subarray(3, 139997));
  assert.equal(copied.long.length, 600000);
  const one = await packBrowserValue(new Uint8Array([1, 2, 3]), binding),
    stream = one.streams[0];
  const bad = new BrowserBinaryInbox();
  bad.begin(stream.meta, () => true);
  const chunk = [...browserFrames(stream.meta, stream.bytes)][0];
  bad.push(chunk);
  assert.throws(() => bad.push(chunk), { code: "PROTOCOL_MISMATCH" });
  await assert.rejects(bad.end({ ...stream.meta, sha256: "0".repeat(64) }), {
    code: "PROTOCOL_MISMATCH",
  });
  const unrelated = new BrowserBinaryInbox();
  assert.throws(() => unrelated.begin(stream.meta, () => false), {
    code: "PROTOCOL_MISMATCH",
  });
  assert.equal(
    new Set(routeDefinitions.map((v) => v.method)).size,
    routeDefinitions.length,
  );
  assert.ok(routeDefinitions.every((v) => typeof v.handle === "function"));
});

test("same-run leases extend targets and local handoff releases one tab only after real cleanup", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease", "1");
  f.open("lease", "2");
  await f.call("cdp.send", { method: "Runtime.enable" }, { id: "1" });
  await f.call("cdp.send", { method: "Runtime.enable" }, { id: "2" });
  const gate = Promise.withResolvers();
  f.setDetachGate(gate);
  let done = false;
  const handoff = f.call("tab.markHandoff").then((value) => {
    done = true;
    return value;
  });
  await delay(5);
  assert.equal(done, false);
  assert.throws(() => f.open("other", "1"), { code: "TAB_ALREADY_CLAIMED" });
  gate.resolve();
  const result = await handoff;
  assert.equal(result.released, true);
  assert.equal(result.target.tabId, "1");
  assert.equal(f.attached.has(1), false);
  assert.equal(f.attached.has(2), true);
  f.open("other", "1");
  assert.throws(() => f.open("lease", "1"), { code: "INVALID_TARGET" });
  await assert.rejects(f.call("tab.title"), { code: "INVALID_TARGET" });
  assert.equal(await f.call("tab.title", {}, { id: "2" }), "Two");
});

test("user context reads require the actual reserved tab and preserve other-run, handoff and closed-target fences", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease", "1");
  f.open("other", "2");
  const original = f.chrome.scripting.executeScript;
  f.chrome.scripting.executeScript = async (input) => {
    if (input.args[0].command === "content")
      return [{ result: { ok: true, value: "Actual reserved text" } }];
    return original(input);
  };
  const context = await f.call("user.getTabContext", { tab: "1" });
  assert.equal(context.text, "Actual reserved text");
  assert.equal(context.title, "One");
  await assert.rejects(f.call("user.getTabContext", { tab: "2" }), {
    code: "INVALID_TARGET",
  });
  await assert.rejects(
    f.call("user.getTabContext", { tab: "2" }, { id: "2" }),
    { code: "TAB_ALREADY_CLAIMED" },
  );
  await f.call("tab.markHandoff");
  await assert.rejects(f.call("user.getTabContext", { tab: "1" }), {
    code: "INVALID_TARGET",
  });
  f.open("lease", "3");
  await f.call("tab.close", {}, { id: "3" });
  await assert.rejects(
    f.call("user.getTabContext", { tab: "3" }, { id: "3" }),
    { code: "INVALID_TARGET" },
  );
});

test("a raw filechooser timeout closes its last native interception and lease closure waits for actual cleanup", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const gate = Promise.withResolvers(),
    started = Promise.withResolvers(),
    original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (...args) => {
    if (args[1] === "Page.setInterceptFileChooserDialog" && !args[2].enabled) {
      started.resolve();
      await gate.promise;
    }
    return original(...args);
  };
  const waiter = await f.call("waiters.arm", {
    event: "filechooser",
    timeoutMs: 15,
  });
  await assert.rejects(f.call("waiters.get", { id: waiter.id }), {
    code: "TIMEOUT",
  });
  await started.promise;
  let closed = false;
  const closing = f.router.endLease("lease").then(() => (closed = true));
  await delay(2);
  assert.equal(closed, false);
  assert.throws(() => f.open("another"), { code: "TAB_ALREADY_CLAIMED" });
  gate.resolve();
  await closing;
  assert.equal(closed, true);
  assert.ok(
    f.calls.some(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "Page.setInterceptFileChooserDialog" &&
        value[3].enabled === false,
    ),
  );
});

test("expired chooser cleanup serializes before a newer arm so a late disable cannot undo its confirmed readiness", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const gate = Promise.withResolvers(),
    started = Promise.withResolvers(),
    original = f.chrome.debugger.sendCommand;
  let first = true;
  f.chrome.debugger.sendCommand = async (...args) => {
    if (
      first &&
      args[1] === "Page.setInterceptFileChooserDialog" &&
      !args[2].enabled
    ) {
      first = false;
      started.resolve();
      await gate.promise;
    }
    return original(...args);
  };
  const old = await f.call("waiters.arm", {
    event: "filechooser",
    timeoutMs: 10,
  });
  await assert.rejects(f.call("waiters.get", { id: old.id }), {
    code: "TIMEOUT",
  });
  await started.promise;
  let ready = false;
  const next = f
    .call("waiters.arm", { event: "filechooser", timeoutMs: 1000 })
    .then((value) => {
      ready = true;
      return value;
    });
  await delay(2);
  assert.equal(ready, false);
  gate.resolve();
  const current = await next;
  const intercepts = () =>
    f.calls.filter(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "Page.setInterceptFileChooserDialog",
    );
  assert.deepEqual(
    intercepts().map((value) => value[3].enabled),
    [true, false, true],
  );
  await f.call("waiters.cancel", { id: current.id });
  assert.equal(intercepts().at(-1)[3].enabled, false);
});

test("navigation waiter is armed before action, buffers early events, and get does not prevent the triggering command", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const info = await f.call("waiters.arm", {
    event: "navigation",
    waitUntil: "commit",
    timeoutMs: 1000,
  });
  const pending = f.call("waiters.get", { id: info.id });
  const result = await f.call("tab.navigate", {
    url: "https://example.com/next",
  });
  assert.equal(result.changed, true);
  const eventValue = await pending;
  assert.equal(eventValue.url, "https://example.com/next");
  assert.deepEqual(await f.call("waiters.get", { id: info.id }), eventValue);
  assert.deepEqual(await f.call("waiters.cancel", { id: info.id }), {
    cancelled: true,
  });
  const early = await f.call("waiters.arm", {
    event: "navigation",
    waitUntil: "commit",
    timeoutMs: 1000,
  });
  f.chrome.webNavigation.onCommitted.emit({
    tabId: 1,
    frameId: 0,
    documentId: "another",
    url: "https://example.com/early",
  });
  assert.equal(
    (await f.call("waiters.get", { id: early.id })).url,
    "https://example.com/early",
  );
  f.open("other", "2");
  await assert.rejects(
    f.call("waiters.get", { id: early.id }, { leaseId: "other", id: "2" }),
    { code: "WAITER_GONE" },
  );
});

test("filechooser readiness, early download events, native completion and cancellation preserve original identities", async (t) => {
  const downloads = [
    {
      id: 12,
      url: "https://example.com/file",
      startTime: new Date().toISOString(),
      filename: "/tmp/actual-download",
      state: "in_progress",
      exists: true,
    },
  ];
  const f = fixture(t, { nativeDownloads: downloads });
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const chooser = await f.call("waiters.arm", {
    event: "filechooser",
    timeoutMs: 1000,
  });
  assert.equal(
    f.calls.some(
      (v) =>
        v[0] === "debugger.sendCommand" &&
        v[2] === "Page.setInterceptFileChooserDialog" &&
        v[3].enabled === true,
    ),
    true,
  );
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "Page.fileChooserOpened", {
    backendNodeId: 87,
    mode: "selectMultiple",
  });
  const chosen = await f.call("waiters.get", { id: chooser.id });
  assert.equal(chosen.multiple, true);
  assert.match(chosen.chooserId, /^chooser_/);
  await f.call("waiters.cancel", { id: chooser.id });
  assert.equal(
    f.calls.some(
      (v) =>
        v[0] === "debugger.sendCommand" &&
        v[2] === "Page.setInterceptFileChooserDialog" &&
        v[3].enabled === false,
    ),
    true,
  );
  const download = await f.call("waiters.arm", {
    event: "download",
    timeoutMs: 1000,
  });
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "Page.downloadWillBegin", {
    guid: "download-guid",
    url: "https://example.com/file",
    suggestedFilename: "file.txt",
  });
  f.chrome.downloads.onCreated.emit(downloads[0]);
  const started = await f.call("waiters.get", { id: download.id });
  assert.equal(started.downloadId, "download-guid");
  let complete = false;
  const path = f
    .call("downloads.path", { downloadId: started.downloadId })
    .then((value) => {
      complete = true;
      return value;
    });
  await delay(5);
  assert.equal(complete, false);
  downloads[0].state = "complete";
  assert.equal(await path, "/tmp/actual-download");
  const cancelled = await f.call("waiters.arm", {
    event: "download",
    timeoutMs: 1000,
  });
  const get = f.call("waiters.get", { id: cancelled.id });
  const rejection = assert.rejects(get, { code: "WAITER_GONE" });
  await f.call("waiters.cancel", { id: cancelled.id });
  await rejection;
  assert.deepEqual(await f.call("waiters.cancel", { id: cancelled.id }), {
    cancelled: true,
  });
});

test("attachment intent is committed before native attach and worker recovery detaches only journaled native controls", async (t) => {
  const snapshots = [],
    f = fixture(t, {
      persistOwned: async (items) => {
        snapshots.push(structuredClone(items));
      },
    });
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const nativeAttach = f.chrome.debugger.attach;
  f.chrome.debugger.attach = async (...args) => {
    assert.equal(snapshots.at(-1)[0].tabId, 1);
    return nativeAttach(...args);
  };
  await f.call("cdp.send", { method: "Runtime.enable" });
  const saved = snapshots.at(-1);
  f.attached.add(9);
  const recoverySnapshots = [],
    recovered = createBrowserRouter(f.chrome, {
      persistOwned: async (items) =>
        recoverySnapshots.push(structuredClone(items)),
    });
  recovered.start();
  const result = await recovered.recoverOwnedControls(saved);
  assert.equal(result.length, 1);
  assert.equal(result[0].receipt.closed, true);
  assert.equal(f.attached.has(1), false);
  assert.equal(f.attached.has(9), true);
  assert.deepEqual(recoverySnapshots.at(-1), []);
  await recovered.dispose();
});

test("native pointer sequences serialize per target while event arms can buffer before readiness returns", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers(),
    send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    if (
      method === "Input.dispatchMouseEvent" &&
      params.type === "mouseMoved" &&
      params.x === 1
    ) {
      entered.resolve();
      await gate.promise;
    }
    return send(source, method, params);
  };
  const first = f.call("cua.click", { options: { x: 1, y: 1 } });
  await entered.promise;
  const second = f.call("cua.click", { options: { x: 2, y: 2 } });
  await delay(5);
  assert.equal(
    f.calls.some(
      (v) =>
        v[0] === "debugger.sendCommand" &&
        v[2] === "Input.dispatchMouseEvent" &&
        v[3].x === 2,
    ),
    false,
  );
  gate.resolve();
  await Promise.all([first, second]);
  const pointer = f.calls
    .filter(
      (v) =>
        v[0] === "debugger.sendCommand" && v[2] === "Input.dispatchMouseEvent",
    )
    .map((v) => [v[3].x, v[3].type]);
  assert.deepEqual(pointer, [
    [1, "mouseMoved"],
    [1, "mousePressed"],
    [1, "mouseReleased"],
    [2, "mouseMoved"],
    [2, "mousePressed"],
    [2, "mouseReleased"],
  ]);
  const armGate = Promise.withResolvers(),
    armEntered = Promise.withResolvers();
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    const result = await send(source, method, params);
    if (method === "Page.enable") {
      f.chrome.debugger.onEvent.emit(source, "Page.downloadWillBegin", {
        guid: "early-guid",
        url: "https://example.com/early",
        suggestedFilename: "early.txt",
      });
      armEntered.resolve();
      await armGate.promise;
    }
    return result;
  };
  let armed = false;
  const pending = f
    .call("waiters.arm", { event: "download", timeoutMs: 1000 })
    .then((value) => {
      armed = true;
      return value;
    });
  await armEntered.promise;
  assert.equal(armed, false);
  armGate.resolve();
  const info = await pending;
  assert.equal(
    (await f.call("waiters.get", { id: info.id })).downloadId,
    "early-guid",
  );
});

test("native keyboard chords release only their own keys after cancellation and raw CDP held input is closed with its original lease", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  await f.call("tab.keyboardDown", { key: "Control" });
  await f.call("cua.keypress", { options: { keys: ["Control", "a"] } });
  const keys = () =>
    f.calls
      .filter(
        (value) =>
          value[0] === "debugger.sendCommand" &&
          value[2] === "Input.dispatchKeyEvent",
      )
      .map((value) => value[3]);
  assert.equal(
    keys().some((value) => value.type === "keyUp" && value.key === "Control"),
    false,
  );
  assert.equal(
    keys().find((value) => value.key === "a" && value.type === "keyDown")
      .modifiers,
    2,
  );
  assert.equal(
    keys().find((value) => value.key === "a" && value.type === "keyDown").text,
    undefined,
  );
  const entered = Promise.withResolvers(),
    original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    const result = await original(source, method, params);
    if (
      method === "Input.dispatchKeyEvent" &&
      params.key === "b" &&
      params.type === "keyDown"
    )
      entered.resolve();
    return result;
  };
  const stop = new AbortController();
  const pending = f.call(
    "cua.keypress",
    { options: { keys: ["Shift", "b"], duration: 30 } },
    { signal: stop.signal },
  );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered.promise;
  stop.abort();
  await rejected;
  for (const key of ["b", "Shift"])
    assert.equal(
      keys().some((value) => value.key === key && value.type === "keyUp"),
      true,
    );
  await f.call("cdp.send", {
    method: "Input.dispatchKeyEvent",
    params: {
      type: "rawKeyDown",
      key: "ArrowDown",
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
    },
  });
  await f.call("cdp.send", {
    method: "Input.dispatchMouseEvent",
    params: { type: "mousePressed", button: "right", x: 12, y: 23 },
  });
  await f.router.endLease("lease");
  for (const key of ["Control", "ArrowDown"])
    assert.equal(
      keys().some((value) => value.key === key && value.type === "keyUp"),
      true,
    );
  assert.equal(
    f.calls.some(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "Input.dispatchMouseEvent" &&
        value[3].type === "mouseReleased" &&
        value[3].button === "right",
    ),
    true,
  );
  assert.equal(f.attached.size, 0);
});

test("native AX indices retain the exact backend node and document and never rebind old numeric observations", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    const result = await original(source, method, params);
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: [
          {
            nodeId: "root",
            backendDOMNodeId: 10,
            role: { value: "RootWebArea" },
            childIds: ["button"],
          },
          {
            nodeId: "button",
            backendDOMNodeId: 20,
            role: { value: "button" },
            name: { value: "Save" },
          },
        ],
      };
    if (method === "DOM.getBoxModel")
      return { model: { border: [10, 20, 30, 20, 30, 40, 10, 40] } };
    if (method === "DOM.resolveNode")
      return { object: { objectId: `native-${params.backendNodeId}` } };
    if (method === "Runtime.callFunctionOn") return { result: { value: true } };
    return result;
  };
  const first = await f.call("ax.snapshot");
  const index = first.nodes.find((node) => node.name === "Save").index;
  assert.equal(
    (await f.call("ax.snapshot")).nodes.find((node) => node.name === "Save")
      .index,
    index,
  );
  await f.call("ax.click", { element: index });
  assert.equal(
    f.calls.some(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "DOM.getBoxModel" &&
        value[3].backendNodeId === 20,
    ),
    true,
  );
  assert.equal(
    f.calls.some(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "Input.dispatchMouseEvent" &&
        value[3].type === "mousePressed" &&
        value[3].x === 20 &&
        value[3].y === 30,
    ),
    true,
  );
  await f.call("ax.setValue", { elementIndex: index, value: "actual input" });
  assert.equal(
    f.calls.some(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "Runtime.releaseObject" &&
        value[3].objectId === "native-20",
    ),
    true,
  );
  const both = await f.call("ax.get", { mode: "both" });
  assert.match(both.state, /button "Save"/);
  assert.deepEqual([...both.screenshot], [3, 7, 9]);
  f.open("other", "2");
  await assert.rejects(
    f.call("ax.click", { element: index }, { leaseId: "other", id: "2" }),
    { code: "STALE_REF" },
  );
  f.chrome.webNavigation.onCommitted.emit({
    tabId: 1,
    frameId: 0,
    documentId: "new-doc",
    url: "https://example.com/new",
  });
  await assert.rejects(f.call("ax.click", { element: index }), {
    code: "STALE_REF",
  });
  const replacement = await f.call("ax.snapshot");
  assert.ok(
    replacement.nodes.find((node) => node.name === "Save").index > index,
  );
  assert.equal(
    f.calls.some((value) => value[0] === "scripting.executeScript"),
    false,
  );
});

test("load-state waits distinguish DOM readiness from load and require the actual main-frame network-idle event", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  let readyState = "interactive";
  f.chrome.scripting.executeScript = async (input) => {
    f.calls.push(["scripting.executeScript", input]);
    return [{ result: { ok: true, value: readyState } }];
  };
  await f.call("playwright.waitForLoadState", {
    options: { state: "domcontentloaded" },
  });
  let loaded = false;
  const load = f
    .call("playwright.waitForLoadState", { options: { state: "load" } })
    .then(() => {
      loaded = true;
    });
  await delay(5);
  assert.equal(loaded, false);
  readyState = "complete";
  await load;
  const original = f.chrome.debugger.sendCommand,
    armed = Promise.withResolvers();
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    const result = await original(source, method, params);
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Page.setLifecycleEventsEnabled") armed.resolve();
    return result;
  };
  let idle = false;
  const wait = f
    .call("playwright.waitForLoadState", { options: { state: "networkidle" } })
    .then(() => {
      idle = true;
    });
  await armed.promise;
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "Page.lifecycleEvent", {
    name: "networkIdle",
    frameId: "child-frame",
  });
  await delay(5);
  assert.equal(idle, false);
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "Page.lifecycleEvent", {
    name: "networkIdle",
    frameId: "main-frame",
  });
  await wait;
  assert.equal(idle, true);
});

test("native WebMCP versions with only tool names report their exact registration-safety limitation without an unsafe fallback", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    const result = await original(source, method, params);
    if (method === "WebMCP.enable")
      f.chrome.debugger.onEvent.emit(source, "WebMCP.toolsAdded", {
        tools: [
          {
            name: "submit",
            description: "A real pre-toolId protocol descriptor",
            frameId: "main-frame",
            inputSchema: { type: "object" },
          },
        ],
      });
    return result;
  };
  const info = await f.call("capabilities.tabGet", { id: "webmcp" });
  assert.equal(info.supported, false);
  assert.match(info.reason, /opaque registration IDs/);
  await assert.rejects(f.call("webmcp.fetchTools"), {
    code: "CAPABILITY_NOT_ALLOWED",
  });
  assert.equal(
    f.calls.some(
      (call) =>
        call[0] === "debugger.sendCommand" && call[2] === "WebMCP.invokeTool",
    ),
    false,
  );
});

test("WebMCP discovery binds exact native registration IDs and cancellation targets only the original invocation", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  let nativeToolId = "registration-one",
    shouldComplete = true,
    invocationSequence = 0;
  const original = f.chrome.debugger.sendCommand,
    invoked = Promise.withResolvers();
  const nativeTool = () => ({
    toolId: nativeToolId,
    frameId: "main-frame",
    name: "submit",
    description: "Submit the visible form",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  });
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    const result = await original(source, method, params);
    if (method === "WebMCP.enable")
      f.chrome.debugger.onEvent.emit(source, "WebMCP.toolsAdded", {
        tools: [nativeTool()],
      });
    if (method === "WebMCP.invokeTool") {
      assert.equal(params.toolName, undefined);
      assert.equal(params.toolId, nativeToolId);
      const invocationId = `invocation-${++invocationSequence}`;
      if (shouldComplete)
        queueMicrotask(() =>
          f.chrome.debugger.onEvent.emit(source, "WebMCP.toolResponded", {
            invocationId,
            status: "Completed",
            output: { value: params.input.value },
          }),
        );
      invoked.resolve(invocationId);
      return { invocationId };
    }
    return result;
  };
  const discovery = await f.call("webmcp.fetchTools"),
    observed = discovery.tools[0];
  assert.equal(
    (await f.call("capabilities.tabGet", { id: "webmcp" })).supported,
    true,
  );
  assert.equal(
    (await f.call("webmcp.fetchTools")).registrationRevision,
    discovery.registrationRevision,
  );
  assert.equal(observed.registrationRevision, discovery.registrationRevision);
  assert.deepEqual(
    await f.call("webmcp.invokeTool", {
      name: "submit",
      args: { value: "one" },
      tool: {
        ...observed,
        inputSchema: {
          required: ["value"],
          properties: { value: { type: "string" } },
          type: "object",
        },
      },
    }),
    { value: "one" },
  );
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "WebMCP.toolsRemoved", {
    tools: [{ toolId: nativeToolId }],
  });
  nativeToolId = "registration-two";
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "WebMCP.toolsAdded", {
    tools: [nativeTool()],
  });
  const before = invocationSequence;
  await assert.rejects(
    f.call("webmcp.invokeTool", {
      name: "submit",
      args: { value: "stale" },
      tool: observed,
    }),
    { code: "STALE_REGISTRATION" },
  );
  assert.equal(invocationSequence, before);
  const replacement = (await f.call("webmcp.listTools"))[0];
  assert.notEqual(
    replacement.registrationRevision,
    observed.registrationRevision,
  );
  shouldComplete = false;
  const stop = new AbortController(),
    pending = f.call(
      "webmcp.invokeTool",
      { name: "submit", args: { value: "two" }, tool: replacement },
      { signal: stop.signal },
    );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  while (invocationSequence < 2) await delay(0);
  stop.abort();
  await rejected;
  assert.equal(
    f.calls.some(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "WebMCP.cancelInvocation" &&
        value[3].invocationId === "invocation-2",
    ),
    true,
  );
  f.chrome.webNavigation.onCommitted.emit({
    tabId: 1,
    frameId: 0,
    documentId: "replacement",
    url: "https://example.com/replacement",
  });
  await assert.rejects(
    f.call("webmcp.invokeTool", {
      name: "submit",
      args: { value: "old-doc" },
      tool: replacement,
    }),
    { code: "STALE_REGISTRATION" },
  );
  f.open("unavailable", "2");
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === "WebMCP.enable")
      throw new Error("WebMCP.enable method wasn't found");
    return original(source, method, params);
  };
  await assert.rejects(
    f.call("webmcp.listTools", {}, { leaseId: "unavailable", id: "2" }),
    { code: "CAPABILITY_NOT_ALLOWED" },
  );
});

test("file batches are fully validated before one exact native input mutation and chooser observations cannot target replacements", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  let multiple = true;
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    const result = await original(source, method, params);
    if (method === "DOM.describeNode")
      return {
        node: {
          backendNodeId: 87,
          nodeName: "INPUT",
          attributes: ["type", "file", ...(multiple ? ["multiple", ""] : [])],
        },
      };
    return result;
  };
  const arm = await f.call("waiters.arm", {
    event: "filechooser",
    timeoutMs: 1000,
  });
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "Page.fileChooserOpened", {
    backendNodeId: 87,
    mode: "selectMultiple",
  });
  const chooser = await f.call("waiters.get", { id: arm.id });
  const file = {
    path: "/tmp/private-prepared/one.txt",
    name: "one.txt",
    mimeType: "text/plain",
  };
  const calls = () =>
    f.calls.filter(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "DOM.setFileInputFiles",
    );
  await assert.rejects(
    f.call("fileChoosers.setFiles", {
      ...chooser,
      files: [file, { path: "relative.txt", name: "two.txt" }],
    }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(calls().length, 0);
  await f.call("fileChoosers.setFiles", {
    ...chooser,
    files: [
      file,
      { ...file, path: "/tmp/private-prepared/two.txt", name: "two.txt" },
    ],
  });
  assert.equal(calls().length, 1);
  assert.deepEqual(calls()[0][3], {
    backendNodeId: 87,
    files: [file.path, "/tmp/private-prepared/two.txt"],
  });
  await assert.rejects(
    f.call("fileChoosers.setFiles", { ...chooser, files: [] }),
    { code: "STALE_REF" },
  );
  const single = await f.call("waiters.arm", {
    event: "filechooser",
    timeoutMs: 1000,
  });
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "Page.fileChooserOpened", {
    backendNodeId: 87,
    mode: "selectSingle",
  });
  const observed = await f.call("waiters.get", { id: single.id });
  multiple = false;
  await assert.rejects(
    f.call("fileChoosers.setFiles", { ...observed, files: [file, file] }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(calls().length, 1);
  f.chrome.webNavigation.onCommitted.emit({
    tabId: 1,
    frameId: 0,
    documentId: "new-upload-doc",
    url: "https://example.com/new",
  });
  await assert.rejects(
    f.call("fileChoosers.setFiles", { ...observed, files: [] }),
    { code: "STALE_REF" },
  );
  assert.equal(calls().length, 1);
});

test("tab.setFiles resolves the opaque ref in the exact extension isolated world and releases only its temporary native object", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const original = f.chrome.debugger.sendCommand;
  f.chrome.scripting.executeScript = async (input) => {
    f.calls.push(["scripting.executeScript", input]);
    return [{ result: { ok: true, value: { multiple: false } } }];
  };
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    const result = await original(source, method, params);
    if (method === "Runtime.enable")
      for (const context of [
        {
          id: 3,
          origin: "https://page.example",
          auxData: { isDefault: true, frameId: "main" },
        },
        {
          id: 4,
          origin: `chrome-extension://${f.chrome.runtime.id}`,
          auxData: { isDefault: false, frameId: "main" },
        },
      ])
        f.chrome.debugger.onEvent.emit(
          source,
          "Runtime.executionContextCreated",
          { context },
        );
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main" } } };
    if (method === "Runtime.evaluate") {
      assert.equal(params.contextId, 4);
      assert.match(params.expression, /nexum.browser.document.v1/);
      assert.match(params.expression, /r_lease_1_original/);
      return { result: { objectId: "original-file-node", subtype: "node" } };
    }
    if (method === "DOM.describeNode") {
      assert.deepEqual(params, { objectId: "original-file-node" });
      return {
        node: {
          backendNodeId: 87,
          nodeName: "INPUT",
          attributes: ["type", "file"],
        },
      };
    }
    return result;
  };
  const result = await f.call("tab.setFiles", {
    ref: "r_lease_1_original",
    files: [{ path: "/tmp/private-prepared/one.txt", name: "one.txt" }],
  });
  assert.equal(result.ok, true);
  assert.equal(
    f.calls.filter(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "DOM.setFileInputFiles",
    ).length,
    1,
  );
  assert.equal(
    f.calls.some(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "Runtime.releaseObject" &&
        value[3].objectId === "original-file-node",
    ),
    true,
  );
});

test("worker recovery releases journaled native input without replay and a real user detach preserves unknown input effects", async (t) => {
  const snapshots = [],
    f = fixture(t, {
      persistOwned: async (records) => snapshots.push(structuredClone(records)),
    });
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
      assert.equal(snapshots.at(-1)[0].keys[0].params.key, "Shift");
      assert.equal(
        Object.hasOwn(snapshots.at(-1)[0].keys[0].params, "text"),
        false,
      );
    }
    return original(source, method, params);
  };
  await f.call("tab.keyboardDown", { key: "Shift" });
  const saved = snapshots.at(-1),
    before = f.calls.length;
  const recovered = createBrowserRouter(f.chrome);
  recovered.start();
  const receipts = await recovered.recoverOwnedControls(saved);
  assert.equal(receipts[0].receipt.closed, true);
  assert.equal(receipts[0].receipt.unconfirmedControls, undefined);
  const recoveryInput = f.calls
    .slice(before)
    .filter(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "Input.dispatchKeyEvent",
    );
  assert.equal(recoveryInput.length, 1);
  assert.equal(recoveryInput[0][3].type, "keyUp");
  assert.equal(recoveryInput[0][3].key, "Shift");
  await recovered.dispose();
  const g = fixture(t, {
    persistOwned: async (records) => snapshots.push(structuredClone(records)),
  });
  g.router.start();
  g.router.bind(binding);
  g.open("lease");
  await g.call("tab.keyboardDown", { key: "Shift" });
  g.attached.delete(1);
  const count = g.calls.length;
  g.chrome.debugger.onDetach.emit({ tabId: 1 }, "canceled_by_user");
  const receipt = await g.router.endLease("lease");
  assert.equal(receipt.closed, true);
  assert.equal(receipt.unconfirmedControls, true);
  assert.equal(
    g.calls
      .slice(count)
      .some(
        (value) =>
          value[0] === "debugger.attach" || value[0] === "debugger.sendCommand",
      ),
    false,
  );
  assert.deepEqual(snapshots.at(-1), []);
});

test("browser viewport resolves and claims the actual selected tab and valid long event waiters retain only their own timer", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease", null);
  const viewport = await f.call(
    "viewport.set",
    { options: { width: 1000, height: 700 } },
    { id: null },
  );
  assert.equal(viewport.target.tabId, "1");
  assert.equal(
    f.calls.some(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[1].tabId === 1 &&
        value[2] === "Emulation.setDeviceMetricsOverride",
    ),
    true,
  );
  assert.throws(() => f.open("other", "1"), { code: "TAB_ALREADY_CLAIMED" });
  const waiter = await f.call("waiters.arm", {
    event: "download",
    timeoutMs: 2147483647,
  });
  assert.ok(waiter.expiresAt > Date.now() + 86400000);
  await f.call("waiters.cancel", { id: waiter.id });
  await f.call("tab.resetViewport");
  await f.router.endLease("lease");
  assert.equal(f.attached.size, 0);
});

test("only the actual synchronous pre-admission failure can prove a rejected lease closed, never an existing target expansion", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("owner", "1");
  f.open("other", "2");
  let failure;
  try {
    f.router.openLease({
      ...binding,
      leaseId: "new",
      runId: "new-run",
      operationId: "new-open",
      target: f.target("1"),
    });
  } catch (cause) {
    failure = cause;
  }
  const receipt = f.router.rejectedLeaseOpen(failure);
  assert.equal(receipt.rejected, true);
  assert.equal(receipt.closed, true);
  assert.equal(receipt.code, "TAB_ALREADY_CLAIMED");
  assert.equal(receipt.operationId, "new-open");
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.router.rejectedLeaseOpen(Object.assign(new Error("fake"), receipt)),
    null,
  );
  let expansion;
  try {
    f.router.openLease({
      ...binding,
      leaseId: "other",
      runId: "other",
      operationId: "expand",
      target: f.target("1"),
    });
  } catch (cause) {
    expansion = cause;
  }
  assert.equal(expansion.code, "TAB_ALREADY_CLAIMED");
  assert.equal(f.router.rejectedLeaseOpen(expansion), null);
  assert.equal(
    await f.call("tab.title", {}, { leaseId: "other", id: "2" }),
    "Two",
  );
});

test("a natively rejected raw mouse move preserves the last finite release coordinates and does not prevent lease cleanup", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    const result = await original(source, method, params);
    if (
      method === "Input.dispatchMouseEvent" &&
      (!Number.isFinite(params.x) || !Number.isFinite(params.y))
    )
      throw new Error("Invalid native mouse coordinates");
    return result;
  };
  await f.call("cdp.send", {
    method: "Input.dispatchMouseEvent",
    params: { type: "mousePressed", button: "left", x: 10, y: 20 },
  });
  await f.call("cdp.send", {
    method: "Input.dispatchMouseEvent",
    params: { type: "mouseMoved", x: 30, y: 40 },
  });
  await assert.rejects(
    f.call("cdp.send", {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 999 },
    }),
    /Invalid native mouse coordinates/,
  );
  assert.equal(
    f.calls.some(
      (value) =>
        value[0] === "debugger.sendCommand" &&
        value[2] === "Input.dispatchMouseEvent" &&
        value[3].type === "mouseMoved" &&
        value[3].x === 999,
    ),
    true,
  );
  const receipt = await f.router.endLease("lease");
  assert.equal(receipt.closed, true);
  const released = f.calls.find(
    (value) =>
      value[0] === "debugger.sendCommand" &&
      value[2] === "Input.dispatchMouseEvent" &&
      value[3].type === "mouseReleased",
  );
  assert.equal(released[3].x, 30);
  assert.equal(released[3].y, 40);
  assert.equal(f.attached.size, 0);
  f.open("next-owner");
});

test("AX secondary actions are exposed from the exact native observation, checked again before input, and confirmed by native state", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease");
  let expanded = false;
  const node = () => ({
    nodeId: "details",
    backendDOMNodeId: 20,
    role: { value: "button" },
    name: { value: "Details" },
    properties: [{ name: "expanded", value: { value: expanded } }],
  });
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    const result = await original(source, method, params);
    if (
      [
        "Accessibility.getFullAXTree",
        "Accessibility.getPartialAXTree",
      ].includes(method)
    )
      return { nodes: [node()] };
    if (method === "DOM.getBoxModel")
      return { model: { border: [0, 0, 40, 0, 40, 20, 0, 20] } };
    if (
      method === "Input.dispatchMouseEvent" &&
      params.type === "mouseReleased"
    )
      expanded = !expanded;
    return result;
  };
  assert.match(await f.call("ax.get"), /actions: Expand/);
  const index = (await f.call("ax.snapshot")).nodes[0].index;
  await assert.rejects(
    f.call("ax.performSecondaryAction", {
      elementIndex: index,
      action: "Collapse",
    }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(
    f.calls.some(
      (call) =>
        call[0] === "debugger.sendCommand" &&
        call[2] === "Input.dispatchMouseEvent",
    ),
    false,
  );
  await f.call("ax.performSecondaryAction", {
    elementIndex: index,
    action: "Expand",
  });
  assert.equal(expanded, true);
  await assert.rejects(
    f.call("ax.performSecondaryAction", {
      elementIndex: index,
      action: "Expand",
    }),
    { code: "STALE_REF" },
  );
  assert.match(await f.call("ax.get"), /actions: Collapse/);
  await f.call("ax.performSecondaryAction", {
    elementIndex: index,
    action: "Collapse",
  });
  assert.equal(expanded, false);
});

test("capability metadata uses current native permissions and target probes and does not report unavailable native APIs as supported", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease", null);
  let granted = true,
    canEmulate = true,
    debuggerDenied = false;
  f.chrome.permissions = {
    async contains(input) {
      assert.deepEqual(input.permissions, ["tabs", "tabGroups", "bookmarks"]);
      return granted;
    },
  };
  f.chrome.tabGroups = {
    async query() {
      return [];
    },
  };
  f.chrome.bookmarks.search = async () => [];
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    if (debuggerDenied && method === "Runtime.enable")
      throw new Error("native error contains secret page text");
    if (method === "WebMCP.enable")
      throw new Error("WebMCP.enable method wasn't found");
    const response = await original(source, method, params);
    return method === "Emulation.canEmulate"
      ? { result: canEmulate }
      : response;
  };
  const available = await f.call(
    "capabilities.browserGet",
    { id: "management" },
    { id: null },
  );
  assert.equal(available.supported, true);
  granted = false;
  const denied = await f.call(
    "capabilities.browserGet",
    { id: "management" },
    { id: null },
  );
  assert.equal(denied.supported, false);
  assert.notEqual(denied.revision, available.revision);
  assert.equal(
    (await f.call("capabilities.browserGet", { id: "viewport" }, { id: null }))
      .supported,
    true,
  );
  canEmulate = false;
  assert.equal(
    (await f.call("capabilities.browserGet", { id: "viewport" }, { id: null }))
      .supported,
    false,
  );
  const list = await f.call("capabilities.tabList");
  assert.equal(list.find((value) => value.id === "cdp").supported, true);
  assert.equal(list.find((value) => value.id === "webmcp").supported, false);
  assert.equal(
    list.find((value) => value.id === "pageAssets").supported,
    false,
  );
  debuggerDenied = true;
  const blocked = await f.call("capabilities.tabGet", { id: "cdp" });
  assert.equal(blocked.supported, false);
  assert.equal(blocked.reason.includes("secret"), false);
  await assert.rejects(f.call("capabilities.tabGet", { id: "invented" }), {
    code: "CAPABILITY_NOT_ALLOWED",
  });
});

test("resuming explicit handoff publishes a new control epoch without reviving old facades, event tokens or foreign native control", async (t) => {
  const f = fixture(t);
  f.router.start();
  f.router.bind(binding);
  f.open("lease", "1");
  f.open("lease", "2");
  const old = (await f.call("tabs.get", { id: "1" })).target;
  assert.equal(typeof old.controlEpoch, "string");
  const invoke = (target, method, args = {}) =>
    f.router.dispatch({
      ...binding,
      actionId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      leaseId: "lease",
      runId: "lease",
      target,
      method,
      args: { target, ...args },
      budgetMs: 1000,
    });
  assert.equal(await invoke(old, "tab.title"), "One");
  await assert.rejects(f.call("tab.title"), { code: "STALE_REF" });
  const waiter = await invoke(old, "waiters.arm", {
    event: "download",
    timeoutMs: 1000,
  });
  f.chrome.debugger.onEvent.emit({ tabId: 1 }, "Page.downloadWillBegin", {
    guid: "before-resume",
    url: "https://example.com/file",
    suggestedFilename: "old.txt",
  });
  assert.equal(
    (await invoke(old, "waiters.get", { id: waiter.id })).target.controlEpoch,
    old.controlEpoch,
  );
  const cursor = await invoke(old, "cdp.cursor");
  await invoke(old, "tab.markHandoff");
  assert.equal(await f.call("tab.title", {}, { id: "2" }), "Two");
  f.attached.add(1);
  await assert.rejects(invoke(old, "tab.resumeUserControl"), {
    code: "CDP_DISCONNECTED",
  });
  f.attached.delete(1);
  f.open("other", "1");
  await assert.rejects(invoke(old, "tab.resumeUserControl"), {
    code: "TAB_ALREADY_CLAIMED",
  });
  await f.router.endLease("other");
  f.chrome.webNavigation.getAllFrames = async ({ tabId }) => [
    {
      frameId: 0,
      documentId: "current-native-document",
      url: (await f.chrome.tabs.get(tabId)).url,
    },
  ];
  const resumed = await invoke(old, "tab.resumeUserControl");
  assert.equal(resumed.resumed, true);
  assert.notEqual(resumed.target.controlEpoch, old.controlEpoch);
  assert.equal(resumed.document.documentId, "current-native-document");
  assert.equal(f.attached.has(1), false);
  await assert.rejects(invoke(old, "tab.title"), { code: "STALE_REF" });
  await assert.rejects(
    invoke({ ...old, controlEpoch: undefined }, "tab.title"),
    { code: "STALE_REF" },
  );
  const fresh = (await f.call("tabs.get", { id: "1" })).target;
  assert.equal(fresh.controlEpoch, resumed.target.controlEpoch);
  assert.equal(await invoke(fresh, "tab.title"), "One");
  await assert.rejects(invoke(fresh, "waiters.get", { id: waiter.id }), {
    code: "WAITER_GONE",
  });
  await assert.rejects(invoke(fresh, "cdp.events", { cursor }), {
    code: "STALE_REF",
  });
  assert.deepEqual(await invoke(fresh, "tab.downloads"), []);
  await assert.rejects(
    invoke(fresh, "downloads.path", { downloadId: "before-resume" }),
    { code: "FILE_UNAVAILABLE" },
  );
});
