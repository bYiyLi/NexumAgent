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

test("the client, factory and read-only installation helper entries are usable without invoking a factory or exposing internal subpaths", (t) => {
  const root = temporary(t);
  mkdirSync(path.join(root, "node_modules", "@nexum-hub"), { recursive: true });
  symlinkSync(
    source,
    path.join(root, "node_modules", "@nexum-hub/browser"),
    "junction",
  );
  symlinkSync(
    fileURLToPath(
      new URL("../node_modules/@nexum-hub/sdk", import.meta.url),
    ),
    path.join(root, "node_modules", "@nexum-hub", "sdk"),
    "junction",
  );
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    path.join(root, "probe.ts"),
    `import {createBrowserClient,type BrowserClient,type PlaywrightLocator,type BrowserArtifact} from "@nexum-hub/browser";
import factory from "@nexum-hub/browser/nexum";import type {ExtensionFactory} from "@nexum-hub/sdk";
const extension:ExtensionFactory=factory;const client:BrowserClient=createBrowserClient({});
async function example(){const selected=await client.browsers.get("actual-browser");const tab=await selected.tabs.get("actual-tab");const locator:PlaywrightLocator=tab.playwright.getByRole("button",{name:"submit"});await locator.click();await tab.cdp.send("Runtime.enable");const artifact:BrowserArtifact=await tab.saveDownload("actual-download");const image=await tab.ax.write("both");return {artifact,image};}
void extension;void example;`,
  );
  const tsc = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
  const compiled = spawnSync(
    process.execPath,
    [
      tsc,
      "--ignoreConfig",
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
  const script = `import assert from "node:assert/strict";import {readdirSync} from "node:fs";const before=process._getActiveHandles().filter(value=>value.constructor?.name==="Server").length;const {createBrowserClient}=await import("@nexum-hub/browser");const extension=await import("@nexum-hub/browser/nexum");const {inspectInstallation}=await import("@nexum-hub/browser/installation");assert.equal(typeof extension.default,"function");assert.equal(typeof createBrowserClient({}).browsers.list,"function");assert.equal((await inspectInstallation(process.env.HOME)).assetsReady,false);assert.equal(process._getActiveHandles().filter(value=>value.constructor?.name==="Server").length,before);await assert.rejects(import("@nexum-hub/browser/dist/extension/service.js"),{code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});assert.deepEqual(readdirSync(process.env.HOME),[]);`;
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

test("the actual private candidate tarball contains its own registered contributions and matched plugins without archives, installed dependencies or local state", (t) => {
  const destination = temporary(t);
  // Invoke the actual bundled CLI; Windows npm.cmd is not a native executable.
  const npm = path.resolve(
    path.dirname(process.execPath),
    process.platform === "win32"
      ? "node_modules/npm/bin/npm-cli.js"
      : "../lib/node_modules/npm/bin/npm-cli.js",
  );
  const packed = spawnSync(
    process.execPath,
    [
      npm,
      "pack",
      "--offline",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination,
    ],
    { cwd: source, env, encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const [result] = JSON.parse(packed.stdout);
  assert.match(result.shasum, /^[0-9a-f]{40}$/);
  const names = new Set(result.files.map((value) => value.path));
  for (const expected of [
    "dist/client/index.js",
    "dist/client/index.d.ts",
    "dist/client/installation.js",
    "dist/client/installation.d.ts",
    "dist/extension/index.js",
    "dist/extension/index.d.ts",
    "instructions/README.md",
    "skills/browser-control/references/bootstrap.md",
    "skills/browser-control/references/api.md",
    "skills/browser-control/references/forms.md",
    "skills/browser-control/references/errors.md",
    "skills/browser-control/references/connection.md",
    "skills/browser-control/references/lifecycle.md",
    "skills/browser-control/references/tabs-and-observation.md",
    "skills/browser-control/references/scripts.md",
    "scripts/discover.js",
    "scripts/installation.js",
    "skills/browser-control/references/installation.md",
    "scripts/screenshot.js",
    "scripts/observe.js",
    "browser-extension/dist/development/semantic-observation.js",
    "browser-extension/dist/production/semantic-observation.js",
    "skills/browser-control/SKILL.md",
    "implementation.json",
    "browser-extension/dist/development/manifest.json",
    "browser-extension/dist/production/manifest.json",
    "browser-extension/dist/development/profile.js",
    "browser-extension/dist/production/profile.js",
    "browser-extension/asset-revision.mjs",
  ]) {
    assert.ok(names.has(expected), `candidate lacks ${expected}`);
  }
  for (const reference of readdirSync(path.join(source, "skills/browser-control/references"))) {
    if (reference.endsWith(".md")) {
      assert.ok(names.has("skills/browser-control/references/" + reference),
        "tarball missing Skill resource: " + reference);
    }
  }
  assert.ok(!names.has("skills/browser-control/references/usage.md"));
    for (const name of names)
    assert.doesNotMatch(
      name,
      /(^|\/)(?:node_modules|archive|test|\.nexum(?:-dev)?|\.git)(?:\/|$)|(?:^|\/)(?:profiles\.json|\.env|.*\.pem)$/,
    );
  const ledger = JSON.parse(
    readFileSync(path.join(source, "implementation.json"), "utf8"),
  );
  assert.equal(ledger.publicMembers.length, 249);
  assert.equal(new Set(ledger.publicMembers.map((item) => item.id)).size, 249);
  assert.ok(
    ledger.publicMembers.every((item) => item.nativeAcceptance === "not_run"),
  );
  assert.equal(ledger.published, false);
  assert.equal(
    JSON.parse(readFileSync(path.join(source, "package.json"))).private,
    false,
  );
});
