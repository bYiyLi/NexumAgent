import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const fail = message => { throw new Error(message); };
const names = ["desktop-darwin-amd64", "desktop-darwin-arm64", "desktop-windows-amd64", "desktop-windows-arm64"];
function entries(dir) {
  if (!fs.lstatSync(dir).isDirectory()) fail("Expected real directory: " + dir);
  return fs.readdirSync(dir).sort();
}
function exact(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fail("Unexpected " + description + ": " + actual.join(", "));
}

export function prepareRelease(downloads, output, version, profile) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version) ||
      !["development", "production"].includes(profile) ||
      (profile === "development") !== version.includes("-")) fail("Invalid version/profile");
  exact(entries(downloads), names, "native artifact set");
  const files = [];
  const prefix = profile === "development" ? "NexumDesktopDev" : "NexumDesktop";
  for (const artifact of names) {
    const [, os, arch] = artifact.split("-");
    const file = prefix + "-" + version + "-" + os + "-" + arch + (os === "darwin" ? ".dmg" : "-installer.exe");
    const expected = [file, file + ".sha256", file + ".metadata.json"];
    let dir = path.join(downloads, artifact);
    // upload-artifact's wildcard can retain profile/release; a flat archive
    // is also valid. Do not recursively flatten arbitrary paths or merge names.
    if (JSON.stringify(entries(dir)) === JSON.stringify([profile])) {
      dir = path.join(dir, profile);
      exact(entries(dir), ["release"], "profile directory");
      dir = path.join(dir, "release");
    }
    exact(entries(dir), expected, artifact + " contents");
    for (const name of expected) {
      const source = path.join(dir, name);
      if (!fs.lstatSync(source).isFile()) fail("Expected regular file: " + source);
      files.push({ source, name });
    }
    const digest = createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex");
    if (fs.readFileSync(path.join(dir, file + ".sha256"), "utf8") !== digest + "  " + file + "\n") fail("Invalid package checksum: " + file);
  }
  // Only create the destination after validating the complete source set.
  fs.mkdirSync(output);
  for (const { source, name } of files) fs.copyFileSync(source, path.join(output, name), fs.constants.COPYFILE_EXCL);
  return files.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = prepareRelease(process.argv[2], process.argv[3], process.env.VERSION ?? "", process.env.PROFILE ?? "");
  console.log("Verified and staged " + count + " Desktop release files");
}
