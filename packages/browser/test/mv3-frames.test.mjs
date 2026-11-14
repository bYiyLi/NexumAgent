import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { createBrowserRouter } from "../browser-extension/router.js";

function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => {
      for (const fn of listeners) fn(...args);
    },
  };
}
const binding = {
  bootId: "boot",
  browserId: "browser",
  browserSessionId: "session",
  connectionId: "connection",
  generation: 1,
};
function fixture(t) {
  const calls = [],
    objects = new Map(),
    onEvent = event(),
    attached = new Set();
  let objectSequence = 0,
    documentSequence = 1,
    frameExists = true,
    parentBlocked = false,
    scrollAncestors = false,
    scrolled = false;
  const backendNodes = new Map();
  class Element {
    constructor(tagName, doc, contents = "") {
      this.tagName = tagName;
      this.ownerDocument = doc;
      this.isConnected = true;
      this.textContent = this.innerText = contents;
      this.children = [];
      this.parentElement = null;
      this.disabled = false;
    }
    getAttribute() {
      return null;
    }
    hasAttribute() {
      return false;
    }
    contains(node) {
      return this === node;
    }
    scrollIntoView() {
      if (scrollAncestors && this.ownerDocument.nested) scrolled = true;
    }
    focus() {}
    scrollBy({ left, top }) {
      this.scrollLeft = (this.scrollLeft ?? 0) + left;
      this.scrollTop = (this.scrollTop ?? 0) + top;
    }
    getBoundingClientRect() {
      return this.tagName === "IFRAME"
        ? {
            x:
              100 -
              (scrolled ? (this.ownerDocument === parentDoc ? 30 : 10) : 0),
            y:
              50 - (scrolled ? (this.ownerDocument === parentDoc ? 20 : 8) : 0),
            width: 300,
            height: 200,
          }
        : { x: 10, y: 20, width: 80, height: 30 };
    }
  }
  const parentDoc = { readyState: "complete", title: "Parent" },
    owner = new Element("IFRAME", parentDoc);
  Object.assign(owner, {
    nativeFrameId: "actual-child-frame",
    offsetWidth: 300,
    offsetHeight: 200,
    clientLeft: 2,
    clientTop: 2,
  });
  parentDoc.querySelectorAll = (selector) =>
    selector === "iframe" && frameExists ? [owner] : [];
  parentDoc.elementFromPoint = () => (parentBlocked ? {} : owner);
  const realm = (document, url) => {
    document.getElementById = () => null;
    return vm.createContext({
      document,
      location: { href: url },
      crypto,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      Element,
      scrollBy({ left, top }) {
        document.scrollX = (document.scrollX ?? 0) + left;
        document.scrollY = (document.scrollY ?? 0) + top;
      },
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        transform: "none",
        paddingLeft: "0",
        paddingTop: "0",
      }),
    });
  };
  const parent = realm(parentDoc, "https://parent.example/"),
    worlds = new Map([[10, parent]]);
  worlds.set(101, realm(parentDoc, "https://parent.example/"));
  const replaceChild = () => {
    const doc = { readyState: "complete", title: "Cross-origin child" },
      button = new Element("BUTTON", doc, `Save version ${documentSequence++}`);
    const nestedOwner = new Element("IFRAME", doc);
    Object.assign(nestedOwner, {
      nativeFrameId: "same-renderer-nested-frame",
      offsetWidth: 300,
      offsetHeight: 200,
      clientLeft: 2,
      clientTop: 2,
    });
    doc.querySelectorAll = (selector) =>
      ["button", "*"].includes(selector)
        ? [button]
        : selector === "#nested"
          ? [nestedOwner]
          : [];
    doc.body = { innerText: button.innerText };
    doc.elementFromPoint = (x, y) =>
      x >= 100 && y >= 50 ? nestedOwner : button;
    worlds.set(20, realm(doc, "https://different-origin.example/frame"));
    worlds.set(201, realm(doc, "https://different-origin.example/frame"));
    const nestedDoc = {
        readyState: "complete",
        title: "Same-renderer nested frame",
        nested: true,
      },
      nestedButton = new Element("BUTTON", nestedDoc, "Nested same renderer");
    nestedDoc.querySelectorAll = (selector) =>
      ["button", "*"].includes(selector) ? [nestedButton] : [];
    nestedDoc.elementFromPoint = () => nestedButton;
    worlds.set(30, realm(nestedDoc, "https://different-origin.example/nested"));
    nestedDoc.body = { innerText: nestedButton.innerText };
    worlds.set(
      301,
      realm(nestedDoc, "https://different-origin.example/nested"),
    );
  };
  replaceChild();
  const chrome = {
    runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
    tabs: {
      async query() {
        return [{ id: 1 }];
      },
      async get() {
        return { id: 1 };
      },
      async update() {
        return { id: 1 };
      },
    },
    debugger: {
      onEvent,
      async attach({ tabId }) {
        attached.add(tabId);
      },
      async detach({ tabId }) {
        attached.delete(tabId);
      },
      async getTargets() {
        return [...attached].map((tabId) => ({ tabId, attached: true }));
      },
      async sendCommand(source, method, params) {
        calls.push({ source, method, params });
        const remote = (value, world) => {
          if (value !== null && ["object", "function"].includes(typeof value)) {
            const objectId = `actual-object-${++objectSequence}`;
            objects.set(objectId, { value, world });
            return {
              objectId,
              type: typeof value,
              ...(value instanceof Element
                ? { subtype: "node" }
                : Array.isArray(value)
                  ? { subtype: "array" }
                  : {}),
            };
          }
          return { type: typeof value, value };
        };
        if (method === "Runtime.enable") {
          for (const [id, frameId] of source.sessionId
            ? [
                [201, "actual-child-frame"],
                [301, "same-renderer-nested-frame"],
              ]
            : [[101, "main-frame"]])
            onEvent.emit(source, "Runtime.executionContextCreated", {
              context: {
                id,
                origin: "https://page.example",
                auxData: { frameId, isDefault: true },
              },
            });
          if (!source.sessionId)
            onEvent.emit(source, "Runtime.executionContextCreated", {
              context: {
                id: 10,
                origin: `chrome-extension://${chrome.runtime.id}`,
                auxData: { frameId: "main-frame", isDefault: false },
              },
            });
          return {};
        }
        if (method === "Runtime.evaluate") {
          const world = worlds.get(params.contextId);
          try {
            return {
              result: remote(
                await vm.runInContext(params.expression, world),
                world,
              ),
            };
          } catch {
            return { exceptionDetails: { text: "Page evaluation rejected" } };
          }
        }
        if (method === "Runtime.getProperties") {
          const object = objects.get(params.objectId);
          return {
            result: Object.getOwnPropertyNames(object.value).map((name) => ({
              name,
              value: remote(object.value[name], object.world),
            })),
          };
        }
        if (method === "DOM.resolveNode") {
          const value = backendNodes.get(params.backendNodeId);
          assert.ok(
            value,
            "native backend identity must already have been observed",
          );
          return {
            object: remote(value, worlds.get(params.executionContextId)),
          };
        }
        if (method === "Target.setAutoAttach" && !source.sessionId)
          onEvent.emit(source, "Target.attachedToTarget", {
            sessionId: "actual-child-session",
            targetInfo: { targetId: "actual-child-frame", type: "iframe" },
          });
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: { id: "main-frame" },
              childFrames: [{ frame: { id: "actual-child-frame" } }],
            },
          };
        if (method === "Page.createIsolatedWorld") {
          if (params.frameId === "same-renderer-nested-frame") {
            assert.equal(source.sessionId, "actual-child-session");
            return { executionContextId: 30 };
          }
          if (params.frameId === "actual-child-frame") {
            assert.equal(source.sessionId, "actual-child-session");
            return { executionContextId: 20 };
          }
          assert.equal(source.sessionId, undefined);
          return { executionContextId: 10 };
        }
        if (method === "Runtime.callFunctionOn") {
          const object = objects.get(params.objectId),
            world = object?.world ?? worlds.get(params.executionContextId);
          assert.ok(world, "a real selected frame world is required");
          if (
            [
              worlds.get(20),
              worlds.get(30),
              worlds.get(201),
              worlds.get(301),
            ].includes(world)
          )
            assert.equal(source.sessionId, "actual-child-session");
          try {
            const fn = vm.runInContext(
                `(${params.functionDeclaration})`,
                world,
              ),
              value = await fn.apply(
                object?.value,
                (params.arguments ?? []).map((argument) =>
                  argument.objectId
                    ? objects.get(argument.objectId)?.value
                    : argument.value,
                ),
              );
            if (!params.returnByValue) return { result: remote(value, world) };
            return { result: { value: JSON.parse(JSON.stringify(value)) } };
          } catch {
            return {
              exceptionDetails: { text: "Native frame evaluation failed" },
            };
          }
        }
        if (method === "DOM.describeNode") {
          const value = objects.get(params.objectId)?.value;
          assert.ok(value instanceof Element);
          let backendDOMNodeId = [...backendNodes].find(
            ([, node]) => node === value,
          )?.[0];
          if (!backendDOMNodeId) {
            backendDOMNodeId = backendNodes.size + 1;
            backendNodes.set(backendDOMNodeId, value);
          }
          return {
            node: {
              frameId: value.nativeFrameId,
              nodeName: value.tagName,
              backendNodeId: backendDOMNodeId,
            },
          };
        }
        if (method === "Runtime.releaseObject") {
          objects.delete(params.objectId);
          return {};
        }
        return {};
      },
    },
    scripting: {
      async executeScript({ func, args, target }) {
        assert.equal(target.tabId, 1);
        const result = await vm.runInContext(
          `(${func.toString()})`,
          parent,
        )(...args);
        return [{ result: JSON.parse(JSON.stringify(result)) }];
      },
    },
  };
  const router = createBrowserRouter(chrome);
  router.start();
  router.bind(binding);
  const target = { ...binding, tabId: "1" };
  router.openLease({
    ...binding,
    target,
    leaseId: "lease",
    runId: "run",
    operationId: "open",
  });
  t.after(() => router.dispose());
  const call = (method, args = {}) =>
    router.dispatch({
      ...binding,
      target,
      leaseId: "lease",
      runId: "run",
      actionId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      method,
      args: { target, ...args },
      budgetMs: 1000,
    });
  return {
    router,
    call,
    calls,
    target,
    objects,
    replaceChild,
    removeFrame: () => {
      frameExists = false;
    },
    blockParent: () => {
      parentBlocked = true;
    },
    scrollAncestors: () => {
      scrollAncestors = true;
    },
    emitNative: (...args) => onEvent.emit(...args),
    scrollPosition: () => ({
      x: parentDoc.scrollX ?? 0,
      y: parentDoc.scrollY ?? 0,
      elementX: owner.scrollLeft ?? 0,
      elementY: owner.scrollTop ?? 0,
    }),
  };
}

