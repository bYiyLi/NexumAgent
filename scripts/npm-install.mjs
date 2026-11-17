import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NODE_VERSION, childEnvironment, currentWindowsSid, serviceAction, servicePlan,
} from "./service.mjs";

const self = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const precise = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.[0-9]+)?$/;
const rootFor = (home, profile) =>
  path.join(home, profile === "production" ? ".nexum" : ".nexum-dev");
const packagePath = (program) =>
  path.join(program, "app", "node_modules", "@nexum-hub", "agent");
const nodeBin = (root) =>
  path.join(root, process.platform === "win32" ? "node.exe" : "bin/node");
const npmBin = (root) =>
  path.join(root, process.platform === "win32"
    ? "node_modules/npm/bin/npm-cli.js"
    : "lib/node_modules/npm/bin/npm-cli.js");
const nodeHome = () =>
  process.platform === "win32"
    ? path.dirname(process.execPath)
    : path.dirname(path.dirname(process.execPath));
const fail = (valid, message) => {
  if (!valid) throw new Error(message);
};

export function npmRegistries(
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const mainland = [
    "Asia/Shanghai", "Asia/Chongqing", "Asia/Harbin", "Asia/Urumqi",
    "PRC", "China Standard Time",
  ].includes(timeZone);
  return [
    ...(mainland ? ["https://registry.npmmirror.com/"] : []),
    "https://registry.npmjs.org/",
  ];
}

