import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import vm from "node:vm";
import {
  buildOpenApiRequest,
  normalizeOpenApiInput,
} from "../dist/adapters/openapi-request.js";

function fixture({
  swagger = false,
  parameters = [],
  content = { "application/json": { schema: {} } },
  ...extra
} = {}) {
  const operation = {
    operationId: "send",
    parameters,
    responses: { 200: { description: "ok" } },
    ...(swagger
      ? { consumes: Object.keys(content) }
      : { requestBody: { content } }),
  };
  return {
    document: {
      ...(swagger
        ? { swagger: "2.0", info: { title: "test", version: "1" } }
        : {
            openapi: "3.1.0",
            info: { title: "test", version: "1" },
            servers: [{ url: "https://unapproved.invalid/" }],
          }),
      paths: { "/items/{id}": { post: operation } },
    },
    operationId: "send",
    method: "post",
    path: "/items/{id}",
    serviceUrl: "https://approved.example/api",
    parameters,
    input: {},
    maxRequestBytes: 1024 * 1024,
    ...extra,
  };
}
function fail(code, fn) {
  assert.throws(fn, (error) => error.code === code);
}

test("positions distinguish equal names and preserve operation overrides without fetching", () => {
  const parameters = [
    { in: "path", name: "id", required: true, schema: { type: "string" } },
    { in: "query", name: "id", schema: { type: "string" } },
    { in: "header", name: "id", schema: { type: "string" } },
    {
      in: "query",
      name: "tags",
      style: "pipeDelimited",
      explode: false,
      schema: { type: "array", items: { type: "string" } },
    },
    { in: "query", name: "empty", schema: { type: "string" } },
  ];
  const options = fixture({
    parameters,
    input: {
      path: { id: "a/b" },
      query: { id: "query", tags: ["a", "b"], empty: "" },
      headers: { ID: "header" },
    },
  });
  options.document.paths[options.path].parameters = [
    { in: "query", name: "tags", style: "form", explode: true },
  ];
  const previous = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("fetch must not run");
  };
  try {
    const request = buildOpenApiRequest(options),
      url = new URL(request.url);
    assert.equal(url.origin, "https://approved.example");
    assert.equal(url.pathname, "/api/items/a%2Fb");
    assert.equal(url.searchParams.get("id"), "query");
    assert.equal(url.searchParams.get("tags"), "a|b");
    assert.equal(url.searchParams.get("empty"), "");
    assert.equal(request.headers.get("id"), "header");
    assert.equal(request.method, "POST");
  } finally {
    globalThis.fetch = previous;
  }
});

test("JSON encodes values including false, zero, null and empty string exactly", () => {
  for (const body of [
    false,
    0,
    null,
    "",
    "hello",
    { count: 2, text: "中文\n" },
    [1, 2],
  ]) {
    const request = buildOpenApiRequest(fixture({ input: { body } }));
    assert.equal(request.body, JSON.stringify(body));
    assert.equal(request.headers.get("content-type"), "application/json");
  }
});

test("multiple cookie parameters survive together with proper encoding", () => {
  const parameters = [
    { in: "cookie", name: "first", schema: { type: "string" } },
    { in: "cookie", name: "second", schema: { type: "string" } },
  ];
  const request = buildOpenApiRequest(
    fixture({
      parameters,
      input: { cookies: { first: "a b", second: "c&d" } },
    }),
  );
  assert.match(request.headers.get("cookie"), /^first=a%20b; second=c%26d$/);
  parameters.push({ in: "header", name: "Cookie", schema: { type: "string" } });
  const mixed = buildOpenApiRequest(
    fixture({
      parameters,
      input: {
        headers: { Cookie: "other=value" },
        cookies: { first: "a", second: "b" },
      },
    }),
  );
  assert.equal(mixed.headers.get("cookie"), "other=value; first=a; second=b");
});

test("parameter content JSON preserves JSON strings rather than guessing encoded input", () => {
  const parameters = [
    {
      in: "query",
      name: "filter",
      content: { "application/json": { schema: { type: "string" } } },
    },
  ];
  const request = buildOpenApiRequest(
    fixture({ parameters, input: { query: { filter: "hello" } } }),
  );
  assert.equal(new URL(request.url).searchParams.get("filter"), '"hello"');
});

