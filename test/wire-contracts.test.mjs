import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateContract } from "../dist/contracts/validation.js";
import { fixedCaller, callerKey } from "../dist/contracts/caller.js";
import {
  decodeEnvelopeV2,
  validateConnectionV2,
  validatePolicyLeaseV2,
  validateReplyV2,
  validateSubmissionV2,
} from "../dist/contracts/wire-validation.js";
import {
  wireOperationsV2,
  MAX_RESOURCES_READ_BODY_BYTES_V2,
  MAX_STATE_VALUE_BYTES_V2,
  MAX_HOST_FEATURE_BYTES_V2,
} from "../dist/contracts/wire.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../contracts/v2/fixtures/wire.json", import.meta.url),
    "utf8",
  ),
);
for (const fixture of fixtures) {
  test(`shared wire fixture: ${fixture.name}`, () => {
    if (fixture.valid)
      assert.doesNotThrow(() =>
        validateContract(fixture.contract, fixture.value),
      );
    else assert.throws(() => validateContract(fixture.contract, fixture.value));
  });
}
const invoke = fixtures.find(
  (f) => f.name === "complete authenticated invoke",
).value;

test("every declared operation has registered strict input and output schemas", () => {
  for (const op of wireOperationsV2) {
    for (const side of ["input", "output"]) {
      const emptyAllowed =
        side === "input" &&
        ["agent.resources.list", "maintenance.request.list"].includes(op);
      if (emptyAllowed) validateContract(`wire.${side}:${op}`, {});
      else
        assert.throws(
          () => validateContract(`wire.${side}:${op}`, {}),
          { code: "invalid_arguments" },
          `${op}.${side}`,
        );
    }
  }
});

test("policy lease checks use the trusted current time, independent of structural fixture validation", () => {
  const now = Date.parse("2026-11-14T00:00:00.000Z");
  const policy = invoke.context.authorization;
  validatePolicyLeaseV2(
    { ...policy, expiresAt: new Date(now + 30_000).toISOString() },
    now,
  );
  for (const offset of [0, -1, 30_001]) {
    assert.throws(
      () =>
        validatePolicyLeaseV2(
          { ...policy, expiresAt: new Date(now + offset).toISOString() },
          now,
        ),
      { code: "authorization_expired" },
    );
  }
  // A schema-owned time must be real, while arbitrary business keys remain ordinary data.
  assert.throws(
    () =>
      validatePolicyLeaseV2(
        { ...policy, expiresAt: "2026-13-99T00:00:00Z" },
        now,
      ),
    { code: "invalid_arguments" },
  );
  validateContract("wire.type:Result", {
    content: [],
    data: { expiresAt: "not a date", agentId: "business-value" },
  });
});

test("submission binding is exact and expired requests cannot be admitted again", () => {
  const input = invoke.input;
  const issuedAt = input.submission.issuedAt;
  validateSubmissionV2(input, issuedAt);
  assert.throws(() => validateSubmissionV2(input, issuedAt + 86_400_000), {
    code: "submission_expired",
  });
  assert.throws(() => validateSubmissionV2(input, issuedAt - 300_001), {
    code: "invalid_request_id",
  });
  assert.throws(
    () =>
      validateSubmissionV2(
        {
          ...input,
          submission: { ...input.submission, issuedAt: issuedAt + 1 },
        },
        issuedAt,
      ),
    { code: "invalid_wire" },
  );
});

test("connection binding includes Agent, profile, boot, Cloud environment and physical connection", () => {
  const connection = invoke.context.connection;
  validateConnectionV2(connection, { ...connection });
  for (const key of Object.keys(connection)) {
    const changed = {
      ...connection,
      [key]: key === "profile" ? "production" : "another",
    };
    assert.throws(
      () => validateConnectionV2(changed, connection),
      { code: "connection_mismatch" },
      key,
    );
  }
});

test("replies are correlated to both the original RPC id and operation", () => {
  const reply = fixtures.find((f) => f.name === "resolve result").value;
  validateReplyV2(reply, "rpc_a", "agent.project.resolve");
  assert.throws(
    () => validateReplyV2(reply, "other", "agent.project.resolve"),
    { code: "reply_mismatch" },
  );
  assert.throws(() => validateReplyV2(reply, "rpc_a", "agent.open"), {
    code: "reply_mismatch",
  });
  validateReplyV2(
    {
      type: "error",
      id: "rpc_a",
      error: { code: "denied", message: "Denied" },
    },
    "rpc_a",
    "agent.open",
  );
  assert.throws(
    () =>
      validateReplyV2({ type: "cancel", id: "rpc_a" }, "rpc_a", "agent.open"),
    { code: "reply_mismatch" },
  );
});

