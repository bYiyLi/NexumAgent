import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  installNpmAgent, installedAgentVersion, npmExec,
  restoreInterruptedCoreUpdate,
} from "../scripts/npm-install.mjs";

async function packageSource(home, version) {
  const source = path.join(home, "source-" + version);
  for (const name of ["dist", "contracts", "scripts", "node_modules"]) {
    await mkdir(path.join(source, name), { recursive: true });
  }
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ name: "@nexum-hub/agent", version, type: "module" }),
  );
  await writeFile(
    path.join(source, "dist/cli.js"),
    "console.log(" + JSON.stringify(version) + ");\n",
  );
  await writeFile(path.join(source, "contracts/fixture.schema.json"), "{}");
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs"]) {
    await writeFile(
      path.join(source, "scripts", name),
      "export const testFixture = true;\n",
    );
  }
  return source;
}

test("interrupted npm Core swaps restore the exact verified previous version", {
  timeout: 120000,
}, async (t) => {
  const scratch = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-npm-recovery-")),
  );
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 3 }));
  const home = path.join(scratch, "home");
  await mkdir(home, { mode: 0o700 });
  const source = await packageSource(scratch, "0.0.1");
  await installNpmAgent({
    profile: "development", version: "0.0.1", home,
    source, register: false,
    config: { server_url: "http://127.0.0.1:8123/",
      token: "fixture-token" },
  });
  const program = path.join(home, ".nexum-dev", "program");
  const node = path.join(program, "runtime");
  const active = path.join(program, "app");
  assert.equal(await installedAgentVersion(program, node), "0.0.1");

  // Crash #1: the old app has moved aside, but the new stage is not active.
  const firstBackup = path.join(program,
    ".previous-00000000-0000-4000-8000-000000000001");
  await rename(active, firstBackup);
  assert.equal(await installedAgentVersion(program, node), null);
  assert.equal(await restoreInterruptedCoreUpdate(program, node), true);
  assert.equal(await installedAgentVersion(program, node), "0.0.1");
  assert.equal(existsSync(firstBackup), false);

  // Crash #2: the new app has been renamed into place, but the durable
  // receipt still names the prior version. Only the prior exact Core may run.
  const secondBackup = path.join(program,
    ".previous-00000000-0000-4000-8000-000000000002");
  await rename(active, secondBackup);
  const unverified = path.join(active, "node_modules", "@nexum-hub", "agent");
  await mkdir(unverified, { recursive: true });
  await writeFile(path.join(unverified, "package.json"),
    '{"name":"@nexum-hub/agent","version":"0.0.2"}');
  assert.equal(await installedAgentVersion(program, node), null);
  assert.equal(await restoreInterruptedCoreUpdate(program, node), true);
  assert.equal(await installedAgentVersion(program, node), "0.0.1");
  assert.equal(existsSync(secondBackup), false);
});

test(
  "npm installer installs one verified app without locks, keeps credentials and never registers a real service in isolation",
  { timeout: 120000 },
  async (t) => {
    const scratch = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), "nexum-npm-installer-fixture-")),
    );
    t.after(async () =>
      rm(scratch, { recursive: true, force: true, maxRetries: 3 }),
    );
    const home = path.join(scratch, "home");
    await mkdir(home, { mode: 0o700 });
    const firstSource = await packageSource(scratch, "0.0.1");
    const inputs = {
      profile: "development",
      version: "0.0.1",
      source: firstSource,
      home,
      register: false,
      config: {
        server_url: "http://127.0.0.1:8123/",
        token: "private-test-token",
      },
    };
    const first = await installNpmAgent(inputs);
    assert.deepEqual(first, {
      profile: "development",
      version: "0.0.1",
      serviceRegistered: false,
      startRequested: false,
    });
    const root = path.join(home, ".nexum-dev");
    assert.equal(
      JSON.parse(await readFile(path.join(root, "program/installed.json"), "utf8"))
        .version,
      "0.0.1",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).token,
      "private-test-token",
    );
    assert.equal(existsSync(path.join(root, "program/identity-replacement.json")), false);
    // Windows fs.stat().mode emulates Unix bits and does not report NTFS ACLs.
    if (process.platform !== "win32")
      assert.equal(
        (await stat(path.join(root, "config.json"))).mode & 0o077,
        0,
      );
    const runtime = path.join(
      root,
      "program/runtime",
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
    assert.ok((await stat(runtime)).isFile());
    assert.equal((await installNpmAgent(inputs)).version, "0.0.1");
    assert.equal(existsSync(path.join(root, "program/identity-replacement.json")), false);
    await mkdir(path.join(root, "work"), { recursive: true });
    await writeFile(path.join(root, "work/retained.txt"), "computer-owned work");
    await writeFile(path.join(root, "program/identity-replacement.json"), "obsolete marker");
    assert.equal((await installNpmAgent({
      ...inputs,
      config: {
        server_url: "http://127.0.0.1:8123/",
        token: "another-cloud-token",
      },
    })).version, "0.0.1");
    assert.equal(
      JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).token,
      "another-cloud-token",
    );
    assert.equal(await readFile(path.join(root, "work/retained.txt"), "utf8"), "computer-owned work");
    assert.equal(existsSync(path.join(root, "program/identity-replacement.json")), false);
    assert.equal(existsSync(path.join(root, "previous-agents")), false);
    assert.equal(
      (await readFile(path.join(root, "config.json"), "utf8")).includes(
        "another-cloud-token",
      ),
      true,
    );
    assert.ok(
      (
        await stat(path.join(root, "program/app/node_modules/@nexum-hub/agent/dist/cli.js"))
      ).isFile(),
    );
    const secondSource = await packageSource(scratch, "0.0.2");
    const second = await installNpmAgent({
      profile: "development",
      version: "0.0.2",
      source: secondSource,
      home,
      register: false,
    });
    assert.equal(second.version, "0.0.2");
    assert.equal(
      JSON.parse(await readFile(path.join(root, "program/installed.json"), "utf8"))
        .version,
      "0.0.2",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).token,
      "another-cloud-token",
    );
    assert.ok(
      (await stat(path.join(root, "program/app/node_modules/@nexum-hub/agent/package.json"))).isFile(),
      "one verified Agent package is installed",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, "program/installed.json"), "utf8")).version,
      "0.0.2",
    );
    assert.equal(existsSync(path.join(root, "program/install.lock")), false);
    assert.equal(existsSync(path.join(root, "program/versions")), false);
    await assert.rejects(
      () =>
        installNpmAgent({
          profile: "production",
          version: "0.0.3",
          home,
          register: false,
        }),
      /Server URL and Agent Token/,
    );
  },
);

