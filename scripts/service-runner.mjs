import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  clearOldInstallation, installedAgentVersion, readState, updateNpmAgent,
} from "./npm-install.mjs";

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
  const line = new Date().toISOString() + " " + code +
    (details ? " " + details : "") + "\n";
  try {
    await mkdir(path.join(root, "logs"), { recursive: true, mode: 0o700 });
    await appendFile(path.join(root, "logs", "agent.log"), line, { mode: 0o600 });
  } catch {
    process.stderr.write(line);
  }
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

async function runAgent() {
  const cli = path.join(
    program, "app", "node_modules", "@nexum-hub", "agent", "dist", "cli.js",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      node,
      ["--experimental-vm-modules", cli, "run", "--profile", profile],
      { stdio: "inherit", windowsHide: true },
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
  try {
    const target = await targetVersion();
    const verified = await installedAgentVersion(program, path.join(
      program, "runtime",
    ));
    if (verified !== target) {
      await diagnostic("agent_install_required", "version=" + target);
      await updateNpmAgent({ profile, version: target });
    }
    // Service ownership guarantees the old Agent stopped before this boot.
    // Clean historical install debris even when the installed app is valid.
    await clearOldInstallation(program);
    if (stopped) return 0;
    const exitCode = await runAgent();
    if (stopped || exitCode === 0) return 0;
    if (exitCode === 75) {
      const requested = await readState(path.join(program, "update.json"));
      if (!requested || !precise.test(requested.version))
        throw new Error("Agent requested upgrade without a valid version.");
      await diagnostic("agent_upgrade_required", "version=" + requested.version);
      return 75; // systemd / launchd / Windows Task owner restarts Launcher.
    }
    await diagnostic("agent_exited", "code=" + String(exitCode));
    return 1;
  } catch (error) {
    if (stopped) return 0;
    // Preserve a safe stage/code, not npm stderr, URLs, environment or tokens.
    await diagnostic(
      "agent_launcher_failed",
      "code=" + String(error?.code ?? "UNEXPECTED").replace(/[^A-Z_0-9]/gi, ""),
    );
    return 1;
  }
}
process.exitCode = await startOnce();