test("raw control decoding rejects invalid UTF8 and counts actual UTF8 JSON bytes", () => {
  assert.deepEqual(
    decodeEnvelopeV2(Buffer.from(JSON.stringify(invoke))),
    invoke,
  );
  assert.throws(() => decodeEnvelopeV2(Uint8Array.of(0xff)));
  const huge = {
    type: "error",
    id: "rpc_a",
    error: { code: "failure", message: "错误".repeat(200_000) },
  };
  assert.throws(() => decodeEnvelopeV2(Buffer.from(JSON.stringify(huge))), {
    code: "data_too_large",
  });
  assert.throws(
    () => decodeEnvelopeV2("{secret-password}"),
    (error) =>
      error.code === "invalid_json" &&
      !error.message.includes("secret-password"),
  );
});

test("Run caller snapshot retains original Host association without changing caller identity", () => {
  const caller = { ...invoke.context.caller, extra: "not copied" };
  const fixed = fixedCaller(caller);
  assert.deepEqual(fixed.hostCapabilities, caller.hostCapabilities);
  assert.equal(fixed.hostRef, caller.hostRef);
  assert.ok(Object.isFrozen(fixed.hostCapabilities));
  assert.equal(fixed.extra, undefined);
  caller.hostCapabilities.sampling = false;
  assert.equal(fixed.hostCapabilities.sampling, true);
  assert.equal(
    callerKey(fixed),
    callerKey({ ...fixed, hostRef: "another-host", grantId: "another-grant" }),
  );
});

test("public Host attachments and private normalized Core input have separate derived views", () => {
  const source = { sourceId: "att_" + "a".repeat(64) };
  for (const [name, input] of [
    [
      "agent.run.start",
      { contextId: "context_a", script: "return 1;", attachments: [source] },
    ],
    [
      "agent.run.input",
      {
        agentId: "agent_a",
        runId: "run_a",
        waitId: "wait_a",
        input: {},
        attachments: [source],
      },
    ],
  ]) {
    assert.throws(() => validateContract(name, input), {
      code: "invalid_arguments",
    });
    assert.doesNotThrow(() => validateContract(`runtime:${name}`, input));
    const raw = {
      ...input,
      attachments: [
        { file_id: "file_a", download_url: "https://example.com/attachment" },
      ],
    };
    assert.doesNotThrow(() => validateContract(name, raw));
    assert.doesNotThrow(() => validateContract(`runtime:${name}`, raw));
    assert.throws(() => validateContract(`wire.input:${name}`, raw), {
      code: "invalid_arguments",
    });
  }
});

test("complete resource reads carry 64 MiB binary as standard base64 on only their independent JSON body", () => {
  const bytes = 64 * 1024 * 1024;
  const base64 = "A".repeat(4 * Math.floor(bytes / 3) + 2) + "==";
  assert.equal(base64.length, 4 * Math.ceil(bytes / 3));
  const result = {
    contents: [
      {
        uri: "nexum://agents/agent/resources/large",
        mimeType: "application/octet-stream",
        blob: base64,
      },
    ],
    _meta: { private: { expiresAt: "ordinary protocol metadata" } },
  };
  assert.doesNotThrow(() =>
    validateContract("wire.body:ResourcesRead", result),
  );
  assert.throws(
    () => validateContract("wire.output:agent.resources.read", result),
    { code: "data_too_large" },
  );
  assert.throws(
    () => validateContract("wire.body:Result", { content: [], data: base64 }),
    { code: "data_too_large" },
  );
  assert.throws(
    () =>
      validateContract("wire.body:ResourcesRead", {
        contents: [
          {
            uri: "fixture://oversized",
            text: "x".repeat(MAX_RESOURCES_READ_BODY_BYTES_V2),
          },
        ],
      }),
    { code: "data_too_large" },
  );
});

test("user-state value UTF8 budget is independent from its readable receipt metadata", () => {
  for (const value of [
    "界".repeat(21844) + "ab",
    "<".repeat(MAX_STATE_VALUE_BYTES_V2 - 2),
    "\u2028".repeat(21844) + "ab",
  ]) {
    assert.equal(
      Buffer.byteLength(JSON.stringify(value)),
      MAX_STATE_VALUE_BYTES_V2,
    );
    const receipt = { value, version: 1, updatedAt: 0 };
    validateContract("wire.input:state.user.set", {
      namespace: "default",
      key: "preferences",
      value,
      expectedVersion: null,
    });
    validateContract("wire.output:state.user.set", receipt);
    validateContract("wire.output:state.user.get", { state: receipt });
    for (const [contract, changed] of [
      [
        "wire.input:state.user.set",
        {
          namespace: "default",
          key: "preferences",
          value: value + "x",
          expectedVersion: null,
        },
      ],
      ["wire.output:state.user.set", { ...receipt, value: value + "x" }],
      [
        "wire.output:state.user.get",
        { state: { ...receipt, value: value + "x" } },
      ],
    ])
      assert.throws(() => validateContract(contract, changed), {
        code: "data_too_large",
      });
  }
});

