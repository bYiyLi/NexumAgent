import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const source = fileURLToPath(new URL("../", import.meta.url));
const env = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
};
function temporary(t) {
  const root = mkdtempSync(path.join(tmpdir(), "nexum-browser-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("both public package entries and external declarations are usable without invoking a factory or exposing internal subpaths", (t) => {
  const root = temporary(t);
  mkdirSync(path.join(root, "node_modules"));
  symlinkSync(
    source,
    path.join(root, "node_modules", "nexum-browser"),
    "junction",
  );
  mkdirSync(path.join(root, "node_modules", "@nexum"));
  symlinkSync(
    fileURLToPath(
      new URL("../node_modules/@nexum/extension-api", import.meta.url),
    ),
    path.join(root, "node_modules", "@nexum", "extension-api"),
    "junction",
  );
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    path.join(root, "probe.ts"),
    `import {createBrowserClient,type BrowserClient,type PlaywrightLocator,type BrowserArtifact} from "nexum-browser";
import factory from "nexum-browser/nexum";import type {ExtensionFactory} from "@nexum/extension-api";
const extension:ExtensionFactory=factory;const client:BrowserClient=createBrowserClient({});
async function example(){const selected=await client.browsers.get("actual-browser");const tab=await selected.tabs.get("actual-tab");const locator:PlaywrightLocator=tab.playwright.getByRole("button",{name:"submit"});await locator.click();await tab.cdp.send("Runtime.enable");const artifact:BrowserArtifact=await tab.saveDownload("actual-download");const image=await tab.ax.write("both");return {artifact,image};}
void extension;void example;`,
  );
  const tsc = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
  const compiled = spawnSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--strict",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--skipLibCheck",
      path.join(root, "probe.ts"),
    ],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const script = `import assert from "node:assert/strict";import {readdirSync} from "node:fs";const before=process._getActiveHandles().filter(value=>value.constructor?.name==="Server").length;const {createBrowserClient}=await import("nexum-browser");const extension=await import("nexum-browser/nexum");assert.equal(typeof extension.default,"function");assert.equal(typeof createBrowserClient({}).browsers.list,"function");assert.equal(process._getActiveHandles().filter(value=>value.constructor?.name==="Server").length,before);await assert.rejects(import("nexum-browser/dist/extension/service.js"),{code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});assert.deepEqual(readdirSync(process.env.HOME),[]);`;
  const home = path.join(root, "home");
  mkdirSync(home);
  const runtime = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: root,
      env: { ...env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    },
  );
  assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
  assert.deepEqual(readdirSync(home), []);
});

test("the actual private candidate tarball contains its own five contributions and matched plugins without archives, installed dependencies or local state", (t) => {
  const destination = temporary(t);
  const packed = spawnSync(
    "npm",
    [
      "pack",
      "--offline",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination,
    ],
    { cwd: source, env, encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const [result] = JSON.parse(packed.stdout);
  assert.match(result.shasum, /^[0-9a-f]{40}$/);
  const names = new Set(result.files.map((value) => value.path));
  for (const expected of [
    "dist/client/index.js",
    "dist/client/index.d.ts",
    "dist/extension/index.js",
    "dist/extension/index.d.ts",
    "instructions/README.md",
    "docs/README.md",
    "docs/api.md",
    "scripts/discover.js",
    "scripts/screenshot.js",
    "skills/browser-control/SKILL.md",
    "implementation.json",
    "browser-extension/dist/development/manifest.json",
    "browser-extension/dist/production/manifest.json",
  ]) {
    assert.ok(names.has(expected), `candidate lacks ${expected}`);
  }
  for (const name of names)
    assert.doesNotMatch(
      name,
      /(^|\/)(?:node_modules|archive|test|\.nexum(?:-dev)?|\.git)(?:\/|$)|(?:^|\/)(?:profiles\.json|\.env|.*\.pem)$/,
    );
  const ledger = JSON.parse(
    readFileSync(path.join(source, "implementation.json"), "utf8"),
  );
  assert.equal(ledger.publicMembers.length, 250);
  assert.equal(new Set(ledger.publicMembers.map((item) => item.id)).size, 250);
  assert.ok(
    ledger.publicMembers.every((item) => item.nativeAcceptance === "not_run"),
  );
  assert.equal(ledger.published, false);
  assert.equal(
    JSON.parse(readFileSync(path.join(source, "package.json"))).private,
    true,
  );
});