test("cross-origin Frame resolves actual native owner/frame/session for every query and maps native pointer coordinates through its ancestors", async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    (await f.call("tab.frame", { selector: "iframe" })).framePath,
    ["iframe"],
  );
  const locator = {
    target: f.target,
    framePath: ["iframe"],
    query: { kind: "selector", selector: "button" },
  };
  assert.equal(await f.call("locator.count", { locator }), 1);
  assert.equal(
    await f.call("locator.textContent", { locator }),
    "Save version 1",
  );
  await f.call("locator.click", { locator });
  const pressed = f.calls.find(
    ({ method, params }) =>
      method === "Input.dispatchMouseEvent" && params.type === "mousePressed",
  );
  assert.equal(pressed.source.sessionId, undefined);
  assert.equal(pressed.params.x, 152);
  assert.equal(pressed.params.y, 87);
  assert.equal(f.objects.size, 0);
  f.removeFrame();
  await assert.rejects(f.call("locator.count", { locator }), {
    code: "INVALID_TARGET",
  });
  assert.equal(f.objects.size, 0);
});

test("child-document replacement preserves query locators while old fixed refs cannot alias a new document; parent overlays prevent native input", async (t) => {
  const f = fixture(t),
    locator = {
      target: f.target,
      framePath: ["iframe"],
      query: { kind: "selector", selector: "button" },
    };
  const old = (await f.call("locator.all", { locator }))[0];
  assert.equal(
    await f.call("locator.textContent", { locator: old }),
    "Save version 1",
  );
  f.replaceChild();
  assert.equal(
    await f.call("locator.textContent", { locator }),
    "Save version 2",
  );
  const current = (await f.call("locator.all", { locator }))[0];
  assert.notEqual(old.query.ref, current.query.ref);
  await assert.rejects(f.call("locator.textContent", { locator: old }), {
    code: "STALE_REF",
  });
  f.blockParent();
  await assert.rejects(f.call("locator.click", { locator }), {
    code: "INVALID_TARGET",
  });
  assert.equal(
    f.calls.some(({ method }) => method === "Input.dispatchMouseEvent"),
    false,
  );
  assert.equal(f.objects.size, 0);
});

