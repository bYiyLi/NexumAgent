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
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs"])
    await cp(new URL("../scripts/" + name, import.meta.url),
      path.join(source, "scripts", name));
  await installNpmAgent({
    profile: "development", version: "0.0.1", home,
    register: false, source,
    config: { server_url: "http://127.0.0.1:8123/", token: "private-test-token" },
  });
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs"])
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
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs"])
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
