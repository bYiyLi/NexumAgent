import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NODE_VERSION,
  childEnvironment,
  currentWindowsSid,
  serviceAction,
  servicePlan,
} from "./service.mjs";

const self = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const precise = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.[0-9]+)?$/;
const nodeBin = (root) =>
  path.join(root, process.platform === "win32" ? "node.exe" : "bin/node");
const npmBin = (root) =>
  path.join(
    root,
    process.platform === "win32"
      ? "node_modules/npm/bin/npm-cli.js"
      : "lib/node_modules/npm/bin/npm-cli.js",
  );
const fail = (condition, reason) => {
  if (!condition) throw new Error(reason);
};
const rootFor = (home, profile) =>
  path.join(home, profile === "production" ? ".nexum" : ".nexum-dev");
const nodeHome = () =>
  process.platform === "win32"
    ? path.dirname(process.execPath)
    : path.dirname(path.dirname(process.execPath));
function exec(file, args, cwd) {
  const result = spawnSync(file, args, {
    cwd,
    env: childEnvironment(),
    windowsHide: true,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  fail(!result.error && result.status === 0, "The npm/Node command failed.");
  return result.stdout.trim();
}
async function directory(value) {
  await mkdir(value, { recursive: true, mode: 0o700 });
  const info = await lstat(value);
  fail(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      (await realpath(value)) === value,
    "A local installation directory is unsafe.",
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
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
function configuration(value, profile) {
  fail(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
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
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[\x00-\x20\x7f]/.test(value.server_url),
    "The selected profile Server URL is invalid.",
  );
  return { server_url: url.href, token: value.token };
}
async function runtime(program) {
  const installed = path.join(program, "runtime");
  if (existsSync(installed)) {
    fail(
      exec(nodeBin(installed), ["--version"]) === `v${NODE_VERSION}`,
      "The managed Node is incompatible.",
    );
    return installed;
  }
  const stage = path.join(program, ".runtime-" + randomUUID());
  await directory(stage);
  try {
    const root = nodeHome();
    const names =
      process.platform === "win32"
        ? ["node.exe", "node_modules/npm", "npm.cmd", "npx.cmd"]
        : ["bin/node", "lib/node_modules/npm", "bin/npm", "bin/npx"];
    for (const name of names) {
      await mkdir(path.dirname(path.join(stage, name)), { recursive: true });
      await cp(path.join(root, name), path.join(stage, name), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    fail(
      exec(nodeBin(stage), ["--version"]) === `v${NODE_VERSION}`,
      "The managed Node version is invalid.",
    );
    await rename(stage, installed);
    return installed;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
function dependenciesOf(source) {
  let candidate = source;
  while (path.dirname(candidate) !== candidate) {
    if (path.basename(candidate) === "node_modules") return candidate;
    candidate = path.dirname(candidate);
  }
  return path.join(source, "node_modules");
}
async function packageStage(stage, version, managedNode, source) {
  const scratch = path.join(stage, ".resolve");
  let from = source;
  if (!from) {
    await directory(scratch);
    exec(nodeBin(managedNode), [
      npmBin(managedNode),
      "install",
      "--prefix",
      scratch,
      "--no-save",
      "--no-package-lock",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      `@nexum-hub/agent@${version}`,
    ]);
    from = path.join(scratch, "node_modules", "@nexum-hub", "agent");
  }
  const manifest = JSON.parse(
    await readFile(path.join(from, "package.json"), "utf8"),
  );
  fail(
    manifest.name === "@nexum-hub/agent" && manifest.version === version,
    "The resolved Agent npm version differs.",
  );
  const app = path.join(stage, "app");
  await directory(app);
  for (const name of [
    "dist",
    "contracts",
    "package.json",
    "scripts/service.mjs",
    "scripts/npm-install.mjs",
    "scripts/service-runner.mjs",
  ]) {
    await mkdir(path.dirname(path.join(app, name)), { recursive: true });
    await cp(path.join(from, name), path.join(app, name), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  await cp(dependenciesOf(from), path.join(app, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  fail(
    exec(nodeBin(managedNode), [
      path.join(app, "dist", "cli.js"),
      "--version",
    ]) === version,
    "The installed Agent did not report the expected version.",
  );
  await rm(scratch, { force: true, recursive: true });
}
export async function installNpmAgent({
  profile,
  version,
  config,
  home = homedir(),
  register = true,
  start = true,
  source,
  fromUpdate = false,
} = {}) {
  fail(
    ["production", "development"].includes(profile),
    "Invalid Agent profile.",
  );
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
  const program = path.join(root, "program"),
    versions = path.join(program, "versions");
  for (const part of [root, program, versions]) await directory(part);
  const configPath = path.join(root, "config.json");
  const previousConfig = await readState(configPath);
  const nextConfig = config
    ? configuration(config, profile)
    : previousConfig
      ? configuration(previousConfig, profile)
      : null;
  fail(
    nextConfig,
    "The first installation needs the Server URL and Agent Token.",
  );
  fail(
    !fromUpdate || !config,
    "Automatic updates never replace Agent credentials.",
  );
  const lock = path.join(program, "install.lock");
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  let staging;
  try {
    const managedNode = await runtime(program);
    const destination = path.join(versions, version);
    if (!existsSync(destination)) {
      staging = path.join(versions, ".install-" + randomUUID());
      await directory(staging);
      await packageStage(
        staging,
        version,
        managedNode,
        fromUpdate ? undefined : (source ?? self),
      );
      await rename(staging, destination);
      staging = undefined;
    } else {
      const stored = JSON.parse(
        await readFile(path.join(destination, "app", "package.json"), "utf8"),
      );
      fail(
        stored.name === "@nexum-hub/agent" && stored.version === version,
        "An existing version is invalid.",
      );
    }
    const launcher = path.join(program, "service-runner.mjs");
    if (!existsSync(launcher))
      await cp(
        path.join(destination, "app", "scripts", "service-runner.mjs"),
        launcher,
        { errorOnExist: true },
      );
    const activePath = path.join(program, "active.json"),
      old = await readState(activePath);
    const plan = servicePlan({
      profile,
      home,
      programDir: destination,
      npmManaged: true,
      ...(process.platform === "win32"
        ? { windowsSid: currentWindowsSid() }
        : {}),
    });
    if (register && old) {
      const state = await serviceAction(plan, "status");
      if (state.registered) await serviceAction(plan, "stop");
    }
    if (
      !previousConfig ||
      JSON.stringify(previousConfig) !== JSON.stringify(nextConfig)
    )
      await writeState(configPath, nextConfig);
    await writeState(activePath, { version, directory: version });
    if (register) {
      await serviceAction(plan, "install");
      if (start) await serviceAction(plan, "start");
    }
    return {
      profile,
      version,
      serviceRegistered: register,
      startRequested: register && start,
    };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { force: true });
  }
}
export async function updateNpmAgent({ profile, version, home = homedir() }) {
  const result = await installNpmAgent({
    profile,
    version,
    home,
    register: false,
    fromUpdate: true,
  });
  const update = path.join(rootFor(home, profile), "program", "update.json");
  if ((await readState(update))?.version === version) await rm(update);
  return result;
}
