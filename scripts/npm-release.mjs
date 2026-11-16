import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const packages = [
  { key: "sdk", name: "@nexum-hub/sdk", dir: "packages/extension-api" },
  { key: "agent", name: "@nexum-hub/agent", dir: "." },
  { key: "browser", name: "@nexum-hub/browser", dir: "packages/browser" },
];
const defaultVersion = "0.0.1";
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseTag(tag) {
  const match = stableTag.exec(tag);
  if (!match) throw new Error(`Only stable vX.Y.Z tags are accepted: ${tag}`);
  const values = match.slice(1).map(Number);
  if (!values.every(Number.isSafeInteger))
    throw new Error("Tag version exceeds the supported integer range.");
  return values;
}

function compareParts(a, b) {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function releasePlan({ eventName, ref, runNumber, tags = [] }) {
  if (eventName === "push") {
    const prefix = "refs/tags/";
    if (!ref.startsWith(prefix))
      throw new Error("A release push must be a tag.");
    const parts = parseTag(ref.slice(prefix.length));
    return { mode: "stable", tag: "latest", version: parts.join(".") };
  }
  if (eventName !== "workflow_dispatch" || ref !== "refs/heads/main")
    throw new Error("Manual preview publishing is allowed only on main.");
  if (!/^[1-9]\d*$/.test(String(runNumber)))
    throw new Error("A unique GitHub run number is required for previews.");
  const known = tags.filter((name) => stableTag.test(name)).map(parseTag);
  const latest = known.sort(compareParts).at(-1);
  const parts = latest ? [...latest] : parseTag(`v${defaultVersion}`);
  if (latest) {
    if (!Number.isSafeInteger(parts[2] + 1))
      throw new Error("Patch number overflow.");
    parts[2]++;
  }
  return {
    mode: "preview",
    tag: "next",
    version: `${parts.join(".")}-next.${runNumber}`,
  };
}

function json(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}

function save(relative, value) {
  writeFileSync(
    path.join(root, relative),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function writeEnv(name, value) {
  if (process.env.GITHUB_ENV)
    appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}

function prepare() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const ref = process.env.GITHUB_REF ?? "";
  let tags = [];
  if (eventName === "workflow_dispatch") {
    tags = execFileSync("git", ["tag", "--merged", "HEAD", "--list", "v*"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  }
  const plan = releasePlan({
    eventName,
    ref,
    runNumber: process.env.GITHUB_RUN_NUMBER,
    tags,
  });
  if (plan.mode === "stable") {
    const tagged = execFileSync(
      "git",
      ["rev-parse", "--verify", `${ref}^{commit}`],
      { cwd: root, encoding: "utf8" },
    ).trim();
    const checkedOut = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    if (tagged !== checkedOut)
      throw new Error(
        "Official release tags must match the checked-out commit.",
      );
    const result = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
      { cwd: root },
    );
    if (result.status !== 0)
      throw new Error("Official release tags must point to a commit on main.");
  }
  for (const item of packages) {
    const relative = path.join(item.dir, "package.json");
    const manifest = json(relative);
    assert.equal(manifest.name, item.name);
    manifest.version = plan.version;
    manifest.publishConfig.tag = plan.tag;
    if (item.key === "browser")
      manifest.peerDependencies["@nexum-hub/sdk"] = plan.version;
    save(relative, manifest);
  }
  const ledger = json("packages/browser/implementation.json");
  ledger.packageVersion = plan.version;
  save("packages/browser/implementation.json", ledger);
  const extension = json(
    "packages/browser/browser-extension/release-info.json",
  );
  extension.packageVersion = plan.version;
  // Chrome MV3 manifest versions must contain only numeric components.
  extension.extensionVersion = plan.version.split("-")[0];
  save("packages/browser/browser-extension/release-info.json", extension);
  writeEnv("RELEASE_VERSION", plan.version);
  writeEnv("RELEASE_TAG", plan.tag);
  console.log(`npm ${plan.mode}: ${plan.version} (dist-tag: ${plan.tag})`);
}

function inspectRelease() {
  const version = process.env.RELEASE_VERSION;
  const tag = process.env.RELEASE_TAG;
  if (!version || !["next", "latest"].includes(tag))
    throw new Error("Run the release preparation step first.");
  const packageEntries = [];
  for (const item of packages) {
    const dir = path.join(root, item.dir);
    const manifest = json(path.join(item.dir, "package.json"));
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, version);
    assert.equal(manifest.private, false);
    assert.equal(manifest.publishConfig.access, "public");
    assert.equal(manifest.publishConfig.tag, tag);
    assert.equal(manifest.license, "UNLICENSED");
    const [pack] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
        cwd: dir,
        encoding: "utf8",
      }),
    );
    assert.equal(pack.name, item.name);
    assert.equal(pack.version, version);
    assert.match(pack.shasum, /^[a-f0-9]{40}$/);
    const names = new Set(pack.files.map(({ path: filename }) => filename));
    for (const required of {
      sdk: ["dist/index.js", "dist/index.d.ts"],
      agent: ["dist/cli.js", "contracts/v2/common.schema.json"],
      browser: [
        "dist/client/index.js",
        "dist/extension/index.js",
        "browser-extension/dist/development/manifest.json",
        "browser-extension/dist/production/manifest.json",
        "implementation.json",
      ],
    }[item.key])
      assert.ok(names.has(required), `${item.name} is missing ${required}`);
    for (const filename of names)
      assert.doesNotMatch(
        filename,
        /(^|\/)(node_modules|test|archive|\.git|\.nexum|src)(\/|$)|(^|\/)(\.env[^/]*|.*\.pem)$/,
      );
    packageEntries.push({ ...item, dir, manifest, pack });
    console.log(`Verified ${item.name}@${version}: ${pack.files.length} files`);
  }
  const browser = json("packages/browser/package.json");
  const ledger = json("packages/browser/implementation.json");
  const extension = json(
    "packages/browser/browser-extension/release-info.json",
  );
  assert.equal(browser.peerDependencies["@nexum-hub/sdk"], version);
  assert.equal(ledger.packageVersion, version);
  assert.equal(extension.packageVersion, version);
  assert.equal(extension.extensionVersion, version.split("-")[0]);
  return packageEntries;
}