test("multipart retains literal strings, File metadata and byte view bounds", async () => {
  const bytes = Buffer.from([99, 0, 1, 2, 88]);
  const content = { "multipart/form-data": { schema: { type: "object" } } };
  const request = buildOpenApiRequest(
    fixture({
      content,
      input: {
        body: {
          quoted: '"hello"',
          json: '{ "a": 1 }',
          empty: "",
          upload: new File(["file"], "report.txt", { type: "text/plain" }),
          bytes: bytes.subarray(1, 4),
        },
      },
    }),
  );
  assert.ok(request.body instanceof FormData);
  assert.equal(request.headers.has("content-type"), false);
  const native = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  assert.match(
    native.headers.get("content-type"),
    /multipart\/form-data; boundary=/,
  );
  const form = await native.formData();
  assert.equal(form.get("quoted"), '"hello"');
  assert.equal(form.get("json"), '{ "a": 1 }');
  assert.equal(form.get("empty"), "");
  assert.equal(form.get("upload").name, "report.txt");
  assert.equal(form.get("upload").type, "text/plain");
  assert.equal(await form.get("upload").text(), "file");
  assert.deepEqual(
    new Uint8Array(await form.get("bytes").arrayBuffer()),
    Uint8Array.of(0, 1, 2),
  );
});

test("urlencoded bodies reuse encoding and preserve JSON-shaped text and empty fields", () => {
  const content = {
    "application/x-www-form-urlencoded": {
      schema: { type: "object" },
      encoding: { tags: { style: "form", explode: true } },
    },
  };
  const request = buildOpenApiRequest(
    fixture({
      content,
      input: { body: { quoted: '"hello"', empty: "", tags: ["a", "b"] } },
    }),
  );
  const form = new URLSearchParams(request.body);
  assert.equal(form.get("quoted"), '"hello"');
  assert.equal(form.get("empty"), "");
  assert.deepEqual(form.getAll("tags"), ["a", "b"]);
});

test("declared part media and JSON strings survive content-type parameters", async () => {
  const content = {
    "multipart/form-data": {
      schema: { type: "object" },
      encoding: {
        text: { contentType: "application/json" },
        file: { contentType: "image/png" },
      },
    },
  };
  const request = buildOpenApiRequest(
    fixture({
      content,
      input: {
        contentType: "multipart/form-data; charset=utf-8",
        body: { text: "hello", file: Buffer.from([1, 2]) },
      },
    }),
  );
  const form = await new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  }).formData();
  assert.equal(await form.get("text").text(), '"hello"');
  assert.equal(form.get("text").type, "application/json");
  assert.equal(form.get("file").type, "image/png");
  fail("api_unsupported_media", () =>
    buildOpenApiRequest(
      fixture({
        content: {
          "multipart/form-data": {
            encoding: { file: { headers: { "X-Custom": {} } } },
          },
        },
        input: { body: { file: new Blob(["x"]) } },
      }),
    ),
  );
});

test("Swagger2 JSON body and formData uploads work without requestBody", async () => {
  for (const body of [0, false, null, { value: 1 }]) {
    const parameters = [
      { in: "body", name: "payload", required: true, schema: {} },
    ];
    const request = buildOpenApiRequest(
      fixture({ swagger: true, parameters, input: { body } }),
    );
    assert.equal(request.body, JSON.stringify(body));
  }
  const parameters = [
    { in: "formData", name: "file", type: "file", required: true },
    { in: "formData", name: "empty", type: "string" },
  ];
  const request = buildOpenApiRequest(
    fixture({
      swagger: true,
      parameters,
      content: { "multipart/form-data": {} },
      input: { body: { file: Buffer.from("hello"), empty: "" } },
    }),
  );
  const form = await new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  }).formData();
  assert.equal(await form.get("file").text(), "hello");
  assert.equal(form.get("empty"), "");
});

test("raw binary and text payloads keep explicit media", async () => {
  const content = { "application/octet-stream": {}, "text/plain": {} };
  const request = buildOpenApiRequest(
    fixture({
      content,
      input: {
        body: Uint8Array.of(1, 2, 3),
        contentType: "application/octet-stream",
      },
    }),
  );
  assert.deepEqual(
    new Uint8Array(await request.body.arrayBuffer()),
    Uint8Array.of(1, 2, 3),
  );
  const text = buildOpenApiRequest(
    fixture({
      content,
      input: { body: "raw", contentType: "text/plain", accept: "text/plain" },
    }),
  );
  assert.equal(text.body, "raw");
  assert.equal(text.headers.get("accept"), "text/plain");
});

