/** Real native supervisors, only on an explicitly authorized ephemeral CI runner. */
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  cp,
  writeFile,
  readFile,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { servicePlan, serviceAction, currentWindowsSid } from "./service.mjs";

assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Native registration runs only on the authorized CI job.",
);
assert.equal(
  process.env.RUNNER_ENVIRONMENT,
  "github-hosted",
  "Use an ephemeral GitHub-hosted runner.",
);
assert.ok(process.env.RUNNER_TEMP);
const interrupted = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () =>
    interrupted.abort(new Error("Native CI interrupted.")),
  );
const base = await realpath(process.env.RUNNER_TEMP);
const home = await mkdtemp(path.join(base, "nexum-native-service 空格 & $ %-"));
let plan, originalManagerState;
const run = (file, args, allowFailure = false) => {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || (!allowFailure && result.status !== 0))
    throw new Error(
      `Native prerequisite failed: ${path.basename(file)} (${result.status ?? "unknown"}).`,
    );
  return result;
};
async function waitFor(check, label, timeout = 90000, cleaning = false) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (!cleaning) interrupted.signal.throwIfAborted();
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Native service did not confirm ${label}.`);
}
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
let ledger, control;
const readLedger = async () => {
  try {
    return JSON.parse(await readFile(ledger, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { boots: [], pid: null };
    throw error;
  }
};
const command = async (exitCode) => {
  const temporary = control + ".next";
  await writeFile(temporary, JSON.stringify({ exitCode }));
  const { rename } = await import("node:fs/promises");
  await rename(temporary, control);
};
const observe = async () => {
  const record = await readLedger();
  return {
    record,
    status: await serviceAction(plan, "status", { isolatedHome: true }),
  };
};
try {
  if (process.platform === "linux") {
    const uid = process.getuid();
    assert.ok(uid > 0, "The Agent user service must not run as root.");
    originalManagerState = run(
      "systemctl",
      ["is-active", `user@${uid}.service`],
      true,
    ).stdout.trim();
    const runtime = `/run/user/${uid}`;
    try {
      const info = await lstat(runtime);
      if (info.uid === uid && info.isDirectory())
        process.env.XDG_RUNTIME_DIR = runtime;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let probe = run(
      "systemctl",
      ["--user", "--no-pager", "show", "--property=Version", "--value"],
      true,
    );
    if (probe.status !== 0) {
      console.log(
        JSON.stringify({
          prerequisite: "user-manager",
          before: originalManagerState,
          action: "start-current-uid-service",
        }),
      );
      run("sudo", ["-n", "systemctl", "start", `user@${uid}.service`]);
      process.env.XDG_RUNTIME_DIR = runtime;
      await waitFor(
        async () =>
          run(
            "systemctl",
            ["--user", "--no-pager", "show", "--property=Version", "--value"],
            true,
          ).status === 0,
        "a current-user manager",
        15000,
        true,
      );
    }
    // No linger, second manager, manager exit, or system-level Agent unit.
  }
  if (process.platform === "darwin")
    run("/bin/launchctl", ["print", `gui/${process.getuid()}`]);
  const program = path.join(
    home,
    ".nexum-dev",
    "program",
    "versions",
    "f".repeat(64),
  );
  await mkdir(path.join(program, "app/dist"), { recursive: true });
  await mkdir(
    path.join(program, "runtime", process.platform === "win32" ? "." : "bin"),
    { recursive: true },
  );
  await cp(
    process.execPath,
    path.join(
      program,
      "runtime",
      process.platform === "win32" ? "node.exe" : "bin/node",
    ),
  );
  await writeFile(path.join(program, "app/package.json"), '{"type":"module"}');
  ledger = path.join(home, "ledger.json");
  control = path.join(home, "control.json");
  await command(null);
  const code = `import fs from 'node:fs';const ledger=${JSON.stringify(ledger)},control=${JSON.stringify(control)};let previous={boots:[]};try{previous=JSON.parse(fs.readFileSync(ledger,'utf8'));}catch{};const state={boots:[...previous.boots,{pid:process.pid,args:process.argv.slice(2),flags:process.execArgv}],pid:process.pid};fs.writeFileSync(ledger+'.new',JSON.stringify(state));fs.renameSync(ledger+'.new',ledger);setInterval(()=>{try{const command=JSON.parse(fs.readFileSync(control,'utf8'));if(Number.isInteger(command.exitCode)){fs.writeFileSync(control+'.consumed',JSON.stringify({exitCode:null}));fs.renameSync(control+'.consumed',control);process.exit(command.exitCode);}}catch{}},50);`;
  await writeFile(path.join(program, "app/dist/cli.js"), code);
  plan = servicePlan({
    profile: "development",
    home,
    programDir: program,
    windowsSid: process.platform === "win32" ? currentWindowsSid() : undefined,
  });
  console.log(
    JSON.stringify({
      stage: "register",
      platform: process.platform,
      label: plan.label,
    }),
  );
  await serviceAction(plan, "install", { isolatedHome: true });
  await delay(1500);
  assert.equal(
    (await readLedger()).boots.length,
    0,
    "install/no-start must not start a process",
  );
  await serviceAction(plan, "start", { isolatedHome: true });
  await waitFor(async () => alive((await readLedger()).pid), "first startup");
  let record = await readLedger();
  assert.deepEqual(record.boots.at(-1).args, [
    "run",
    "--profile",
    "development",
  ]);
  assert.ok(record.boots.at(-1).flags.includes("--experimental-vm-modules"));
  for (const exitCode of [75, 1]) {
    const count = record.boots.length,
      pid = record.pid;
    console.log(JSON.stringify({ stage: "restart", exitCode, pid }));
    await command(exitCode);
    await waitFor(async () => {
      const current = await readLedger();
      return (
        current.boots.length > count &&
        current.pid !== pid &&
        alive(current.pid)
      );
    }, `restart after ${exitCode}`);
    record = await readLedger();
  }
  const count = record.boots.length,
    pid = record.pid;
  await command(0);
  await waitFor(async () => !alive(pid), "normal exit");
  await delay(process.platform === "win32" ? 65000 : 13000, undefined, {
    signal: interrupted.signal,
  });
  assert.equal(
    (await readLedger()).boots.length,
    count,
    "exit 0 must not restart",
  );
  await serviceAction(plan, "start", { isolatedHome: true });
  await waitFor(async () => {
    const current = await readLedger();
    return current.boots.length > count && alive(current.pid);
  }, "restart after normal stop");
  record = await readLedger();
  await serviceAction(plan, "stop", { isolatedHome: true });
  await waitFor(
    async () => !alive(record.pid),
    "native stop closes its actual leader",
  );
  await serviceAction(plan, "start", { isolatedHome: true });
  await waitFor(async () => {
    const current = await readLedger();
    return current.boots.length > record.boots.length && alive(current.pid);
  }, "start after persistent stop");
  console.log(
    JSON.stringify({ stage: "lifecycle-passed", ...(await observe()) }),
  );
} catch (error) {
  let status;
  try {
    if (plan)
      status = await serviceAction(plan, "status", { isolatedHome: true });
  } catch {}
  console.error(
    JSON.stringify({ stage: "native-failed", message: error.message, status }),
  );
  if (plan && process.platform === "win32") {
    // Read only this fixture's actual Task Scheduler settings and timestamps.
    // A failed candidate remains failed; no new trigger or restart is injected.
    const name = "'" + plan.label.replaceAll("'", "''") + "'";
    const diagnostic = run(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName ${name};$i=Get-ScheduledTaskInfo -TaskName ${name};@{stage='native-task-settings';state=[string]$t.State;lastResult=$i.LastTaskResult;lastRun=$i.LastRunTime.ToString('o');nextRun=$i.NextRunTime.ToString('o');missedRuns=$i.NumberOfMissedRuns;restartCount=$t.Settings.RestartCount;restartInterval=[string]$t.Settings.RestartInterval;allowDemandStart=$t.Settings.AllowDemandStart;unifiedEngine=$t.Settings.UseUnifiedSchedulingEngine;triggerTypes=@($t.Triggers|ForEach-Object{$_.CimClass.CimClassName})}|ConvertTo-Json -Compress`,
      ],
      true,
    );
    console.error(diagnostic.stdout);
    console.error(diagnostic.stderr);
  }
  if (plan && process.platform === "linux") {
    // This runner-only fixture owns its unique unit and never receives private
    // configuration. Keep its native failure evidence in CI, not product logs.
    for (const [file, args] of [
      [
        "systemctl",
        [
          "--user",
          "--no-pager",
          "show",
          plan.label,
          "--property=LoadState,ActiveState,Result,ExecMainCode,ExecMainStatus,FragmentPath",
        ],
      ],
      [
        "journalctl",
        ["--user", "--unit", plan.label, "--no-pager", "--lines=20"],
      ],
    ]) {
      const diagnostic = run(file, args, true);
      console.error(diagnostic.stdout);
      console.error(diagnostic.stderr);
    }
  }
  throw error;
} finally {
  const failures = [];
  if (plan) {
    try {
      await command(0);
    } catch (error) {
      failures.push(error);
    }
    try {
      await serviceAction(plan, "remove", { isolatedHome: true });
    } catch (error) {
      failures.push(error);
    }
    try {
      await waitFor(
        async () =>
          !(await serviceAction(plan, "status", { isolatedHome: true }))
            .registered,
        "native unregistration",
        15000,
        true,
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      await waitFor(
        async () => !(await readLedger()).boots.some((boot) => alive(boot.pid)),
        "all fixture process closure",
        15000,
        true,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length)
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  console.log(
    JSON.stringify({
      stage: "cleanup",
      label: plan?.label ?? null,
      confirmed: failures.length === 0,
      originalManagerState,
    }),
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      "Native service cleanup was not confirmed; isolated fixture retained for inspection.",
    );
}
