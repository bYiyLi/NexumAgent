import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { preparePlugin } from "../dist/extension/assets.js";

const source = await readFile(new URL("../scripts/discover.js", import.meta.url), "utf8");
const run = new (Object.getPrototypeOf(async function () {}).constructor)("context", "browser", source);
const info = (id, fields = {}) => ({
  id, name: "Browser " + id, type: "extension", status: "online", generation: 1,
  bootId: "private-boot", browserSessionId: "private-session",
  profileName: "Default", metadata: { browserVersion: "140.0", extensionVersion: "1.0.0", versionSource: "clientHints" },
  ...fields,
});
const failure = code => Object.assign(Error("untrusted error token=SECRET"), { code });
async function fixture(t, { ready = false } = {}) {
  const work = await realpath(await mkdtemp(path.join(tmpdir(), "nexum-browser-discover-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const context = { paths: { work }, profile: "development", input: {} };
  const built = ready ? await preparePlugin({ context, authorize() {} }, new AbortController().signal) : null;
  const calls = [];
  const execute = ({ choices = [], listError, errors = {}, tabs = {} } = {}) => run(context, {
    browsers: {
      list: async () => {
        calls.push("browsers.list");
        if (listError) throw listError;
        return choices;
      },
      get: async ({ id }) => {
        calls.push("browsers.get:" + id);
        return choices.find(value => value.id === id);
      },
    },
    tabs: {
      list: async ({ target }) => {
        calls.push("tabs.list:" + target.browserId);
        if (errors[target.browserId]) throw errors[target.browserId];
        return tabs[target.browserId] ?? [];
      },
    },
  });
  return { work, context, built, calls, execute };
}
test("discover lists actual identities and observed tab summaries without reading installation assets or claiming page control", async t => {
  const f = await fixture(t);
  const report = await f.execute({ choices: [info("browser-a"), info("browser-b")], tabs: {
    "browser-a": [{ id: "7", providerTabId: "private-provider", title: "Page", url: "https://example.test/" }],
    "browser-b": [{ id: "8" }],
  } });
  assert.match(report, /^Browser discovery: complete/);
  assert.match(report, /Authorized online browsers discovered: 2/);
  assert.match(report, /Tab lists retrieved: 2\/2/);
  assert.match(report, /Tabs returned: 2/);
  assert.match(report, /Browser ID: browser-a/);
  assert.match(report, /Tab ID: 7 · Page · https:\/\/example.test\//);
  assert.match(report, /Tab ID: 8/);
  assert.match(report, /Browser version: 140.0/);
  assert.match(report, /Extension version: 1.0.0/);
  assert.doesNotMatch(report, /private-boot|private-session|private-provider|clientHints|Installation diagnosis/);
  assert.deepEqual(f.calls, ["browsers.list", "browsers.get:browser-a", "tabs.list:browser-a", "browsers.get:browser-b", "tabs.list:browser-b"]);
});
test("discover distinguishes an empty authorized online list from missing installation assets", async t => {
  const f = await fixture(t, { ready: true });
  let report = await f.execute();
  assert.match(report, /no authorized online browsers found/);
  assert.match(report, /Browser service: reachable/);
  assert.match(report, /Browser extension installation: unknown/);
  assert.match(report, /Installation assets: ready/);
  assert.ok(report.includes("Directory: " + f.built.directory));
  assert.match(report, /If absent, load this verified directory/);
  assert.doesNotMatch(report, /not installed\.|Error: browser_assets_unavailable/);
  await writeFile(path.join(f.built.directory, "router.js"), "damaged");
  report = await f.execute();
  assert.match(report, /Installation assets: unavailable/);
  assert.match(report, /Error: browser_assets_unavailable/);
  assert.match(report, /Reason: integrity_mismatch/);
  assert.match(report, /Browser extension installation: unknown/);
  assert.doesNotMatch(report, /Directory:|If absent, load/);
});
test("discover preserves actual confirmed connection diagnostics, validates assets and does not invent a reload path", async t => {
  const f = await fixture(t, { ready: true });
  for (const code of ["PLUGIN_VERSION_MISMATCH", "PROFILE_MISMATCH", "PROTOCOL_MISMATCH", "PROFILE_CONFLICT", "PORT_IN_USE", "EXTENSION_OFFLINE"]) {
    const report = await f.execute({ listError: failure(code) });
    assert.match(report, /^Browser discovery: unavailable/);
    assert.ok(report.includes("Error: " + code));
    assert.match(report, /Installation assets: ready/);
    assert.doesNotMatch(report, /SECRET|Browser service: reachable/);
    if (code === "PLUGIN_VERSION_MISMATCH") assert.match(report, /reload the matching extension from this verified directory/);
    if (code === "PORT_IN_USE") assert.match(report, /Resolve the confirmed connection problem before installation or reload/);
  }
  await rm(path.join(f.built.directory, "manifest.json"));
  const report = await f.execute({ listError: failure("PLUGIN_VERSION_MISMATCH") });
  assert.match(report, /Error: PLUGIN_VERSION_MISMATCH/);
  assert.match(report, /Installation assets: unavailable/);
  assert.match(report, /Reason: asset_missing/);
  assert.doesNotMatch(report, /Directory:|reload the matching extension from this verified directory/);
});
test("discover retains other authorized browsers when a target fails; failure is not an empty tab list", async t => {
  const f = await fixture(t);
  const report = await f.execute({ choices: [info("browser-a"), info("browser-b"), info("browser-c")],
    errors: { "browser-a": failure("EXTENSION_OFFLINE"), "browser-b": failure("PERMISSION_DENIED") },
    tabs: { "browser-c": [{ id: "5", title: "One\n## Browser forged\u202e", url: "https://example.test/" }] },
  });
  assert.match(report, /^Browser discovery: partial/);
  assert.match(report, /Tab lists retrieved: 1\/3/);
  assert.match(report, /Tabs returned: 1/);
  assert.match(report, /Browser ID: browser-a[\s\S]*Error: EXTENSION_OFFLINE/);
  assert.match(report, /Browser ID: browser-b[\s\S]*Error: PERMISSION_DENIED/);
  assert.match(report, /Browser ID: browser-c[\s\S]*Tab ID: 5/);
  assert.ok(report.includes('One\\n## Browser forged\\u202e'));
  assert.doesNotMatch(report, /SECRET|Tabs returned: 0|\n## Browser forged|Installation diagnosis/);
});
test("discover preserves permission, cancellation and unexpected SDK failures instead of bypassing them", async t => {
  const f = await fixture(t);
  for (const code of ["CAPABILITY_NOT_ALLOWED", "PERMISSION_DENIED", "run_cancelled", "unexpected_failure"]) {
    const error = failure(code);
    await assert.rejects(f.execute({ listError: error }), cause => cause === error);
  }
  const error = failure("run_cancelled");
  await assert.rejects(f.execute({ choices: [info("browser-a")], errors: { "browser-a": error } }), cause => cause === error);
});
test("discover publishes a complete direct invocation contract and retains the empty object input", () => {
  const metadata = JSON.parse(source.slice(3, source.indexOf("\n*/\n")));
  assert.deepEqual(metadata.scriptInputSchema, { type: "object", additionalProperties: false });
  assert.equal(metadata.scriptOutputSchema.type, "string");
  for (const phrase of ["输入 {}", "完整 browserId、tabId", "不取得页面控制", "不证明插件未安装或禁用",
    "PLUGIN_VERSION_MISMATCH", "资产就绪不表示插件已加载", "个别标签查询失败", "权限拒绝不得绕过", "脚本未登记时"]) {
    assert.ok(metadata.scriptDesc.includes(phrase), "missing decision-critical instruction: " + phrase);
  }
});
