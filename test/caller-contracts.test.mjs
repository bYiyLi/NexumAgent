import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixedCaller, callerKey, MAX_HOST_FEATURE_BYTES_V2 } from "../dist/contracts/caller.js";

const fixtures = JSON.parse(
  readFileSync(new URL("../contracts/v2/fixtures/wire.json", import.meta.url), "utf8"),
);
const sourceCaller = fixtures.find((f) => f.name === "complete authenticated invoke").value.context.caller;

test("Run caller snapshot retains original Host association without changing caller identity", () => {
  const caller = { ...structuredClone(sourceCaller), extra: "not copied" };
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

test("negotiated Host feature snapshots are bounded independent JSON without changing caller identity", () => {
  const features = {
    sampling: { context: {}, tools: { supported: ["native"] } },
    elicitation: { form: { applyDefaults: true }, url: {} },
    roots: { listChanged: true },
  };
  const source = { ...structuredClone(sourceCaller), hostFeatures: features };
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
  fixedCaller({ ...source, hostFeatures: exact });
  const oversized = {
    elicitation: { form: { hint: exact.elicitation.form.hint + "x" } },
  };
  assert.throws(() => fixedCaller({ ...source, hostFeatures: oversized }), {
    code: "data_too_large",
  });
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
