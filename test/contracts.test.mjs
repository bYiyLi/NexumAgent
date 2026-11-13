import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  validateContract,
  compileInputSchema,
} from "../dist/contracts/validation.js";
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
test("shared positive and negative public/wire fixtures", () => {
  for (const fixture of fixtures) {
    if (fixture.valid)
      assert.doesNotThrow(
        () => validateContract(fixture.contract, fixture.value),
        JSON.stringify(fixture),
      );
    else
      assert.throws(
        () => validateContract(fixture.contract, fixture.value),
        undefined,
        JSON.stringify(fixture),
      );
  }
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
