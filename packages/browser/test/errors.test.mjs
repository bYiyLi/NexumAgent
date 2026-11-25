import assert from "node:assert/strict";
import test from "node:test";
import { publicError } from "../browser-extension/errors.js";

test("native diagnostics classify only confirmed closed tabs and protected pages without exposing raw text", () => {
  const closed = publicError(new Error("No tab with id: 123."), true);
  assert.equal(closed.code, "TARGET_GONE");
  assert.equal(closed.reason, "tab_closed");
  assert.equal(closed.effect, "unknown");
  assert.equal(closed.retryable, false);
  const protectedPage = publicError(new Error("Cannot access a chrome:// URL."));
  assert.equal(protectedPage.code, "PERMISSION_DENIED");
  assert.equal(protectedPage.reason, "protected_page");
  for (const raw of ["Cannot attach to this target", "Cannot access contents of the page", "private content https://secret.invalid/"]) {
    const result = publicError(new Error(raw));
    assert.equal(result.code, "NATIVE_OPERATION_FAILED");
    assert.equal(result.reason, undefined);
    assert.ok(!JSON.stringify(result).includes(raw));
  }
});
