import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
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

test("MCP selector presence rules remain exclusive", () => {
  const valid = [
    ["agent.open", {agentId:"agt_test",projectId:"project_one"}],
    ["agent.open", {agentId:"agt_test",path:"/tmp/project"}],
    ["agent.list", {agentId:"agt_test",projectsCursor:"page_two"}],
    ["agent.list", {cursor:"page_two"}],
    ["agent.run.get", {agentId:"agt_test",runId:"run_one"}],
    ["agent.run.start", {contextId:"ctx_test",script:"return 1;"}],
    ["agent.run.start", {contextId:"ctx_test",scriptName:"my-script"}],
  ];
  const invalid = [
    ["agent.open", {agentId:"agt_test",projectId:"project_one",path:"/tmp/project"}],
    ["agent.list", {cursor:"page_two",agentId:"agt_test"}],
    ["agent.list", {cursor:"page_two",projectsCursor:"page_three"}],
    ["agent.run.get", {agentId:"agt_test",runId:"run_one",requestId:"req_1234567890123_00000000000000000000000000000000"}],
    ["agent.run.get", {agentId:"agt_test",requestId:"req_1234567890123_00000000000000000000000000000000"}],
    ["agent.run.start", {contextId:"ctx_test",script:"return 1;",requestId:"req_1234567890123_00000000000000000000000000000000"}],
    ["agent.run.start", {contextId:"ctx_test",script:"return 1;",scriptName:"my-script"}],
  ];
  for (const [name,input] of valid) assert.doesNotThrow(()=>validateContract(name,input), name+" valid");
  for (const [name,input] of invalid) assert.throws(()=>validateContract(name,input), name+" invalid");
});


test("Wire accepts a Cloud-only requestId but the public MCP tool never does", () => {
  const requestId = newRequestId();
  const base = { contextId: "ctx_test", script: "return 1;", input: { requestId: "business_value" } };
  const issuedAt = Number(requestId.split("_")[1]);
  const submission = { issuedAt, expiresAt: issuedAt + 86_400_000 };
  assert.throws(() => validateContract("agent.run.start", { ...base, requestId }), { code: "invalid_arguments" });
  assert.doesNotThrow(() => validateContract("wire.input:agent.run.start", { ...base, requestId, submission }));
  assert.throws(() => validateContract("wire.input:agent.run.start", { ...base, requestId: "invalid", submission }), { code: "invalid_arguments" });
  assert.throws(() => validateContract("wire.input:agent.run.start", { ...base, requestId, submission, unwanted: true }), { code: "invalid_arguments" });
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
