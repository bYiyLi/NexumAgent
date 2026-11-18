import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { npmExec, npmRegistries } from "./npm-install.mjs";

const MAX_REPORT = 48 * 1024;
const MAX_LOG = 1024 * 1024;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const packageVersion = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const codePattern = /^[a-zA-Z][a-zA-Z_0-9-]{0,100}$/;
const safeCode = (value) => codePattern.test(value ?? "") ? value : "unexpected";

/** npm is a mandatory part of Nexum's managed runtime even if the approved
 * work package graph is currently empty. Verify the exact managed CLI before
 * admitting Core, without fetching or executing third-party package scripts. */
export async function verifyStartupNpm({
  program, run = npmExec, timeoutMs = 12000,
}) {
  const npmCli = process.platform === "win32"
    ? path.join(program, "runtime", "node_modules", "npm", "bin", "npm-cli.js")
    : path.join(program, "runtime", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const version = await run(process.execPath,
    [npmCli, "--version"], program, timeoutMs);
  if (typeof version !== "string" || !packageVersion.test(version))
    throw Object.assign(new Error("The managed npm CLI did not verify."), {
      code: "npm_runtime_invalid",
    });
  return { version };
}

async function privateDir(value) {
  await mkdir(value, { recursive: true, mode: 0o700 });
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      await realpath(value) !== value)
    throw Object.assign(new Error("Invalid private startup directory."), {
      code: "startup_directory_invalid",
    });
  return value;
}

function checkedObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

async function checkedText(file, limit = 4 * 1024 * 1024) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.size > limit)
    throw Object.assign(new Error("Invalid startup evidence."), {
      code: "startup_source_invalid",
    });
  return readFile(file, "utf8");
}

