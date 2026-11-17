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
  loadServicePlan,
} from "../scripts/service.mjs";
import { npmRegistries } from "../scripts/npm-install.mjs";
import { windowsConsoleProbe } from "../scripts/native-console-probe.mjs";

test("native console probe has real PowerShell here-string newlines and distinct failure codes", () => {
  const script = windowsConsoleProbe(12345);
  assert.ok(script.includes("@'\n"), "opening here-string must end with a real line break");
  assert.ok(script.includes("\n'@\n"), "closing here-string must start on its own line");
  assert.ok(!script.includes("\\n"), "literal slash-n makes PowerShell parse fail");
  assert.ok(script.includes("AttachConsole([uint32]12345)"));
  assert.match(script, /exit 11/); // real console association
  assert.match(script, /exit 12/); // unexpected native API error
  assert.match(script, /exit 0/); // no console association
  assert.throws(() => windowsConsoleProbe(0));
  assert.throws(() => windowsConsoleProbe(1.5));
});
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
      assert.match(plan.content, /ExecStart=:"\/tmp\/User 空格 & \$ %%/);
      assert.doesNotMatch(plan.content, /\$\$/);
      assert.match(plan.content, /WorkingDirectory=\/tmp\/User 空格 & \$ %%/);
      assert.match(plan.content, /UnsetEnvironment=NODE_OPTIONS NODE_PATH/);
    }
    if (platform === "win32") {
      assert.match(plan.content, /<LogonType>InteractiveToken/);
      assert.match(plan.content, /-WindowStyle/);
      assert.match(plan.content, /Hidden/);
      assert.match(plan.launcher, /New-Object System\.Diagnostics\.ProcessStartInfo/);
      assert.match(plan.launcher, /\[NexumAgentService\.JobOwner\]::DetachConsole\(\)/);
      assert.match(plan.launcher, /static extern bool FreeConsole\(\)/);
      assert.match(plan.launcher, /\$nexumStart\.UseShellExecute = \$false/);
      assert.match(plan.launcher, /\$nexumStart\.CreateNoWindow = \$true/);
      assert.match(plan.launcher, /\$nexumStart\.RedirectStandardOutput = \$true/);
      assert.match(plan.launcher, /\$nexumStart\.RedirectStandardError = \$true/);
      assert.match(plan.launcher, /\$nexumProcess\.BeginOutputReadLine\(\)/);
      assert.match(plan.launcher, /\$nexumProcess\.BeginErrorReadLine\(\)/);
      assert.match(plan.launcher, /\$nexumProcess\.WaitForExit\(\)/);
      assert.doesNotMatch(plan.launcher, /^\s*&\s*['"]?C:/m);
      assert.match(plan.content, /<RunLevel>LeastPrivilege/);
      assert.match(plan.content, /<ExecutionTimeLimit>PT0S/);
      assert.match(plan.content, /<Count>255/);
      assert.match(plan.content, /<MultipleInstancesPolicy>IgnoreNew/);
      assert.ok(plan.launcher.includes("while ($true)"));
      assert.ok(plan.launcher.includes("$nexumExit -eq 0"));
      assert.ok(plan.launcher.includes("exit 0"));
      assert.ok(plan.launcher.includes("Start-Sleep -Seconds 10"));
      assert.ok(plan.launcher.includes("Remove-Item Env:NODE_OPTIONS"));
    }
  }
});
test("npm mirror follows mainland timezone rather than UTC offset", () => {
  for (const zone of ["Asia/Shanghai", "Asia/Urumqi"]) {
    assert.deepEqual(npmRegistries(zone), [
      "https://registry.npmmirror.com/",
      "https://registry.npmjs.org/",
    ]);
  }
  for (const zone of ["Asia/Singapore", "Asia/Taipei", "UTC"]) {
    assert.deepEqual(npmRegistries(zone), ["https://registry.npmjs.org/"]);
  }
});
test("npm-managed native service launches a stable local runner rather than npx or an old version", async (t) => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const home = platform === "win32" ? "C:\\Users\\Agent" : "/tmp/agent-user";
    const p = platform === "win32" ? path.win32 : path.posix;
    const root = p.join(home, ".nexum-dev", "program");
    const plan = servicePlan({
      platform,
      home,
      profile: "development",
      npmManaged: true,
      userId: 501,
      windowsSid: "S-1-5-21-1-2-3-1001",
      programDir: root,
    });
    assert.equal(
      plan.node,
      p.join(root, "runtime", platform === "win32" ? "node.exe" : "bin/node"),
    );
    assert.deepEqual(plan.args, [
      p.join(root, "service-runner.mjs"),
      "--profile",
      "development",
    ]);
    assert.equal(
      plan.native,
      p.join(root, platform === "win32" ? "nexum-agent.exe" : "nexum-agent"),
    );
    assert.deepEqual(plan.nativeArgs, ["--profile", "development", "--home", home]);
    assert.ok(plan.content.includes("nexum-agent"));
    assert.doesNotMatch(plan.content, /service-runner\.mjs/);
    if (platform === "win32") {
      assert.equal(plan.launcher, undefined);
      assert.equal(plan.launcherPath, undefined);
      assert.match(plan.content, /<LogonType>InteractiveToken/);
      assert.match(plan.content, /<MultipleInstancesPolicy>IgnoreNew/);
      assert.match(plan.content, /nexum-agent\.exe/);
      assert.doesNotMatch(plan.content, /powershell\.exe|service-launch\.ps1/i);
    }
    assert.doesNotMatch(plan.content, /npx|0\.0\.2-next\.123/);
  }
  const home = await temporary(t);
  const program = path.join(home, ".nexum-dev", "program");
  await mkdir(program, { recursive: true });
  await writeFile(
    path.join(program, "installed.json"),
    JSON.stringify({ version: "0.0.2", directory: "app" }),
  );
  const loaded = await loadServicePlan("development", home);
  assert.equal(loaded.entry, path.join(program, "service-runner.mjs"));
  assert.equal(loaded.programDir, program);
  assert.equal(loaded.native, path.join(program,
    process.platform === "win32" ? "nexum-agent.exe" : "nexum-agent"));
});

