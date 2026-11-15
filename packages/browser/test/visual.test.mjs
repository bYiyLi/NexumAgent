import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import {
  createVisualController,
  visualPage,
  visualStyles,
} from "../browser-extension/visual.js";
function event() {
  const listeners = new Set();
  return {
    addListener(fn) {
      listeners.add(fn);
    },
    removeListener(fn) {
      listeners.delete(fn);
    },
    emit(...args) {
      for (const fn of listeners) fn(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}
function context(tabId = "1", fields = {}) {
  return {
    leaseId: "lease-1",
    runId: "run-1",
    operationId: "operation-1",
    target: {
      browserId: "browser",
      bootId: "boot",
      browserSessionId: "session",
      generation: 1,
      tabId,
      controlEpoch: "epoch-1",
      pageVersion: 1,
    },
    deadline: Date.now() + 5000,
    signal: new AbortController().signal,
    ...fields,
  };
}
function fixture({ execute, frame } = {}) {
  const tabs = new Map([
      [1, { id: 1, windowId: 10, groupId: -1, active: false }],
      [2, { id: 2, windowId: 10, groupId: -1, active: false }],
      [3, { id: 3, windowId: 10, groupId: 77, active: false }],
      [4, { id: 4, windowId: 20, groupId: -1, active: false }],
    ]),
    calls = [],
    saved = [],
    notices = [],
    groups = new Map([[77, { id: 77, title: "User group", color: "red" }]]);
  let next = 100;
  const onActivated = event(),
    onRemoved = event(),
    onUpdated = event();
  const chrome = {
    tabs: {
      onActivated,
      onRemoved,
      onUpdated,
      get: async (id) => {
        calls.push(["tabs.get", id]);
        assert.ok(tabs.has(id));
        return { ...tabs.get(id) };
      },
      update: async (id, change) => {
        calls.push(["tabs.update", id, change]);
        Object.assign(tabs.get(id), change);
        if (change.active)
          onActivated.emit({ tabId: id, windowId: tabs.get(id).windowId });
        return { ...tabs.get(id) };
      },
      group: async (args) => {
        calls.push(["tabs.group", args]);
        const id = args.groupId ?? next++;
        if (!groups.has(id))
          groups.set(id, { id, windowId: args.createProperties.windowId });
        for (const tabId of args.tabIds) tabs.get(tabId).groupId = id;
        return id;
      },
      ungroup: async (ids) => {
        calls.push(["tabs.ungroup", ids]);
        for (const id of ids) tabs.get(id).groupId = -1;
      },
    },
    tabGroups: {
      update: async (id, change) => {
        calls.push(["groups.update", id, change]);
        Object.assign(groups.get(id), change);
        return { ...groups.get(id) };
      },
    },
    webNavigation: {
      getFrame: async (args) => {
        calls.push(["getFrame", args]);
        return frame ? await frame(args) : { documentId: `doc-${args.tabId}` };
      },
    },
    scripting: {
      insertCSS: async (args) => calls.push(["insertCSS", args]),
      removeCSS: async (args) => calls.push(["removeCSS", args]),
      executeScript: async (args) => {
        calls.push(["execute", args]);
        return execute
          ? await execute(args)
          : [{ result: { ok: true, arrived: true } }];
      },
    },
  };
  const controller = createVisualController(chrome, {
    emit: (value) => notices.push(value),
    persist: async (value) => saved.push(value),
  });
  return { controller, chrome, calls, saved, notices, tabs, groups };
}
async function until(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < end, "visual fixture did not settle");
    await delay(1);
  }
}

test("host wakeups enforce visual timeouts when worker timers are stalled", async () => {
  const nativeSetTimeout = globalThis.setTimeout;
  let intercepted = 0;
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds > 0 && milliseconds <= 250) {
      intercepted++;
      return nativeSetTimeout(callback, 10000, ...args);
    }
    return nativeSetTimeout(callback, milliseconds, ...args);
  };
  const frameGate = Promise.withResolvers(),
    frame = fixture({ frame: () => frameGate.promise }),
    pageGate = Promise.withResolvers(),
    page = fixture({
      execute: async () => await pageGate.promise,
    });
  try {
    const action = frame.controller.beforeAction(context());
    await until(() => frame.calls.some((item) => item[0] === "getFrame"));
    await delay(320);
    frame.controller.wake();
    assert.deepEqual(await action, { degraded: true });
    frameGate.resolve({ documentId: "late-document" });
    await delay(5);
    assert.equal(frame.calls.filter((item) => item[0] === "execute").length, 0);

    const result = page.controller.markDeliverable(context());
    await until(() => page.calls.some((item) => item[0] === "execute"));
    await delay(320);
    page.controller.wake();
    assert.deepEqual(await result, { degraded: true });
    pageGate.resolve([{ result: { ok: true } }]);
    assert.ok(intercepted >= 2);
  } finally {
    frameGate.resolve({ documentId: "late-document" });
    pageGate.resolve([{ result: { ok: true } }]);
    globalThis.setTimeout = nativeSetTimeout;
    await frame.controller.dispose();
    await page.controller.dispose();
  }
});

