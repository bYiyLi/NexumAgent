import assert from "node:assert/strict";
import test from "node:test";
import { AgentError } from "../dist/contracts/errors.js";
import { safeErrorData } from "../dist/contracts/error-data.js";

test("safe error data reads only branded own data, bounds messages and omits invalid details", () => {
  const fallback = { code: "safe_fallback", message: "Safe failure." };
  let calls = 0;
  const error = new AgentError("known", "m".repeat(5000), { kept: 1 });
  const normal = safeErrorData(error, fallback);
  assert.equal(normal.code, "known");
  assert.equal(Buffer.byteLength(normal.message), 1024);
  assert.match(normal.message, /\[truncated\]$/);
  error.details.kept = 2;
  assert.deepEqual(normal.details, { kept: 1 });
  assert.deepEqual(safeErrorData(new AgentError("c".repeat(257), "Failure."), fallback), { ...fallback, message: "Failure." });
  for (const key of ["code", "message", "details", "toJSON"])
    Object.defineProperty(error, key, {
      configurable: true,
      get() { calls++; throw new Error("must-not-read-accessor"); },
    });
  assert.deepEqual(safeErrorData(error, fallback), {
    ...fallback, details: { omitted: true, reason: "invalid_error_details" },
  });
  const proxy = new Proxy(error, {
    get() { calls++; throw new Error("must-not-read-proxy"); },
    getPrototypeOf() { calls++; throw new Error("must-not-inspect-proxy"); },
  });
  assert.deepEqual(safeErrorData(proxy, fallback), fallback);
  const forged = Object.create(AgentError.prototype, {
    code: { value: "forged" }, message: { value: "must-not-trust" },
  });
  assert.deepEqual(safeErrorData(forged, fallback), fallback);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.deepEqual(safeErrorData(new AgentError("known", "Failure.", cyclic), fallback).details,
    { omitted: true, reason: "invalid_error_details" });
  assert.equal(calls, 0);
});

test("public error projection preserves case, UTF8, recovery identity and irreversible facts", async () => {
  const { boundErrorDetails,isPublicErrorCode } = await import("../dist/contracts/error-data.js");
  const code = "BROWSER_"+"X".repeat(200);
  const details = { operationId:"op_original", effect:"unknown", dispatched:true, retryable:true,
    nested:[{token:"PRIVATE_TOKEN",stack_trace:"PRIVATE_STACK",field:"name"}] };
  const e = new AgentError(code,"故障🙂".repeat(1024),details);
  const data = safeErrorData(e,{code:"fallback",message:"fallback"});
  assert.equal(data.code,code);
  assert.ok(Buffer.byteLength(data.message)<=1024);
  assert.ok(!data.message.includes("�"));
  assert.deepEqual(data.details.nested,[{field:"name"}]);
  assert.equal(data.details.retryable,false);
  assert.equal(details.retryable,true);
  assert.equal(isPublicErrorCode("bad\n"),false);
  const big = boundErrorDetails({...details,reason:"original_reason",debug:"x".repeat(128*1024)}, {dispatched:false,effect:"none",retryable:true});
  assert.equal(big.operationId,"op_original");
  assert.equal(big.effect,"unknown");
  assert.equal(big.retryable,false);
  assert.equal(big.reason,"original_reason");
  assert.equal(big.omitted,true);
  assert.equal(boundErrorDetails({effect:"unknown"}).retryable,false);
});