test("preparing a service preview cannot overwrite the selected manifest or its Windows launcher", async (t) => {
  const home = await temporary(t),
    selected = planFor(process.platform, home),
    preview = servicePlan({
      profile: "development",
      home,
      platform: process.platform,
      userId: 501,
      windowsSid: "S-1-5-21-1-2-3-1001",
      programDir: selected.programDir,
      preview: true,
    });
  await writeServiceManifest(selected);
  const original = await readFile(selected.manifestPath),
    launcher = selected.launcherPath
      ? await readFile(selected.launcherPath)
      : null;
  await writeServiceManifest(preview);
  assert.notEqual(preview.manifestPath, selected.manifestPath);
  assert.deepEqual(await readFile(selected.manifestPath), original);
  if (launcher) {
    assert.notEqual(preview.launcherPath, selected.launcherPath);
    assert.deepEqual(await readFile(selected.launcherPath), launcher);
    assert.match(
      await readFile(preview.manifestPath, "utf16le"),
      /service-preview-launch\.ps1/,
    );
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
    const parser = spawnSync(
      path.join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$issues=$null;$tokens=$null;[System.Management.Automation.Language.Parser]::ParseFile('" +
          plan.launcherPath.replaceAll("'", "''") +
          "',[ref]$tokens,[ref]$issues)|Out-Null;if($issues.Count){$issues|Out-String|Write-Host;exit 1}",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(parser.status, 0, parser.stderr || parser.stdout);
  },
);
test("service/build child environment strips Agent credentials and Node preloads without changing the caller", () => {
  const environment = {
    PATH: "/usr/bin",
    NODE_OPTIONS: "--require private.js",
    NODE_PATH: "/private",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    NEXUM_AGENT_TOKEN: "secret",
    OTHER_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    npm_config__auth: "secret",
    HOME: "/home/user",
    LANG: "zh_CN.UTF-8",
  };
  const copy = childEnvironment(environment);
  assert.equal(copy.PATH, environment.PATH);
  assert.equal(copy.HOME, environment.HOME);
  assert.equal(copy.NODE_OPTIONS, undefined);
  assert.equal(copy.PSModulePath, undefined);
  assert.equal(
    environment.PSModulePath,
    "C:\\Program Files\\PowerShell\\7\\Modules",
  );
  assert.equal(copy.NEXUM_AGENT_TOKEN, undefined);
  assert.equal(copy.OPENAI_API_KEY, undefined);
  assert.equal(copy.npm_config__auth, undefined);
  assert.equal(environment.OTHER_TOKEN, "secret");
});