test("visual construction is cold and every run/window owns its blue group while user groups and OS focus stay unchanged", async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  await f.controller.start({ browserSessionId: "session" });
  await Promise.all([
    f.controller.beforeAction(context("1")),
    f.controller.beforeAction(context("2")),
    f.controller.beforeAction(context("3")),
    f.controller.beforeAction(context("4")),
  ]);
  const own = [...f.groups.values()].filter((value) => value.id !== 77);
  assert.equal(own.length, 2);
  assert.ok(
    own.every(
      (value) => value.color === "blue" && value.title === "Nexum browser",
    ),
  );
  assert.equal(f.tabs.get(1).groupId, f.tabs.get(2).groupId);
  assert.notEqual(f.tabs.get(1).groupId, f.tabs.get(4).groupId);
  assert.deepEqual(f.groups.get(77), {
    id: 77,
    title: "User group",
    color: "red",
  });
  assert.ok(
    f.calls
      .filter((value) => value[0] === "tabs.update")
      .every((value) => Object.keys(value[2]).join() === "active"),
  );
  await f.controller.nameSession({ ...context(), name: "🔎 Native task" });
  assert.ok(
    own.every((value) => f.groups.get(value.id).title === "🔎 Native task"),
  );
  assert.equal(f.groups.get(77).title, "User group");
  await f.controller.releaseTab(context("1"));
  assert.equal(f.tabs.get(1).groupId, -1);
  assert.equal(f.tabs.get(3).groupId, 77);
  await f.controller.dispose();
  assert.equal(f.chrome.tabs.onActivated.size, 0);
  assert.equal(f.chrome.tabs.onUpdated.size, 0);
  assert.equal(f.chrome.tabs.onRemoved.size, 0);
});

test("favicon preparation begins while the exact tab group is still being prepared", async () => {
  const groupGate = Promise.withResolvers(),
    iconGate = Promise.withResolvers(),
    groupStarted = Promise.withResolvers();
  let iconStarted = false;
  const f = fixture({
    execute: async (args) => {
      if (args.args[0].command === "active") {
        iconStarted = true;
        return await iconGate.promise;
      }
      return [{ result: { ok: true } }];
    },
  });
  const group = f.chrome.tabs.group;
  f.chrome.tabs.group = async (args) => {
    groupStarted.resolve();
    await groupGate.promise;
    return group(args);
  };
  try {
    const pending = f.controller.beforeAction(context());
    await groupStarted.promise;
    assert.equal(iconStarted, true);
    groupGate.resolve();
    iconGate.resolve([{ result: { ok: true } }]);
    assert.deepEqual(await pending, { degraded: false });
  } finally {
    groupGate.resolve();
    iconGate.resolve([{ result: { ok: true } }]);
    await f.controller.dispose();
  }
});

