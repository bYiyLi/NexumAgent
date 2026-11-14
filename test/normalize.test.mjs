import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { Blob, File } from "node:buffer";
import { Readable } from "node:stream";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeData, contentValue } from "../dist/results/normalize.js";
import { createOutput } from "../dist/sdk/output.js";
import { canonicalJson } from "../dist/contracts/json.js";
import { AgentError } from "../dist/contracts/errors.js";

const pwd = path.resolve(".");
const plain = (value) => JSON.parse(JSON.stringify(value));
const failure =
  (position, code = "invalid_result_data") =>
  (error) => {
    assert.equal(error.code, code);
    assert.equal(error.details.path, position);
    return true;
  };

test("supported native values retain their data meaning and conversions without invoking author hooks", async () => {
  const date = new Date("2026-11-14T00:00:00.000Z");
  date.toJSON =
    date.toISOString =
    date.getTime =
      () => {
        throw Error("date hook");
      };
  const map = new Map([[{ key: 1 }, new Set([1n, "1"])]]);
  map[Symbol.iterator] = map.forEach = () => {
    throw Error("map hook");
  };
  const expression = /foo/giu;
  Object.defineProperty(expression, "global", {
    get() {
      throw Error("regexp hook");
    },
  });
  const error = new TypeError("returned error", {
    cause: { reason: "business" },
  });
  error.code = "BUSINESS";
  const result = await normalizeData({
    date,
    integer: 900719925474099312345n,
    map,
    url: new URL("https://example.invalid/a?q=1#f"),
    expression,
    zero: -0,
    error,
  });
  assert.deepEqual(plain(result.data), {
    date: "2026-11-14T00:00:00.000Z",
    integer: "900719925474099312345",
    map: [[{ key: 1 }, ["1", "1"]]],
    url: "https://example.invalid/a?q=1#f",
    expression: { source: "foo", flags: "giu" },
    zero: 0,
    error: {
      name: "TypeError",
      message: "returned error",
      code: "BUSINESS",
      cause: { reason: "business" },
    },
  });
  assert.equal(Object.is(result.data.zero, -0), false);
  assert.equal("stack" in result.data.error, false);
  assert.deepEqual(
    result.conversions.map(({ path, from }) => [path, from]),
    [
      ["$.date", "Date"],
      ["$.integer", "BigInt"],
      ["$.map", "Map"],
      ["$.map[0][1]", "Set"],
      ["$.map[0][1][0]", "BigInt"],
      ["$.url", "URL"],
      ["$.expression", "RegExp"],
      ["$.zero", "-0"],
      ["$.error", "Error"],
    ],
  );
});

test("guest realm objects and native slots work without relying on host instanceof", async () => {
  const value = vm.runInNewContext(`({
    object: { hello: "world" }, array:[1,null,true], date:new Date("2020-01-01Z"),
    map:new Map([["x",2n]]), set:new Set([1,2]), regexp:/a/dg,
    error:new RangeError("business")
  })`);
  const result = await normalizeData(value);
  assert.deepEqual(plain(result.data), {
    object: { hello: "world" },
    array: [1, null, true],
    date: "2020-01-01T00:00:00.000Z",
    map: [["x", "2"]],
    set: [1, 2],
    regexp: { source: "a", flags: "dg" },
    error: { name: "RangeError", message: "business" },
  });
});

test("plain data rejects lossy values and points to the original field", async () => {
  for (const invalid of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    () => {},
    Symbol("x"),
    Promise.resolve(1),
  ])
    await assert.rejects(
      normalizeData({ items: [{ value: invalid }] }),
      failure("$.items[0].value"),
    );
  await assert.rejects(normalizeData(undefined), failure("$"));
  await assert.rejects(normalizeData({ items: [, 1] }), failure("$.items[0]"));
  await assert.rejects(normalizeData(new Date("invalid")), failure("$"));
  const array = [1];
  array.extra = 2;
  await assert.rejects(normalizeData(array), failure("$"));
  await assert.rejects(
    normalizeData({ ["a.b"]: undefined }),
    failure('$["a.b"]'),
  );
});

