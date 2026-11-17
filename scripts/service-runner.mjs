import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  clearOldInstallation, installedAgentVersion, readState,
  restoreInterruptedCoreUpdate, updateNpmAgent,
} from "./npm-install.mjs";
import {
  reconcileStartupPackages, startupEvent, startupIssue, verifyStartupNpm,
  writeStartupReport,
} from "./startup-report.mjs";

const profile = process.argv[2] === "--profile" ? process.argv[3] : undefined;
if (
  !["production", "development"].includes(profile) ||
  process.argv.length !== 4
) throw new Error("The managed Agent service requires one explicit profile.");

const root = path.join(homedir(), profile === "production" ? ".nexum" : ".nexum-dev");
const program = path.join(root, "program");
const node = process.execPath;
const precise = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.[0-9]+)?$/;
const diagnostic = async (code, details = "") => {
  const line = JSON.stringify({
    time: new Date().toISOString(), profile, stage: "launcher",
    code: /^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : "agent_launcher_failed",
    retry: false,
    ...(typeof details === "string" &&
      /^version=[A-Za-z0-9._-]{1,128}$/.test(details)
      ? { version: details.slice(8) } : {}),
    ...(typeof details === "string" &&
      /^code=[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(details)
      ? { failureCode: details.slice(5) } : {}),
  }) + "\n";
  try {
    await mkdir(path.join(root, "logs"), { recursive: true, mode: 0o700 });
    await appendFile(path.join(root, "logs", "agent.log"), line, { mode: 0o600 });
  } catch {
    process.stderr.write(line);
  }
};
const recordEvent = async (...args) => {
  try { await startupEvent(...args); }
  catch { await diagnostic("startup_event_unavailable"); }
};
let stopped = false;
process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });

async function targetVersion() {
  const pending = await readState(path.join(program, "update.json"));
  if (pending) {
    if (!precise.test(pending.version))
      throw new Error("Invalid requested Agent version.");
    return pending.version;
  }
  const receipt = await readState(path.join(program, "installed.json"));
  if (receipt) {
    if (receipt.directory !== "app" || !precise.test(receipt.version))
      throw new Error("Invalid installed Agent receipt.");
    return receipt.version;
  }
  // Recover a pre-migration installation after an interrupted explicit install.
  const legacy = await readState(path.join(program, "active.json"));
  if (legacy && precise.test(legacy.version)) return legacy.version;
  throw new Error("The Agent installation has no requested version.");
}

async function runAgent(version) {
  // A native Host launches Node with VM modules already enabled. Run the
  // Agent in this *same* process: Windows never starts another console
  // subsystem Node, and Unix needs no second process to supervise.
  if (typeof vm.SourceTextModule === "function") {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      const entry = path.join(program, "app", "node_modules",
        "@nexum-hub", "agent", "dist", "application", "main.js");
      const { runAgent: start } = await import(pathToFileURL(entry).href);
      return await start(profile, { version, signal: controller.signal });
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
  // Compatibility for old registered user tasks which still launch this
  // script without the required VM flag. A manual reinstall migrates them
  // to the native entrypoint and eliminates the extra process.
  const cli = path.join(
    program, "app", "node_modules", "@nexum-hub", "agent", "dist", "cli.js",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      node,
      ["--experimental-vm-modules", cli, "run", "--profile", profile],
      {
        stdio: "inherit",
        windowsHide: true,
        // The native Windows entry is detached from the console. Its child
        // must not create a hidden but still attached console either.
        ...(process.platform === "win32" ? { detached: true } : {}),
      },
    );
    const forward = () => child.kill("SIGTERM");
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    const finish = (error, code) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      error ? reject(error) : resolve(code);
    };
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(null, code));
  });
}

