import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createBrowserRouter } from "../browser-extension/router.js";

const binding = {
  bootId: "boot",
  browserId: "browser",
  browserSessionId: "session",
  connectionId: "connection",
  generation: 1,
};
function fixture(t, options = {}) {
  const scripts = [],
    nativeCalls = [],
    attached = new Set(),
    journals = [];
  let nativeItems = [],
    writes = 0,
    failDrop = false;
  class NativeClipboardItem {
    constructor(formats, { presentationStyle } = {}) {
      this.formats = formats;
      this.types = Object.keys(formats);
      this.presentationStyle = presentationStyle ?? "unspecified";
    }
    async getType(type) {
      return this.formats[type];
    }
  }
  if (options.emptyNativeItem) nativeItems = [new NativeClipboardItem({})];
  const realm = vm.createContext({
    document: {},
    Blob,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    ClipboardItem: NativeClipboardItem,
    navigator: {
      clipboard: {
        async read() {
          return nativeItems;
        },
        async write(items) {
          writes++;
          if (options.rejectWrite)
            throw new DOMException(
              "User denied clipboard access",
              "NotAllowedError",
            );
          nativeItems = items;
        },
      },
    },
  });
  const chrome = {
    debugger: {
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
        nativeCalls.push({ source, method, params });
        return {};
      },
    },
    tabs: {
      async get() {
        return { id: 1, active: true };
      },
      async query() {
        return [{ id: 1, active: true }];
      },
      async update() {
        return { id: 1, active: true };
      },
    },
    scripting: {
      async executeScript(input) {
        const request = JSON.parse(JSON.stringify(input.args[0]));
        scripts.push(request);
        if (failDrop && request.command === "drop")
          throw new Error("Native scripting cleanup temporarily unavailable");
        const native = vm.runInContext(`(${input.func.toString()})`, realm);
        const result = await native(request);
        options.afterScript?.(request);
        return [{ frameId: 0, result: JSON.parse(JSON.stringify(result)) }];
      },
    },
  };
  const router = createBrowserRouter(chrome, {
    persistOwned: async (records) => journals.push(structuredClone(records)),
  });
  router.start();
  router.bind(binding);
  const target = { ...binding, tabId: "1" };
  router.openLease({
    ...binding,
    leaseId: "lease",
    runId: "run",
    operationId: "open",
    target,
  });
  t.after(() => {
    failDrop = false;
    return router.dispose();
  });
  const call = (method, fields = {}, signal) =>
    router.dispatch(
      {
        ...binding,
        actionId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        runId: "run",
        leaseId: "lease",
        method,
        target,
        args: { target, ...fields },
        budgetMs: 30000,
      },
      signal,
    );
  return {
    router,
    nativeCalls,
    chrome,
    call,
    scripts,
    journals,
    realm,
    setFailDrop: (value) => {
      failDrop = value;
    },
    writes: () => writes,
    items: () => nativeItems,
    stages: () =>
      vm.runInContext(
        'globalThis[Symbol.for("nexum.browser.clipboard.v1")]?.entries.size ?? 0',
        realm,
      ),
  };
}

test("multi-format native ClipboardItem round-trips text and exact byte subviews with bounded native chunks and one commit", async (t) => {
  const f = fixture(t),
    source = new Uint8Array(200005);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;
  const bytes = source.subarray(2, source.length - 3);
  await f.call("clipboard.write", {
    items: [
      {
        presentationStyle: "inline",
        entries: [
          { mimeType: "text/plain", text: "你好🌏" },
          { mimeType: "text/html", text: "<b>你好🌏</b>" },
          { mimeType: "image/png", data: bytes },
        ],
      },
    ],
  });
  assert.equal(f.writes(), 1);
  assert.equal(f.stages(), 0);
  assert.deepEqual(
    new Uint8Array(
      await f
        .items()[0]
        .getType("image/png")
        .then((blob) => blob.arrayBuffer()),
    ),
    bytes,
  );
  const values = await f.call("clipboard.read");
  assert.equal(values[0].entries[0].text, "你好🌏");
  assert.equal(values[0].entries[1].text, "<b>你好🌏</b>");
  assert.deepEqual(values[0].entries[2].data, bytes);
  assert.equal(values[0].presentationStyle, "inline");
  assert.equal(f.stages(), 0);
  assert.ok(
    f.scripts.filter((request) => request.command === "append").length > 10,
  );
  assert.ok(
    f.scripts
      .filter((request) => request.command === "append")
      .every(
        (request) =>
          Array.isArray(request.bytes) && request.bytes.length <= 16384,
      ),
  );
  assert.equal(f.journals.at(-1).length, 0);
});

