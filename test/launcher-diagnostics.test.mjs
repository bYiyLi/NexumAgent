import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installNpmAgent } from "../scripts/npm-install.mjs";
import { coreFailureForAttempt } from "../scripts/startup-report.mjs";

test("Launcher records same-boot Core failure stage, error and module without credentials", {
  timeout: 120000,
}, async (t) => {
  const scratch = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-launcher-core-failure-")),
  );
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 3 }));
  const home = path.join(scratch, "home");
  const root = path.join(home, ".nexum-dev");
  const program = path.join(root, "program");
  const source = path.join(scratch, "source");
  const secret = "nx_agt_DO_NOT_PRINT";
  await mkdir(home, { recursive: true });
  for (const sub of ["dist/application", "contracts", "scripts", "node_modules"])
    await mkdir(path.join(source, sub), { recursive: true });
  await writeFile(path.join(source, "package.json"),
    '{"name":"@nexum-hub/agent","version":"0.0.1","type":"module"}');
  await writeFile(path.join(source, "dist/cli.js"),
    "if(process.argv.includes('--version')) console.log('0.0.1');");
  const errorLog = path.join(root, "logs", "agent.log");
  await writeFile(path.join(source, "dist/application/main.js"),
    "import {appendFileSync,mkdirSync} from 'node:fs';" +
    "import {dirname} from 'node:path';" +
    "export async function runAgent(profile,{attemptId}){" +
    "const file=" + JSON.stringify(errorLog) + ";" +
    "mkdirSync(dirname(file),{recursive:true});" +
    "appendFileSync(file,JSON.stringify({time:new Date().toISOString()," +
    "profile,code:'agent_startup_failed',retry:false,attemptId,component:'core'," +
    "phase:'core_initialize',failureCode:'storage_error',sourceCode:'ERR_SQLITE_ERROR'," +
    "sourceModule:'storage/sqlite',exceptionType:'TypeError'," +
    "recoveryCode:'inspect_storage'})+'\\n');" +
    "return process.env.NEXUM_FIXTURE_PERMANENT==='1'?78:1;}");
  await writeFile(path.join(source, "contracts/fixture.json"), "{}");
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs",
    "startup-report.mjs"])
    await cp(new URL("../scripts/" + name, import.meta.url),
      path.join(source, "scripts", name));
  await installNpmAgent({
    profile: "development", version: "0.0.1", home,
    register: false, source,
    config: { server_url: "http://127.0.0.1:8123/", token: secret },
  });
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs",
    "startup-report.mjs"])
    await cp(new URL("../scripts/" + name, import.meta.url),
      path.join(program, name));
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules",
    path.join(program, "service-runner.mjs"),
    "--profile", "development",
  ], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8", timeout: 12000,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(await readFile(
    path.join(root, "state", "startup-report.json"), "utf8",
  ));
  assert.equal(report.status, "blocked");
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].stage, "core_initialize");
  assert.equal(report.issues[0].code, "storage_error");
  assert.equal(report.issues[0].sourceModule, "storage/sqlite");
  assert.equal(report.issues[0].exceptionType, "TypeError");
  assert.equal(report.issues[0].sourceCode, "ERR_SQLITE_ERROR");
  const startup = (await readFile(path.join(root, "logs", "startup.log"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.ok(startup.some((event) => event.stage === "core_runtime" &&
    event.code === "failed" && event.attemptId === report.attemptId &&
    event.failureCode === "storage_error"));
  assert.doesNotMatch(JSON.stringify(report) + JSON.stringify(startup) + result.stderr,
    /nx_agt_DO_NOT_PRINT/);

  assert.equal(await coreFailureForAttempt(root, "development",
    "00000000-0000-4000-8000-000000000000"), null,
  "an old/different attempt must not be attributed to this failure");
  assert.equal((await coreFailureForAttempt(root, "development", report.attemptId)).code,
    "storage_error");

  const permanent = spawnSync(process.execPath, [
    "--experimental-vm-modules",
    path.join(program, "service-runner.mjs"),
    "--profile", "development",
  ], {
    env: { ...process.env, HOME: home, USERPROFILE: home,
      NEXUM_FIXTURE_PERMANENT: "1" },
    encoding: "utf8", timeout: 12000,
  });
  assert.equal(permanent.status, 0,
    "permanent Core failure should stop the native supervisor retry loop");
  const finalReport = JSON.parse(await readFile(
    path.join(root, "state", "startup-report.json"), "utf8",
  ));
  assert.equal(finalReport.status, "blocked",
    "a stopped retry loop must not mean Core started successfully");
  assert.equal(finalReport.issues[0].code, "storage_error");
  assert.notEqual(finalReport.attemptId, report.attemptId);
});
