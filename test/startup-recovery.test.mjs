import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  reconcileStartupPackages, updateStartupPackages, startupEvent, startupIssue, verifyStartupNpm,
  writeStartupReport,
} from "../scripts/startup-report.mjs";

const diagnostic = await import(
  new URL("../dist/application/startup-report.js", import.meta.url)
);

async function fixture(t, desired = "2.0.0", installed = "1.0.0") {
  const home = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-startup-")),
  );
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(home, ".nexum-dev");
  const work = path.join(root, "work");
  const program = path.join(root, "program");
  for (const dir of [work, program, path.join(root, "state", "maintenance")])
    await mkdir(dir, { recursive: true });
  const manifest = JSON.stringify({
    private: true, type: "module",
    dependencies: { "example-browser": desired },
  });
  const lock = JSON.stringify({
    lockfileVersion: 3,
    name: "startup-fixture",
    packages: {
      "": { dependencies: { "example-browser": desired } },
      "node_modules/example-browser": { version: desired },
    },
  });
  await writeFile(path.join(work, "package.json"), manifest);
  await writeFile(path.join(work, "package-lock.json"), lock);
  await writeFile(path.join(root, "state", "maintenance", "packages.json"),
    JSON.stringify({
      version: 1, profile: "development", root,
      agentId: "fixture-agent",
      approved: { "example-browser": desired },
      manifest, lock,
    }));
  if (installed) {
    const pkg = path.join(work, "node_modules", "example-browser");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "package.json"),
      JSON.stringify({ name: "example-browser", version: installed }));
  }
  return { root, work, program, manifest, lock };
}

test("npm CLI verification is mandatory even without optional work packages", async (t) => {
  const f = await fixture(t);
  const checked = await verifyStartupNpm({
    program: f.program,
    run: async (_node, args) => {
      assert.ok(args.includes("--version"));
      assert.ok(args.some((arg) => arg.endsWith("npm-cli.js")));
      return "10.34.5";
    },
  });
  assert.equal(checked.version, "10.34.5");
  await assert.rejects(verifyStartupNpm({
    program: f.program,
    run: async () => "not-a-version",
  }), { code: "npm_runtime_invalid" });
  await assert.rejects(verifyStartupNpm({
    program: f.program,
    run: async () => {
      throw Object.assign(new Error("npm unavailable"), { code: "ENOENT" });
    },
  }), { code: "ENOENT" });
});

test("approved exact npm graph installs before Core with atomic staging and verified swap", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await reconcileStartupPackages({
    ...f, profile: "development", registries: ["https://registry.invalid/"],
    install: async (_exe, argv, cwd) => {
      calls++;
      assert.ok(argv.includes("ci"));
      assert.ok(argv.includes("--workspaces=false"));
      assert.ok(argv.some((one) => one.startsWith("--registry=")));
      await mkdir(path.join(cwd, "node_modules", "example-browser"),
        { recursive: true });
      await writeFile(path.join(cwd, "node_modules", "example-browser", "package.json"),
        JSON.stringify({ name: "example-browser", version: "2.0.0" }));
    },
  });
  assert.equal(result.status, "updated");
  assert.equal(result.packageCount, 1);
  assert.equal(calls, 1);
  const pkg = JSON.parse(await readFile(path.join(f.work, "node_modules",
    "example-browser", "package.json"), "utf8"));
  assert.equal(pkg.version, "2.0.0");
  const second = await reconcileStartupPackages({
    ...f, profile: "development",
    install: async () => assert.fail("an unchanged graph must never redownload"),
  });
  assert.equal(second.status, "ready");
});

test("failed npm download keeps the last runnable work graph intact", async (t) => {
  const f = await fixture(t);
  const failure = Object.assign(new Error("redacted secret"),
    { code: "ETIMEDOUT" });
  await assert.rejects(
    reconcileStartupPackages({
      ...f, profile: "development",
      registries: ["https://registry.invalid/"],
      install: async () => { throw failure; },
    }),
    { code: "ETIMEDOUT" },
  );
  const pkg = JSON.parse(await readFile(path.join(f.work,
    "node_modules", "example-browser", "package.json"), "utf8"));
  assert.equal(pkg.version, "1.0.0");
});

