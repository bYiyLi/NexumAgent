import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  symlink,
  readdir,
  rm,
  lstat,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildAgent, signatureMessage } from "../scripts/build-agent.mjs";
import {
  installAgent,
  verifyArchive,
  cleanupPrograms,
} from "../scripts/install-agent.mjs";

const temporary = async (t) => {
  const dir = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-install-fixture 空格 & $ %-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
};
async function inputs(root, version = "1.0.0") {
  const source = path.join(root, "source"),
    compiled = path.join(root, "compiled"),
    nodeRoot = path.join(root, "trusted-node"),
    out = path.join(root, "out-" + version);
  await mkdir(source, { recursive: true });
  await mkdir(compiled, { recursive: true });
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "nexum-agent",
      version,
      type: "module",
      dependencies: {},
    }),
  );
  await mkdir(path.join(source, "contracts"), { recursive: true });
  await writeFile(path.join(source, "contracts", "fixture.schema.json"), "{}");
  await writeFile(
    path.join(compiled, "cli.js"),
    `console.log(JSON.stringify({version:${JSON.stringify(version)},argv:process.argv.slice(2),flags:process.execArgv}));`,
  );
  // Existing source material must not enter the installer by directory copying.
  for (const name of [
    "docs/browser/archive/private.txt",
    "state/secret.json",
    "test/cache.bin",
  ]) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), "must-not-ship");
  }
  const key = generateKeyPairSync("ed25519"),
    privateKey = path.join(root, "private.pem"),
    publicKey = path.join(root, "trusted-public.pem");
  await writeFile(
    privateKey,
    key.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  await writeFile(
    publicKey,
    key.publicKey.export({ type: "spki", format: "pem" }),
  );
  if (process.platform === "win32") {
    await mkdir(path.join(nodeRoot, "node_modules/npm/bin"), {
      recursive: true,
    });
    await cp(process.execPath, path.join(nodeRoot, "node.exe"));
    await writeFile(path.join(nodeRoot, "npm.cmd"), "@echo off\r\n");
    await writeFile(path.join(nodeRoot, "npx.cmd"), "@echo off\r\n");
  } else {
    await mkdir(path.join(nodeRoot, "bin"), { recursive: true });
    await mkdir(path.join(nodeRoot, "lib/node_modules/npm/bin"), {
      recursive: true,
    });
    await cp(process.execPath, path.join(nodeRoot, "bin/node"));
    await symlink(
      "../lib/node_modules/npm/bin/npm-cli.js",
      path.join(nodeRoot, "bin/npm"),
    );
    await symlink(
      "../lib/node_modules/npm/bin/npm-cli.js",
      path.join(nodeRoot, "bin/npx"),
    );
  }
  await writeFile(
    path.join(
      nodeRoot,
      process.platform === "win32"
        ? "node_modules/npm/bin/npm-cli.js"
        : "lib/node_modules/npm/bin/npm-cli.js",
    ),
    'console.log("fixture npm");',
  );
  await writeFile(path.join(nodeRoot, "LICENSE"), "Node fixture license");
  return {
    root: source,
    compiledDir: compiled,
    nodeRoot,
    outputDir: out,
    signingKeyFile: privateKey,
    prepareDependencies: false,
    publicKeyFile: publicKey,
  };
}
const optionsFor = (bundle, keys, home) => ({
  archive: bundle.archive,
  sha256: bundle.sha256,
  signatureFile: bundle.signatureFile,
  publicKeyFile: keys.publicKeyFile,
  home,
  profile: "development",
  registerService: false,
  config: {
    server_url: "http://127.0.0.1:48765/",
    token: "fixture-private-token",
  },
});
test(
  "signed program builds from allowlisted files and installs, updates and cleans only its temporary profile",
  { timeout: 120000 },
  async (t) => {
    const root = await temporary(t),
      keys = await inputs(root),
      home = path.join(root, "home with 空格 & $ %");
    await mkdir(home);
    const first = await buildAgent(keys);
    assert.ok(
      first.manifest.files.some(
        (f) =>
          f.path ===
          (process.platform === "win32"
            ? "runtime/node.exe"
            : "runtime/bin/node"),
      ),
    );
    assert.ok(
      first.manifest.files.every(
        (f) =>
          !/(?:^app\/(?:docs|state|test|archive)|private\.pem)/.test(f.path),
      ),
    );
    const opts = optionsFor(first, keys, home),
      installed = await installAgent(opts);
    assert.equal(installed.serviceRegistered, false);
    assert.equal(installed.startRequested, false);
    assert.equal(
      JSON.parse(
        await readFile(path.join(home, ".nexum-dev/config.json"), "utf8"),
      ).token,
      "fixture-private-token",
    );
    assert.equal((await readdir(home)).includes(".nexum"), false);
    if (process.platform !== "win32")
      assert.equal(
        (await lstat(path.join(home, ".nexum-dev/config.json"))).mode & 0o077,
        0,
      );
    const executable = path.join(
      installed.programDir,
      "runtime",
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
    const child = spawnSync(
      executable,
      [
        "--experimental-vm-modules",
        path.join(installed.programDir, "app/dist/cli.js"),
        "run",
        "--profile",
        "development",
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout).argv, [
      "run",
      "--profile",
      "development",
    ]);
    const verified = await verifyArchive(opts);
    await writeFile(first.archive, "replaced original after verification");
    assert.notEqual(verified.archive, first.archive);
    assert.ok((await readFile(verified.archive)).length > 1000);
    await verified.dispose();
    const configPath = path.join(home, ".nexum-dev/config.json"),
      policyConfig = {
        ...opts.config,
        storage: { max_managed_bytes: 20 * 1024 ** 3 },
        retention: {
          work_idle_ms: 86_400_000,
          run_history_ms: 2 * 86_400_000,
          run_logs_ms: 86_400_000,
          input_attachments_ms: 86_400_000,
          artifact_ms: 86_400_000,
          material_copies_ms: 86_400_000,
        },
      },
      configBytes = JSON.stringify(policyConfig, null, 2) + "\n";
    await writeFile(configPath, configBytes, { mode: 0o600 });
    // A second authentic archive replaces only the selected profile's active receipt.
    await writeFile(
      path.join(keys.root, "package.json"),
      JSON.stringify({
        name: "nexum-agent",
        version: "1.0.1",
        type: "module",
        dependencies: {},
      }),
    );
    const second = await buildAgent({
      ...keys,
      outputDir: path.join(root, "out-2"),
    });
    const updated = await installAgent({
      ...optionsFor(second, keys, home),
      config: undefined,
    });
    assert.notEqual(updated.programDir, installed.programDir);
    assert.equal(await readFile(configPath, "utf8"), configBytes);
    const beforeRejected = await readFile(
      path.join(home, ".nexum-dev/program/active.json"),
      "utf8",
    );
    for (const config of [
      { ...policyConfig, unsupported: true },
      { ...policyConfig, storage: { max_bytes: 1 } },
      { ...policyConfig, storage: { max_managed_bytes: 1.5 } },
      { ...policyConfig, retention: { artifact_ms: 0 } },
      { ...policyConfig, retention: { artifact_ms: 8_640_000_000_000_000 } },
    ])
      await assert.rejects(
        installAgent({
          ...optionsFor(second, keys, home),
          replaceConfig: true,
          config,
        }),
        /configuration|policy/,
      );
    assert.equal(await readFile(configPath, "utf8"), configBytes);
    assert.equal(
      await readFile(path.join(home, ".nexum-dev/program/active.json"), "utf8"),
      beforeRejected,
    );
    await installAgent({
      ...optionsFor(second, keys, home),
      replaceConfig: true,
      config: policyConfig,
    });
    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf8")),
      policyConfig,
    );
    const linkType = process.platform === "win32" ? "junction" : "dir",
      linkedVersionHome = path.join(root, "linked-version-home"),
      linkedVersions = path.join(
        linkedVersionHome,
        ".nexum-dev/program/versions",
      );
    await mkdir(linkedVersions, { recursive: true });
    await symlink(
      updated.programDir,
      path.join(linkedVersions, second.sha256),
      linkType,
    );
    await assert.rejects(
      installAgent(optionsFor(second, keys, linkedVersionHome)),
      /canonical/,
    );
    await assert.rejects(
      readFile(path.join(linkedVersionHome, ".nexum-dev/program/active.json")),
      { code: "ENOENT" },
    );
    // Every cleanup ancestor must be checked before opening a lock or removing
    // an authentic older program through a redirected profile path.
    for (const ancestor of ["home", "profile", "program", "versions"]) {
      const redirected = path.join(root, "cleanup-link-" + ancestor);
      if (ancestor === "home") await symlink(home, redirected, linkType);
      else {
        const relative = {
            profile: ".nexum-dev",
            program: ".nexum-dev/program",
            versions: ".nexum-dev/program/versions",
          }[ancestor],
          link = path.join(redirected, relative);
        await mkdir(path.dirname(link), { recursive: true });
        await symlink(path.join(home, relative), link, linkType);
        if (ancestor === "versions")
          await cp(
            path.join(home, ".nexum-dev/program/active.json"),
            path.join(redirected, ".nexum-dev/program/active.json"),
          );
      }
      await assert.rejects(
        cleanupPrograms({ profile: "development", home: redirected }),
        /canonical/,
      );
      assert.equal((await lstat(installed.programDir)).isDirectory(), true);
      await assert.rejects(
        lstat(path.join(home, ".nexum-dev/program/install.lock")),
        { code: "ENOENT" },
      );
    }
    const cleaned = await cleanupPrograms({ profile: "development", home });
    assert.deepEqual(cleaned.removed, [first.sha256]);
    assert.equal((await lstat(updated.programDir)).isDirectory(), true);
    assert.deepEqual(
      (await cleanupPrograms({ profile: "development", home })).removed,
      [],
    );
  },
);
test(
  "invalid digest, foreign signature, missing public trust and symlink target are rejected before activation",
  { timeout: 120000 },
  async (t) => {
    const root = await temporary(t),
      keys = await inputs(root),
      home = path.join(root, "home");
    await mkdir(home);
    const bundle = await buildAgent(keys),
      opts = optionsFor(bundle, keys, home);
    await assert.rejects(
      installAgent({ ...opts, sha256: "0".repeat(64) }),
      /checksum/,
    );
    const foreign = generateKeyPairSync("ed25519"),
      wrong = path.join(root, "wrong.pub");
    await writeFile(
      wrong,
      foreign.publicKey.export({ type: "spki", format: "pem" }),
    );
    await assert.rejects(
      installAgent({ ...opts, publicKeyFile: wrong }),
      /signature/,
    );
    await assert.rejects(installAgent({ ...opts, publicKeyFile: undefined }));
    assert.deepEqual(await readdir(home), []);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(
      outside,
      path.join(home, ".nexum-dev"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(installAgent(opts), /canonical/);
    assert.deepEqual(await readdir(outside), []);
  },
);
