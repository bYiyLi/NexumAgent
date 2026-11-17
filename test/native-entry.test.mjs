import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nativeTargets } from "../scripts/build-native.mjs";
import { installNativeEntry, verifyNativeExecutable } from "../scripts/npm-install.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const fileFor = (platform, arch, filename) =>
  path.join(root, "native", platform + "-" + arch, filename);
const hasNative = nativeTargets.every(([platform, arch, , filename]) =>
  existsSync(fileFor(platform, arch, filename)));

test("native Agent targets contain six exact names and verified architectures", {
  skip: !hasNative && "Run node scripts/build-native.mjs before native artifact checks.",
}, async () => {
  assert.deepEqual(
    nativeTargets.map(([platform, arch, , name]) => platform + "-" + arch + "/" + name),
    [
      "windows-x64/nexum-agent.exe", "windows-arm64/nexum-agent.exe",
      "darwin-x64/nexum-agent", "darwin-arm64/nexum-agent",
      "linux-x64/nexum-agent", "linux-arm64/nexum-agent",
    ],
  );
  for (const [platform, arch, , filename] of nativeTargets) {
    const buffer = await readFile(fileFor(platform, arch, filename));
    if (platform === "windows") {
      assert.equal(buffer.subarray(0, 2).toString(), "MZ");
      const pe = buffer.readUInt32LE(0x3c);
      assert.equal(buffer.subarray(pe, pe + 4).toString("hex"), "50450000");
      assert.equal(buffer.readUInt16LE(pe + 4), arch === "x64" ? 0x8664 : 0xaa64);
      assert.equal(buffer.readUInt16LE(pe + 24 + 68), 2,
        "Windows native Agent must use GUI subsystem, never Console");
    } else if (platform === "linux") {
      assert.equal(buffer.subarray(0, 4).toString("hex"), "7f454c46");
      assert.equal(buffer.readUInt16LE(18), arch === "x64" ? 62 : 183);
    } else {
      assert.equal(buffer.readUInt32LE(0), 0xfeedfacf);
      assert.equal(buffer.readUInt32LE(4), arch === "x64" ? 0x01000007 : 0x0100000c);
    }
  }
});

test("installer rejects wrong CPU and non-GUI Windows executables", {
  skip: !hasNative && "Native release assets must be compiled first.",
}, async (t) => {
  const scratch = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-native-validation-")),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const [platform, arch, , filename] of nativeTargets) {
    const file = fileFor(platform, arch, filename);
    const os = platform === "windows" ? "win32" : platform;
    assert.equal(await verifyNativeExecutable(file, os, arch), true);
    await assert.rejects(
      () => verifyNativeExecutable(file, os, arch === "x64" ? "arm64" : "x64"),
      /does not match this platform/,
    );
  }
  const original = await readFile(fileFor("windows", "x64", "nexum-agent.exe"));
  const pe = original.readUInt32LE(0x3c);
  const modified = Buffer.from(original);
  modified.writeUInt16LE(3, pe + 24 + 68);
  const fake = path.join(scratch, "nexum-agent.exe");
  await writeFile(fake, modified);
  await assert.rejects(
    () => verifyNativeExecutable(fake, "win32", "x64"),
    /does not match this platform/,
  );
});

test("the installer copies the platform-specific published native executable", {
  skip: !hasNative && "Native release assets must be compiled first.",
}, async (t) => {
  const scratch = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-native-copy-")),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const program = path.join(scratch, "program");
  for (const [osName, platform, arch] of [
    ["windows", "win32", "x64"],
    ["windows", "win32", "arm64"],
    ["darwin", "darwin", "arm64"],
    ["linux", "linux", "x64"],
  ]) {
    const name = platform === "win32" ? "nexum-agent.exe" : "nexum-agent";
    const src = path.join(program, "app/node_modules/@nexum-hub/agent/native",
      osName + "-" + arch, name);
    await mkdir(path.dirname(src), { recursive: true });
    await cp(fileFor(osName, arch, name), src);
    const installed = await installNativeEntry(program, { platform, arch });
    assert.equal(installed, path.join(program, name));
    assert.deepEqual(await readFile(installed), await readFile(src));
  }
});

test("Unix native Agent execs managed runtime without a resident helper", {
  skip: process.platform === "win32" || !hasNative &&
    "Native binaries are built by CI and the publish workflow.",
  timeout: 12000,
}, async t => {
  const base = realpathSync.native(await mkdtemp(path.join(tmpdir(), "nexum-native-exec-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "用户 空格 & $ %");
  const program = path.join(home, ".nexum-dev", "program");
  await mkdir(path.join(program, "runtime", "bin"), { recursive: true });
  await writeFile(path.join(program, "service-runner.mjs"), "");
  const command = path.join(program, "runtime", "bin", "node");
  await writeFile(command, "#!/bin/sh\nprintf '%s\\n' \"$$\" \"$1\" \"$2\" \"$3\" \"$HOME\" \"${NODE_OPTIONS:-empty}\"\n");
  await chmod(command, 0o700);
  const executable = fileFor(
    process.platform, process.arch === "x64" ? "x64" : "arm64", "nexum-agent",
  );
  const child = spawn(executable, ["--profile", "development", "--home", home], {
    env: { ...process.env, NODE_OPTIONS: "--require=untrusted.js", HOME: "/wrong" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const [code, signal] = await new Promise(resolve =>
    child.once("exit", (status, reason) => resolve([status, reason])));
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  const lines = stdout.trim().split("\n");
  assert.equal(Number(lines[0]), child.pid,
    "syscall.Exec must replace the native Host with Node in the same PID");
  assert.equal(lines[1], path.join(program, "service-runner.mjs"));
  assert.equal(lines[2], "--profile");
  assert.equal(lines[3], "development");
  assert.equal(lines[4], home);
  assert.equal(lines[5], "empty");
});