test("unknown groups, location parameters, media and unsupported streams fail explicitly", () => {
  fail("api_unknown_parameter", () =>
    buildOpenApiRequest(fixture({ input: { server: "https://evil.test" } })),
  );
  fail("api_unknown_parameter", () =>
    buildOpenApiRequest(fixture({ input: { query: { unknown: 1 } } })),
  );
  fail("api_unsupported_media", () =>
    buildOpenApiRequest(
      fixture({ input: { body: 1, contentType: "text/plain" } }),
    ),
  );
  fail("api_invalid_arguments", () =>
    buildOpenApiRequest(
      fixture({ input: { body: Readable.from(["secret"]) } }),
    ),
  );
  fail("api_invalid_body", () =>
    buildOpenApiRequest(fixture({ input: { body: Buffer.from("x") } })),
  );
  fail("api_unsupported_media", () =>
    buildOpenApiRequest(
      fixture({ content: { "text/plain": {} }, input: { body: { value: 1 } } }),
    ),
  );
});

test("reserved routing headers and unapproved URL escape are rejected", () => {
  for (const name of [
    "Host",
    "Content-Length",
    "Transfer-Encoding",
    "Authorization",
    "Proxy-X",
  ]) {
    const parameters = [{ in: "header", name, schema: { type: "string" } }];
    fail("api_invalid_header", () =>
      buildOpenApiRequest(
        fixture({ parameters, input: { headers: { [name]: "evil" } } }),
      ),
    );
  }
  const options = fixture({ path: "/../outside" });
  options.document.paths[options.path] = options.document.paths["/items/{id}"];
  fail("api_invalid_service_url", () => buildOpenApiRequest(options));
});

test("budget checks precede binary copying and reject escaping or percent-encoded amplification", () => {
  const binary = Buffer.alloc(1024 * 1024);
  let read = 0;
  Object.defineProperty(binary, "buffer", {
    get() {
      read++;
      throw new Error("unsafe getter");
    },
  });
  fail("api_request_too_large", () =>
    buildOpenApiRequest(
      fixture({
        content: { "application/octet-stream": {} },
        input: { body: binary },
        maxRequestBytes: 1000,
      }),
    ),
  );
  assert.equal(read, 0);
  const small = Buffer.from([1, 2]);
  Object.defineProperty(small, "buffer", {
    get() {
      read++;
      throw new Error("unsafe getter");
    },
  });
  const valid = buildOpenApiRequest(
    fixture({
      content: { "application/octet-stream": {} },
      input: { body: small },
    }),
  );
  assert.ok(valid.body instanceof Blob);
  assert.equal(read, 0);
  const parameters = [{ in: "query", name: "q", schema: { type: "string" } }];
  fail("api_request_too_large", () =>
    buildOpenApiRequest(
      fixture({
        parameters,
        input: { query: { q: "中".repeat(80) } },
        maxRequestBytes: 700,
      }),
    ),
  );
  fail("api_request_too_large", () =>
    buildOpenApiRequest(
      fixture({ input: { body: "\u0000".repeat(100) }, maxRequestBytes: 300 }),
    ),
  );
});

test("input getters, proxies, custom hooks and sparse arrays never execute", () => {
  let called = 0;
  const getter = {};
  Object.defineProperty(getter, "secret", {
    enumerable: true,
    get() {
      called++;
      return "bad";
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        called++;
        throw new Error("bad");
      },
    },
  );
  for (const body of [
    getter,
    proxy,
    {
      toJSON() {
        called++;
        return "bad";
      },
    },
    Array(4),
  ])
    fail("api_invalid_arguments", () =>
      buildOpenApiRequest(fixture({ input: { body } })),
    );
  assert.equal(called, 0);
  const crossRealm = vm.runInNewContext('({body: {value: "ok"}})');
  assert.equal(
    buildOpenApiRequest(fixture({ input: crossRealm })).body,
    '{"value":"ok"}',
  );
  const protoProxy = Object.create(
    new Proxy(
      {},
      {
        getPrototypeOf() {
          called++;
          throw new Error("bad");
        },
      },
    ),
  );
  fail("api_invalid_arguments", () =>
    buildOpenApiRequest(fixture({ input: { body: protoProxy } })),
  );
  assert.equal(called, 0);
  fail("api_invalid_body", () =>
    buildOpenApiRequest(
      fixture({ input: { body: new Uint8Array(new SharedArrayBuffer(8)) } }),
    ),
  );
});