test("a same-renderer descendant inside an OOPIF uses its nearest actually attached ancestor session without requiring a fictitious child target", async (t) => {
  const f = fixture(t),
    locator = {
      target: f.target,
      framePath: ["iframe", "#nested"],
      query: { kind: "selector", selector: "button" },
    };
  assert.equal(
    await f.call("locator.textContent", { locator }),
    "Nested same renderer",
  );
  await f.call("locator.click", { locator });
  const nestedWorld = f.calls.filter(
    ({ method, params }) =>
      method === "Page.createIsolatedWorld" &&
      params.frameId === "same-renderer-nested-frame",
  );
  assert.ok(nestedWorld.length >= 2);
  assert.ok(
    nestedWorld.every(
      ({ source }) => source.sessionId === "actual-child-session",
    ),
  );
  assert.equal(f.objects.size, 0);
});

test("nested native input remaps every owner after descendant scrollIntoView moves its ancestor chain", async (t) => {
  const f = fixture(t);
  f.scrollAncestors();
  const locator = {
    target: f.target,
    framePath: ["iframe", "#nested"],
    query: { kind: "selector", selector: "button" },
  };
  await f.call("locator.click", { locator });
  const pressed = f.calls.find(
    ({ method, params }) =>
      method === "Input.dispatchMouseEvent" && params.type === "mousePressed",
  );
  assert.equal(pressed.params.x, 214);
  assert.equal(pressed.params.y, 111);
  assert.equal(f.objects.size, 0);
});

