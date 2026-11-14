import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { Blob, File } from "node:buffer";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createOutput, outputIntent } from "../dist/sdk/output.js";

const pwd = path.resolve(tmpdir(), "nexum-output-intents-only");
const output = () => createOutput(pwd, () => {});
const code = (value) => (error) => error?.code === value;

test("output helpers construct typed intentions without reading files or producing resource/download identities", () => {
  const sdk = output();
  const image = sdk.image("missing/chart.png");
  assert.equal(image.kind, "image");
  assert.equal(image.value.path, path.resolve(pwd, "missing/chart.png"));
  assert.equal(Object.hasOwn(image.value, "data"), false);
  assert.equal(Object.hasOwn(image.value, "resourceId"), false);
  assert.equal(Object.isFrozen(image), true);
  assert.equal(Object.isFrozen(image.value), true);
  assert.equal(outputIntent(image), image);
  assert.equal(sdk.file, sdk.resourceLink);
  assert.equal(sdk.resource, sdk.embeddedResource);
  assert.equal(sdk.resource("notes.md").kind, "resource");
  assert.equal(sdk.audio("missing.wav").kind, "audio");
  const uri = "nexum://agents/agent/resources/file";
  const link = sdk.file({ uri, name: "movie.mp4", mimeType: "video/mp4" });
  assert.equal(link.kind, "resource_link");
  assert.equal(link.value.uri, uri);
  assert.equal(link.value.mimeType, "video/mp4");
});

test("binary source identities and their byte ranges survive construction without conversion or copying", () => {
  const sdk = output();
  const backing = new Uint8Array([99, 1, 2, 3, 88]);
  const bytes = backing.subarray(1, 4);
  const view = new DataView(backing.buffer, 1, 3);
  const typed = new Uint16Array([2, 3]);
  const shared = new SharedArrayBuffer(16);
  const sharedView = new Uint8Array(shared, 3, 4);
  const large = Buffer.alloc(11 * 1024 * 1024); // Inline budgets are enforced when materializing, not by this pure descriptor.
  for (const value of [
    bytes,
    view,
    typed,
    backing.buffer,
    Buffer.from([1]),
    shared,
    sharedView,
    large,
    new Blob([bytes]),
    new File([bytes], "file.bin"),
  ]) {
    const intent = sdk.image({ data: value, mimeType: "image/png" });
    assert.equal(intent.value.data, value);
  }
  assert.equal(sdk.image({ data: bytes }).value.data.byteOffset, 1);
  assert.equal(sdk.image({ data: view }).value.data.byteLength, 3);
  const foreign = runInNewContext("new DataView(new ArrayBuffer(8),2,3)");
  assert.equal(sdk.file({ data: foreign }).value.data, foreign);
  assert.equal(sdk.image({ data: new Uint8Array(0) }).value.data.byteLength, 0);
});

test("business data remains explicit and arrays are not silently converted into content", () => {
  const sdk = output();
  const business = [
    { type: "image", path: "business-field" },
    new Map([["one", 1]]),
    3n,
  ];
  const json = sdk.json(business);
  assert.equal(json.kind, "json");
  assert.equal(json.value, business);
  assert.equal(outputIntent(business), null);
  const images = sdk.images([]);
  assert.equal(images.kind, "collection");
  assert.deepEqual(images.value, []);
  assert.equal(outputIntent([]), null);
  const result = sdk.result({
    content: [sdk.text("done")],
    structuredContent: business,
  });
  assert.equal(result.value.structuredContent, business);
  assert.equal(result.value.content[0].kind, "text");
});

test("explicit content flattens only content collections and supports all five declared MCP block kinds", () => {
  const sdk = output(),
    business = { items: [1, 2, 3] };
  const rawImage = { type: "image", mimeType: "image/png", data: "AA==" };
  const rawAudio = { type: "audio", mimeType: "audio/wav", data: "AA==" };
  const rawLink = {
    type: "resource_link",
    name: "report.pdf",
    uri: "nexum://agents/agent/resources/file",
    mimeType: "application/pdf",
  };
  const embedded = {
    type: "resource",
    resource: {
      uri: "nexum://agents/agent/resources/text",
      mimeType: "text/plain",
      text: "body",
    },
  };
  const result = sdk.result({
    content: [
      sdk.text("done"),
      sdk.images(["first.png", "second.png"]),
      [{ type: "text", text: "raw" }, rawImage],
      rawAudio,
      rawLink,
      embedded,
    ],
    structuredContent: business,
  });
  assert.equal(result.value.content.length, 8);
  assert.equal(result.value.content.some(Array.isArray), false);
  assert.equal(
    result.value.content.some(
      (value) => outputIntent(value)?.kind === "collection",
    ),
    false,
  );
  assert.equal(result.value.structuredContent, business);
  assert.equal(Object.isFrozen(result.value.content), true);
  assert.notEqual(result.value.content[4], rawImage);
  rawImage.data = "changed";
  assert.equal(result.value.content[4].data, "AA==");
  assert.throws(
    () => sdk.result({ content: [sdk.json(business)] }),
    code("invalid_output"),
  );
  assert.throws(
    () => sdk.result({ content: [sdk.result({ content: [] })] }),
    code("invalid_output"),
  );
  assert.throws(
    () => sdk.result({ content: sdk.text("missing array") }),
    code("invalid_output"),
  );
});