test("unsupported style is explicit, path-object keys are escaped, and defaults do not invent inputs", () => {
  const parameters = [
    {
      in: "path",
      name: "id",
      style: "matrix",
      explode: true,
      schema: { type: "object" },
    },
    {
      in: "query",
      name: "default",
      default: "do-not-send",
      schema: { type: "string" },
    },
  ];
  const request = buildOpenApiRequest(
    fixture({ parameters, input: { path: { id: { "key/slash": "value" } } } }),
  );
  assert.match(request.url, /key%2Fslash=value/);
  assert.equal(new URL(request.url).searchParams.has("default"), false);
  const invalid = [
    { in: "query", name: "q", style: "matrix", schema: { type: "array" } },
  ];
  fail("api_parameter_serialization", () =>
    buildOpenApiRequest(
      fixture({ parameters: invalid, input: { query: { q: [1, 2] } } }),
    ),
  );
});

test("public normalization rejects unsafe envelopes and fixes data before schema access", () => {
  let getterCalls = 0;
  const input = { body: { data: [1, 2, 3] } };
  const normalized = normalizeOpenApiInput(input, 1024);
  input.body.data.push(4);
  assert.deepEqual(normalized.body.data, [1, 2, 3]);
  const envelope = {};
  Object.defineProperty(envelope, "body", {
    enumerable: true,
    get() {
      getterCalls++;
      return {};
    },
  });
  fail("api_invalid_arguments", () => normalizeOpenApiInput(envelope, 1024));
  fail("api_invalid_arguments", () => normalizeOpenApiInput([], 1024));
  fail("api_unknown_parameter", () =>
    normalizeOpenApiInput({ server: "bad" }, 1024),
  );
  assert.equal(getterCalls, 0);
});

test("forged Blob Symbol accessors never run and real File shadow getters are stripped", async () => {
  let calls = 0;
  const reference = new Blob(["x"]);
  const fake = Object.create(Blob.prototype);
  for (const key of Object.getOwnPropertySymbols(reference))
    Object.defineProperty(fake, key, {
      get() {
        calls++;
        return undefined;
      },
    });
  fail("api_invalid_arguments", () =>
    normalizeOpenApiInput({ body: fake }, 10000),
  );
  assert.equal(calls, 0);
  const file = new File(["native"], "safe.txt", { type: "text/plain" });
  for (const key of ["name", "size", "type"])
    Object.defineProperty(file, key, {
      get() {
        calls++;
        throw new Error("getter");
      },
    });
  const request = buildOpenApiRequest(
    fixture({
      content: { "multipart/form-data": {} },
      input: { body: { file } },
    }),
  );
  const result = await new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  }).formData();
  assert.equal(await result.get("file").text(), "native");
  assert.equal(result.get("file").name, "safe.txt");
  assert.equal(result.get("file").type, "text/plain");
  assert.equal(calls, 0);
});

test("unsupported structured cookies, missing required cookies and huge part media fail explicitly", () => {
  const parameters = [
    { in: "cookie", name: "colour", required: true, explode: true, schema: {} },
  ];
  for (const value of [["a", "b"], { one: "a", two: "b" }])
    fail("api_parameter_serialization", () =>
      buildOpenApiRequest(
        fixture({ parameters, input: { cookies: { colour: value } } }),
      ),
    );
  fail("api_invalid_arguments", () =>
    buildOpenApiRequest(fixture({ parameters })),
  );
  const content = {
    "multipart/form-data": {
      encoding: { text: { contentType: `text/${"a".repeat(5000)}` } },
    },
  };
  fail("api_request_too_large", () =>
    buildOpenApiRequest(
      fixture({
        content,
        input: { body: { text: "small" } },
        maxRequestBytes: 2000,
      }),
    ),
  );
});