test("negotiated Host feature snapshots are bounded independent JSON without changing caller identity", () => {
  const features = {
    sampling: { context: {}, tools: { supported: ["native"] } },
    elicitation: { form: { applyDefaults: true }, url: {} },
    roots: { listChanged: true },
  };
  const source = { ...invoke.context.caller, hostFeatures: features };
  const snapshot = fixedCaller(source);
  assert.deepEqual(snapshot.hostFeatures, features);
  assert.notEqual(snapshot.hostFeatures, features);
  assert.ok(Object.isFrozen(snapshot.hostFeatures.sampling.tools.supported));
  features.sampling.tools.supported.push("mutated");
  features.elicitation.form.applyDefaults = false;
  assert.deepEqual(snapshot.hostFeatures.sampling.tools.supported, ["native"]);
  assert.equal(snapshot.hostFeatures.elicitation.form.applyDefaults, true);
  assert.equal(
    callerKey(snapshot),
    callerKey({
      principalId: snapshot.principalId,
      clientId: snapshot.clientId,
    }),
  );
  for (const hostFeatures of [
    { sampling: true },
    { roots: { callerId: "injected" } },
    { elicitation: { form: { applyDefaults: "yes" } } },
  ])
    assert.throws(() => fixedCaller({ ...source, hostFeatures }), {
      code: "invalid_host_features",
    });
  const overhead = Buffer.byteLength(
    JSON.stringify({ elicitation: { form: { hint: "" } } }),
  );
  const exact = {
    elicitation: {
      form: { hint: "x".repeat(MAX_HOST_FEATURE_BYTES_V2 - overhead) },
    },
  };
  assert.equal(
    Buffer.byteLength(JSON.stringify(exact)),
    MAX_HOST_FEATURE_BYTES_V2,
  );
  validateContract("wire.type:HostFeatures", exact);
  fixedCaller({ ...source, hostFeatures: exact });
  const oversized = {
    elicitation: { form: { hint: exact.elicitation.form.hint + "x" } },
  };
  assert.throws(() => validateContract("wire.type:HostFeatures", oversized), {
    code: "data_too_large",
  });
  assert.throws(() => fixedCaller({ ...source, hostFeatures: oversized }), {
    code: "data_too_large",
  });
  for (const contract of [
    "wire.type:Caller",
    "wire.type:McpCaller",
    "wire.type:InvocationContext",
    "wire.type:McpInvocationContext",
  ]) {
    const caller = { ...source, hostFeatures: oversized };
    assert.throws(
      () =>
        validateContract(
          contract,
          contract.endsWith("Context") ? { ...invoke.context, caller } : caller,
        ),
      { code: "data_too_large" },
    );
  }
});

test("owner session snapshots preserve their distinct identity without changing caller keys", () => {
  const sessionRef = "a".repeat(64);
  const caller = {
    principalId: "owner",
    clientId: `nexum-console:${sessionRef}`,
    source: "owner_session",
    sessionRef,
  };
  const snapshot = fixedCaller(caller);
  assert.deepEqual(snapshot, caller);
  assert.notEqual(snapshot, caller);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(
    callerKey(snapshot),
    callerKey({ principalId: caller.principalId, clientId: caller.clientId }),
  );
  for (const patch of [
    { grantId: "grant" },
    { hostFeatures: {} },
    { clientId: "nexum-console:" + "b".repeat(64) },
  ])
    assert.throws(() => fixedCaller({ ...caller, ...patch }), {
      code: "invalid_caller",
    });
});

test("user-state budgets count preserved lone UTF16 surrogates as JSON escapes", () => {
  const value = "\ud800".repeat(10922) + "ab";
  assert.equal(
    Buffer.byteLength(JSON.stringify(value)),
    MAX_STATE_VALUE_BYTES_V2,
  );
  const receipt = { value, version: 1, updatedAt: 0 };
  validateContract("wire.input:state.user.set", {
    namespace: "default",
    key: "units",
    value,
    expectedVersion: null,
  });
  validateContract("wire.output:state.user.get", { state: receipt });
  assert.throws(
    () =>
      validateContract("wire.output:state.user.set", {
        ...receipt,
        value: value + "x",
      }),
    { code: "data_too_large" },
  );
});
