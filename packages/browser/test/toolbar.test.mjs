import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
import test from "node:test";

const extension = fileURLToPath(new URL("../browser-extension/dist/", import.meta.url));
const sizes = [16, 32, 48, 128];

for (const profile of ["development", "production"]) {
  test(`${profile} extension includes branded icons and opens the welcome page on toolbar click`, async () => {
    const folder = path.join(extension, profile);
    const manifest = JSON.parse(readFileSync(path.join(folder, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.action.default_popup, undefined);
    const icons = Object.fromEntries(sizes.map((size) => [size, `icon-${size}.png`]));
    assert.deepEqual(manifest.icons, icons);
    assert.deepEqual(manifest.action.default_icon, icons);
    for (const size of sizes) {
      const png = readFileSync(path.join(folder, icons[size]));
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }

    let onClick;
    const opened = [];
    const chrome = {
      action: { onClicked: { addListener(listener) { onClick = listener; } } },
      tabs: { create(options) { opened.push(options); return Promise.resolve({}); } },
      storage: { session: { set() {} } },
    };
    const context = createContext({ chrome });
    const worker = new SourceTextModule(readFileSync(path.join(folder, "worker.js"), "utf8"), { context });
    const stub = (names, values) => new SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, values[name]);
    }, { context });
    const dependencies = {
      "./profile.js": stub(["profile", "extensionVersion"], { profile, extensionVersion: "test" }),
      "./router.js": stub(["createBrowserRouter"], { createBrowserRouter: () => ({}) }),
      "./connection.js": stub(["createExtensionConnection"], { createExtensionConnection: () => ({ start: async () => {} }) }),
      "./visual.js": stub(["createVisualController"], { createVisualController: () => ({}) }),
    };
    await worker.link((specifier) => dependencies[specifier]);
    await worker.evaluate();
    assert.equal(typeof onClick, "function");
    onClick();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, "https://nexum.y2l.top/");
  });
}
