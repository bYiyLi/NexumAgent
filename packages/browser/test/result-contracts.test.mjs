import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { browserRoutes } from "../dist/client/routes.js";
import { browserResultContract } from "../dist/extension/result-contracts.js";

test("every raw Browser method has result semantics; fixed JSON schemas compile", () => {
  const ajv = new Ajv({ strict: true });
  const contracts = browserRoutes.map(route => [route.path, browserResultContract(route.path)]);
  assert.equal(contracts.length, 169);
  for (const [path, result] of contracts) {
    assert.ok(result.description.includes(path));
    if (result.outputSchema) ajv.compile(result.outputSchema);
  }
  const without = contracts.filter(([, result]) => !result.outputSchema).map(([path]) => path);
  assert.deepEqual(without, [
    "tabs.selected", "tab.title", "tab.url", "tab.markHandoff", "tab.getJsDialog", "tab.requestUserTakeover",
    "tab.screenshot", "tab.evaluate", "clipboard.read", "ax.get", "ax.write", "tab.semanticSnapshot", "tab.writeObservation", "playwright.elementScreenshot",
    "playwright.evaluate", "locator.evaluate", "locator.evaluateAll", "webmcp.invokeTool", "cdp.send",
  ]);
  const info = ajv.compile(browserResultContract("locator.count").outputSchema);
  assert.ok(info(3));
  assert.equal(info(-1), false);
});
