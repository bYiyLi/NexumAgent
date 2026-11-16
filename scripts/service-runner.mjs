import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const profile = process.argv[2] === "--profile" ? process.argv[3] : undefined;
if (
  !["production", "development"].includes(profile) ||
  process.argv.length !== 4
)
  throw new Error("The managed Agent service requires one explicit profile.");

const root = path.join(
  homedir(),
  profile === "production" ? ".nexum" : ".nexum-dev",
);
const program = path.join(root, "program");
const node = process.execPath;
const precise = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.[0-9]+)?$/;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const diagnostic = async (code) => {
  try {
    await appendFile(
      path.join(root, "logs", "agent.log"),
      new Date().toISOString() + " " + code + "\n",
      { mode: 0o600 },
    );
  } catch {
    process.stderr.write(code + "\n");
  }
};
async function state(filename) {
  const value = JSON.parse(
    await readFile(path.join(program, filename), "utf8"),
  );
  if (!value || typeof value !== "object")
    throw new Error("The Agent release state is invalid.");
  return value;
}
let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});

let failures = 0;
while (!stopped) {
  let active;
  try {
    active = await state("active.json");
    if (!precise.test(active.version) || active.directory !== active.version)
      throw new Error("Invalid active Agent release.");
    let pending;
    try {
      pending = await state("update.json");
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    if (pending && pending.version !== active.version) {
      if (!precise.test(pending.version))
        throw new Error("Invalid requested Agent version.");
      const installer = path.join(
        program,
        "versions",
        active.directory,
        "app",
        "scripts",
        "npm-install.mjs",
      );
      const tool = await import(pathToFileURL(installer).href);
      await tool.updateNpmAgent({ profile, version: pending.version });
      failures = 0;
      continue;
    }
    const cli = path.join(
      program,
      "versions",
      active.directory,
      "app",
      "dist",
      "cli.js",
    );
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        node,
        ["--experimental-vm-modules", cli, "run", "--profile", profile],
        {
          stdio: "inherit",
          windowsHide: true,
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
    if (stopped || result === 0) break;
    if (result === 75) {
      failures = 0;
      continue;
    }
    process.exitCode = 1;
    break;
  } catch {
    if (stopped) break;
    await diagnostic("agent_update_or_start_failed");
    await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
  }
}