test("pointer arrival is a bounded native barrier; middle drag points do not block or replay a business action", async () => {
  const gate = Promise.withResolvers();
  let move;
  const f = fixture({
    execute: async (args) => {
      if (args.args[0].command === "move") {
        move = args;
        return await gate.promise;
      }
      return [{ result: { ok: true } }];
    },
  });
  await f.controller.start({ browserSessionId: "session" });
  let arrived = false;
  const pending = f.controller
    .beforePointer({ ...context(), point: { x: 120, y: 90 }, moveSequence: 5 })
    .then((value) => {
      arrived = true;
      return value;
    });
  await until(() => move);
  assert.equal(arrived, false);
  assert.equal(move.func, visualPage);
  assert.deepEqual(move.target, { tabId: 1, documentIds: ["doc-1"] });
  assert.equal(move.args[0].moveSequence, 5);
  assert.equal(move.args[0].runId, "run-1");
  assert.equal(move.args[0].operationId, "operation-1");
  assert.equal(move.args[0].target.controlEpoch, "epoch-1");
  gate.resolve([{ result: { ok: true, arrived: true } }]);
  assert.deepEqual(await pending, { degraded: false });
  assert.equal(arrived, true);
  const other = Promise.withResolvers(),
    drag = fixture({
      execute: async (args) =>
        args.args[0].command === "move"
          ? other.promise
          : [{ result: { ok: true } }],
    });
  await drag.controller.beforeAction({ ...context(), followSessionTab: false });
  const started = performance.now();
  assert.deepEqual(
    await drag.controller.beforePointer({
      ...context(),
      point: { x: 2, y: 3 },
      moveSequence: 6,
      wait: false,
    }),
    { degraded: false },
  );
  assert.ok(performance.now() - started < 100);
  assert.equal(
    drag.calls.filter((value) => value[0] === "tabs.update").length,
    0,
  );
  other.resolve([{ result: { ok: true } }]);
  await f.controller.dispose();
  await drag.controller.dispose();
});

test("a pointer can still appear when its already-started favicon preparation is slow", async () => {
  const gate = Promise.withResolvers(),
    f = fixture({
      execute: async (args) =>
        args.args[0].command === "active"
          ? await gate.promise
          : [{ result: { ok: true, arrived: true } }],
    });
  await f.controller.start({ browserSessionId: "session" });
  const input = context();
  try {
    assert.deepEqual(await f.controller.beforeAction(input), {
      degraded: true,
    });
    assert.deepEqual(
      await f.controller.beforePointer({
        ...input,
        visualPrepared: true,
        point: { x: 42, y: 64 },
        moveSequence: 1,
      }),
      { degraded: false },
    );
    assert.deepEqual(
      f.calls
        .filter((value) => value[0] === "execute")
        .map((value) => value[1].args[0].command),
      ["active", "move"],
    );
  } finally {
    gate.resolve([{ result: { ok: false, reason: "VISUAL_TARGET_RELEASED" } }]);
    await f.controller.dispose();
  }
});

test("a later action can recover after native pointer stylesheet insertion fails", async () => {
  const f = fixture();
  let attempts = 0;
  f.chrome.scripting.insertCSS = async (args) => {
    f.calls.push(["insertCSS", args]);
    if (++attempts === 1) throw Error("native insertion failed");
  };
  await f.controller.start({ browserSessionId: "session" });
  try {
    assert.deepEqual(await f.controller.beforeAction(context()), {
      degraded: false,
    });
    const move = (moveSequence) =>
      f.controller.beforePointer({
        ...context(),
        visualPrepared: true,
        point: { x: 42, y: 64 },
        moveSequence,
      });
    assert.deepEqual(await move(1), { degraded: true });
    assert.deepEqual(await move(2), { degraded: false });
    assert.equal(attempts, 2);
    assert.equal(
      f.calls.filter(
        (value) =>
          value[0] === "execute" && value[1].args[0].command === "move",
      ).length,
      1,
    );
  } finally {
    await f.controller.dispose();
  }
});