test("automatic update changes only approved direct packages and retains exact evidence", async (t) => {
  const f = await fixture(t, "1.0.0", "1.0.0");
  const result = await updateStartupPackages({
    ...f, profile: "development", registries: ["https://registry.invalid/"],
    install: async (_node, argv, cwd) => {
      assert.ok(argv.includes("install"));
      assert.ok(argv.includes("example-browser@latest"));
      assert.ok(argv.includes("--save-exact"));
      await writeFile(path.join(cwd, "package.json"), JSON.stringify({
        private: true, type: "module", dependencies: { "example-browser": "1.2.0" },
      }));
      await writeFile(path.join(cwd, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3, packages: {
          "node_modules/example-browser": { version: "1.2.0" },
        },
      }));
      await mkdir(path.join(cwd, "node_modules", "example-browser"), { recursive: true });
      await writeFile(path.join(cwd, "node_modules", "example-browser", "package.json"),
        JSON.stringify({ name: "example-browser", version: "1.2.0" }));
    },
  });
  assert.equal(result.status, "updated");
  const record = JSON.parse(await readFile(path.join(f.root,
    "state", "maintenance", "packages.json"), "utf8"));
  assert.deepEqual(record.approved, { "example-browser": "1.2.0" });
  assert.equal(record.manifest, await readFile(path.join(f.work, "package.json"), "utf8"));
  assert.equal(record.lock, await readFile(path.join(f.work, "package-lock.json"), "utf8"));
  const installed = JSON.parse(await readFile(path.join(f.work,
    "node_modules", "example-browser", "package.json"), "utf8"));
  assert.equal(installed.version, "1.2.0");
});

test("failed automatic update keeps old npm files and runnable package intact", async (t) => {
  const f = await fixture(t, "1.0.0", "1.0.0");
  const recordFile = path.join(f.root, "state", "maintenance", "packages.json");
  const before = await Promise.all([
    readFile(recordFile, "utf8"),
    readFile(path.join(f.work, "package.json"), "utf8"),
    readFile(path.join(f.work, "package-lock.json"), "utf8"),
  ]);
  await assert.rejects(updateStartupPackages({
    ...f, profile: "development", registries: ["https://registry.invalid/"],
    install: async () => {
      throw Object.assign(new Error("Private npm details"), { code: "ETIMEDOUT" });
    },
  }), { code: "ETIMEDOUT" });
  assert.deepEqual(await Promise.all([
    readFile(recordFile, "utf8"),
    readFile(path.join(f.work, "package.json"), "utf8"),
    readFile(path.join(f.work, "package-lock.json"), "utf8"),
  ]), before);
  const installed = JSON.parse(await readFile(path.join(f.work,
    "node_modules", "example-browser", "package.json"), "utf8"));
  assert.equal(installed.version, "1.0.0");
});

test("Dev Nexum packages use next, and a newly added direct dependency is rejected", async (t) => {
  const f = await fixture(t, "1.0.0", "1.0.0");
  const name = "@nexum-hub/browser";
  const manifest = JSON.stringify({ dependencies: { [name]: "1.0.0" } });
  const lock = JSON.stringify({ packages: {
    ["node_modules/" + name]: { version: "1.0.0" },
  } });
  await writeFile(path.join(f.work, "package.json"), manifest);
  await writeFile(path.join(f.work, "package-lock.json"), lock);
  const approvalFile = path.join(f.root, "state", "maintenance", "packages.json");
  await writeFile(approvalFile, JSON.stringify({
    version: 2, root: f.root, profile: "development",
    approved: { [name]: "1.0.0" }, manifest, lock,
  }));
  await mkdir(path.join(f.work, "node_modules", "@nexum-hub", "browser"),
    { recursive: true });
  await writeFile(path.join(f.work, "node_modules", "@nexum-hub", "browser", "package.json"),
    JSON.stringify({ name, version: "1.0.0" }));
  await assert.rejects(updateStartupPackages({
    ...f, profile: "development", registries: ["https://registry.invalid/"],
    install: async (_node, argv, cwd) => {
      assert.ok(argv.includes("@nexum-hub/browser@next"));
      await writeFile(path.join(cwd, "package.json"), JSON.stringify({
        dependencies: { [name]: "1.1.0", unapproved: "1.0.0" },
      }));
      await writeFile(path.join(cwd, "package-lock.json"), lock);
    },
  }), { code: "npm_update_graph_invalid" });
  const saved = JSON.parse(await readFile(approvalFile, "utf8"));
  assert.deepEqual(saved.approved, { [name]: "1.0.0" });
});