test("getters, Proxy traps, custom converters and iterators are never executed to guess data", async () => {
  let calls = 0;
  const hook = () => {
    calls++;
    throw Error("must not execute");
  };
  for (const value of [
    Object.defineProperty({}, "secret", { enumerable: true, get: hook }),
    new Proxy({}, { ownKeys: hook, get: hook, getPrototypeOf: hook }),
    Object.create(new Proxy({}, { getPrototypeOf: hook, get: hook })),
    { toJSON: hook },
    Object.defineProperty([], "0", { enumerable: true, get: hook }),
    { [Symbol("unrepresentable")]: 1 },
    new (class Unknown {
      value = 1;
    })(),
    new Response("do not consume"),
    Readable.from(["do not consume"]),
  ])
    await assert.rejects(normalizeData(value), { code: "invalid_result_data" });
  const nonenumerable = Object.defineProperty({ ok: true }, "toJSON", {
    value: hook,
  });
  assert.deepEqual(plain((await normalizeData(nonenumerable)).data), {
    ok: true,
  });
  const symbols = Reflect.ownKeys(new Blob([])).filter(
    (key) => typeof key === "symbol",
  );
  const spoof = {};
  for (const key of symbols) Object.defineProperty(spoof, key, { get: hook });
  assert.deepEqual(plain((await normalizeData(spoof)).data), {});
  assert.equal(calls, 0);
});

test("cycles fail while repeated references are copied without an object graph protocol", async () => {
  const common = { item: 1 };
  const copy = (await normalizeData({ left: common, right: common })).data;
  assert.deepEqual(plain(copy), { left: { item: 1 }, right: { item: 1 } });
  assert.notEqual(copy.left, copy.right);
  const circular = {};
  circular.self = circular;
  await assert.rejects(normalizeData(circular), failure("$.self"));
  const map = new Map();
  map.set("self", map);
  await assert.rejects(normalizeData(map), failure("$[0][1]"));
  const set = new Set();
  set.add(set);
  await assert.rejects(normalizeData(set), failure("$[0]"));
});

test("nested native bytes route by original identity and receive explicit resource associations", async () => {
  const bytes = Buffer.from([8, 1, 2, 9]);
  const view = new DataView(bytes.buffer, bytes.byteOffset + 1, 2);
  const blob = new Blob(["hello"], { type: "text/plain" });
  const file = new File(["world"], "greeting.txt", { type: "text/plain" });
  const seen = [];
  const result = await normalizeData(
    { view, blob, file },
    {
      resolveContent: async (value, position) => {
        seen.push({ value, position });
        return {
          resourceId: `res_${seen.length}`,
          mimeType: "application/octet-stream",
          size: value === view ? 2 : 5,
        };
      },
    },
  );
  assert.equal(seen[0].value, view);
  assert.equal(seen[1].value, blob);
  assert.equal(seen[2].value, file);
  assert.deepEqual(
    seen.map(({ position }) => position),
    ["$.view", "$.blob", "$.file"],
  );
  assert.deepEqual(plain(result.data), {
    view: {
      resourceId: "res_1",
      mimeType: "application/octet-stream",
      size: 2,
    },
    blob: {
      resourceId: "res_2",
      mimeType: "application/octet-stream",
      size: 5,
    },
    file: {
      resourceId: "res_3",
      mimeType: "application/octet-stream",
      size: 5,
    },
  });
  assert.deepEqual(
    result.conversions.map(({ from }) => from),
    ["DataView", "Blob", "File"],
  );
  await assert.rejects(
    normalizeData({ bytes }),
    failure("$.bytes", "result_content_resolver_required"),
  );
});