test("a late stylesheet failure cannot evict a replacement document's style", async () => {
  let documentId = "document-old";
  const gate = Promise.withResolvers();
  const f = fixture({ frame: async () => ({ documentId }) });
  f.chrome.scripting.insertCSS = async (args) => {
    f.calls.push(["insertCSS", args]);
    if (args.target.documentIds[0] === "document-old")
      return await gate.promise;
  };
  await f.controller.start({ browserSessionId: "session" });
  try {
    await f.controller.beforeAction(context());
    const move = (moveSequence) =>
      f.controller.beforePointer({
        ...context(),
        visualPrepared: true,
        point: { x: 42, y: 64 },
        moveSequence,
      });
    const old = move(1);
    await until(() => f.calls.some((value) => value[0] === "insertCSS"));
    documentId = "document-new";
    await f.controller.beforeAction(context());
    assert.deepEqual(await move(2), { degraded: false });
    gate.reject(Error("old document insertion failed"));
    assert.deepEqual(await old, { degraded: true });
    assert.deepEqual(await move(3), { degraded: false });
    assert.deepEqual(
      f.calls
        .filter((value) => value[0] === "insertCSS")
        .map((value) => value[1].target.documentIds[0]),
      ["document-old", "document-new"],
    );
  } finally {
    gate.resolve();
    await f.controller.dispose();
  }
});

test("a prepared visual for one tab does not substitute for another tab", async () => {
  const f = fixture();
  await f.controller.start({ browserSessionId: "session" });
  try {
    await f.controller.beforeAction(context("1"));
    await f.controller.beforePointer({
      ...context("2"),
      visualPrepared: true,
      point: { x: 42, y: 64 },
      moveSequence: 1,
    });
    assert.deepEqual(
      f.calls
        .filter(
          (value) =>
            value[0] === "execute" && value[1].args[0].command === "active",
        )
        .map((value) => value[1].target.tabId),
      [1, 2],
    );
  } finally {
    await f.controller.dispose();
  }
});

test("unavailable rendering and slow native setup degrade within 250ms; cancellation remains cancellation", async () => {
  const f = fixture({
    execute: async () => {
      throw Error("page blocks isolated execution");
    },
  });
  assert.deepEqual(await f.controller.beforeAction(context()), {
    degraded: true,
  });
  assert.ok(f.notices.some((value) => value.event === "visual_degraded"));
  assert.equal(f.calls.filter((value) => value[0] === "execute").length, 1);
  const gate = Promise.withResolvers(),
    slow = fixture({ frame: () => gate.promise });
  const started = performance.now();
  assert.deepEqual(await slow.controller.beforeAction(context()), {
    degraded: true,
  });
  assert.ok(performance.now() - started < 500);
  gate.resolve({ documentId: "late-document" });
  await delay(5);
  assert.equal(
    slow.calls.filter((value) => value[0] === "execute").length,
    0,
    "a late native reply cannot start a fresh visual operation",
  );
  const abort = new AbortController(),
    cancelGate = Promise.withResolvers(),
    cancel = fixture({ frame: () => cancelGate.promise });
  const reason = Object.assign(Error("cancel"), { code: "cancelled" }),
    pending = cancel.controller.beforeAction(
      context("1", { signal: abort.signal }),
    );
  await until(() => cancel.calls.some((value) => value[0] === "getFrame"));
  abort.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  cancelGate.resolve({ documentId: "cancelled-document" });
  await delay(5);
  assert.equal(
    cancel.calls.filter((value) => value[0] === "execute").length,
    0,
  );
  await f.controller.dispose();
  await slow.controller.dispose();
  await cancel.controller.dispose();
});