test("intent classification cannot be forged by a prototype, copied descriptors or a proxy", () => {
  const sdk = output(),
    intent = sdk.image("file.png");
  assert.equal(outputIntent(Object.create(intent)), null);
  assert.equal(
    outputIntent(
      Object.defineProperties({}, Object.getOwnPropertyDescriptors(intent)),
    ),
    null,
  );
  assert.equal(
    outputIntent({ kind: "image", value: { path: "file.png" }, options: {} }),
    null,
  );
  let traps = 0;
  const proxy = new Proxy(intent, {
    get() {
      traps++;
      throw new Error("get");
    },
    getOwnPropertyDescriptor() {
      traps++;
      throw new Error("descriptor");
    },
    getPrototypeOf() {
      traps++;
      throw new Error("prototype");
    },
  });
  assert.equal(outputIntent(proxy), null);
  assert.throws(() => sdk.result({ content: [proxy] }));
  assert.equal(traps, 0);
});

test("control fields reject proxies, accessors, hidden required fields and sparse arrays without executing hooks", () => {
  const sdk = output();
  let calls = 0;
  const getter = (value, key) =>
    Object.defineProperty(value, key, {
      enumerable: true,
      get() {
        calls++;
        throw new Error("getter ran");
      },
    });
  for (const thunk of [
    () => sdk.image(getter({}, "path")),
    () => sdk.image({ path: "file" }, getter({}, "mimeType")),
    () => sdk.image({ path: "file" }, { annotations: getter({}, "priority") }),
    () => sdk.result(getter({}, "content")),
    () => sdk.result({ content: [getter({ type: "text" }, "text")] }),
    () =>
      sdk.result({
        content: [
          { type: "resource", resource: getter({ text: "text" }, "uri") },
        ],
      }),
    () => sdk.error("error", getter({}, "content")),
    () => sdk.images(getter(["file"], "0")),
    () => sdk.result({ content: getter([sdk.text("a")], "0") }),
  ])
    assert.throws(thunk);
  assert.equal(calls, 0);
  assert.throws(
    () => sdk.image(Object.defineProperty({}, "path", { value: "file" })),
    code("invalid_output_source"),
  );
  assert.throws(() => sdk.images(new Array(1)), code("invalid_output"));
  const sources = ["file.png"];
  Object.defineProperty(sources, Symbol.iterator, {
    get() {
      calls++;
      throw new Error("iterator ran");
    },
  });
  Object.defineProperty(sources, "map", {
    get() {
      calls++;
      throw new Error("map ran");
    },
  });
  assert.equal(sdk.images(sources).value.length, 1);
  assert.equal(calls, 0);
  let proxyTraps = 0;
  const proxy = new Proxy(
    { path: "file" },
    {
      ownKeys() {
        proxyTraps++;
        throw new Error("proxy ran");
      },
      getPrototypeOf() {
        proxyTraps++;
        throw new Error("proxy ran");
      },
    },
  );
  assert.throws(() => sdk.image(proxy));
  assert.equal(proxyTraps, 0);
  const symbol = Symbol("field"),
    symbols = { path: "file", [symbol]: 1 };
  assert.throws(() => sdk.image(symbols));
  assert.throws(() => sdk.text("a", { annotations: { [symbol]: 1 } }));
});

test("MIME and annotations are validated as data, normalized, and copied independently of caller mutation", () => {
  const sdk = output();
  const annotations = {
    audience: ["assistant"],
    priority: 0.7,
    lastModified: "2026-11-14T01:02:03+08:00",
  };
  const image = sdk.image(
    { data: Buffer.from([1]), mimeType: "IMAGE/PNG" },
    { name: "name", mimeType: "Image/PNG", annotations },
  );
  assert.equal(image.value.mimeType, "image/png");
  assert.equal(image.options.mimeType, "image/png");
  annotations.audience.push("user");
  annotations.priority = 0;
  assert.deepEqual(image.options.annotations.audience, ["assistant"]);
  assert.equal(image.options.annotations.priority, 0.7);
  assert.equal(Object.isFrozen(image.options.annotations.audience), true);
  for (const mimeType of [
    "",
    0,
    false,
    null,
    undefined,
    "bad",
    "image/\r\npng",
    {
      toString() {
        throw new Error("must not coerce");
      },
    },
  ])
    assert.throws(
      () => sdk.image({ data: Buffer.from([1]), mimeType }),
      code("invalid_output_mime_type"),
    );
  for (const annotations of [
    { priority: 1.1 },
    { priority: NaN },
    { audience: ["system"] },
    { audience: ["user", "user"] },
    { lastModified: "not-a-date" },
    { unknown: true },
  ])
    assert.throws(() => sdk.text("text", { annotations }));
  assert.equal(
    sdk.file({
      data: Buffer.alloc(0),
      mimeType: "application/x-nexum;version=1",
    }).value.mimeType,
    "application/x-nexum;version=1",
  );
});

