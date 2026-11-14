import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import {
  mkdir,
  writeFile,
  rename,
  lstat,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "24.22.1";
const profiles = new Set(["development", "production"]);
const clean = (value) => {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value))
    throw new Error("Invalid service path or identity.");
  return value;
};
const xml = (value) =>
  clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const ps = (value) => "'" + clean(value).replaceAll("'", "''") + "'";
const unit = (value) =>
  '"' +
  clean(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%") +
  '"';
export function windowsArgument(value) {
  clean(value);
  return (
    '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"'
  );
}
export function childEnvironment(source = process.env) {
  // These fixed installer/service commands use Windows PowerShell 5.1. When
  // launched through Node under pwsh, its inherited PS7 path bypasses PowerShell's
  // direct-child compatibility cleanup and can load incompatible system modules.
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/^(?:NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|PSModulePath|NEXUM(?:_.*|$)|npm_config_.*auth.*|.*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|API_?KEY|PRIVATE_?KEY).*)$/i.test(
          key,
        ),
    ),
  );
}
export function servicePlan({
  profile,
  programDir,
  home = homedir(),
  platform = process.platform,
  userId = process.getuid?.(),
  windowsSid,
  preview = false,
} = {}) {
  if (
    !profiles.has(profile) ||
    !["darwin", "linux", "win32"].includes(platform)
  )
    throw new Error("Select an explicit supported Agent profile and platform.");
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(clean(home)) || !p.isAbsolute(clean(programDir)))
    throw new Error("Service paths must be absolute.");
  const root = p.join(
      home,
      profile === "development" ? ".nexum-dev" : ".nexum",
    ),
    versions = p.join(root, "program", "versions");
  const relative = p.relative(versions, programDir);
  if (
    !relative ||
    relative.startsWith("..") ||
    p.isAbsolute(relative) ||
    relative.includes(p.sep)
  )
    throw new Error(
      "Use one immutable version inside this profile's program directory.",
    );
  const node = p.join(
      programDir,
      "runtime",
      platform === "win32" ? "node.exe" : "bin/node",
    ),
    entry = p.join(programDir, "app", "dist", "cli.js");
  const args = [
    "--experimental-vm-modules",
    entry,
    "run",
    "--profile",
    profile,
  ];
  const runtimePath =
    p.dirname(node) +
    (platform === "win32" ? ";" : ":") +
    (platform === "win32"
      ? (process.env.PATH ?? "")
      : "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  const logs = p.join(root, "logs"),
    state = p.join(root, "state");
  const base = {
    profile,
    platform,
    home,
    root,
    programDir,
    node,
    entry,
    args,
    logs,
    state,
  };
  if (platform === "darwin") {
    if (!Number.isSafeInteger(userId) || userId < 0)
      throw new Error("Use the current target user's uid.");
    const label = `com.nexum.agent.${profile}.${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
    const program = [
      "/usr/bin/env",
      "-u",
      "NODE_OPTIONS",
      "-u",
      "NODE_PATH",
      "-u",
      "NODE_REPL_EXTERNAL_MODULE",
      node,
      ...args,
    ];
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${program.map((x) => `<string>${xml(x)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(runtimePath)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`;
    return {
      ...base,
      label,
      target: `gui/${userId}/${label}`,
      domain: `gui/${userId}`,
      manifestPath: preview
        ? p.join(state, "service-preview.plist")
        : p.join(home, "Library", "LaunchAgents", label + ".plist"),
      content,
    };
  }
  if (platform === "linux") {
    const label = `nexum-agent-${profile}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}.service`;
    const content = `[Unit]\nDescription=Nexum Agent (${profile})\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nExecStart=:${[node, ...args].map(unit).join(" ")}\nWorkingDirectory=${clean(root).replaceAll("%", "%%")}\nEnvironment=${unit("HOME=" + home)}\nEnvironment=${unit("PATH=" + runtimePath)}\nUnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE\nRestart=on-failure\nRestartSec=10s\nTimeoutStopSec=60s\nKillMode=mixed\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
    return {
      ...base,
      label,
      manifestPath: preview
        ? p.join(state, "service-preview.service")
        : p.join(home, ".config", "systemd", "user", label),
      content,
    };
  }
  if (typeof windowsSid !== "string" || !/^S-1-[0-9-]+$/.test(windowsSid))
    throw new Error("Use the current Windows user's actual SID.");
  const label = `Nexum.Agent.${profile}.${createHash("sha256")
    .update(windowsSid + "\n" + root)
    .digest("hex")
    .slice(0, 12)}`;
  const launcherPath = p.join(
    state,
    preview ? "service-preview-launch.ps1" : "service-launch.ps1",
  );
  const launcher = `$ErrorActionPreference = 'Stop'\nRemove-Item Env:NODE_OPTIONS,Env:NODE_PATH,Env:NODE_REPL_EXTERNAL_MODULE -ErrorAction SilentlyContinue\n${"$env:PATH = " + ps(p.dirname(node) + ";") + " + $env:PATH"}\n$env:USERPROFILE = ${ps(home)}\n& ${ps(node)} ${args.map(ps).join(" ")}\nexit $LASTEXITCODE\n`;
  const executable = p.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const actionArgs = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    launcherPath,
  ]
    .map(windowsArgument)
    .join(" ");
  const content = `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Nexum Agent (${profile}), current-user authority</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(windowsSid)}</UserId></LogonTrigger></Triggers><Principals><Principal id="TargetUser"><UserId>${xml(windowsSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfIdle>false</RunOnlyIfIdle><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure></Settings><Actions Context="TargetUser"><Exec><Command>${xml(executable)}</Command><Arguments>${xml(actionArgs)}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions></Task>\n`;
  return {
    ...base,
    label,
    windowsSid,
    launcherPath,
    launcher,
    manifestPath: p.join(
      state,
      preview ? "service-preview.xml" : "service-task.xml",
    ),
    content,
  };
}
async function writePrivate(filename, content, encoding = "utf8") {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const previous = await lstat(filename);
    if (!previous.isFile() || previous.isSymbolicLink())
      throw new Error("The service manifest is not a regular local file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = filename + `.${process.pid}.new`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600, encoding });
  await rename(temporary, filename);
}
export async function writeServiceManifest(plan) {
  const base = path.resolve(plan.home);
  if ((await realpath(base)) !== base)
    throw new Error("Use a canonical target home for service files.");
  const ensure = async (destination) => {
    const relative = path.relative(base, destination);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("A service file escaped the target user's home.");
    let current = base;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const info = await lstat(current);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(current)) !== current
      )
        throw new Error("Service directories must remain canonical.");
    }
  };
  for (const directory of [
    plan.logs,
    plan.state,
    path.dirname(plan.manifestPath),
  ])
    await ensure(directory);
  if (plan.launcher)
    await writePrivate(plan.launcherPath, "\uFEFF" + plan.launcher);
  await writePrivate(
    plan.manifestPath,
    plan.platform === "win32" ? "\uFEFF" + plan.content : plan.content,
    plan.platform === "win32" ? "utf16le" : "utf8",
  );
}