test("result favicon records use actual documents, survive control release and clear on user activation without retaining input", async () => {
  let doc = "document-before";
  const f = fixture({ frame: async () => ({ documentId: doc }) });
  await f.controller.start({ browserSessionId: "session" });
  await f.controller.beforeAction(context());
  await f.controller.markDeliverable(context());
  await f.controller.releaseTab(context());
  assert.equal(f.saved.at(-1).length, 1);
  assert.equal(f.saved.at(-1)[0].documentId, doc);
  assert.doesNotMatch(JSON.stringify(f.saved), /point|password|https?:/);
  assert.equal(
    f.calls.filter((value) => value[0] === "execute").at(-1)[1].args[0].command,
    "result",
  );
  doc = "document-after";
  f.chrome.tabs.onUpdated.emit(1, { status: "complete" });
  await until(() => f.saved.at(-1)?.[0]?.documentId === doc);
  assert.equal(
    f.calls.filter((value) => value[0] === "execute").at(-1)[1].target
      .documentIds[0],
    doc,
  );
  f.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 10 });
  await until(() => f.saved.at(-1)?.length === 0);
  assert.equal(
    f.calls.filter((value) => value[0] === "execute").at(-1)[1].args[0].command,
    "clear",
  );
  const wrong = fixture();
  await wrong.controller.start({
    browserSessionId: "new-browser-session",
    markers: [
      {
        tabId: 1,
        browserSessionId: "session",
        documentId: "old-doc",
        target: context().target,
        leaseId: "old-lease",
        runId: "old-run",
        operationId: "old-operation",
      },
    ],
  });
  assert.deepEqual(wrong.calls, []);
  await wrong.controller.dispose();
  const mismatched = fixture();
  await mismatched.controller.start({
    browserSessionId: "session",
    markers: [
      {
        tabId: 1,
        browserSessionId: "session",
        documentId: "old-doc",
        target: { ...context().target, browserSessionId: "other-session" },
        leaseId: "old-lease",
        runId: "old-run",
        operationId: "old-operation",
      },
    ],
  });
  assert.deepEqual(mismatched.calls, []);
  await mismatched.controller.dispose();
  await f.controller.dispose();
});

function pageFixture({
  reduced = true,
  iconBytes = 0,
  pausedFrames = false,
  visibility = "visible",
  wallClock,
} = {}) {
  const calls = { fetch: [], cancel: 0, bitmap: 0 };
  const frames = new Map();
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.attributes = {};
      this.children = [];
      this.style = {};
    }
    setAttribute(key, value) {
      this.attributes[key] = value;
    }
    hasAttribute(key) {
      return Object.hasOwn(this.attributes, key);
    }
    append(node) {
      node.parent = this;
      this.children.push(node);
    }
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter(
          (node) => node !== this,
        );
    }
    getContext() {
      return {
        drawImage() {},
        beginPath() {},
        arc() {},
        fill() {},
        stroke() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
      };
    }
    toDataURL() {
      return "data:image/png;base64,fixture";
    }
  }
  const root = new Node("html"),
    head = new Node("head"),
    original = new Node("link");
  original.rel = "icon";
  original.href = "https://public-icon.test/favicon.png";
  head.append(original);
  const document = {
    visibilityState: visibility,
    head,
    documentElement: root,
    createElement: (tag) => new Node(tag),
    querySelectorAll: () =>
      head.children.filter((node) => node.tagName === "link"),
  };
  let tick = 0,
    nextFrame = 0;
  const ClockDate = wallClock
    ? class extends Date {
        static now() {
          return wallClock();
        }
      }
    : Date;
  const sandbox = vm.createContext({
    document,
    Blob,
    Uint8Array,
    AbortController,
    Date: ClockDate,
    Symbol,
    Set,
    Map,
    Promise,
    Math,
    performance: { now: () => tick },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: (fn) => {
      const id = ++nextFrame;
      frames.set(id, fn);
      if (!pausedFrames)
        setTimeout(() => {
          if (!frames.delete(id)) return;
          tick += 16;
          fn(tick);
        }, 0);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    fetch: async (value, options) => {
      calls.fetch.push({ value, options });
      let sent = false;
      return {
        ok: true,
        headers: { get: () => "image/png" },
        body: {
          getReader: () => ({
            read: async () =>
              sent
                ? { done: true }
                : ((sent = true),
                  { done: false, value: new Uint8Array(iconBytes) }),
            cancel: async () => {
              calls.cancel++;
            },
            releaseLock() {},
          }),
        },
      };
    },
    createImageBitmap: async () => {
      calls.bitmap++;
      return { width: 32, height: 32, close() {} };
    },
  });
  const execute = (input) =>
    vm.runInContext(
      `(${visualPage.toString()})(${JSON.stringify(input)})`,
      sandbox,
    );
  return { execute, document, root, head, original, calls, frames, sandbox };
}