function exec(file, args, cwd) {
  // A package installation may take several minutes on Windows. The previous
  // 180-second total limit killed real installs during dependency extraction.
  // Keep the command bounded, but leave ample time for slow native packages.
  const result = spawnSync(file, args, {
    cwd,
    env: childEnvironment(),
    windowsHide: true,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const code = result.error?.code ?? "COMMAND_FAILED";
    const error = new Error(
      "Agent installer command failed (code=" + code +
      ", exit=" + String(result.status) +
      ", signal=" + String(result.signal) + "). Check the npm debug log.",
    );
    error.code = code;
    throw error;
  }
  return result.stdout.trim();
}

// Keep npm in a separately owned process tree. A timed-out npm command
// cannot leave installation scripts racing the next registry attempt.
export async function npmExec(file, args, cwd, timeoutMs = 900000) {
  const windows = process.platform === "win32";
  const child = spawn(file, args, {
    cwd, env: childEnvironment(), windowsHide: true,
    detached: !windows, stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  let cancelled = false;
  const terminate = () => {
    if (!child.pid) return;
    if (windows) {
      spawnSync(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true, encoding: "utf8", timeout: 15000,
        },
      );
    } else {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  return new Promise((resolve, reject) => {
    let error;
    const stdout = [];
    let stdoutBytes = 0;
    const consume = (chunks, bytes, value) => {
      if (bytes + value.length > 4 * 1024 * 1024) return bytes;
      chunks.push(value);
      return bytes + value.length;
    };
    child.stdout.on("data", (value) => {
      stdoutBytes = consume(stdout, stdoutBytes, value);
    });
    // Drain npm stderr without exposing potentially sensitive URLs or output.
    child.stderr.resume();
    const cancel = () => {
      cancelled = true;
      try { terminate(); } catch (cause) { error = cause; }
    };
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
    const timer = setTimeout(() => {
      timedOut = true;
      try { terminate(); } catch (cause) { error = cause; }
    }, timeoutMs);
    child.once("error", (cause) => { error = cause; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
      if (!windows) {
        // Clean up detached installer-script descendants that kept running.
        try { terminate(); } catch (cause) { error ??= cause; }
      }
      if (error || timedOut || cancelled || code !== 0) {
        const causeCode = timedOut ? "ETIMEDOUT" :
          cancelled ? "ECANCELLED" : error?.code ?? "NPM_INSTALL_FAILED";
        const failure = new Error(
          "Agent npm install failed (code=" + causeCode +
          ", exit=" + String(code) + ", signal=" + String(signal) +
          "). Check the npm debug log.",
        );
        failure.code = causeCode;
        reject(failure);
      } else {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
      }
    });
  });
}

async function directory(value) {
  await mkdir(value, { recursive: true, mode: 0o700 });
  const info = await lstat(value);
  fail(
    info.isDirectory() && !info.isSymbolicLink() &&
      (await realpath(value)) === value,
    "The Agent installation directory is unsafe.",
  );
}

export async function readState(file) {
  try {
    const info = await lstat(file);
    fail(
      info.isFile() && !info.isSymbolicLink() && info.size <= 16384,
      "The stored Agent state is invalid.",
    );
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeState(file, value) {
  const temp = file + "." + randomUUID() + ".new";
  await writeFile(temp, JSON.stringify(value) + "\n", {
    flag: "wx", mode: 0o600,
  });
  try {
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

function configuration(value, profile) {
  fail(
    value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).every((k) => ["server_url", "token"].includes(k)) &&
      typeof value.server_url === "string" &&
      typeof value.token === "string" &&
      /^[\x21-\x7e]{1,8192}$/.test(value.token),
    "The private Agent configuration is invalid.",
  );
  const url = new URL(value.server_url);
  fail(
    ["http:", "https:"].includes(url.protocol) &&
      (profile === "development" || url.protocol === "https:") &&
      !url.username && !url.password && !url.search && !url.hash &&
      !/[\x00-\x20\x7f]/.test(value.server_url),
    "The selected profile Server URL is invalid.",
  );
  return { server_url: url.href, token: value.token };
}

async function runtime(program) {
  const installed = path.join(program, "runtime");
  if (existsSync(installed)) {
    const info = await lstat(installed);
    fail(
      info.isDirectory() && !info.isSymbolicLink() &&
        (await realpath(installed)) === installed,
      "The managed Node directory is unsafe.",
    );
    try {
      if (
        existsSync(npmBin(installed)) &&
        exec(nodeBin(installed), ["--version"]) === "v" + NODE_VERSION
      ) return installed;
    } catch {
      // An interrupted runtime copy is not a valid managed Node.
    }
    fail(
      path.resolve(nodeHome()) !== path.resolve(installed),
      "The running managed Node is incomplete; repair it from the bootstrap installer.",
    );
    await rm(installed, { recursive: true, force: true });
  }
  // The runtime is copied directly to its single managed home: no staging
  // directories or permanent install locks can survive a failed bootstrap.
  await directory(installed);
  const source = nodeHome();
  const names = process.platform === "win32"
    ? ["node.exe", "node_modules/npm", "npm.cmd", "npx.cmd"]
    : ["bin/node", "lib/node_modules/npm", "bin/npm", "bin/npx"];
  for (const name of names) {
    await mkdir(path.dirname(path.join(installed, name)), { recursive: true });
    await cp(path.join(source, name), path.join(installed, name), {
      recursive: true, force: true, verbatimSymlinks: true,
    });
  }
  fail(
    exec(nodeBin(installed), ["--version"]) === "v" + NODE_VERSION &&
      existsSync(npmBin(installed)),
    "The managed Node installation is incomplete.",
  );
  return installed;
}

function dependenciesOf(source) {
  let current = source;
  while (path.dirname(current) !== current) {
    if (path.basename(current) === "node_modules") return current;
    current = path.dirname(current);
  }
  return path.join(source, "node_modules");
}

async function verifyApp(program, version, managedNode) {
  const pkg = packagePath(program);
  for (const dir of [
    path.join(program, "app"),
    path.join(program, "app", "node_modules"),
    path.join(program, "app", "node_modules", "@nexum-hub"),
    pkg,
  ]) {
    const info = await lstat(dir);
    fail(
      info.isDirectory() && !info.isSymbolicLink() &&
        (await realpath(dir)) === dir,
      "The installed Agent package path is unsafe.",
    );
  }
  const manifest = await readState(path.join(pkg, "package.json"));
  fail(
    manifest?.name === "@nexum-hub/agent" && manifest.version === version,
    "The installed Agent package version is invalid.",
  );
  const cli = path.join(pkg, "dist", "cli.js");
  fail(
    exec(nodeBin(managedNode), [cli, "--version"]) === version,
    "The installed Agent did not report its expected version.",
  );
}

export async function installedAgentVersion(program, managedNode) {
  const receipt = await readState(path.join(program, "installed.json"));
  if (!receipt || receipt.directory !== "app" || !precise.test(receipt.version))
    return null;
  try {
    await verifyApp(program, receipt.version, managedNode);
    return receipt.version;
  } catch {
    return null;
  }
}

async function installPackage(program, version, managedNode, source) {
  const app = path.join(program, "app");
  const pkg = packagePath(program);
  await directory(app);
  if (source) {
    const manifest = await readState(path.join(source, "package.json"));
    fail(
      manifest?.name === "@nexum-hub/agent" && manifest.version === version,
      "The supplied Agent package does not match the requested version.",
    );
    await mkdir(path.dirname(pkg), { recursive: true });
    await cp(dependenciesOf(source), path.join(app, "node_modules"), {
      recursive: true, force: true, verbatimSymlinks: true,
    });
    await directory(pkg);
    for (const name of [
      "dist", "contracts", "package.json", "scripts/service.mjs",
      "scripts/npm-install.mjs", "scripts/service-runner.mjs",
    ]) {
      await mkdir(path.dirname(path.join(pkg, name)), { recursive: true });
      await cp(path.join(source, name), path.join(pkg, name), {
        recursive: true, force: true, verbatimSymlinks: true,
      });
    }
  } else {
    const registries = npmRegistries();
    for (const [index, registry] of registries.entries()) {
      // Reset the same application directory before each registry attempt.
      // npm never races another Nexum installation within the managed service.
      await rm(app, { recursive: true, force: true });
      await directory(app);
      try {
        await npmExec(nodeBin(managedNode), [
          npmBin(managedNode), "install", "--prefix", app,
          "--no-save", "--no-package-lock", "--omit=dev",
          "--no-audit", "--no-fund", "--registry=" + registry,
          "@nexum-hub/agent@" + version,
        ]);
        break;
      } catch (error) {
        if (index === registries.length - 1) throw error;
      }
    }
  }
  await verifyApp(program, version, managedNode);
}

export async function clearOldInstallation(program) {
  // The service owner has already stopped the old Agent. No shared lock is
  // needed. Never touch credentials, user work, SQLite, or extension state.
  for (const name of ["install.lock", "active.json"]) {
    await rm(path.join(program, name), { force: true });
  }
  await rm(path.join(program, "versions"), {
    recursive: true, force: true,
  });
  for (const name of await readdir(program)) {
    if (/^\.runtime-[0-9a-f-]+$|^\.install-[0-9a-f-]+$/.test(name))
      await rm(path.join(program, name), { recursive: true, force: true });
  }
}

export async function installNpmAgent({
  profile, version, config, home = homedir(),
  register = true, start = true, source, fromUpdate = false,
} = {}) {
  fail(["production", "development"].includes(profile), "Invalid Agent profile.");
  fail(precise.test(version), "Expected a precise Agent npm version.");
  fail(
    process.versions.node === NODE_VERSION,
    "The installer requires Node " + NODE_VERSION + ".",
  );
  fail(
    (await realpath(home)) === path.resolve(home),
    "Use the canonical user home.",
  );
  const root = rootFor(home, profile);
  const program = path.join(root, "program");
  for (const part of [root, program]) await directory(part);
  const configPath = path.join(root, "config.json");
  const previousConfig = await readState(configPath);
  const nextConfig = config
    ? configuration(config, profile)
    : previousConfig ? configuration(previousConfig, profile) : null;
  fail(nextConfig, "The first installation needs the Server URL and Agent Token.");
  fail(!fromUpdate || !config, "Automatic updates never replace Agent credentials.");

  // Only the service manager owns Agent lifecycle. A manual install first
  // stops its task, before any executable files are replaced.
  const plan = servicePlan({
    profile, home, programDir: program, npmManaged: true,
    ...(process.platform === "win32"
      ? { windowsSid: currentWindowsSid() } : {}),
  });
  const previousService = register ? await serviceAction(plan, "status") : null;
  const previouslyRunning = previousService?.registered &&
    ["Running", "Queued", "running", "active"].includes(previousService.state);
  if (previousService?.registered) await serviceAction(plan, "stop");
  try {

    // Identity replacement is an explicit user action, never an auto upgrade.
    if (config && !fromUpdate) {
      const marker = path.join(program, "identity-replacement.json");
      const tokenDigest = createHash("sha256").update(nextConfig.token).digest("hex");
      const previous = await readState(marker);
      if (previous) {
        fail(
          previous.profile === profile &&
            previous.serverUrl === nextConfig.server_url &&
            previous.tokenDigest === tokenDigest &&
            typeof previous.archiveId === "string" &&
            /^[0-9a-f-]{36}$/.test(previous.archiveId),
          "A previous Agent identity replacement must finish before installing another identity.",
        );
      } else {
        await writeState(marker, {
          profile, serverUrl: nextConfig.server_url,
          tokenDigest, archiveId: randomUUID(),
        });
      }
    }

    const managedNode = await runtime(program);
    const receiptPath = path.join(program, "installed.json");
    if ((await installedAgentVersion(program, managedNode)) !== version) {
      // Persist the requested version *before* removing an incomplete or old
      // installation. After a crash, the stable launcher must still know what
      // to install, even when no complete installed.json receipt remains.
      await writeState(path.join(program, "update.json"), { version });
      await rm(receiptPath, { force: true });
      await rm(path.join(program, "app"), { recursive: true, force: true });
      const requestedSource = fromUpdate ? undefined : source ?? self;
      const sourceInsideApp = requestedSource &&
        (path.resolve(requestedSource) === path.resolve(path.join(program, "app")) ||
          path.resolve(requestedSource).startsWith(path.resolve(path.join(program, "app")) + path.sep));
      await installPackage(
        program, version, managedNode,
        sourceInsideApp ? undefined : requestedSource,
      );
      await writeState(receiptPath, { version, directory: "app" });
    }
    // The standalone service launcher is intentionally not changed by an
    // automatic Agent upgrade. Manual installs refresh the launcher explicitly.
    if (register) {
      for (const name of ["service-runner.mjs", "npm-install.mjs", "service.mjs"]) {
        await cp(path.join(packagePath(program), "scripts", name), path.join(program, name), {
          force: true,
        });
      }
    }
    if (
      !previousConfig || JSON.stringify(previousConfig) !== JSON.stringify(nextConfig)
    ) await writeState(configPath, nextConfig);
    await clearOldInstallation(program);
    // A completed explicit install wins over any stale request from the old Agent.
    if (!fromUpdate) await rm(path.join(program, "update.json"), { force: true });

    if (register) {
      await serviceAction(plan, "install");
      if (start) await serviceAction(plan, "start");
    }
    return {
      profile, version,
      serviceRegistered: register, startRequested: register && start,
    };
  } catch (error) {
    // A failed explicit reinstall must not leave an earlier running user
    // service permanently disabled. Restart its existing registration; the
    // persistent update target lets the launcher retry incomplete installs.
    if (previouslyRunning && start) {
      try {
        await serviceAction(plan, "start");
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "The Agent install and native service recovery both failed.",
        );
      }
    }
    throw error;
  }
}

export async function updateNpmAgent({ profile, version, home = homedir() }) {
  const result = await installNpmAgent({
    profile, version, home, register: false, fromUpdate: true,
  });
  const update = path.join(rootFor(home, profile), "program", "update.json");
  if ((await readState(update))?.version === version)
    await rm(update, { force: true });
  return result;
}
