import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  writeFile,
  lstat,
  realpath,
  rename,
  rm,
  readdir,
  open,
  mkdtemp,
} from "node:fs/promises";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileInventory, signatureMessage } from "./build-agent.mjs";
import {
  NODE_VERSION,
  childEnvironment,
  servicePlan,
  serviceAction,
  writeServiceManifest,
  currentWindowsSid,
} from "./service.mjs";
const profiles = new Set(["development", "production"]),
  hashPattern = /^[0-9a-f]{64}$/;
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
async function hashFile(filename) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    assert(
      size <= 1024 ** 3,
      "The installation archive exceeds its byte budget.",
    );
    hash.update(chunk);
  }
  return hash.digest("hex");
}
function native(file, args, maxBuffer = 32 * 1024 * 1024) {
  const result = spawnSync(file, args, {
    env: childEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
  });
  assert(
    !result.error && result.status === 0,
    "A native installer command failed; inspect actual state before repeating it.",
  );
  return result.stdout;
}
async function directory(filename) {
  try {
    await mkdir(filename, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = await lstat(filename);
  assert(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      (await realpath(filename)) === path.resolve(filename),
    "The installation directory must remain canonical and local.",
  );
}
async function protectWindows(filename) {
  if (process.platform !== "win32") return;
  const literal = "'" + filename.replaceAll("'", "''") + "'";
  const script =
    "$ErrorActionPreference='Stop';$id=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($id);$acl.SetAccessRuleProtection($true,$false);foreach($sid in @($id,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)};Set-Acl -LiteralPath " +
    literal +
    " -AclObject $acl";
  native(
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
  );
}
async function boundedBytes(filename, maximum) {
  const file = await open(
    filename,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await file.stat();
    assert(
      info.isFile() && info.size <= maximum,
      "The installer metadata is unavailable or too large.",
    );
    const buffer = Buffer.alloc(Math.min(maximum + 1, 65536)),
      chunks = [];
    let size = 0;
    while (true) {
      const read = await file.read(
        buffer,
        0,
        Math.min(buffer.length, maximum + 1 - size),
        null,
      );
      if (!read.bytesRead) break;
      size += read.bytesRead;
      assert(
        size <= maximum,
        "The installer metadata exceeds its byte budget.",
      );
      chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}
async function boundedJSON(filename, maximum) {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await boundedBytes(filename, maximum),
    ),
  );
}

function configuration(value, profile) {
  assert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      typeof value.server_url === "string" &&
      typeof value.token === "string" &&
      /^[\x21-\x7e]{1,8192}$/.test(value.token),
    "Use only server_url and a valid token in the private configuration.",
  );
  assert(
    value.server_url.trim() === value.server_url &&
      Buffer.byteLength(value.server_url) <= 8192 &&
      !/[\x00-\x20\x7f]/.test(value.server_url),
    "The Server URL must be exact bounded text.",
  );
  const server = new URL(value.server_url);
  assert(
    ["http:", "https:"].includes(server.protocol) &&
      (profile === "development" || server.protocol === "https:") &&
      !server.username &&
      !server.password &&
      !server.hash &&
      !server.search,
    "The selected profile Server URL is invalid.",
  );
  return { server_url: server.href, token: value.token };
}
export async function verifyArchive({
  archive,
  sha256,
  signatureFile,
  publicKeyFile,
}) {
  assert(
    process.versions.node === NODE_VERSION,
    "Use the fixed trusted bootstrap Node version.",
  );
  assert(
    hashPattern.test(sha256) &&
      path.isAbsolute(archive) &&
      path.isAbsolute(signatureFile) &&
      path.isAbsolute(publicKeyFile),
    "Use explicit archive, digest, detached signature and independently trusted public-key paths.",
  );
  const fixedRoot = await mkdtemp(
      path.join(tmpdir(), "nexum-verified-archive-"),
    ),
    fixedArchive = path.join(fixedRoot, "program.tar.gz");
  let input;
  try {
    input = await open(
      archive,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const before = await input.stat();
    assert(
      before.isFile() && before.size <= 1024 ** 3,
      "Use a regular bounded installation archive.",
    );
    const target = await open(fixedArchive, "wx", 0o600);
    let copied = 0;
    try {
      const buffer = Buffer.allocUnsafe(65536);
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        copied += bytesRead;
        assert(copied <= 1024 ** 3, "The archive exceeds its copy budget.");
        let written = 0;
        while (written < bytesRead) {
          const result = await target.write(
            buffer,
            written,
            bytesRead - written,
            null,
          );
          assert(
            result.bytesWritten > 0,
            "The archive copy could not make progress.",
          );
          written += result.bytesWritten;
        }
      }
      await target.sync();
    } finally {
      await target.close();
    }
    const after = await input.stat();
    assert(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        copied === before.size,
      "The source archive changed while being fixed.",
    );
    await input.close();
    input = undefined;
    archive = fixedArchive;
    const actual = await hashFile(archive);
    assert(
      actual === sha256,
      "The archive checksum does not match the trusted expected digest.",
    );

    const signed = await boundedJSON(signatureFile, 4096),
      key = createPublicKey(await boundedBytes(publicKeyFile, 16384));
    assert(
      key.asymmetricKeyType === "ed25519" &&
        signed.algorithm === "Ed25519" &&
        signed.sha256 === actual &&
        typeof signed.signature === "string" &&
        verify(
          null,
          signatureMessage(actual),
          key,
          Buffer.from(signed.signature, "base64"),
        ),
      "The archive signature does not match the independently trusted publisher key.",
    );
    // Verify the complete archive before invoking its Node or extracting any file.
    const tar = process.platform === "win32" ? "tar.exe" : "tar";
    const listed = native(tar, ["-tzf", archive]);
    assert(
      listed
        .split(/\r?\n/)
        .filter(Boolean)
        .every(
          (name) =>
            !/[\0-\x1f\x7f\\]/.test(name) &&
            !path.posix.isAbsolute(name) &&
            !name.split("/").includes("..") &&
            !/^[A-Za-z]:/.test(name),
        ),
      "The signed archive contains an unsafe path.",
    );
    const manifest = JSON.parse(
      native(tar, ["-xOzf", archive, "./manifest.json"]),
    );
    assert(
      manifest.schemaVersion === 1 &&
        manifest.name === "nexum-agent" &&
        manifest.platform === process.platform &&
        manifest.arch === process.arch &&
        manifest.nodeVersion === NODE_VERSION &&
        typeof manifest.version === "string" &&
        Array.isArray(manifest.files) &&
        manifest.files.length <= 100000,
      "The signed program does not match this platform and Node version.",
    );
    assert(
      manifest.files.every(
        (item) =>
          item &&
          typeof item.path === "string" &&
          !item.path.startsWith("/") &&
          !item.path.includes("\\") &&
          !item.path.split("/").some((x) => !x || x === "." || x === "..") &&
          ["app", "runtime", "scripts"].includes(item.path.split("/")[0]),
      ),
      "The signed inventory contains an unsafe payload path.",
    );
    return {
      sha256: actual,
      manifest,
      archive: fixedArchive,
      dispose: () => rm(fixedRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await input?.close();
    await rm(fixedRoot, { recursive: true, force: true });
    throw error;
  }
}
async function verifyExtracted(stage, manifest, executeNode = true) {
  const records = (await fileInventory(stage)).filter(
    (item) =>
      item.path !== "manifest.json" && item.path !== ".installation.json",
  );
  const expected = manifest.files.map((item) => {
    const { mode, ...rest } = item;
    return rest;
  });
  const actual = records.map((item) => {
    const { mode, ...rest } = item;
    return rest;
  });
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    "The extracted files differ from the signed program inventory.",
  );
  if (!executeNode) return;
  const node = path.join(
    stage,
    "runtime",
    process.platform === "win32" ? "node.exe" : "bin/node",
  );
  assert(
    native(node, ["--version"]).trim() === `v${NODE_VERSION}`,
    "The verified Node runtime has the wrong version.",
  );
}
async function atomicJSON(filename, value) {
  const temporary = filename + `.${process.pid}.new`;
  await writeFile(temporary, JSON.stringify(value) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, filename);
}
/** Explicit user installation/update; tests use a temporary home and no OS registration. */
export async function installAgent(options) {
  const {
    profile,
    home = homedir(),
    config,
    replaceConfig = false,
    registerService = true,
    start = true,
  } = options;
  assert(profiles.has(profile), "Select an explicit Agent profile.");
  const checked = await verifyArchive(options);
  try {
    const canonicalHome = await realpath(home);
    assert(
      canonicalHome === path.resolve(home),
      "Use a canonical target-user home.",
    );
    const root = path.join(
      home,
      profile === "development" ? ".nexum-dev" : ".nexum",
    );
    await directory(root);
    await protectWindows(root);
    await directory(path.join(root, "program"));
    await directory(path.join(root, "program", "versions"));
    const lockPath = path.join(root, "program", "install.lock"),
      lock = await open(lockPath, "wx", 0o600);
    let staging;
    try {
      const configPath = path.join(root, "config.json");
      let previousConfig;
      try {
        previousConfig = configuration(
          await boundedJSON(configPath, 16384),
          profile,
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const nextConfig =
        config === undefined ? previousConfig : configuration(config, profile);
      assert(
        nextConfig,
        "A first installation needs its private configuration on standard input.",
      );
      assert(
        !previousConfig ||
          config === undefined ||
          replaceConfig ||
          JSON.stringify(previousConfig) === JSON.stringify(nextConfig),
        "Replacing existing credentials needs the explicit replace-config option.",
      );
      const destination = path.join(
        root,
        "program",
        "versions",
        checked.sha256,
      );
      let exists = false;
      try {
        await lstat(destination);
        exists = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (exists) await verifyExtracted(destination, checked.manifest);
      else {
        staging = path.join(
          root,
          "program",
          `.install-${process.pid}-${checked.sha256.slice(0, 12)}`,
        );
        await mkdir(staging, { mode: 0o700 });
        native(process.platform === "win32" ? "tar.exe" : "tar", [
          "-xzf",
          checked.archive,
          "-C",
          staging,
        ]);
        await verifyExtracted(staging, checked.manifest);
        await writeFile(
          path.join(staging, ".installation.json"),
          JSON.stringify({
            sha256: checked.sha256,
            manifestSha256: createHash("sha256")
              .update(await readFile(path.join(staging, "manifest.json")))
              .digest("hex"),
          }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        await rename(staging, destination);
        staging = undefined;
      }
      const activePath = path.join(root, "program", "active.json");
      let old;
      try {
        old = await boundedJSON(activePath, 16384);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const windowsSid =
        process.platform === "win32" ? currentWindowsSid() : undefined;
      const plan = servicePlan({
        profile,
        home,
        programDir: destination,
        windowsSid,
      });
      if (registerService && old) {
        const previous = servicePlan({
          profile,
          home,
          programDir: old.programDir,
          windowsSid,
        });
        const state = await serviceAction(previous, "status");
        if (state.registered) await serviceAction(previous, "stop");
        await serviceAction(previous, "remove");
      }
      if (!previousConfig || config !== undefined)
        await atomicJSON(configPath, nextConfig);
      await atomicJSON(activePath, {
        schemaVersion: 1,
        sha256: checked.sha256,
        version: checked.manifest.version,
        nodeVersion: NODE_VERSION,
        platform: process.platform,
        arch: process.arch,
        programDir: destination,
        installedAt: new Date().toISOString(),
      });
      if (registerService) {
        await serviceAction(plan, "install");
        if (start) await serviceAction(plan, "start");
      } else
        await writeServiceManifest({
          ...plan,
          manifestPath: path.join(
            root,
            "state",
            "service-preview" +
              (process.platform === "win32"
                ? ".xml"
                : process.platform === "darwin"
                  ? ".plist"
                  : ".service"),
          ),
        });
      return {
        profile,
        programDir: destination,
        version: checked.manifest.version,
        serviceRegistered: registerService,
        startRequested: registerService && start,
        manifestPath: registerService
          ? plan.manifestPath
          : path.join(
              root,
              "state",
              "service-preview" +
                (process.platform === "win32"
                  ? ".xml"
                  : process.platform === "darwin"
                    ? ".plist"
                    : ".service"),
            ),
      };
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
      await lock.close();
      await rm(lockPath);
    }
  } finally {
    await checked.dispose();
  }
}
export async function cleanupPrograms({ profile, home = homedir() } = {}) {
  assert(profiles.has(profile), "Select an explicit Agent profile.");
  const root = path.join(
      home,
      profile === "development" ? ".nexum-dev" : ".nexum",
    ),
    program = path.join(root, "program");
  const versions = path.join(program, "versions"),
    lock = await open(path.join(program, "install.lock"), "wx", 0o600),
    removed = [],
    retained = [];
  try {
    const active = await boundedJSON(path.join(program, "active.json"), 16384);
    assert(
      hashPattern.test(active.sha256) &&
        active.programDir === path.join(versions, active.sha256),
      "The active version receipt is invalid.",
    );
    for (const name of await readdir(versions)) {
      if (!hashPattern.test(name) || name === active.sha256) continue;
      const filename = path.join(versions, name),
        info = await lstat(filename);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        retained.push(name);
        continue;
      }
      try {
        const manifest = await boundedJSON(
          path.join(filename, "manifest.json"),
          32 * 1024 * 1024,
        );
        assert(
          manifest.name === "nexum-agent" &&
            manifest.nodeVersion === NODE_VERSION,
          "Unknown version directory.",
        );
        const receipt = await boundedJSON(
          path.join(filename, ".installation.json"),
          4096,
        );
        assert(
          receipt.sha256 === name &&
            receipt.manifestSha256 ===
              createHash("sha256")
                .update(await readFile(path.join(filename, "manifest.json")))
                .digest("hex"),
          "No verified installation receipt exists.",
        );
        await verifyExtracted(filename, manifest, false);
        await rm(filename, { recursive: true });
        removed.push(name);
      } catch {
        retained.push(name);
      }
    }
    return { removed, retained };
  } finally {
    await lock.close();
    await rm(path.join(program, "install.lock"));
  }
}
async function stdinConfig() {
  if (process.stdin.isTTY) return undefined;
  let bytes = 0,
    parts = [];
  for await (const part of process.stdin) {
    bytes += part.length;
    assert(bytes <= 16384, "The private configuration is too large.");
    parts.push(part);
  }
  const text = Buffer.concat(parts).toString("utf8").trim();
  return text ? JSON.parse(text) : undefined;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = {},
    args = process.argv.slice(2);
  let cleanup = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--cleanup") {
      cleanup = true;
      continue;
    }
    if (name === "--no-register") {
      options.registerService = false;
      continue;
    }
    if (name === "--no-start") {
      options.start = false;
      continue;
    }
    if (name === "--replace-config") {
      options.replaceConfig = true;
      continue;
    }
    const field = {
      "--profile": "profile",
      "--home": "home",
      "--archive": "archive",
      "--sha256": "sha256",
      "--signature-file": "signatureFile",
      "--public-key-file": "publicKeyFile",
    }[name];
    assert(field && args[i + 1], "Unknown installer option.");
    options[field] =
      field === "profile" || field === "sha256"
        ? args[++i]
        : path.resolve(args[++i]);
  }
  try {
    assert(
      !options.home || options.registerService === false,
      "A temporary home requires no-register mode.",
    );
    const result = cleanup
      ? await cleanupPrograms(options)
      : await installAgent({ ...options, config: await stdinConfig() });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      "Agent installation did not complete. Inspect current version/service state before retrying; no credential or provider output is included.",
    );
    process.exitCode = 1;
  }
}