test("finished visual identities expire without reviving a delayed old move", async () => {
  let now = 100000;
  const f = pageFixture({ visibility: "hidden", wallClock: () => now });
  const old = {
    token: "old-lease",
    deadline: now + 5000,
    command: "move",
    point: { x: 12, y: 8 },
    moveSequence: 1,
  };
  assert.equal((await f.execute(old)).ok, true);
  await f.execute({
    token: old.token,
    command: "release",
    deadline: now + 250,
  });
  assert.equal(f.root.children.length, 0);
  now += 300;
  await f.execute({
    token: "another",
    command: "release",
    deadline: now + 250,
  });
  assert.equal((await f.execute(old)).ok, false);
  assert.equal(f.root.children.length, 0);
  for (let i = 0; i < 1000; i++) {
    now += 300;
    await f.execute({
      token: `finished-${i}`,
      command: "release",
      deadline: now + 250,
    });
  }
  const retained = vm.runInContext(
    'globalThis[Symbol.for("nexum.browser.visual.v1")].closed.size',
    f.sandbox,
  );
  assert.ok(retained <= 1, `retained ${retained} finished visual identities`);
  assert.equal((await f.execute(old)).ok, false);
  assert.equal(f.root.children.length, 0);
});

test("visual identities saved by the previous worker remain closed through the late-action window", async () => {
  let now = 100000;
  const f = pageFixture({ visibility: "hidden", wallClock: () => now });
  vm.runInContext(
    'globalThis[Symbol.for("nexum.browser.visual.v1")]={current:null,closed:new Set(["legacy-lease"])}',
    f.sandbox,
  );
  const old = {
    token: "legacy-lease",
    deadline: now + 200,
    command: "move",
    point: { x: 12, y: 8 },
    moveSequence: 1,
  };
  await f.execute({
    token: "new-lease",
    command: "release",
    deadline: now + 250,
  });
  assert.equal((await f.execute(old)).ok, false);
  now += 300;
  await f.execute({ token: "next", command: "release", deadline: now + 250 });
  const retained = vm.runInContext(
    'globalThis[Symbol.for("nexum.browser.visual.v1")].closed.size',
    f.sandbox,
  );
  assert.ok(retained <= 1, `retained ${retained} expired visual identities`);
  assert.equal((await f.execute(old)).ok, false);
  assert.equal(f.root.children.length, 0);
});

test("a hidden native page completes its cursor move without scheduling paused paint callbacks", async () => {
  const f = pageFixture({
    reduced: false,
    pausedFrames: true,
    visibility: "hidden",
  });
  const moved = await Promise.race([
    f.execute({
      token: "hidden-native-move",
      deadline: Date.now() + 50,
      command: "move",
      point: { x: 180, y: 140 },
      moveSequence: 1,
    }),
    delay(500).then(() => "pending"),
  ]);
  assert.equal(moved.arrived, true);
  assert.equal(f.frames.size, 0);
  assert.equal(
    f.root.children[0].style.transform,
    "translate3d(180px,140px,0)",
  );
});