/** Stable, token-free diagnostics; never serialize npm stderr, URLs or exceptions. */
export async function startupEvent(root, profile, stage, code, fields = {}) {
  const directory = await privateDir(path.join(root, "logs"));
  const file = path.join(directory, "startup.log");
  const existing = await lstat(file).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() ||
      existing.nlink !== 1))
    throw Object.assign(new Error("Invalid startup log."), {
      code: "startup_log_unavailable",
    });
  const safeFields = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!["attemptId", "durationMs", "componentCount", "targetVersion",
      "activeVersion", "packageCount", "fallback", "failureCode",
      "sourceCode"].includes(name))
      continue;
    if (typeof value === "boolean" || (Number.isSafeInteger(value) && value >= 0))
      safeFields[name] = value;
    else if (typeof value === "string" && value.length <= 128 &&
      /^[a-zA-Z0-9._-]+$/.test(value))
      safeFields[name] = value;
  }
  const line = JSON.stringify({
    time: new Date().toISOString(), profile,
    stage: safeCode(stage), code: safeCode(code), ...safeFields,
  }) + "\n";
  await appendFile(file, line, { mode: 0o600, flag: "a" });
  if ((await stat(file)).size > MAX_LOG) {
    const tail = (await readFile(file, "utf8")).slice(-MAX_LOG / 2);
    const newline = tail.indexOf("\n");
    const retained = newline < 0 ? "" : tail.slice(newline + 1);
    const temp = file + "." + randomUUID() + ".new";
    await writeFile(temp, retained, { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  }
}

/** Single last-start record, written before Core connects to Cloud. */
export async function writeStartupReport(root, report) {
  const directory = await privateDir(path.join(root, "state"));
  const file = path.join(directory, "startup-report.json");
  const previous = await lstat(file).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (previous && (!previous.isFile() || previous.isSymbolicLink() ||
      previous.nlink !== 1))
    throw Object.assign(new Error("Invalid startup report."), {
      code: "startup_report_unavailable",
    });
  const body = JSON.stringify(report) + "\n";
  if (Buffer.byteLength(body) > MAX_REPORT)
    throw Object.assign(new Error("Startup report exceeded budget."), {
      code: "startup_report_too_large",
    });
  const temp = file + "." + randomUUID() + ".new";
  try {
    await writeFile(temp, body, { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export function startupIssue(component, stage, code, details = {}) {
  const issue = {
    component: safeCode(component),
    stage: safeCode(stage),
    code: safeCode(code),
    observedAt: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(details)) {
    if (["targetVersion", "activeVersion", "packageName"].includes(key) &&
        typeof value === "string" && value.length <= 214 &&
        /^[a-zA-Z0-9@._/-]+$/.test(value))
      issue[key] = value;
  }
  if (typeof details.sourceModule === "string" &&
      /^(?:application|storage|runtime|work|extensions|results|services|maintenance|contracts|transfer)\/[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*){0,2}$/.test(details.sourceModule))
    issue.sourceModule = details.sourceModule;
  if (typeof details.exceptionType === "string" &&
      ["AgentError", "Error", "TypeError", "RangeError", "ReferenceError",
        "SyntaxError", "AggregateError", "SystemError"].includes(details.exceptionType))
    issue.exceptionType = details.exceptionType;
  if (typeof details.sourceCode === "string" &&
      /^(?:E[A-Z_]{2,32}|ERR_[A-Z_]{2,72}|SQLITE_[A-Z_]{2,32})$/.test(details.sourceCode))
    issue.sourceCode = details.sourceCode;
  if (typeof details.recoveryCode === "string" &&
      ["check_configuration", "inspect_storage", "check_permissions",
        "verify_core", "check_network", "inspect_startup",
        "inspect_shutdown"].includes(details.recoveryCode))
    issue.recoveryCode = details.recoveryCode;
  return issue;
}

/** Read only the last complete, correlated Core failure. The caller must
 * never use arbitrary stderr or an old boot's evidence as the new cause. */
export async function coreFailureForAttempt(root, profile, attemptId) {
  try {
    const directory = await privateDir(path.join(root, "logs"));
    const text = await checkedText(path.join(directory, "agent.log"), MAX_LOG);
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      let row;
      try { row = JSON.parse(lines[index]); } catch { continue; }
      if (row?.code !== "agent_startup_failed" ||
          row.profile !== profile || row.attemptId !== attemptId)
        continue;
      const details = startupIssue("core", row.phase, row.failureCode, {
        sourceModule: row.sourceModule,
        sourceCode: row.sourceCode,
        exceptionType: row.exceptionType,
        recoveryCode: row.recoveryCode,
      });
      return {
        stage: details.stage, code: details.code,
        ...(details.sourceCode ? { sourceCode: details.sourceCode } : {}),
        ...(details.sourceModule ? { sourceModule: details.sourceModule } : {}),
        ...(details.exceptionType ? { exceptionType: details.exceptionType } : {}),
        ...(details.recoveryCode ? { recoveryCode: details.recoveryCode } : {}),
      };
    }
  } catch {
    // No valid, correlated evidence: never guess a cause from older logs.
  }
  return null;
}

async function installedMatches(work, approved) {
  for (const [name, version] of Object.entries(approved)) {
    try {
      const file = path.join(work, "node_modules", name, "package.json");
      const installed = JSON.parse(await checkedText(file, 1024 * 1024));
      if (installed.name !== name || installed.version !== version) return false;
    } catch (cause) {
      if (cause.code === "ENOENT") return false;
      throw cause;
    }
  }
  return true;
}

/**
 * The Launcher may reconcile ONLY the existing approved exact npm graph.
 * Work edits and disk-only packages must not become an approval at boot.
 * A failed install never replaces the working node_modules directory.
 */
export async function reconcileStartupPackages({
  root, program, profile, timeoutMs = 45000,
  install = npmExec, registries = npmRegistries(),
}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const work = path.join(root, "work");
  const approvalFile = path.join(root, "state", "maintenance", "packages.json");
  if (!existsSync(approvalFile))
    return { status: "not_configured", packageCount: 0, durationMs: Date.now() - started };
  const evidence = JSON.parse(await checkedText(approvalFile, 16 * 1024 * 1024));
  if (!checkedObject(evidence) || ![1, 2].includes(evidence.version) ||
      evidence.root !== root || evidence.profile !== profile ||
      (evidence.version === 2 && Object.hasOwn(evidence, "agentId")) ||
      !checkedObject(evidence.approved) ||
      typeof evidence.manifest !== "string" || typeof evidence.lock !== "string" ||
      await checkedText(path.join(work, "package.json")) !== evidence.manifest ||
      await checkedText(path.join(work, "package-lock.json")) !== evidence.lock)
    throw Object.assign(new Error("Approved npm graph differs from the work files."), {
      code: "npm_approval_changed",
    });
  const approved = evidence.approved;
  const manifest = JSON.parse(evidence.manifest);
  const lock = JSON.parse(evidence.lock);
  const declarations = { ...manifest.dependencies, ...manifest.devDependencies,
    ...manifest.optionalDependencies };
  const names = Object.keys(approved);
  if (names.length > 150 || Object.keys(declarations).some((name) => !approved[name]) ||
      names.some((name) =>
        !packageName.test(name) || !packageVersion.test(approved[name]) ||
        declarations[name] !== approved[name] ||
        lock.packages?.["node_modules/" + name]?.version !== approved[name]))
    throw Object.assign(new Error("Unapproved or conflicting npm dependency graph."), {
      code: "npm_approval_invalid",
    });
  if (!names.length || await installedMatches(work, approved))
    return { status: "ready", packageCount: names.length, durationMs: Date.now() - started };
  const staging = path.join(work, ".startup-npm-" + randomUUID());
  const backup = path.join(work, ".startup-previous-" + randomUUID());
  await privateDir(staging);
  let movedOld = false, activated = false;
  try {
    await writeFile(path.join(staging, "package.json"), evidence.manifest, {
      flag: "wx", mode: 0o600,
    });
    await writeFile(path.join(staging, "package-lock.json"), evidence.lock, {
      flag: "wx", mode: 0o600,
    });
    const npmCli = process.platform === "win32"
      ? path.join(program, "runtime", "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(program, "runtime", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    let lastError;
    for (const registry of registries) {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw Object.assign(new Error("The npm startup budget expired."), {
            code: "npm_update_timeout",
          });
        await install(process.execPath, [
          npmCli, "ci", "--prefix=" + staging, "--no-audit", "--no-fund",
          "--workspaces=false", "--registry=" + registry,
        ], staging, remaining);
        lastError = undefined;
        break;
      } catch (cause) {
        lastError = cause;
        if (Date.now() >= deadline) break;
      }
    }
    if (lastError) throw lastError;
    if (!(await installedMatches(staging, approved)))
      throw Object.assign(new Error("npm staged output does not match approval."), {
        code: "npm_stage_mismatch",
      });
    const active = path.join(work, "node_modules");
    if (existsSync(active)) {
      const info = await lstat(active);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Object.assign(new Error("Invalid installed npm directory."), {
          code: "npm_install_path_invalid",
        });
      await rename(active, backup);
      movedOld = true;
    }
    try {
      await rename(path.join(staging, "node_modules"), active);
      activated = true;
      if (!(await installedMatches(work, approved)))
        throw Object.assign(new Error("npm activated graph changed."), {
          code: "npm_activation_mismatch",
        });
    } catch (cause) {
      if (activated) await rename(active, path.join(staging, "node_modules"));
      if (movedOld) await rename(backup, active);
      throw cause;
    }
    if (movedOld) await rm(backup, { recursive: true, force: true }).catch(() => {});
    return { status: "updated", packageCount: names.length, durationMs: Date.now() - started };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Upgrade the already-approved direct packages; a failed update must leave
 * the last usable graph in place. New package names still require approval. */
export async function updateStartupPackages({
  root, program, profile, timeoutMs = 45000,
  install = npmExec, registries = npmRegistries(),
}) {
  const started = Date.now(), work = path.join(root, "work");
  const approvalFile = path.join(root, "state", "maintenance", "packages.json");
  if (!existsSync(approvalFile)) return { status: "not_configured", packageCount: 0, durationMs: 0 };
  const saved = JSON.parse(await checkedText(approvalFile, 16 * 1024 * 1024));
  if (!checkedObject(saved) || ![1, 2].includes(saved.version) ||
      saved.root !== root || saved.profile !== profile ||
      !checkedObject(saved.approved) ||
      typeof saved.manifest !== "string" || typeof saved.lock !== "string" ||
      await checkedText(path.join(work, "package.json")) !== saved.manifest ||
      await checkedText(path.join(work, "package-lock.json")) !== saved.lock)
    throw Object.assign(new Error("The approved package graph changed."), {
      code: "npm_approval_changed",
    });
  const names = Object.keys(saved.approved);
  if (!names.length) return { status: "ready", packageCount: 0, durationMs: Date.now() - started };
  const oldManifest = JSON.parse(saved.manifest), oldLock = JSON.parse(saved.lock);
  const declared = { ...oldManifest.dependencies, ...oldManifest.devDependencies,
    ...oldManifest.optionalDependencies };
  if (names.length > 150 || Object.keys(declared).length !== names.length ||
      names.some((name) => !packageName.test(name) ||
        !packageVersion.test(saved.approved[name]) ||
        declared[name] !== saved.approved[name] ||
        oldLock.packages?.["node_modules/" + name]?.version !== saved.approved[name]))
    throw Object.assign(new Error("The approved npm graph is invalid."), {
      code: "npm_approval_invalid",
    });
  if (!(await installedMatches(work, saved.approved)))
    throw Object.assign(new Error("The old package graph is not usable."), {
      code: "npm_packages_unavailable",
    });
  const staging = path.join(work, ".startup-update-" + randomUUID());
  const backup = path.join(work, ".startup-previous-" + randomUUID());
  await privateDir(staging);
  try {
    await writeFile(path.join(staging, "package.json"), saved.manifest, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(staging, "package-lock.json"), saved.lock, { flag: "wx", mode: 0o600 });
    const npmCli = path.join(program, "runtime", ...(process.platform === "win32"
      ? ["node_modules", "npm", "bin", "npm-cli.js"]
      : ["lib", "node_modules", "npm", "bin", "npm-cli.js"]));
    const packages = names.map((name) =>
      name + "@" + (profile === "development" && name.startsWith("@nexum-hub/")
        ? "next" : "latest"));
    let failure;
    for (const registry of registries) {
      try {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0)
          throw Object.assign(new Error("npm update deadline exceeded."), { code: "npm_update_timeout" });
        await install(process.execPath, [npmCli, "install", ...packages, "--save-exact",
          "--prefix=" + staging, "--workspaces=false", "--no-audit", "--no-fund",
          "--registry=" + registry], staging, remaining);
        failure = undefined;
        break;
      } catch (cause) {
        failure = cause;
      }
    }
    if (failure) throw failure;
    const manifest = await checkedText(path.join(staging, "package.json"));
    const lock = await checkedText(path.join(staging, "package-lock.json"));
    const next = JSON.parse(manifest), nextLock = JSON.parse(lock);
    const versions = { ...next.dependencies, ...next.devDependencies,
      ...next.optionalDependencies };
    if (Object.keys(versions).length !== names.length ||
        names.some((name) => !Object.hasOwn(versions, name) ||
          !packageVersion.test(versions[name]) ||
          nextLock.packages?.["node_modules/" + name]?.version !== versions[name]) ||
        !(await installedMatches(staging, versions)))
      throw Object.assign(new Error("The npm update graph did not verify."), {
        code: "npm_update_graph_invalid",
      });
    if (names.every((name) => versions[name] === saved.approved[name]))
      return { status: "ready", packageCount: names.length, durationMs: Date.now() - started };
    await privateDir(backup);
    await writeFile(path.join(staging, "packages.json"), JSON.stringify({
      version: 2, root, profile, approved: versions, manifest, lock,
    }), { flag: "wx", mode: 0o600 });
    const entries = [
      ["node_modules", path.join(work, "node_modules")],
      ["package.json", path.join(work, "package.json")],
      ["package-lock.json", path.join(work, "package-lock.json")],
      ["packages.json", approvalFile],
    ];
    const moved = [];
    try {
      for (const [name, destination] of entries) {
        const prior = await lstat(destination);
        if (prior.isSymbolicLink() ||
            (name === "node_modules" ? !prior.isDirectory() : !prior.isFile()))
          throw Object.assign(new Error("Unsafe package destination."), { code: "npm_install_path_invalid" });
        const entry = { name, destination, swapped: false };
        await rename(destination, path.join(backup, name));
        moved.push(entry);
        await rename(path.join(staging, name), destination);
        entry.swapped = true;
      }
      if (!(await installedMatches(work, versions)))
        throw Object.assign(new Error("Updated packages failed activation."), {
          code: "npm_activation_mismatch",
        });
    } catch (cause) {
      for (const entry of moved.reverse()) {
        if (entry.swapped) await rename(entry.destination, path.join(staging, entry.name));
        await rename(path.join(backup, entry.name), entry.destination);
      }
      throw cause;
    }
    await rm(backup, { recursive: true, force: true }).catch(() => {});
    return { status: "updated", packageCount: names.length, durationMs: Date.now() - started };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
