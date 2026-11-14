import test from "node:test";
import assert from "node:assert/strict";
import { pressKeys, keyToken } from "../browser-extension/keyboard.js";

test("macOS ControlOrMeta+A uses one native SelectAll command and releases only acquired keys", async () => {
  const original = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "platform",
  );
  Object.defineProperty(globalThis.navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  const sent = [],
    held = new Map(),
    ctx = {
      target: { tabId: "1" },
      lease: { keys: new Map([[1, held]]) },
      router: {
        heldKey(_ctx, key) {
          return held.get(keyToken(key));
        },
        async send(_ctx, method, params) {
          sent.push({ method, params });
          if (params.type === "keyDown")
            held.set(keyToken(params), { source: {}, params });
          else held.delete(keyToken(params));
        },
        async releaseKey(_ctx, key) {
          sent.push({
            method: "Input.dispatchKeyEvent",
            params: { type: "keyUp", ...key, modifiers: 0 },
          });
          held.delete(keyToken(key));
        },
      },
    };
  try {
    await pressKeys(ctx, ["ControlOrMeta", "A"]);
    const down = sent.filter((entry) => entry.params.type === "keyDown");
    assert.equal(down[0].params.key, "Meta");
    assert.equal(down[1].params.modifiers, 4);
    assert.deepEqual(down[1].params.commands, ["SelectAll"]);
    assert.equal(sent.filter((entry) => entry.params.commands).length, 1);
    assert.equal(held.size, 0);
    assert.ok(
      sent
        .filter((entry) => entry.params.type === "keyUp")
        .every((entry) => !entry.params.commands),
    );
  } finally {
    if (original)
      Object.defineProperty(globalThis.navigator, "platform", original);
    else delete globalThis.navigator.platform;
  }
});