test(
  "an interrupted fixed-directory install is rebuilt on retry and legacy debris is removed without deleting state",
  { timeout: 120000 },
  async (t) => {
    const scratch = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), "nexum-npm-recovery-")),
    );
    t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 3 }));
    const home = path.join(scratch, "home");
    await mkdir(home, { mode: 0o700 });
    const root = path.join(home, ".nexum-dev");
    const program = path.join(root, "program");
    const firstSource = await packageSource(scratch, "0.0.1");
    await installNpmAgent({
      profile: "development", version: "0.0.1", home,
      source: firstSource, register: false,
      config: { server_url: "http://127.0.0.1:8123/", token: "private-test-token" },
    });
    await mkdir(path.join(root, "work"), { recursive: true });
    await writeFile(path.join(root, "work", "protected-state"), "untouched");
    await mkdir(path.join(program, "versions", ".install-old"), { recursive: true });
    await writeFile(path.join(program, "install.lock"), "424242");
    const secondSource = await packageSource(scratch, "0.0.2");
    await rm(path.join(secondSource, "dist", "cli.js"));
    await assert.rejects(() => installNpmAgent({
      profile: "development", version: "0.0.2", home,
      source: secondSource, register: false,
    }));
    assert.equal(existsSync(path.join(program, "installed.json")), false);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(program, "update.json"), "utf8")),
      { version: "0.0.2" },
      "a failed install must persist its next recoverable target",
    );
    assert.equal(existsSync(path.join(program, "install.lock")), true);
    assert.equal(await readFile(path.join(root, "work", "protected-state"), "utf8"), "untouched");
    await writeFile(
      path.join(secondSource, "dist", "cli.js"),
      'console.log("0.0.2");\n',
    );
    const repaired = await installNpmAgent({
      profile: "development", version: "0.0.2", home,
      source: secondSource, register: false,
    });
    assert.equal(repaired.version, "0.0.2");
    assert.equal(existsSync(path.join(program, "install.lock")), false);
    assert.equal(existsSync(path.join(program, "versions")), false);
    assert.equal(existsSync(path.join(program, "active.json")), false);
    assert.equal(await readFile(path.join(root, "work", "protected-state"), "utf8"), "untouched");
    assert.equal(
      JSON.parse(await readFile(path.join(program, "installed.json"), "utf8")).version,
      "0.0.2",
    );
  },
);

test("a timed-out installer command kills its own real native descendant tree before retry", {
  timeout: 20000,
}, async (t) => {
  const scratch = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-installer-process-")),
  );
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 3 }));
  const pidFile = path.join(scratch, "child.pid");
  const code =
    "const fs=require('node:fs'), cp=require('node:child_process');" +
    "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
    "fs.writeFileSync(" + JSON.stringify(pidFile) + ",String(child.pid));" +
    "setInterval(()=>{},1000);";
  await assert.rejects(
    npmExec(process.execPath, ["-e", code], scratch, 2500),
    { code: "ETIMEDOUT" },
  );
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const active = async () => {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        const { readFile: read } = await import("node:fs/promises");
        const proc = await read("/proc/" + pid + "/stat", "utf8").catch(() => "");
        if (/\)\s+Z\s/.test(proc)) return false;
      }
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  let exited = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await active())) { exited = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(exited, "timed-out npm descendants must be observed stopped");
});
