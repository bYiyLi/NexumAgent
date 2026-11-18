import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installNpmAgent } from "../scripts/npm-install.mjs";

test("the fixed launcher restarts on a verified upgrade request without staging directories or an install lock", {
  timeout: 120000,
}, async (t) => {
  const scratch = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-launcher-fixture-")),
  );
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 3 }));
  const home = path.join(scratch, "home");
  const program = path.join(home, ".nexum-dev", "program");
  const source = path.join(scratch, "package");
  await mkdir(home, { recursive: true });
  for (const sub of ["dist", "contracts", "scripts", "node_modules"])
    await mkdir(path.join(source, sub), { recursive: true });
  await writeFile(
    path.join(source, "package.json"),
    '{"name":"@nexum-hub/agent","version":"0.0.1","type":"module"}',
  );
  const boots = path.join(home, "boots.txt");
  const marker = path.join(home, "upgrade-once.txt");
  const update = path.join(program, "update.json");
  const cli =
    "import {existsSync,writeFileSync,appendFileSync} from 'node:fs';" +
    "import {argv} from 'node:process';" +
    "if(argv.includes('--version')){console.log('0.0.1');process.exit(0)};" +
    "appendFileSync(" + JSON.stringify(boots) + ",'boot\\n');" +
    "if(!existsSync(" + JSON.stringify(marker) + ")){" +
    "writeFileSync(" + JSON.stringify(marker) + ",'1');" +
    "writeFileSync(" + JSON.stringify(update) + ",JSON.stringify({version:'0.0.1'}));" +
    "process.exit(75)}process.exit(0);";
  await writeFile(path.join(source, "dist", "cli.js"), cli);
  await writeFile(path.join(source, "contracts", "fixture.json"), "{}");
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs", "startup-report.mjs"])
    await cp(new URL("../scripts/" + name, import.meta.url),
      path.join(source, "scripts", name));
  await installNpmAgent({
    profile: "development", version: "0.0.1", home,
    register: false, source,
    config: { server_url: "http://127.0.0.1:8123/", token: "private-test-token" },
  });
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs", "startup-report.mjs"])
    await cp(new URL("../scripts/" + name, import.meta.url),
      path.join(program, name));
  await mkdir(path.join(program, "versions", ".install-old"), { recursive: true });
  await writeFile(path.join(program, "install.lock"), "stale");
  const startOnce = () => spawnSync(
    process.execPath,
    [path.join(program, "service-runner.mjs"), "--profile", "development"],
    { env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8", timeout: 12000 },
  );
  const first = startOnce();
  assert.equal(first.status, 75, first.stderr);
  assert.equal(await readFile(boots, "utf8"), "boot\n");
  assert.equal(existsSync(path.join(program, "install.lock")), false);
  assert.equal(existsSync(path.join(program, "versions")), false);
  const second = startOnce();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(boots, "utf8"), "boot\nboot\n");
  assert.equal(
    JSON.parse(await readFile(path.join(program, "installed.json"), "utf8")).version,
    "0.0.1",
  );
  assert.equal(
    (await readFile(path.join(home, ".nexum-dev", "logs", "agent.log"), "utf8"))
      .includes("agent_upgrade_required"),
    true,
  );
});

test("a malformed update request exits instead of launching an unverified Agent", {
  timeout: 15000,
}, async (t) => {
  const scratch = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-launcher-invalid-")),
  );
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 3 }));
  const home = path.join(scratch, "home");
  const program = path.join(home, ".nexum-dev", "program");
  await mkdir(program, { recursive: true });
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs", "startup-report.mjs"])
    await cp(new URL("../scripts/" + name, import.meta.url),
      path.join(program, name));
  await writeFile(path.join(program, "update.json"), '{"version":"not-valid"}');
  const result = spawnSync(
    process.execPath,
    [path.join(program, "service-runner.mjs"), "--profile", "development"],
    { env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 1);
});

