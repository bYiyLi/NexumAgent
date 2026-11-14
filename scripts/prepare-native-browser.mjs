/** Pinned, disposable Chrome for Testing for native CI; never selects a user's browser. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  lstat,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { childEnvironment } from "./service.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.versions.node, "24.22.1");
assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_ENV);
const temp = await realpath(process.env.RUNNER_TEMP);
const environment = await realpath(process.env.GITHUB_ENV);
const relative = path.relative(temp, environment);
assert.ok(
  relative &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative) &&
    (await lstat(environment)).isFile(),
);

const version = "160.0.8160.0";
// SHA-256 was computed over complete streams from these exact official HTTPS
// release objects, with their full Content-Length checked, before enabling CI.
const archives = {
  "linux-x64": {
    platform: "linux64",
    size: 214853842,
    sha256: "7521f2e2f6fe90af5b1d6481a80a0a1421b6d743e370de6f614b05d4b1bed4de",
    executable: "chrome",
  },
  "darwin-x64": {
    platform: "mac-x64",
    size: 214624298,
    sha256: "7fd77afe2e542a15113d6ecafd0c6ce6cea70548801a04071b35f09818f5efe6",
    executable:
      "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  },
  "win32-x64": {
    platform: "win64",
    size: 218433523,
    sha256: "574ca7f73e650798e184eb6b2c5aa8c590dd7a46d18add670c9d0bb69d95ac14",
    executable: "chrome.exe",
  },
};
const archive = archives[`${process.platform}-${process.arch}`];
assert.ok(archive, "This CI fixture requires one of its native x64 runners.");
const root = await mkdtemp(path.join(temp, "nexum-browser-native-"));
const zip = path.join(root, "chrome.zip");
const extraction = path.join(root, "extracted");
let prepared = false;
const run = (file, args) =>
  execFileSync(file, args, {
    env: childEnvironment(),
    windowsHide: true,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
try {
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/${archive.platform}/chrome-${archive.platform}.zip`;
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get("content-length")), archive.size);
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.byteLength;
        if (bytes > archive.size)
          return done(
            new Error("The pinned browser archive exceeded its exact size."),
          );
        hash.update(chunk);
        done(null, chunk);
      },
    }),
    createWriteStream(zip, { flags: "wx", mode: 0o600 }),
  );
  assert.equal(bytes, archive.size);
  assert.equal(hash.digest("hex"), archive.sha256);
  if (process.platform === "win32") {
    const literal = (value) => {
      assert.doesNotMatch(value, /[\0\r\n]/);
      return "'" + value.replaceAll("'", "''") + "'";
    };
    run(
      path.join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop';Expand-Archive -LiteralPath ${literal(zip)} -DestinationPath ${literal(extraction)}`,
      ],
    );
  } else {
    run("unzip", ["-q", zip, "-d", extraction]);
  }
  const directory = path.join(extraction, `chrome-${archive.platform}`);
  const binary = await realpath(path.join(directory, archive.executable));
  assert.ok((await lstat(binary)).isFile());
  assert.doesNotMatch(binary, /[\0\r\n]/);
  const variables = [`NEXUM_BROWSER_NATIVE_BINARY=${binary}`];
  if (process.platform === "linux") {
    // Ubuntu's unprivileged-user-namespace policy also applies to CfT. Configure
    // only this verified release's native SUID helper in the owned runner temp;
    // do not disable the browser sandbox or change a global kernel policy.
    const sandbox = path.join(directory, "chrome_sandbox");
    assert.ok((await lstat(sandbox)).isFile());
    run("sudo", ["--non-interactive", "chown", "root:root", sandbox]);
    run("sudo", ["--non-interactive", "chmod", "4755", sandbox]);
    const info = await lstat(sandbox);
    assert.ok(info.uid === 0 && (info.mode & 0o4000) !== 0);
    variables.push(`CHROME_DEVEL_SANDBOX=${sandbox}`);
  }
  const binaryHash = createHash("sha256");
  for await (const chunk of createReadStream(binary)) binaryHash.update(chunk);
  const receipt = {
    version,
    platform: process.platform,
    architecture: process.arch,
    archiveSha256: archive.sha256,
    archiveBytes: bytes,
    binarySha256: binaryHash.digest("hex"),
    userBrowserSelected: false,
    sandboxDisabled: false,
  };
  await writeFile(
    path.join(root, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600 },
  );
  await appendFile(environment, variables.join("\n") + "\n");
  await rm(zip);
  prepared = true;
  console.log(JSON.stringify(receipt));
} finally {
  if (!prepared) await rm(root, { recursive: true, force: true });
}