test("Locator evaluate and evaluateAll call page functions with exact native DOM objects in MAIN, with no resolver closure or retained handles", async (t) => {
  const f = fixture(t),
    locator = {
      target: f.target,
      framePath: ["iframe", "#nested"],
      query: { kind: "selector", selector: "button" },
    };
  assert.equal(
    await f.call("locator.evaluate", {
      locator,
      expression: "(element,arg)=>element.textContent+arg",
      arg: "!",
    }),
    "Nested same renderer!",
  );
  assert.deepEqual(
    await f.call("locator.evaluateAll", {
      locator,
      expression: "elements=>elements.map(element=>element.tagName)",
    }),
    ["BUTTON"],
  );
  assert.equal(
    await f.call("locator.evaluate", {
      locator,
      expression:
        'element=>globalThis[Symbol.for("nexum.browser.document.v1")]===undefined',
    }),
    true,
  );
  assert.equal(f.objects.size, 0);
  await assert.rejects(
    f.call("locator.evaluate", {
      locator,
      expression: 'element=>{throw new Error("user-page-secret")}',
    }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(f.objects.size, 0);
  const none = { ...locator, query: { kind: "selector", selector: "missing" } };
  await assert.rejects(
    f.call("locator.evaluate", {
      locator: none,
      expression: "element=>element.tagName",
    }),
    { code: "INVALID_TARGET" },
  );
  assert.deepEqual(
    await f.call("locator.evaluateAll", {
      locator: none,
      expression: "elements=>elements.length",
    }),
    0,
  );
  assert.equal(f.objects.size, 0);
  const main = {
    target: f.target,
    framePath: [],
    query: { kind: "selector", selector: "iframe" },
  };
  const fixed = (await f.call("locator.all", { locator: main }))[0];
  assert.equal(
    await f.call("locator.evaluate", {
      locator: fixed,
      expression: "element=>element.tagName",
    }),
    "IFRAME",
  );
  assert.equal(
    await f.call("locator.evaluate", {
      locator: main,
      expression:
        'element=>globalThis[Symbol.for("nexum.browser.document.v1")]===undefined',
    }),
    true,
  );
  assert.equal(f.objects.size, 0);
});

test("tab/frame wait conditions observe the actual scoped document and native networkIdle; native scroll targets the page or exact fixed element", async (t) => {
  const f = fixture(t);
  await f.call("tab.scroll", { options: { x: 20, y: 30 } });
  const main = {
      target: f.target,
      framePath: [],
      query: { kind: "selector", selector: "iframe" },
    },
    ref = (await f.call("locator.all", { locator: main }))[0].query.ref;
  await f.call("dom.scroll", { options: { node_id: ref, x: 5, y: 7 } });
  assert.deepEqual(f.scrollPosition(), {
    x: 20,
    y: 30,
    elementX: 5,
    elementY: 7,
  });
  const input = {
    framePath: ["iframe"],
    condition: {
      kind: "element",
      selector: "button",
      state: "visible",
      timeoutMs: 100,
    },
  };
  const matched = await f.call("frame.waitFor", input);
  assert.equal(matched.matched, true);
  assert.equal(matched.snapshot.url, "https://different-origin.example/frame");
  assert.equal(
    (
      await f.call("frame.waitFor", {
        framePath: ["iframe"],
        condition: { kind: "text", value: "Save version 1" },
      })
    ).matched,
    true,
  );
  await assert.rejects(
    f.call("frame.waitFor", {
      framePath: ["iframe"],
      condition: {
        kind: "selector",
        value: "missing",
        timeoutMs: 5,
        pollingMs: 1,
      },
    }),
    { code: "TIMEOUT" },
  );
  const navigation = f.call("frame.waitFor", {
    framePath: ["iframe"],
    condition: {
      kind: "navigation",
      waitUntil: "load",
      timeoutMs: 100,
      pollingMs: 1,
    },
  });
  await delay(3);
  f.replaceChild();
  assert.equal((await navigation).matched, true);
  const idle = f.call("frame.waitFor", {
    framePath: ["iframe"],
    condition: {
      kind: "state",
      state: "networkidle",
      timeoutMs: 100,
      pollingMs: 1,
    },
  });
  while (
    !f.calls.some((entry) => entry.method === "Page.setLifecycleEventsEnabled")
  )
    await delay(1);
  f.emitNative(
    { tabId: 1, sessionId: "actual-child-session" },
    "Page.lifecycleEvent",
    { frameId: "actual-child-frame", name: "networkIdle" },
  );
  assert.equal((await idle).matched, true);
  assert.equal(f.objects.size, 0);
});