test("invalid batches and cancelled staging never mutate the native clipboard; denied native writes preserve accurate errors and clear stages", async (t) => {
  const stop = new AbortController();
  const f = fixture(t, {
    afterScript(request) {
      if (request.command === "append") stop.abort();
    },
  });
  await assert.rejects(
    f.call("clipboard.write", {
      items: [
        {
          entries: [
            { mimeType: "text/plain", text: "valid" },
            { mimeType: "image/png", data: {} },
          ],
        },
      ],
    }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(f.scripts.length, 0);
  assert.equal(f.writes(), 0);
  await assert.rejects(
    f.call(
      "clipboard.write",
      {
        items: [
          { entries: [{ mimeType: "image/png", data: new Uint8Array(50000) }] },
        ],
      },
      stop.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(f.writes(), 0);
  assert.equal(f.stages(), 0);
  const denied = fixture(t, { rejectWrite: true });
  await assert.rejects(
    denied.call("clipboard.write", {
      items: [{ entries: [{ mimeType: "text/plain", text: "denied" }] }],
    }),
    { code: "PERMISSION_DENIED" },
  );
  assert.equal(denied.writes(), 1);
  assert.equal(denied.stages(), 0);
});

test("worker restart recovers only inert clipboard staging and closes it without replaying clipboard writes or requiring debugger attachment", async (t) => {
  const f = fixture(t);
  f.setFailDrop(true);
  await assert.rejects(
    f.call("clipboard.write", {
      items: [
        { entries: [{ mimeType: "text/plain", text: "one committed value" }] },
      ],
    }),
    /cleanup temporarily unavailable/,
  );
  assert.equal(f.writes(), 1);
  assert.equal(f.stages(), 1);
  const records = f.journals.at(-1);
  assert.equal(records[0].attachmentIntent, false);
  assert.equal(records[0].clipboardStages.length, 1);
  const retry = createBrowserRouter(f.chrome);
  retry.start();
  f.setFailDrop(false);
  const receipts = await retry.recoverOwnedControls(records);
  assert.equal(receipts[0].receipt.closed, true);
  assert.equal(f.stages(), 0);
  assert.equal(f.writes(), 1);
  await retry.dispose();
});

test("AX rich paste writes actual HTML MIME then dispatches the native paste chord, and cannot pretend unrendered Markdown is HTML", async (t) => {
  const f = fixture(t);
  await f.call("ax.paste", {
    elementIndex: null,
    text: "<strong>actual rich content</strong>",
    options: { format: "html" },
  });
  assert.equal(f.writes(), 1);
  assert.equal(
    await f
      .items()[0]
      .getType("text/html")
      .then((blob) => blob.text()),
    "<strong>actual rich content</strong>",
  );
  assert.equal(
    f.nativeCalls.some(({ method, params }) => method === "Input.insertText"),
    false,
  );
  assert.equal(
    f.nativeCalls.some(
      ({ method, params }) =>
        method === "Input.dispatchKeyEvent" &&
        params.type === "keyDown" &&
        params.key === "v" &&
        params.commands?.[0] === "Paste" &&
        (params.modifiers === 2 || params.modifiers === 4),
    ),
    true,
  );
  await assert.rejects(
    f.call("ax.paste", {
      elementIndex: null,
      text: "**unrendered**",
      options: { format: "md" },
    }),
    { code: "CAPABILITY_NOT_ALLOWED" },
  );
  assert.equal(f.writes(), 1);
});

test("native clipboard items with no exposed MIME formats are canonical empty clipboard data", async (t) => {
  const f = fixture(t, { emptyNativeItem: true });
  assert.deepEqual(await f.call("clipboard.read"), []);
  assert.equal(f.stages(), 0);
  assert.equal(f.writes(), 0);
});