test("content identification validates real descriptions and never interprets ordinary path strings or type fields", async () => {
  const output = createOutput(pwd, () => {});
  assert.equal(contentValue("picture.png", pwd), null);
  assert.equal(contentValue({ path: "picture.png" }, pwd), null);
  assert.equal(contentValue({ type: "image", business: 1 }, pwd), null);
  assert.equal(
    contentValue(output.json({ type: "image", path: "x" }), pwd),
    null,
  );
  const raw = { type: "image", path: "picture.png", mimeType: "image/png" };
  assert.equal(contentValue(raw, pwd).path, path.join(pwd, "picture.png"));
  const calls = [];
  const result = await normalizeData(
    {
      a: raw,
      b: output.text("content"),
      plain: { path: "notes.md" },
      string: "picture.png",
    },
    {
      pwd,
      resolveContent: async (value, position) => {
        calls.push({ value, position });
        return {
          resourceId: `res_${calls.length}`,
          type: "resource_link",
          uri: "nexum://agents/a/resources/r",
          name: "r",
        };
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].value.path, path.join(pwd, "picture.png"));
  assert.equal(calls[1].value.kind, "text");
  assert.deepEqual(plain(result.data.plain), { path: "notes.md" });
  assert.equal(result.data.string, "picture.png");
  await assert.rejects(
    normalizeData({ bad: { type: "image", path: 7 } }, { pwd }),
    failure("$.bad", "invalid_result_content"),
  );
});

test("explicit data preserves content-shaped business objects but refuses actual binary and output wrappers", async () => {
  const output = createOutput(pwd, () => {});
  const business = { type: "image", path: "not-a-file", nested: [1, 2] };
  assert.deepEqual(
    plain((await normalizeData(output.json(business))).data),
    business,
  );
  assert.deepEqual(
    plain((await normalizeData(business, { mode: "data" })).data),
    business,
  );
  for (const value of [
    Buffer.from([1]),
    new Blob(["x"]),
    output.image("x.png"),
  ])
    await assert.rejects(
      normalizeData({ nested: value }, { mode: "data" }),
      failure("$.nested"),
    );
  await assert.rejects(
    normalizeData(output.json({ nested: output.image("x.png") })),
    failure("$.nested"),
  );
});

test("shared memory is never consumed automatically but explicit content retains the source for its resolver", async () => {
  const shared = new SharedArrayBuffer(8);
  for (const source of [shared, new Uint8Array(shared), new DataView(shared)])
    await assert.rejects(normalizeData({ source }), failure("$.source"));
  const output = createOutput(pwd, () => {});
  let seen;
  const intention = output.image({ data: shared, mimeType: "image/png" });
  const result = await normalizeData(
    { image: intention },
    {
      resolveContent: async (value) => {
        seen = value;
        return { resourceId: "explicit" };
      },
    },
  );
  assert.equal(seen, intention);
  assert.equal(seen.value.data, shared);
  assert.deepEqual(plain(result.data), { image: { resourceId: "explicit" } });
});

test("returned Errors expose bounded validated data and omit stacks without evaluating their accessors", async () => {
  let calls = 0;
  const error = new Error("business", { cause: new Error("nested") });
  Object.defineProperty(error, "stack", {
    get() {
      calls++;
      throw Error("stack getter");
    },
  });
  const result = await normalizeData(error);
  assert.deepEqual(plain(result.data), {
    name: "Error",
    message: "business",
    cause: { name: "Error", message: "nested" },
  });
  assert.equal(calls, 0);
  Object.defineProperty(error, "code", {
    get() {
      calls++;
      throw Error("code getter");
    },
  });
  await assert.rejects(normalizeData(error), failure("$.code"));
  const named = new Error("x");
  Object.setPrototypeOf(
    named,
    Object.defineProperty({}, "name", {
      get() {
        calls++;
        throw Error("name getter");
      },
    }),
  );
  await assert.rejects(normalizeData(named), failure("$.name"));
  assert.equal(calls, 0);
});

test("budgets bound expansion, paths, UTF-8 escaping and native representations before publishing data", async () => {
  await assert.rejects(
    normalizeData({ deep: { value: 1 } }, { maxDepth: 1 }),
    failure("$.deep.value", "result_data_too_large"),
  );
  await assert.rejects(
    normalizeData([1, 2], { maxNodes: 2 }),
    failure("$", "result_data_too_large"),
  );
  await assert.rejects(
    normalizeData([1n, 2n], { maxConversions: 1 }),
    failure("$[1]", "result_data_too_large"),
  );
  await assert.rejects(
    normalizeData(10n ** 100000n, { maxBytes: 1024 }),
    failure("$", "result_data_too_large"),
  );
  await assert.rejects(
    normalizeData("\n".repeat(1000), { maxBytes: 1024 }),
    failure("$", "result_data_too_large"),
  );
  const value = { text: "中文\n\u0000", negative: -0, integer: 1234n };
  const normalized = await normalizeData(value);
  const exact = Buffer.byteLength(JSON.stringify(normalized));
  assert.deepEqual(await normalizeData(value, { maxBytes: exact }), normalized);
  await assert.rejects(normalizeData(value, { maxBytes: exact - 1 }), {
    code: "result_data_too_large",
  });
  const source = new Map([
    [1, 2],
    [3, 4],
  ]);
  await assert.rejects(
    normalizeData(source, { maxNodes: 5 }),
    failure("$", "result_data_too_large"),
  );
});

test("JSON string byte accounting is exact for escapes, UTF-8 and paired or unpaired surrogates", async () => {
  const samples = [
    "",
    '"\\',
    Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join(
      "",
    ),
    "\u007f\u0080\u07ff\u0800\ud7ff\ue000\uffff",
    "\ud800",
    "\udc00",
    "\ud800\udc00",
    "\ud800\ud800\udc00\udc00",
    "a".repeat(8191) + "\ud83d\ude00" + "b".repeat(8191) + "\ud800",
  ];
  for (const value of samples) {
    const expected = { data: value, conversions: [] };
    const exact = Buffer.byteLength(JSON.stringify(expected));
    assert.deepEqual(await normalizeData(value, { maxBytes: exact }), expected);
    await assert.rejects(normalizeData(value, { maxBytes: exact - 1 }), {
      code: "result_data_too_large",
    });
  }
  const data = { ['a"\u0000\ud800']: 1n };
  const expected = await normalizeData(data);
  const exact = Buffer.byteLength(JSON.stringify(expected));
  assert.deepEqual(await normalizeData(data, { maxBytes: exact }), expected);
  await assert.rejects(normalizeData(data, { maxBytes: exact - 1 }), {
    code: "result_data_too_large",
  });
});

test("oversized escaped strings fail before a whole-string JSON escape allocation", async () => {
  const source = "\u0000".repeat(8 * 1024 * 1024);
  const stringify = JSON.stringify;
  let attempts = 0;
  JSON.stringify = function (value, ...arguments_) {
    if (value === source) {
      attempts++;
      throw new Error("unbounded escaping attempted");
    }
    return Reflect.apply(stringify, JSON, [value, ...arguments_]);
  };
  try {
    await assert.rejects(
      normalizeData(source, { maxBytes: 16 * 1024 * 1024 }),
      failure("$", "result_data_too_large"),
    );
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(attempts, 0);
});

test("a 50 MiB control string is rejected within a bounded 128 MiB native process heap", (t) => {
  const entry = new URL("../dist/results/normalize.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=128", "--input-type=module"],
    {
      input: `import {normalizeData} from ${JSON.stringify(entry)};
const source='\\u0000'.repeat(50*1024*1024);
const before=process.memoryUsage().heapUsed;
let failure;
try {await normalizeData(source,{maxBytes:64*1024*1024});}
catch(error){failure={code:error.code,path:error.details?.path};}
console.log(JSON.stringify({...failure,inputChars:source.length,codeUnit:source.charCodeAt(0),heapGrowth:process.memoryUsage().heapUsed-before}));`,
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 64 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const measured = JSON.parse(result.stdout.trim());
  assert.equal(measured.code, "result_data_too_large");
  assert.equal(measured.path, "$");
  assert.equal(measured.inputChars, 50 * 1024 * 1024);
  assert.equal(measured.codeUnit, 0);
  assert.ok(measured.heapGrowth < 80 * 1024 * 1024, JSON.stringify(measured));
  t.diagnostic(
    `50 MiB control input, 64 MiB encoded budget, 128 MiB heap cap: ${(measured.heapGrowth / 1024 / 1024).toFixed(2)} MiB measured heap growth`,
  );
});

test("BigInt budget checks scale with actual values even when the configured result limit is large", (t) => {
  const entry = new URL("../dist/results/normalize.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=module"],
    {
      input: `import {normalizeData} from ${JSON.stringify(entry)};
const value=10n**2047n+123n;
const before=process.memoryUsage().heapUsed,start=performance.now();
const result=await normalizeData(value,{maxBytes:256*1024*1024});
console.log(JSON.stringify({digits:result.data.length,exact:result.data===value.toString(10),elapsedMs:performance.now()-start,heapGrowth:process.memoryUsage().heapUsed-before}));`,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const measured = JSON.parse(result.stdout.trim());
  assert.equal(measured.digits, 2048);
  assert.equal(measured.exact, true);
  assert.ok(measured.elapsedMs < 2000, JSON.stringify(measured));
  assert.ok(measured.heapGrowth < 16 * 1024 * 1024, JSON.stringify(measured));
  t.diagnostic(
    `2048 decimal digits, 256 MiB result budget, 64 MiB heap cap: ${measured.elapsedMs.toFixed(2)} ms, ${(measured.heapGrowth / 1024 / 1024).toFixed(2)} MiB measured heap growth`,
  );
});

test("positive and negative BigInt boundaries use exact decimal bytes after a bounded native precheck", async () => {
  for (const value of [
    0n,
    1n,
    -1n,
    999n,
    -999n,
    1000n,
    -1000n,
    10n ** 99n,
    -(10n ** 99n),
  ]) {
    const expected = await normalizeData(value);
    const exact = Buffer.byteLength(JSON.stringify(expected));
    assert.deepEqual(await normalizeData(value, { maxBytes: exact }), expected);
    assert.deepEqual(
      await normalizeData(value, { maxBytes: exact + 1 }),
      expected,
    );
    await assert.rejects(normalizeData(value, { maxBytes: exact - 1 }), {
      code: "result_data_too_large",
    });
  }
  const huge = 10n ** 100000n;
  for (const value of [huge, -huge])
    await assert.rejects(
      normalizeData(value, { maxBytes: 1024 }),
      failure("$", "result_data_too_large"),
    );
});

test("very long keys cannot inflate error paths beyond a small persistable envelope", async () => {
  const key = "a".repeat(2 * 1024 * 1024);
  const boundedError = (code) => (error) => {
    assert.equal(error.code, code);
    assert.equal(error.details.pathTruncated, true);
    assert.ok(Buffer.byteLength(error.details.path) <= 512);
    assert.ok(Buffer.byteLength(canonicalJson(error.toJSON())) < 4096);
    assert.ok(error.details.path.endsWith("…"));
    return true;
  };
  await assert.rejects(
    normalizeData({ [key]: undefined }, { maxBytes: 4 * 1024 * 1024 }),
    boundedError("invalid_result_data"),
  );
  await assert.rejects(
    normalizeData(
      { [key]: "x".repeat(3 * 1024 * 1024) },
      { maxBytes: 4 * 1024 * 1024 },
    ),
    boundedError("result_data_too_large"),
  );
  await assert.rejects(
    normalizeData(
      { [key]: { type: "image", path: 7 } },
      { maxBytes: 4 * 1024 * 1024 },
    ),
    boundedError("invalid_result_content"),
  );
  await assert.rejects(
    normalizeData(
      { [key]: { [key]: undefined } },
      { maxBytes: 6 * 1024 * 1024 },
    ),
    boundedError("invalid_result_data"),
  );
  const result = await normalizeData(
    { [key]: 1n },
    { maxBytes: 4 * 1024 * 1024 },
  );
  assert.equal(result.data[key], "1");
  assert.equal(result.conversions[0].pathTruncated, true);
  assert.ok(Buffer.byteLength(result.conversions[0].path) <= 512);
  const exact = Buffer.byteLength(JSON.stringify(result));
  assert.deepEqual(
    await normalizeData({ [key]: 1n }, { maxBytes: exact }),
    result,
  );
});

test("resolver errors use the same bounded path and do not copy untrusted messages or details", async () => {
  const key = "错误".repeat(1024 * 1024);
  const original = new AgentError("resource_read_failed", key, { path: key });
  await assert.rejects(
    normalizeData(
      { [key]: Buffer.from([1]) },
      {
        maxBytes: 16 * 1024 * 1024,
        async resolveContent() {
          throw original;
        },
      },
    ),
    (error) => {
      assert.equal(error.code, "resource_read_failed");
      assert.equal(error.cause, original);
      assert.equal(error.details.pathTruncated, true);
      assert.ok(Buffer.byteLength(error.details.path) <= 512);
      assert.ok(Buffer.byteLength(canonicalJson(error.toJSON())) < 4096);
      assert.equal(error.message.includes("错误"), false);
      assert.equal(error.details.path.includes("�"), false);
      return true;
    },
  );
  let traps = 0;
  await assert.rejects(
    normalizeData(Buffer.from([1]), {
      async resolveContent() {
        throw new Proxy(
          {},
          {
            get() {
              traps++;
            },
            getPrototypeOf() {
              traps++;
            },
          },
        );
      },
    }),
    failure("$", "result_content_resolution_failed"),
  );
  assert.equal(traps, 0);
});

test("authorization is checked throughout asynchronous resolution and references cannot smuggle unvalidated data", async () => {
  let active = true,
    resolve;
  const pending = new Promise((r) => (resolve = r));
  const result = normalizeData(
    { bytes: Buffer.from([1]) },
    {
      assertCurrent() {
        if (!active) throw Error("revoked");
      },
      resolveContent: async () => pending,
    },
  );
  await Promise.resolve();
  active = false;
  resolve({ resourceId: "r" });
  await assert.rejects(result, /revoked/);
  await assert.rejects(
    normalizeData(Buffer.from([1]), {
      resolveContent: async () => ({ bad: undefined }),
    }),
    failure("$.bad"),
  );
});
