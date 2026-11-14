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
function fixture(t) {
  const scripts = [],
    fetches = [],
    nativeCalls = [],
    journals = [],
    objectUrls = new Map(),
    attached = new Set();
  let sequence = 0,
    aborted = 0;
  const base = "https://fixture.example/",
    location = { href: `${base}page` };
  const nodes = [
    {
      tagName: "IMG",
      currentSrc: `${base}picture.png`,
      getAttribute: (name) => (name === "src" ? "/picture.png" : null),
    },
    {
      tagName: "LINK",
      rel: "stylesheet",
      getAttribute: (name) => (name === "href" ? "/style.css" : null),
    },
    {
      tagName: "svg",
      outerHTML:
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>',
      getAttribute: () => null,
    },
  ];
  const document = {
    baseURI: location.href,
    title: "Actual native document",
    doctype: {},
    documentElement: {
      outerHTML: "<html><body><h1>Actual native document</h1></body></html>",
      cloneNode() {
        return {
          outerHTML: this.outerHTML,
          querySelectorAll() {
            return [];
          },
        };
      },
    },
    body: { innerText: "Actual native document" },
    querySelectorAll: (selector) =>
      selector === '[data-nexum-visual-icon="v1"]'
        ? nodes.filter((node) => node.ownIcon)
        : nodes,
  };
  class NativeURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:${base}${++sequence}`;
      objectUrls.set(url, blob);
      return url;
    }
    static revokeObjectURL(url) {
      objectUrls.delete(url);
    }
  }
  const image = new Uint8Array(80000);
  for (let i = 0; i < image.length; i++) image[i] = i % 251;
  const realm = vm.createContext({
    document,
    location,
    Blob,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    AbortController,
    URL: NativeURL,
    getComputedStyle: () => ({ getPropertyValue: () => "none" }),
    performance: { getEntriesByType: () => [] },
    async fetch(url, options = {}) {
      fetches.push({ url, options });
      if (url.endsWith("/slow"))
        return new Promise((_, reject) =>
          options.signal.addEventListener(
            "abort",
            () => {
              aborted++;
              reject(new DOMException("cancelled", "AbortError"));
            },
            { once: true },
          ),
        );
      if (url.endsWith("/denied"))
        throw new TypeError("CORS error containing a private token");
      if (objectUrls.has(url))
        return new Response(objectUrls.get(url), {
          headers: { "content-type": objectUrls.get(url).type },
        });
      return new Response(
        url.endsWith(".png")
          ? image
          : url.endsWith(".css")
            ? "body {color:blue}"
            : new Uint8Array([1, 2, 3]),
        {
          headers: {
            "content-type": url.endsWith(".png")
              ? "image/png"
              : url.endsWith(".css")
                ? "text/css"
                : "font/woff2",
          },
        },
      );
    },
  });
  const pdf = new Uint8Array(
      Buffer.from("%PDF-1.7\nactual-native-stream\n%%EOF\n"),
    ),
    reads = new Map();
  const chrome = {
    tabs: {
      async get() {
        return { id: 1, url: location.href, title: document.title };
      },
      async query() {
        return [{ id: 1 }];
      },
      async update() {
        return { id: 1 };
      },
    },
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
        if (method === "Page.getResourceTree")
          return {
            frameTree: {
              frame: { id: "main-frame" },
              resources: [{ url: `${base}font.woff2`, type: "Font" }],
            },
          };
        if (method === "Page.printToPDF") {
          reads.set("native-pdf-handle", 0);
          return { stream: "native-pdf-handle" };
        }
        if (method === "IO.read") {
          const offset = reads.get(params.handle);
          reads.set(params.handle, pdf.length);
          return {
            base64Encoded: true,
            data: Buffer.from(pdf.subarray(offset)).toString("base64"),
            eof: true,
          };
        }
        if (method === "IO.close") {
          reads.delete(params.handle);
          return {};
        }
        return {};
      },
    },
    scripting: {
      async executeScript(input) {
        const request = JSON.parse(JSON.stringify(input.args[0]));
        scripts.push(request);
        const native = vm.runInContext(`(${input.func.toString()})`, realm);
        return [{ result: JSON.parse(JSON.stringify(await native(request))) }];
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
  t.after(() => router.dispose());
  const call = (method, fields = {}, signal) =>
    router.dispatch(
      {
        ...binding,
        target,
        actionId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        leaseId: "lease",
        runId: "run",
        method,
        args: { target, ...fields },
        budgetMs: 30000,
      },
      signal,
    );
  return {
    router,
    call,
    fetches,
    scripts,
    nativeCalls,
    nodes,
    image,
    objectUrls,
    location,
    realm,
    reads,
    pdf,
    aborted: () => aborted,
    stages: () =>
      vm.runInContext(
        'globalThis[Symbol.for("nexum.browser.data.v1")]?.stages.size ?? 0',
        realm,
      ),
  };
}

test("page asset inventory and plan perform no network; the bundle fetches only the fixed native inventory and preserves actual inline and file bytes", async (t) => {
  const f = fixture(t);
  // Native page decoration is not a website asset, even when it contains an actual SVG or favicon.
  f.nodes.push(
    {
      tagName: "svg",
      outerHTML: "<svg><path id='nexum-arrow'/></svg>",
      closest() {
        return {};
      },
      getAttribute() {
        return null;
      },
    },
    {
      tagName: "LINK",
      ownIcon: true,
      href: "data:image/png;base64,AAAA",
      closest() {
        return {};
      },
      getAttribute(name) {
        return name === "href" ? this.href : null;
      },
    },
  );
  const inventory = await f.call("pageAssets.list");
  assert.equal(inventory.assets.length, 4);
  assert.equal(inventory.inlineSvgs.length, 1);
  assert.equal(f.fetches.length, 0);
  assert.ok(
    inventory.assets.some(
      (asset) => asset.kind === "font" && asset.url.endsWith(".woff2"),
    ),
  );
  const plan = await f.call("pageAssets.plan", {
    options: { inventoryId: inventory.id },
  });
  assert.equal(plan.inventoryId, inventory.id);
  assert.equal(f.fetches.length, 0);
  assert.equal(
    plan.assets.find((asset) => asset.url.startsWith("blob:")).embedded,
    true,
  );
  f.nodes[0].currentSrc = "https://unapproved.invalid/replacement.png";
  const result = await f.call("pageAssets.bundle", {
    options: {
      inventoryId: inventory.id,
      assetIds: plan.assets.map((asset) => asset.id),
    },
  });
  assert.equal(result.assets.length, 4);
  assert.equal(result.failures.length, 0);
  assert.equal(
    f.fetches.some(({ url }) => url.includes("unapproved.invalid")),
    false,
  );
  assert.deepEqual(
    result.assets.find((asset) => asset.url.endsWith("picture.png")).data,
    f.image,
  );
  assert.equal(
    new TextDecoder()
      .decode(result.assets.find((asset) => asset.url.startsWith("blob:")).data)
      .startsWith("<svg"),
    true,
  );
  assert.ok(
    f.fetches.every(
      ({ options }) =>
        options.credentials === "include" && options.redirect === "error",
    ),
  );
  assert.ok(
    f.scripts
      .filter((request) => request.command === "chunk")
      .every((request) => request.length <= 16384),
  );
  await f.router.endLease("lease");
  assert.equal(f.objectUrls.size, 0);
  assert.equal(f.stages(), 0);
});

test("explicit browser downloads preserve partial failures, stop real fetch on cancellation, and stale inventories never silently rebind", async (t) => {
  const f = fixture(t),
    inventory = await f.call("pageAssets.list");
  const result = await f.call("pageAssets.download", {
    urls: [
      "https://fixture.example/denied",
      "https://fixture.example/picture.png",
    ],
  });
  assert.equal(result.files.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].reason.includes("private"), false);
  assert.deepEqual(result.files[0].data, f.image);
  const stop = new AbortController(),
    pending = f.call(
      "pageAssets.download",
      {
        urls: [
          "https://fixture.example/slow",
          "https://fixture.example/must-not-start",
        ],
      },
      stop.signal,
    );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  while (!f.fetches.some(({ url }) => url.endsWith("/slow")))
    await new Promise((resolve) => setTimeout(resolve, 1));
  stop.abort();
  await rejected;
  assert.equal(f.aborted(), 1);
  assert.equal(
    f.fetches.some(({ url }) => url.endsWith("must-not-start")),
    false,
  );
  f.location.href = "https://fixture.example/replaced";
  await assert.rejects(
    f.call("pageAssets.plan", { options: { inventoryId: inventory.id } }),
    { code: "STALE_REF" },
  );
});

test("HTML and Markdown source export actual authorized DOM HTML; PDF consumes the real native stream and confirms handle closure", async (t) => {
  const f = fixture(t);
  for (const format of ["html", "markdown"]) {
    const plan = await f.call("content.plan", {
      method: "tab.exportFile",
      options: { format },
    });
    assert.deepEqual(plan.urls, []);
    const file = await f.call("tab.exportFile", {
      planId: plan.id,
      options: { format },
    });
    assert.equal(file.mimeType, "text/html");
    assert.match(file.text, /<h1>Actual native document<\/h1>/);
    assert.equal(file.sourceUrl, f.location.href);
  }
  const plan = await f.call("content.plan", {
    method: "tab.exportFile",
    options: { format: "pdf" },
  });
  const pdf = await f.call("tab.exportFile", {
    planId: plan.id,
    options: { format: "pdf" },
  });
  assert.equal(pdf.mimeType, "application/pdf");
  assert.deepEqual(pdf.data, f.pdf);
  assert.equal(f.reads.size, 0);
  assert.equal(
    f.nativeCalls.find(({ method }) => method === "Page.printToPDF").params
      .transferMode,
    "ReturnAsStream",
  );
  assert.equal(
    f.nativeCalls.filter(({ method }) => method === "IO.close").length,
    1,
  );
  assert.equal(f.stages(), 0);
});