test("invalid npm preflight blocks the verified Core", {
  timeout: 120000,
}, async (t) => {
  const scratch = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-launcher-degraded-")),
  );
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 3 }));
  const home = path.join(scratch, "home");
  const source = path.join(scratch, "source");
  const program = path.join(home, ".nexum-dev", "program");
  const marker = path.join(home, "core-executed");
  for (const sub of ["dist/application", "contracts", "scripts", "node_modules"])
    await mkdir(path.join(source, sub), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(source, "package.json"),
    '{"name":"@nexum-hub/agent","version":"0.0.1","type":"module"}');
  await writeFile(path.join(source, "dist/cli.js"),
    "if(process.argv.includes('--version'))console.log('0.0.1');");
  await writeFile(path.join(source, "dist/application/main.js"),
    "import {writeFileSync} from 'node:fs';export async function runAgent(){writeFileSync(" +
      JSON.stringify(marker) + ",'executed');return 0}");
  await writeFile(path.join(source, "contracts/fixture.json"), "{}");
  for (const name of [
    "service.mjs", "npm-install.mjs", "service-runner.mjs",
    "startup-report.mjs",
  ])
    await cp(new URL("../scripts/" + name, import.meta.url),
      path.join(source, "scripts", name));
  await installNpmAgent({
    profile: "development", version: "0.0.1", home,
    register: false, source,
    config: { server_url: "http://127.0.0.1:8123/",
      token: "private-test-token" },
  });
  for (const name of [
    "service.mjs", "npm-install.mjs", "service-runner.mjs",
    "startup-report.mjs",
  ])
    await cp(new URL("../scripts/" + name, import.meta.url),
      path.join(program, name));
  await writeFile(path.join(program, "update.json"),
    '{"version":"unapproved-latest"}');
  const result = spawnSync(process.execPath,
    ["--experimental-vm-modules", path.join(program, "service-runner.mjs"),
      "--profile", "development"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8", timeout: 12000,
    });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(await readFile(path.join(home,
    ".nexum-dev", "state", "startup-report.json"), "utf8"));
  assert.equal(report.activeVersion, "0.0.1");
  assert.equal(report.status, "blocked");
  assert.equal(report.issues[0].code, "agent_version_invalid");
  assert.equal(report.issues[0].stage, "version_resolution");
  assert.equal(existsSync(marker), false, "npm failure must not execute Core");
  const root = path.join(home, ".nexum-dev");
  const work = path.join(root, "work");
  await mkdir(path.join(root, "state", "maintenance"), { recursive: true });
  await mkdir(work, { recursive: true });
  const manifest = JSON.stringify({
    private: true, type: "module", dependencies: { example: "1.0.0" },
  });
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: { "node_modules/example": { version: "1.0.0" } },
  });
  await writeFile(path.join(work, "package.json"), JSON.stringify({
    private: true, type: "module", dependencies: { changed: "1.0.0" },
  }));
  await writeFile(path.join(work, "package-lock.json"), lock);
  await writeFile(path.join(root, "state", "maintenance", "packages.json"),
    JSON.stringify({
      version: 1, profile: "development", root,
      approved: { example: "1.0.0" }, manifest, lock,
    }));
  await writeFile(path.join(program, "update.json"), '{"version":"0.0.1"}');
  const dependencyFailure = spawnSync(process.execPath,
    ["--experimental-vm-modules", path.join(program, "service-runner.mjs"),
      "--profile", "development"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8", timeout: 12000,
    });
  assert.equal(dependencyFailure.status, 0, dependencyFailure.stderr);
  assert.equal(existsSync(marker), true,
    "failed optional npm dependencies must not block a valid Core");
  const dependencyReport = JSON.parse(await readFile(path.join(root,
    "state", "startup-report.json"), "utf8"));
  assert.equal(dependencyReport.status, "degraded");
  assert.equal(dependencyReport.issues[0].component, "npm");
  assert.equal(dependencyReport.issues[0].stage, "work_dependencies");
  assert.equal(dependencyReport.issues[0].code, "npm_approval_changed");
  const rows = (await readFile(path.join(root, "logs", "startup.log"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(rows.some((entry) => entry.stage === "work_npm" &&
    entry.code === "failed" &&
    entry.failureCode === "npm_approval_changed"));
  const npmCli = path.join(program, "runtime",
    ...(process.platform === "win32"
      ? ["node_modules", "npm", "bin", "npm-cli.js"]
      : ["lib", "node_modules", "npm", "bin", "npm-cli.js"]));
  await rm(npmCli, { force: true });
  await rm(marker, { force: true });
  const cliFailure = spawnSync(process.execPath,
    ["--experimental-vm-modules", path.join(program, "service-runner.mjs"),
      "--profile", "development"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8", timeout: 12000,
    });
  assert.equal(cliFailure.status, 1, cliFailure.stderr);
  const cliReport = JSON.parse(await readFile(path.join(root,
    "state", "startup-report.json"), "utf8"));
  assert.equal(cliReport.status, "blocked");
  assert.equal(cliReport.issues[0].component, "npm");
  assert.equal(cliReport.issues[0].stage, "npm_runtime");
  assert.equal(existsSync(marker), false,
    "missing managed npm CLI cannot be bypassed by a valid Core binary");
});

test("native VM launcher imports the Agent into its own Node process rather than spawning a second Node", {
  timeout: 120000,
}, async (t) => {
  const scratch = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-launcher-single-node-")),
  );
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 3 }));
  const home = path.join(scratch, "home");
  await mkdir(home, { recursive: true });
  const source = path.join(scratch, "source");
  const program = path.join(home, ".nexum-dev", "program");
  const marker = path.join(home, "runtime.json");
  for (const sub of ["dist/application", "contracts", "scripts", "node_modules"])
    await mkdir(path.join(source, sub), { recursive: true });
  await writeFile(
    path.join(source, "package.json"),
    '{"name":"@nexum-hub/agent","version":"0.0.1","type":"module"}',
  );
  await writeFile(
    path.join(source, "dist/cli.js"),
    "if(process.argv.includes('--version')){console.log('0.0.1')}else{process.exit(91)}",
  );
  await writeFile(path.join(source, "contracts", "fixture.json"), "{}");
  await writeFile(
    path.join(source, "dist/application/main.js"),
    "import {writeFileSync} from 'node:fs';export async function runAgent(profile,{version}){writeFileSync(" +
      JSON.stringify(marker) +
      ",JSON.stringify({pid:process.pid,argv:process.argv.slice(2),flags:process.execArgv,profile,version}));return process.env.NEXUM_FIXTURE_RESTART==='1'?76:0}",
  );
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs", "startup-report.mjs"])
    await cp(new URL("../scripts/" + name, import.meta.url),
      path.join(source, "scripts", name));
  await installNpmAgent({
    profile: "development", version: "0.0.1", home,
    register: false, source,
    config: { server_url: "http://127.0.0.1:8123/", token: "private-test-token" },
  });
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs", "startup-report.mjs"])
    await cp(new URL("../scripts/" + name, import.meta.url),
      path.join(program, name));
  const invocation = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", path.join(program, "service-runner.mjs"),
      "--profile", "development"],
    { encoding: "utf8", timeout: 12000,
      env: { ...process.env, HOME: home, USERPROFILE: home } },
  );
  assert.equal(invocation.status, 0, invocation.stderr);
  const fact = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(fact.pid, invocation.pid,
    "the business Agent must reuse the original Node launcher process");
  assert.deepEqual(fact.argv, ["--profile", "development"]);
  assert.ok(fact.flags.includes("--experimental-vm-modules"));
  assert.equal(fact.profile, "development");
  assert.equal(fact.version, "0.0.1");
  const restart = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", path.join(program, "service-runner.mjs"),
      "--profile", "development"],
    { encoding: "utf8", timeout: 12000,
      env: { ...process.env, HOME: home, USERPROFILE: home,
        NEXUM_FIXTURE_RESTART: "1" } },
  );
  assert.equal(restart.status, 76,
    "an accepted restart must return a nonzero Supervisor-owned exit");
  const rows = (await readFile(path.join(home, ".nexum-dev",
    "logs", "agent.log"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(rows.some((entry) => entry.code === "agent_restart_requested"),
    "the handoff must be retained in local diagnostics");
});