function execute(file, args, { allowFailure = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    env: childEnvironment(),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && !allowFailure))
    throw new Error(
      "The native user service command failed; inspect its current state before repeating a mutation.",
    );
  return result;
}
function powershell(script) {
  return execute(
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" +
        script,
    ],
  );
}
export function currentWindowsSid() {
  return powershell(
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  ).stdout.trim();
}
export async function serviceAction(
  plan,
  action,
  { isolatedHome = false } = {},
) {
  if (plan.platform !== process.platform)
    throw new Error("Use the actual native platform.");
  if (path.resolve(plan.home) !== path.resolve(homedir())) {
    const base = await realpath(process.env.RUNNER_TEMP || tmpdir()),
      actual = await realpath(plan.home),
      relative = path.relative(base, actual),
      info = await lstat(actual);
    if (
      !isolatedHome ||
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      actual !== path.resolve(plan.home) ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Native registration requires the actual current user's home or an explicit owned isolated home.",
      );
  }
  if (!["install", "start", "stop", "status", "remove"].includes(action))
    throw new Error("Unknown service action.");
  if (action === "install") await writeServiceManifest(plan);
  if (plan.platform === "linux") {
    if (action === "install") {
      execute("systemctl", [
        "--user",
        ...(isolatedHome ? ["--runtime"] : []),
        "enable",
        plan.manifestPath,
      ]);
      execute("systemctl", ["--user", "daemon-reload"]);
      return;
    }
    if (action === "status") {
      const result = execute(
        "systemctl",
        [
          "--user",
          "show",
          plan.label,
          "--property=LoadState,ActiveState,UnitFileState",
          "--no-pager",
        ],
        { allowFailure: true },
      );
      const output = result.stdout;
      const values = Object.fromEntries(
        output
          .trim()
          .split(/\r?\n/)
          .map((line) => line.split(/=(.*)/s).slice(0, 2)),
      );
      if (
        !values.LoadState ||
        (result.status !== 0 && values.LoadState !== "not-found")
      )
        throw new Error("The current user service state is unknown.");
      return {
        registered: values.LoadState !== "not-found",
        state: values.ActiveState ?? "unknown",
        enabled: [
          "enabled",
          "enabled-runtime",
          "linked",
          "linked-runtime",
        ].includes(values.UnitFileState),
      };
    }
    if (action === "start") {
      execute("systemctl", [
        "--user",
        ...(isolatedHome ? ["--runtime"] : []),
        "enable",
        plan.manifestPath,
      ]);
      execute("systemctl", ["--user", "daemon-reload"]);
      return execute("systemctl", ["--user", "start", plan.label]);
    }
    const current = await serviceAction(plan, "status", { isolatedHome });
    if (current.registered)
      execute("systemctl", [
        "--user",
        ...(isolatedHome ? ["--runtime"] : []),
        "disable",
        "--now",
        plan.label,
      ]);
    if (action === "remove") {
      await rm(plan.manifestPath, { force: true });
      execute("systemctl", ["--user", "daemon-reload"]);
    }
    return;
  }
  if (plan.platform === "darwin") {
    const loaded = () => {
      const result = execute("/bin/launchctl", ["print", plan.target], {
        allowFailure: true,
      });
      if (result.status === 0) return result;
      if (result.status === 113) return null;
      throw new Error(
        "The current launchd state is unknown; no mutation was retried.",
      );
    };
    if (action === "install") {
      execute("/bin/launchctl", ["enable", plan.target]);
      return;
    }
    if (action === "start") {
      const current = loaded();
      execute("/bin/launchctl", ["enable", plan.target]);
      return current
        ? execute("/bin/launchctl", ["kickstart", plan.target])
        : execute("/bin/launchctl", [
            "bootstrap",
            plan.domain,
            plan.manifestPath,
          ]);
    }
    const current = loaded(),
      pid = current
        ? Number(/^\s*pid = ([1-9][0-9]*)\s*$/m.exec(current.stdout)?.[1] ?? 0)
        : 0;
    if (action === "status") {
      let file = false;
      try {
        const info = await lstat(plan.manifestPath);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("The service file is not regular.");
        file = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return {
        registered: !!current || file,
        loaded: !!current,
        state: pid ? "running" : current ? "idle" : "unloaded",
        ...(pid ? { pid } : {}),
      };
    }
    execute("/bin/launchctl", ["disable", plan.target]);
    if (current) execute("/bin/launchctl", ["bootout", plan.target]);
    if (pid) {
      const deadline = performance.now() + 60000;
      while (true) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") break;
          throw error;
        }
        if (performance.now() >= deadline)
          throw new Error(
            "The previous service leader has not confirmed closure.",
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (action === "remove") {
      await rm(plan.manifestPath, { force: true });
      execute("/bin/launchctl", ["enable", plan.target]);
    }
    return;
  }
  const name = ps(plan.label);
  const stateScript = `try{$t=Get-ScheduledTask -TaskName ${name} -ErrorAction Stop}catch{if($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*'){[Console]::Write('{"registered":false,"state":"absent"}');exit 0}else{throw}};$i=Get-ScheduledTaskInfo -TaskName ${name};@{registered=$true;state=[string]$t.State;lastResult=$i.LastTaskResult}|ConvertTo-Json -Compress`;
  if (action === "install")
    return powershell(
      `Register-ScheduledTask -TaskName ${name} -Xml ([System.IO.File]::ReadAllText(${ps(plan.manifestPath)})) -Force | Out-Null`,
    );
  if (action === "status") return JSON.parse(powershell(stateScript).stdout);
  if (action === "start")
    return powershell(
      `Enable-ScheduledTask -TaskName ${name}|Out-Null;Start-ScheduledTask -TaskName ${name}`,
    );
  const current = JSON.parse(powershell(stateScript).stdout);
  if (current.registered) {
    powershell(`Disable-ScheduledTask -TaskName ${name}|Out-Null`);
    if (["Running", "Queued"].includes(current.state))
      powershell(`Stop-ScheduledTask -TaskName ${name}`);
    else if (!["Ready", "Disabled"].includes(current.state))
      throw new Error("The task's stop state is unknown.");
  }
  if (action === "remove") {
    if (current.registered)
      powershell(`Unregister-ScheduledTask -TaskName ${name} -Confirm:$false`);
    await rm(plan.manifestPath, { force: true });
    await rm(plan.launcherPath, { force: true });
  }
}

export async function loadServicePlan(profile, home = homedir()) {
  if (!profiles.has(profile))
    throw new Error("Select an explicit Agent profile.");
  const root = path.join(
    home,
    profile === "development" ? ".nexum-dev" : ".nexum",
  );
  const active = JSON.parse(
    await readFile(path.join(root, "program", "active.json"), "utf8"),
  );
  return servicePlan({
    profile,
    home,
    programDir: active.programDir,
    windowsSid: process.platform === "win32" ? currentWindowsSid() : undefined,
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [action, ...rest] = process.argv.slice(2);
  if (rest.length !== 2 || rest[0] !== "--profile")
    throw new Error("Use ACTION --profile development|production.");
  const plan = await loadServicePlan(rest[1]);
  const result = await serviceAction(plan, action);
  console.log(
    JSON.stringify(
      action === "status"
        ? result
        : { profile: plan.profile, action, acknowledged: true },
    ),
  );
}
