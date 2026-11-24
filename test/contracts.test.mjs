import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  compileInputSchema,
} from "../dist/contracts/validation.js";
import { validateOpenInputV2 } from "../dist/contracts/fixed-open-input.js";
import {
  canonicalJson,
  digest,
  newRequestId,
  requestWindow,
} from "../dist/contracts/json.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../contracts/v2/fixtures/inputs.json", import.meta.url),
    "utf8",
  ),
);
test("Node Open input matches the public Open fixtures", () => {
  const cases = fixtures.filter((fixture) => fixture.contract === "agent.open");
  assert(cases.length > 0);
  for (const fixture of cases) {
    if (fixture.valid) assert.doesNotThrow(() => validateOpenInputV2(fixture.value));
    else assert.throws(() => validateOpenInputV2(fixture.value), { code: "invalid_arguments" });
  }
});

test("Node Open input rejects invalid fields without echoing secrets", () => {
  for (const value of [
    {}, null, [], { agentId: null }, { agentId: "" }, { agentId: "x".repeat(257) },
    { agentId: "agt", projectId: "prj", path: "/tmp" },
    { agentId: "agt", path: "x".repeat(8193) },
    { agentId: "agt", "secret-token": true },
  ]) {
    assert.throws(() => validateOpenInputV2(value), (error) => {
      assert.equal(error.code, "invalid_arguments");
      assert(!JSON.stringify(error.toJSON()).includes("secret-token"));
      return true;
    });
  }
  validateOpenInputV2({ agentId: "😀".repeat(256), path: "/tmp" });
  assert.throws(() => validateOpenInputV2({ agentId: "😀".repeat(257) }), {code: "invalid_arguments"});
});

test("validation does not coerce or mutate script input", () => {
  const check = compileInputSchema({
    type: "object",
    properties: { n: { type: "integer", default: 2 } },
    required: ["n"],
    additionalProperties: false,
  });
  const input = { n: "2", extra: "preserved" };
  assert.throws(() => check(input), { code: "invalid_arguments" });
  assert.deepEqual(input, { n: "2", extra: "preserved" });
  assert.throws(() => check({}), { code: "invalid_arguments" });
  assert.doesNotThrow(() => check({ n: 2 }));
  assert.throws(
    () =>
      compileInputSchema({ $ref: "https://example.com/private-schema.json" }),
    { code: "invalid_input_schema" },
  );
  compileInputSchema({ $id: "https://example.com/input", type: "string" })(
    "one",
  );
  compileInputSchema({ $id: "https://example.com/input", type: "integer" })(1);
});

test("canonical intent preserves array order, null and rejects lossy values without calling accessors", () => {
  assert.equal(digest({ a: [1, 2], b: null }), digest({ b: null, a: [1, 2] }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  assert.notEqual(digest({}), digest({ input: null }));
  const circular = {};
  circular.self = circular;
  for (const value of [
    circular,
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    new Date(),
    [, 1],
  ]) {
    assert.throws(() => canonicalJson(value), { code: "invalid_json" });
  }
  let called = false;
  assert.throws(
    () =>
      canonicalJson({
        get secret() {
          called = true;
          return 1;
        },
      }),
    { code: "invalid_json" },
  );
  assert.equal(called, false);
  assert.throws(
    () =>
      canonicalJson(
        Object.create(
          new Proxy(
            {},
            {
              getOwnPropertyDescriptor() {
                called = true;
                return undefined;
              },
            },
          ),
        ),
      ),
    { code: "invalid_json" },
  );
  assert.equal(called, false);
  assert.throws(() => canonicalJson("x".repeat(1025), 1024), {
    code: "data_too_large",
  });
  assert.throws(() => canonicalJson(Array(100_001)), {
    code: "data_too_large",
  });
  assert.equal(
    canonicalJson(JSON.parse('{"__proto__":{"x":1}}')),
    '{"__proto__":{"x":1}}',
  );
});

test("request expiry is decidable after mappings have been deleted", () => {
  const now = Date.now();
  const id = newRequestId(now);
  assert.deepEqual(requestWindow(id, now), {
    issuedAt: now,
    expiresAt: now + 86_400_000,
  });
  assert.throws(() => requestWindow(id, now + 86_400_000), {
    code: "submission_expired",
  });
  assert.throws(() => requestWindow(newRequestId(now + 300_001), now), {
    code: "invalid_request_id",
  });
  assert.throws(() => requestWindow("req_opaque", now), {
    code: "invalid_request_id",
  });
});

test("SDK JSON accepts a plain object from the guest realm without invoking proxy traps or class conversions", () => {
  assert.equal(
    canonicalJson(
      vm.runInNewContext('({message:"question",inputSchema:{type:"integer"}})'),
    ),
    '{"inputSchema":{"type":"integer"},"message":"question"}',
  );
  let called = false;
  assert.throws(
    () =>
      canonicalJson(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              called = true;
              return null;
            },
            ownKeys() {
              called = true;
              return [];
            },
          },
        ),
      ),
    { code: "invalid_json" },
  );
  assert.equal(called, false);
  assert.throws(
    () =>
      canonicalJson(
        vm.runInNewContext("new (class X {constructor(){this.x=1;}})"),
      ),
    { code: "invalid_json" },
  );
});

test("schema failures identify field and constraint without echoing rejected input", () => {
  const check = compileInputSchema({
    type: "object",
    properties: {
      timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
      mode: { enum: ["safe", "fast"] },
    },
    required: ["timeoutMs"],
    additionalProperties: false,
  });
  assert.throws(() => check({}), (error) => {
    assert.equal(error.code, "invalid_arguments");
    assert.deepEqual(error.details.errors[0], {
      path: "$.timeoutMs", keyword: "required", expected: "provide this field",
    });
    return true;
  });
  assert.throws(() => check({ timeoutMs: "private-string-value" }), (error) => {
    assert.equal(error.details.errors[0].path, "$.timeoutMs");
    assert.equal(error.details.errors[0].expected, "integer");
    assert(!JSON.stringify(error.toJSON()).includes("private-string-value"));
    return true;
  });
  assert.throws(() => check({ timeoutMs: 0 }), (error) => {
    assert.equal(error.details.errors[0].expected, "minimum 1");
    return true;
  });
  assert.throws(() => check({ timeoutMs: 1, "secret-token-DO-NOT-ECHO": true }), (error) => {
    assert(!JSON.stringify(error.toJSON()).includes("secret-token-DO-NOT-ECHO"));
    return true;
  });
  assert.doesNotThrow(() => check({ timeoutMs: 500, mode: "safe" }));
});