test("unapproved drift cannot trigger an unapproved install", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.work, "package.json"),
    JSON.stringify({ dependencies: { "other-package": "8.8.8" } }));
  await assert.rejects(reconcileStartupPackages({
    ...f, profile: "development",
    install: async () => assert.fail("the unapproved graph must not install"),
  }), { code: "npm_approval_changed" });
});

test("Launcher accepts local v2 npm approvals after a Cloud identity change", async (t) => {
  const f = await fixture(t, "1.0.0", "1.0.0");
  const filename = path.join(f.root, "state", "maintenance", "packages.json");
  const old = JSON.parse(await readFile(filename, "utf8"));
  await writeFile(filename, JSON.stringify({
    version: 2,
    root: old.root,
    profile: old.profile,
    approved: old.approved,
    manifest: old.manifest,
    lock: old.lock,
  }));
  const result = await reconcileStartupPackages({
    ...f, profile: "development",
    install: async () => assert.fail("Already installed v2 packages must not be downloaded"),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.packageCount, 1);

  await writeFile(filename, JSON.stringify({
    ...JSON.parse(await readFile(filename, "utf8")),
    agentId: "unexpected-cloud-id",
  }));
  await assert.rejects(reconcileStartupPackages({
    ...f, profile: "development",
  }), { code: "npm_approval_changed" });
});

test("npm-blocked startup is private, not misreported as live Core, and optional faults remain actionable", async (t) => {
  const f = await fixture(t);
  const issue = startupIssue("npm", "work_dependencies", "ETIMEDOUT", {
    packageName: "example-browser", targetVersion: "2.0.0",
    activeVersion: "1.0.0",
  });
  await writeStartupReport(f.root, {
    version: 1, profile: "development", attemptId: randomUUID(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    targetVersion: "0.0.3-next.19", activeVersion: "0.0.3-next.18",
    status: "blocked", issues: [issue],
  });
  await startupEvent(f.root, "development", "work_npm", "failed", {
    durationMs: 117, componentCount: 1,
    injectedToken: "must never appear",
  });
  assert.equal(diagnostic.readStartupReport(f.root, "development"), null,
    "a blocked npm startup cannot become a live Agent instruction");
  const blocked = JSON.parse(await readFile(path.join(f.root, "state",
    "startup-report.json"), "utf8"));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.issues[0].code, "ETIMEDOUT");
  const logfile = await readFile(path.join(f.root, "logs", "startup.log"), "utf8");
  assert.match(logfile, /work_npm/);
  assert.doesNotMatch(logfile, /injectedToken|must never appear/);
  const extensionIssue = startupIssue("extension", "initialization",
    "extension_worker_exited", { packageName: "example-browser" });
  await writeStartupReport(f.root, {
    version: 1, profile: "development", attemptId: randomUUID(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    targetVersion: "0.0.3-next.19", activeVersion: "0.0.3-next.19",
    status: "degraded", issues: [extensionIssue],
  });
  const report = diagnostic.readStartupReport(f.root, "development");
  assert.equal(report.status, "degraded");
  const instruction = diagnostic.formatStartupInstruction(report, []);
  assert.match(instruction, /extension_worker_exited/);
  assert.match(instruction, /example-browser/);
  assert.doesNotMatch(instruction, /must never appear|ETIMEDOUT/);
  if (process.platform !== "win32")
    assert.equal((await stat(path.join(f.root, "state", "startup-report.json"))).mode & 0o077, 0);
  assert.equal(diagnostic.readStartupReport(f.root, "production"), null);
});