test("invalid source shapes fail before encoding while native data values are not coerced", () => {
  const sdk = output();
  let calls = 0;
  for (const source of [
    {},
    null,
    { path: "x", data: Buffer.from([1]) },
    { path: "" },
    { path: "nul\0path" },
    { uri: "relative" },
    { uri: undefined },
    { data: "base64" },
    { data: {} },
    { data: new Proxy(new Uint8Array(1), {}) },
    { path: "x", name: undefined },
    { path: "x", extra: true },
  ])
    assert.throws(() => sdk.image(source));
  const dangerous = {
    toString() {
      calls++;
      return "image/png";
    },
  };
  assert.throws(() =>
    sdk.image({ data: Buffer.from([1]), mimeType: dangerous }),
  );
  assert.equal(calls, 0);
  assert.throws(() => sdk.result({ content: [{ type: "image" }] }));
  assert.throws(() =>
    sdk.result({ content: [{ type: "audio", data: "AA==" }] }),
  );
  assert.throws(() =>
    sdk.result({ content: [{ type: "resource_link", uri: "nexum://x" }] }),
  );
  for (const content of [
    { type: "text", text: "body", path: "image.png" },
    { type: "resource_link", name: "x", uri: "nexum://x", path: "x" },
    {
      type: "resource",
      resource: { uri: "nexum://x", text: "body" },
      data: "AA==",
    },
    { type: "image", path: "x", name: undefined },
    { type: "image", path: "x", description: 1 },
    { type: "image", path: "x".repeat(262145) },
  ])
    assert.throws(() => sdk.result({ content: [content] }));
  assert.throws(() =>
    sdk.result({
      content: [
        {
          type: "resource",
          resource: { uri: "nexum://x", text: "a", blob: "AA==" },
        },
      ],
    }),
  );
});

test("business errors are explicit result intentions and cannot inject platform lifecycle fields", () => {
  const sdk = output(),
    business = { code: "not_found" };
  const result = sdk.error("file not found", {
    content: [sdk.file("diagnostic.txt")],
    structuredContent: business,
  });
  assert.equal(result.kind, "result");
  assert.equal(result.value.isError, true);
  assert.equal(result.value.structuredContent, business);
  assert.equal(result.value.content.length, 2);
  assert.equal(result.value.content[0].value, "file not found");
  assert.throws(() => sdk.error(""), code("invalid_output"));
  assert.throws(
    () => sdk.error("error", { isError: false }),
    code("invalid_output"),
  );
  assert.throws(
    () => sdk.result({ content: [], run: { status: "succeeded" } }),
    code("invalid_output"),
  );
  assert.throws(
    () => sdk.result({ content: [], isError: undefined }),
    code("invalid_output"),
  );
});

test("explicit content construction has bounded depth/items and detects cycles without altering structured business graphs", () => {
  const sdk = output();
  let nested = sdk.text("x");
  for (let index = 0; index < 66; index++) nested = [nested];
  assert.throws(() => sdk.result({ content: nested }), code("data_too_large"));
  const cycle = [];
  cycle.push(cycle);
  assert.throws(() => sdk.result({ content: cycle }), code("invalid_output"));
  const large = new Array(100001).fill("x");
  assert.throws(() => sdk.images(large), code("data_too_large"));
  const business = {};
  business.self = business;
  assert.equal(sdk.json(business).value, business);
  assert.equal(
    sdk.result({ content: [], structuredContent: business }).value
      .structuredContent,
    business,
  );
});

test("every helper enforces its bound invocation and accepts ordinary objects from a guest realm", () => {
  let active = true;
  const sdk = createOutput(pwd, () => {
    if (!active)
      throw Object.assign(new Error("closed"), { code: "invocation_closed" });
  });
  const source = runInNewContext(
    '({path:"from-guest.png",mimeType:"image/png"})',
  );
  assert.equal(
    sdk.image(source).value.path,
    path.resolve(pwd, "from-guest.png"),
  );
  const result = runInNewContext(
    '({content:[{type:"text",text:"guest"}],structuredContent:[1,2]})',
  );
  assert.equal(
    sdk.result(result).value.structuredContent,
    result.structuredContent,
  );
  active = false;
  for (const invoke of [
    () => sdk.text("a"),
    () => sdk.json({}),
    () => sdk.image("a"),
    () => sdk.images([]),
    () => sdk.audio("a"),
    () => sdk.file("a"),
    () => sdk.resource("a"),
    () => sdk.result({ content: [] }),
    () => sdk.error("a"),
  ])
    assert.throws(invoke, code("invocation_closed"));
});
