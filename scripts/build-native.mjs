import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const nativeTargets = [
  ["windows", "x64", "amd64", "nexum-agent.exe"],
  ["windows", "arm64", "arm64", "nexum-agent.exe"],
  ["darwin", "x64", "amd64", "nexum-agent"],
  ["darwin", "arm64", "arm64", "nexum-agent"],
  ["linux", "x64", "amd64", "nexum-agent"],
  ["linux", "arm64", "arm64", "nexum-agent"],
];
export function nativePath(platform, arch, program) {
  const target = nativeTargets.find(([os, cpu]) => os === platform && cpu === arch);
  if (!target) throw new Error("Unsupported native Agent platform.");
  return path.join(
    root, "native", platform + "-" + arch, target[3],
  );
}
const inspect = async (name) => {
  const file = await stat(name);
  if (!file.isFile() || file.size < 10000 || file.size > 20 * 1024 * 1024)
    throw new Error("Native Agent executable has an invalid size.");
  const body = await readFile(name);
  if (!(body.subarray(0, 2).toString() === "MZ" ||
    (body[0] === 0x7f && body.subarray(1, 4).toString() === "ELF") ||
    [0xfeedfacf, 0xcffaedfe, 0xcafebabe].includes(body.readUInt32BE(0)) ||
    [0xfeedfacf, 0xcffaedfe].includes(body.readUInt32LE(0))))
    throw new Error("Native Agent is not a valid platform executable.");
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const native = path.join(root, "native");
  await rm(native, { recursive: true, force: true });
  for (const [platform, arch, goarch, name] of nativeTargets) {
    const output = path.join(native, platform + "-" + arch, name);
    await mkdir(path.dirname(output), { recursive: true });
    const flags = platform === "windows"
      ? ["-ldflags=-s -w -H windowsgui"] : ["-ldflags=-s -w"];
    const result = spawnSync(
      "go", ["build", "-trimpath", "-buildvcs=false", ...flags, "-o", output, "./native-src"],
      { cwd: root, encoding: "utf8", env: {
        ...process.env, GO111MODULE: "off", CGO_ENABLED: "0",
        GOOS: platform, GOARCH: goarch,
      }, timeout: 120000 },
    );
    if (result.status !== 0 || result.error)
      throw new Error("Native " + platform + "/" + arch + " build failed: " +
        (result.stderr || result.error?.code || result.status));
    await inspect(output);
    console.log("Built native Agent", platform, arch);
  }
}
