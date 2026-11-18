// Cloud Bootstrap owns installation. This module only adapts its desired
// native executable and user-service definition to the current OS.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentWindowsSid, serviceAction, servicePlan,
} from "./service.mjs";
import { verifyNativeExecutable } from "./npm-install.mjs";

const rootPackage = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const binaries = { darwin: "darwin", linux: "linux", win32: "windows" };
const binaryName = () => process.platform === "win32" ? "nexum-agent.exe" : "nexum-agent";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function matches(file, bytes) {
  try { return sha(await readFile(file)) === sha(bytes); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function prepareNative(root, mode) {
  const source = path.join(rootPackage, "native", binaries[process.platform] +
    "-" + process.arch, binaryName());
  await verifyNativeExecutable(source);
  const bytes = await readFile(source);
  const regular = path.join(root, binaryName());
  if (process.platform !== "win32") {
    if (!(await matches(regular, bytes))) await replaceBinary(regular, bytes);
    return regular;
  }
  // A running Windows PE image cannot be overwritten. Switch the task's
  // *next* invocation to the other fixed slot, not the current process.
  const alternate = path.join(root, "nexum-agent-next.exe");
  const running = process.env.NEXUM_RUNNING_NATIVE || "";
  if (mode === "install" && !running) {
    if (!(await matches(regular, bytes))) await replaceBinary(regular, bytes);
    return regular;
  }
  if (running === regular || running === alternate) {
    if (await matches(running, bytes)) return running;
    const next = running === regular ? alternate : regular;
    if (!(await matches(next, bytes))) await replaceBinary(next, bytes);
    return next;
  }
  if (await matches(regular, bytes)) return regular;
  if (await matches(alternate, bytes)) return alternate;
  if (mode === "prepare")
    throw new Error("The running Windows native entrypoint was not identified.");
  await replaceBinary(regular, bytes);
  return regular;
}

async function replaceBinary(destination, bytes) {
  const temporary = destination + ".new-" + randomUUID();
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o700 });
    if (process.platform !== "win32") await chmod(temporary, 0o700);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function synchronizeCloudService({
  profile, serverUrl, home = homedir(), mode = "prepare", register = true,
} = {}) {
  if (!["production", "development"].includes(profile) ||
      !["prepare", "install", "stop"].includes(mode) || !serverUrl)
    throw new Error("Select an explicit Cloud Agent profile and installation mode.");
  const root = path.join(home, profile === "production" ? ".nexum" : ".nexum-dev");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const nativeExecutable = mode === "stop" ? path.join(root, binaryName()) :
    await prepareNative(root, mode);
  const plan = servicePlan({
    profile, home, cloudManaged: true, serverUrl, nativeExecutable,
    ...(process.platform === "win32" ? { windowsSid: currentWindowsSid() } : {}),
  });
  if (mode === "stop") {
    if (register) {
      const status = await serviceAction(plan, "status");
      if (status.registered) await serviceAction(plan, "stop");
    }
    return { nativeExecutable, changed: false };
  }
  if (!register) return { nativeExecutable, manifest: plan.content };

  const expected = process.platform === "win32" ? "\uFEFF" + plan.content : plan.content;
  let installed = null;
  try {
    installed = await readFile(plan.manifestPath,
      process.platform === "win32" ? "utf16le" : "utf8");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (installed !== expected) {
    // Registering a new definition does not stop a currently running service.
    // launchd applies a changed plist after its next explicit bootstrap.
    await serviceAction(plan, "install");
  }
  if (mode === "install") {
    const status = await serviceAction(plan, "status");
    if (!["running", "active", "Running", "Queued"].includes(status.state))
      await serviceAction(plan, "start");
  }
  return { nativeExecutable, changed: installed !== expected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = process.env.NEXUM_BOOTSTRAP_PROFILE;
  const serverUrl = process.env.NEXUM_BOOTSTRAP_SERVER;
  const mode = process.env.NEXUM_BOOTSTRAP_MODE;
  try {
    const result = await synchronizeCloudService({ profile, serverUrl, mode });
    process.stdout.write(JSON.stringify({ changed: result.changed ?? false }) + "\n");
  } catch (error) {
    // Never emit configuration, command input, private paths or native errors.
    process.stderr.write("cloud_service_prepare_failed\n");
    process.exitCode = 1;
  }
}
