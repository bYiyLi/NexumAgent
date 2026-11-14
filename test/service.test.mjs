import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  servicePlan,
  writeServiceManifest,
  childEnvironment,
  serviceAction,
  currentWindowsSid,
} from "../scripts/service.mjs";

const temporary = async (t) => {
  const root = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-services-")),
  );
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
};
const planFor = (platform, home) => {
  const p = platform === "win32" ? path.win32 : path.posix;
  return servicePlan({
    platform,
    profile: "development",
    home,
    userId: 501,
    windowsSid: "S-1-5-21-1-2-3-1001",
    programDir: p.join(
      home,
      ".nexum-dev",
      "program",
      "versions",
      "a".repeat(64),
    ),
  });
};
test("all native manifests use explicit profiles, absolute pinned Node argv and current-user authority", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const home =
      platform === "win32"
        ? "C:\\Users\\User 空格 & $ %"
        : "/tmp/User 空格 & $ %";
    const plan = planFor(platform, home);
    assert.ok(plan.node.includes("runtime"));
    assert.deepEqual(plan.args.slice(-3), ["run", "--profile", "development"]);
    assert.equal(plan.args[0], "--experimental-vm-modules");
    assert.doesNotMatch(
      plan.content,
      /fixture-private-token|server_url|HighestAvailable|<LogonType>Password|<LogonType>S4U/i,
    );
    if (platform === "darwin") {
      assert.match(plan.content, /SuccessfulExit<\/key><false\/>/);
      assert.match(plan.content, /&amp;/);
      assert.match(plan.content, /NODE_OPTIONS/);
      assert.match(
        plan.content,
        /StandardOutPath<\/key><string>\/dev\/null<\/string>/,
      );
      assert.match(
        plan.content,
        /StandardErrorPath<\/key><string>\/dev\/null<\/string>/,
      );
      assert.doesNotMatch(plan.content, /service\.(?:stdout|stderr)\.log/);
    }
    if (platform === "linux") {
      assert.match(plan.content, /Restart=on-failure/);
      assert.match(plan.content, /User 空格 & \$\$ %%/);
      assert.match(plan.content, /WorkingDirectory=\/tmp\/User 空格 & \$ %%/);
      assert.match(plan.content, /UnsetEnvironment=NODE_OPTIONS NODE_PATH/);
    }
    if (platform === "win32") {
      assert.match(plan.content, /<LogonType>InteractiveToken/);
      assert.match(plan.content, /<RunLevel>LeastPrivilege/);
      assert.match(plan.content, /<ExecutionTimeLimit>PT0S/);
      assert.match(plan.content, /<Count>255/);
      assert.match(plan.content, /<MultipleInstancesPolicy>IgnoreNew/);
      assert.ok(plan.launcher.includes("exit $LASTEXITCODE"));
      assert.ok(plan.launcher.includes("Remove-Item Env:NODE_OPTIONS"));
    }
  }
});
test("profile ownership and service file boundaries cannot target a project or traverse a symlink", async (t) => {
  const home = await temporary(t),
    plan = planFor(process.platform, home);
  assert.throws(() =>
    servicePlan({
      profile: "development",
      home,
      programDir: path.join(home, "project"),
      platform: process.platform,
      windowsSid: "S-1-5-21-1",
    }),
  );
  await writeServiceManifest(plan);
  assert.ok((await readFile(plan.manifestPath)).length > 0);
  if (process.platform === "win32") {
    const bytes = await readFile(plan.manifestPath);
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
    assert.deepEqual(
      [...(await readFile(plan.launcherPath)).subarray(0, 3)],
      [0xef, 0xbb, 0xbf],
    );
  } else if (process.platform === "darwin") {
    const result = spawnSync("/usr/bin/plutil", ["-lint", plan.manifestPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  await assert.rejects(
    serviceAction(plan, "start"),
    /actual current user's home/,
  );
  const other = await temporary(t),
    outside = await temporary(t);
  await symlink(
    outside,
    path.join(other, ".nexum-dev"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    writeServiceManifest(planFor(process.platform, other)),
    /canonical/,
  );
  assert.deepEqual(await readdir(outside), []);
});
test(
  "native Windows XML is accepted by Task Scheduler without registering a task",
  { skip: process.platform !== "win32" },
  async (t) => {
    const home = await temporary(t),
      plan = servicePlan({
        profile: "development",
        home,
        programDir: path.join(
          home,
          ".nexum-dev/program/versions",
          "b".repeat(64),
        ),
        windowsSid: currentWindowsSid(),
      });
    await writeServiceManifest(plan);
    const script =
      "$ErrorActionPreference='Stop';$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$t=$s.NewTask(0);$t.XmlText=[IO.File]::ReadAllText('" +
      plan.manifestPath.replaceAll("'", "''") +
      "');[Console]::Write('validated')";
    const result = spawnSync(
      path.join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /validated/);
  },
);
test("service/build child environment strips Agent credentials and Node preloads without changing the caller", () => {
  const environment = {
    PATH: "/usr/bin",
    NODE_OPTIONS: "--require private.js",
    NODE_PATH: "/private",
    NEXUM_AGENT_TOKEN: "secret",
    OTHER_TOKEN: "secret",
    HOME: "/home/user",
    LANG: "zh_CN.UTF-8",
  };
  const copy = childEnvironment(environment);
  assert.equal(copy.PATH, environment.PATH);
  assert.equal(copy.HOME, environment.HOME);
  assert.equal(copy.NODE_OPTIONS, undefined);
  assert.equal(copy.NEXUM_AGENT_TOKEN, undefined);
  assert.equal(environment.OTHER_TOKEN, "secret");
});