test("a visible native page whose paint callbacks stop settles its actual move Promise and cancels late rendering", async () => {
  const f = pageFixture({ reduced: false, pausedFrames: true });
  const moving = f.execute({
    token: "paused-native-move",
    deadline: Date.now() + 50,
    command: "move",
    point: { x: 180, y: 140 },
    moveSequence: 1,
  });
  const late = [...f.frames.values()][0];
  const result = await Promise.race([moving, delay(500).then(() => "pending")]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    reason: "VISUAL_TIMEOUT",
  });
  assert.equal(f.frames.size, 0);
  const layer = f.root.children[0],
    before = layer.style.transform;
  late();
  assert.equal(layer.style.transform, before);
  assert.equal(f.frames.size, 0);
});

test("serialized native page visuals draw a non-interactive cursor, preserve original icons and reject released/out-of-order moves", async () => {
  const f = pageFixture({ reduced: false, iconBytes: 128 }),
    base = { token: "lease:epoch", deadline: Date.now() + 5000 };
  assert.deepEqual(
    JSON.parse(JSON.stringify(await f.execute({ ...base, command: "active" }))),
    { ok: true },
  );
  assert.equal(f.original.href, "https://public-icon.test/favicon.png");
  assert.equal(f.calls.fetch[0].options.credentials, "omit");
  assert.equal(f.calls.fetch[0].options.redirect, "error");
  assert.equal(f.calls.fetch[0].options.referrerPolicy, "no-referrer");
  const moved = await f.execute({
    ...base,
    command: "move",
    point: { x: 140, y: 80 },
    moveSequence: 8,
  });
  assert.equal(moved.arrived, true);
  const layer = f.root.children.find(
    (node) => node.attributes["data-nexum-visual-layer"],
  );
  assert.equal(layer.attributes["aria-hidden"], "true");
  assert.equal(layer.style.pointerEvents, "none");
  assert.equal(layer.style.transform, "translate3d(140px,80px,0)");
  const stale = await f.execute({
    ...base,
    command: "move",
    point: { x: 1, y: 1 },
    moveSequence: 7,
  });
  assert.equal(stale.stale, true);
  assert.equal(layer.style.transform, "translate3d(140px,80px,0)");
  assert.match(visualStyles, /@media print/);
  assert.match(visualStyles, /prefers-reduced-motion/);
  assert.match(visualStyles, /pointer-events:none!important/);
  await f.execute({ ...base, command: "result" });
  assert.equal(f.root.children.length, 0);
  assert.equal(f.head.children.length, 2);
  await f.execute({ ...base, command: "clear" });
  assert.deepEqual(f.head.children, [f.original]);
  await f.execute({ ...base, command: "release" });
  assert.equal(
    (
      await f.execute({
        ...base,
        command: "move",
        point: { x: 9, y: 9 },
        moveSequence: 9,
      })
    ).ok,
    false,
  );
  assert.equal(f.root.children.length, 0);
});

test("favicon byte reads enforce 64KiB before decoding, and late deadlines never create a new overlay", async () => {
  const f = pageFixture({ iconBytes: 65537 }),
    base = { token: "budget", deadline: Date.now() + 5000 };
  assert.equal((await f.execute({ ...base, command: "active" })).ok, true);
  assert.equal(f.calls.bitmap, 0);
  assert.equal(f.calls.cancel, 1);
  assert.equal(f.original.href, "https://public-icon.test/favicon.png");
  const late = pageFixture();
  assert.equal(
    (
      await late.execute({
        token: "late",
        deadline: Date.now() - 1,
        command: "move",
        point: { x: 1, y: 1 },
        moveSequence: 1,
      })
    ).ok,
    false,
  );
  assert.equal(late.root.children.length, 0);
});