async function registryPackage(name) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const response = await fetch(url, {
    headers: { "Cache-Control": "no-cache", Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`${name} registry lookup failed: HTTP ${response.status}`);
  return response.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilIndexed(name, version, tag) {
  // Public npm indexing can lag an accepted publish by more than 150 seconds.
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await registryPackage(name);
    if (result?.versions?.[version] && result["dist-tags"]?.[tag] === version)
      return result;
    if (attempt % 12 === 0)
      console.log(
        `Waiting for npm Registry: ${name}@${version} (${tag}), check ${attempt + 1}/60`,
      );
    await sleep(5000);
  }
  throw new Error(
    `${name}@${version} was accepted or updated but is not indexed with ${tag}; inspect the registry before retrying.`,
  );
}

async function publish() {
  const entries = inspectRelease();
  const { RELEASE_VERSION: version, RELEASE_TAG: tag } = process.env;
  const existing = [];
  // Fail before publishing any member if this version already exists with different bytes.
  for (const item of entries) {
    const registry = await registryPackage(item.name);
    const found = registry?.versions?.[version];
    const latest = registry?.["dist-tags"]?.latest;
    if (
      tag === "latest" &&
      latest &&
      stableTag.test(`v${latest}`) &&
      compareParts(parseTag(`v${latest}`), parseTag(`v${version}`)) > 0
    )
      throw new Error(
        `${item.name}: refusing to downgrade latest from ${latest} to ${version}.`,
      );
    if (found && found.dist?.shasum !== item.pack.shasum)
      throw new Error(
        `${item.name}@${version} already exists with different contents; publish a new version instead.`,
      );
    existing.push({ item, registry, found });
  }
  for (const { item, registry, found } of existing) {
    if (found) {
      if (registry["dist-tags"]?.[tag] !== version) {
        execFileSync(
          "npm",
          ["dist-tag", "add", `${item.name}@${version}`, tag],
          { cwd: item.dir, stdio: "inherit" },
        );
      }
      console.log(`Reused immutable ${item.name}@${version}`);
    } else {
      // No blind retry: a successful upload can take time to become visible.
      execFileSync(
        "npm",
        [
          "publish",
          "--access",
          "public",
          "--tag",
          tag,
          "--provenance",
          "--ignore-scripts",
        ],
        {
          cwd: item.dir,
          stdio: "inherit",
        },
      );
    }
    await waitUntilIndexed(item.name, version, tag);
    console.log(`Registry confirmed ${item.name}@${version} (${tag})`);
  }
}

const command = process.argv[2];
if (command === "prepare") prepare();
else if (command === "verify") inspectRelease();
else if (command === "publish") await publish();
else if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  throw new Error("Usage: node scripts/npm-release.mjs prepare|verify|publish");