// A service invocation is single-shot. Only the native manager (or the
// Windows Task's OS-owned launcher action) restarts it. Agent cannot restart
// itself, and failed installation never leaves a blocking lock file.
async function startOnce() {
  const attemptId = randomUUID();
  const startedAt = new Date().toISOString();
  const issues = [];
  let target = null;
  let active = null;
  let npmPassed = false;
  let npmPhase = "version_resolution";
  try {
    const managedNode = path.join(program, "runtime");
    const recovered = await restoreInterruptedCoreUpdate(program, managedNode);
    if (recovered)
      await recordEvent(root, profile, "core_version", "previous_restored", {
        attemptId,
      });
    active = await installedAgentVersion(program, managedNode);
    target = await targetVersion();
    await recordEvent(root, profile, "core_version", "check_started", {
      attemptId, targetVersion: target,
    });
    npmPhase = "core_update";
    if (active !== target) {
      await diagnostic("agent_install_required", "version=" + target);
      const started = Date.now();
      try {
        await updateNpmAgent({ profile, version: target });
        active = await installedAgentVersion(program, managedNode);
        if (active !== target)
          throw Object.assign(new Error("Core update did not verify."), {
            code: "agent_update_unverified",
          });
        await recordEvent(root, profile, "core_version", "updated", {
          attemptId, activeVersion: active, durationMs: Date.now() - started,
        });
      } catch (cause) {
        active = await installedAgentVersion(program, managedNode);
        const failureCode = cause?.code ?? "agent_install_failed";
        issues.push(startupIssue("core", "npm_update",
          failureCode, {
            targetVersion: target,
            ...(active ? { activeVersion: active } : {}),
          }));
        await recordEvent(root, profile, "core_version", "update_failed", {
          attemptId, durationMs: Date.now() - started,
          fallback: Boolean(active), failureCode,
        });
        // The previous Core is preserved on disk for a later successful
        // attempt, but is never started while the requested npm update fails.
        throw cause;
      }
    } else {
      await recordEvent(root, profile, "core_version", "verified", {
        attemptId, activeVersion: active,
      });
    }
    if (stopped) return 0;
    npmPhase = "npm_runtime";
    const checkedAt = Date.now();
    const npm = await verifyStartupNpm({ program });
    await recordEvent(root, profile, "npm_runtime", "verified", {
      attemptId, activeVersion: npm.version,
      durationMs: Date.now() - checkedAt,
    });
    npmPhase = "work_dependencies";
    const started = Date.now();
    try {
      const packages = await reconcileStartupPackages({
        root, program, profile,
      });
      await recordEvent(root, profile, "work_npm", packages.status, {
        attemptId, durationMs: packages.durationMs,
        packageCount: packages.packageCount,
      });
    } catch (cause) {
      const failureCode = cause?.code ?? "npm_install_failed";
      issues.push(startupIssue("npm", "work_dependencies",
        failureCode));
      await recordEvent(root, profile, "work_npm", "failed", {
        attemptId, durationMs: Date.now() - started, failureCode,
      });
      // npm is a mandatory startup prerequisite, not an optional extension.
      // A valid old node_modules snapshot is not permission to bypass failure.
      throw cause;
    }
    npmPassed = true;
    // Installation debris is not an Agent identity or execution dependency.
    // A failed hygiene pass is observable but not allowed to prevent boot.
    try {
      await clearOldInstallation(program);
    } catch (cause) {
      const failureCode = cause?.code ?? "agent_cleanup_failed";
      issues.push(startupIssue("core", "cleanup",
        failureCode));
      await recordEvent(root, profile, "core_cleanup", "failed", {
        attemptId, failureCode,
      });
    }
    try {
      await writeStartupReport(root, {
        version: 1, profile, attemptId, startedAt,
        completedAt: new Date().toISOString(),
        targetVersion: target, activeVersion: active,
        status: issues.length ? "degraded" : "ready",
        issues,
      });
    } catch {
      await diagnostic("startup_report_unavailable");
    }
    if (stopped) return 0;
    const exitCode = await runAgent(active);
    if (stopped || exitCode === 0) return 0;
    if (exitCode === 75) {
      const requested = await readState(path.join(program, "update.json"));
      if (!requested || !precise.test(requested.version))
        throw new Error("Agent requested upgrade without a valid version.");
      await diagnostic("agent_upgrade_required", "version=" + requested.version);
      return 75; // systemd / launchd / Windows Task owner restarts Launcher.
    }
    if (exitCode === 76) {
      await diagnostic("agent_restart_requested");
      return 76; // Supervised, nonzero exit triggers the platform restart policy.
    }
    await diagnostic("agent_exited", "code=" + String(exitCode));
    return 1;
  } catch (error) {
    if (stopped) return 0;
    if (!npmPassed) {
      const last = issues.at(-1);
      const failure = last?.code ?? (
        npmPhase === "version_resolution"
          ? "agent_version_invalid"
          : npmPhase === "npm_runtime"
            ? "npm_runtime_unavailable"
            : "npm_install_failed"
      );
      if (!last)
        issues.push(startupIssue(
          ["work_dependencies", "npm_runtime"].includes(npmPhase)
            ? "npm" : "core",
          npmPhase, failure,
          ...(active ? [{ activeVersion: active }] : []),
        ));
      await recordEvent(root, profile, "npm_gate", "blocked", {
        attemptId, failureCode: failure,
        sourceCode: typeof error?.code === "string" &&
          /^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(error.code)
          ? error.code : "unknown",
        ...(target ? { targetVersion: target } : {}),
        ...(active ? { activeVersion: active } : {}),
      });
      try {
        await writeStartupReport(root, {
          version: 1, profile, attemptId, startedAt,
          completedAt: new Date().toISOString(),
          targetVersion: target ?? "unresolved",
          activeVersion: active ?? "unavailable",
          status: "blocked",
          issues,
        });
      } catch {
        await diagnostic("startup_report_unavailable");
      }
      await diagnostic("npm_startup_blocked", "code=" + failure);
      return 1; // systemd / launchd / Windows Supervisor can retry.
    }
    // Preserve a safe stage/code, not npm stderr, URLs, environment or tokens.
    await diagnostic(
      "agent_launcher_failed",
      "code=" + String(error?.code ?? "UNEXPECTED").replace(/[^A-Z_0-9]/gi, ""),
    );
    return 1;
  }
}
process.exitCode = await startOnce();