test("dispose/release during native preparation cannot create late active UI or leave its own late group", async () => {
  for (const mode of ["dispose", "release"]) {
    const gate = Promise.withResolvers(),
      f = fixture({ frame: () => gate.promise });
    const input = context();
    const pending = f.controller.beforeAction(input);
    await until(() => f.calls.some((value) => value[0] === "getFrame"));
    let closed = false;
    const cleanup = (
      mode === "dispose"
        ? f.controller.dispose()
        : f.controller.releaseTab(input)
    ).then(() => {
      closed = true;
    });
    await delay(5);
    assert.equal(
      closed,
      false,
      "native preparation must actually settle before cleanup confirms",
    );
    gate.resolve({ documentId: "late-document" });
    await cleanup;
    assert.deepEqual(await pending, { degraded: true });
    assert.equal(f.calls.filter((value) => value[0] === "execute").length, 0);
    assert.equal(
      f.calls.filter((value) => value[0] === "tabs.group").length,
      0,
    );
    await f.controller.dispose();
  }
  for (const mode of ["dispose", "release"]) {
    const f = fixture(),
      nativeGroup = f.chrome.tabs.group,
      gate = Promise.withResolvers(),
      input = context();
    f.chrome.tabs.group = async (args) => {
      const result = await nativeGroup(args);
      await gate.promise;
      return result;
    };
    const pending = f.controller.beforeAction(input);
    await until(() => f.calls.some((value) => value[0] === "tabs.group"));
    const activeBeforeCleanup = f.calls.filter(
      (value) =>
        value[0] === "execute" && value[1].args[0].command === "active",
    ).length;
    assert.equal(activeBeforeCleanup, 1);
    let closed = false;
    const cleanup = (
      mode === "dispose"
        ? f.controller.dispose()
        : f.controller.releaseTab(input)
    ).then(() => {
      closed = true;
    });
    await delay(5);
    assert.equal(closed, false);
    gate.resolve();
    await cleanup;
    assert.deepEqual(await pending, { degraded: true });
    assert.equal(f.tabs.get(1).groupId, -1);
    assert.equal(
      f.calls.filter(
        (value) =>
          value[0] === "execute" && value[1].args[0].command === "active",
      ).length,
      activeBeforeCleanup,
    );
    assert.equal(
      f.calls.filter(
        (value) =>
          value[0] === "execute" && value[1].args[0].command === "release",
      ).length,
      1,
    );
    await f.controller.dispose();
  }
});

test("a 250ms degraded pointer result does not pretend its still-pending native execution has closed", async () => {
  const gate = Promise.withResolvers(),
    f = fixture({
      execute: async (args) =>
        args.args[0].command === "move"
          ? gate.promise
          : [{ result: { ok: true } }],
    });
  const input = { ...context(), point: { x: 5, y: 5 }, moveSequence: 1 };
  assert.deepEqual(await f.controller.beforePointer(input), { degraded: true });
  let closed = false;
  const release = f.controller.releaseTab(input).then(() => {
    closed = true;
  });
  await delay(5);
  assert.equal(closed, false);
  gate.resolve([{ result: { ok: true } }]);
  await release;
  assert.equal(closed, true);
  assert.equal(
    f.calls.filter((value) => value[0] === "execute").at(-1)[1].args[0].command,
    "release",
  );
  await f.controller.dispose();
});

test("user activation clears a live-run result permanently and later release cannot repaint that cleared result", async () => {
  const f = fixture();
  await f.controller.start({ browserSessionId: "session" });
  await f.controller.beforeAction(context());
  await f.controller.markDeliverable(context());
  f.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 10 });
  await until(() => f.saved.at(-1)?.length === 0);
  const before = f.calls.filter((value) => value[0] === "execute").length;
  await f.controller.releaseTab(context());
  const after = f.calls.filter((value) => value[0] === "execute").slice(before);
  assert.equal(after.at(-1)[1].args[0].command, "release");
  assert.equal(
    after.some((value) => value[1].args[0].command === "result"),
    false,
  );
  assert.equal(f.tabs.get(1).groupId, -1);
  assert.equal(f.saved.at(-1).length, 0);
  await f.controller.dispose();
});
