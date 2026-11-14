import { createReadStream } from "node:fs";
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  readlink,
  mkdtemp,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NODE_VERSION, childEnvironment } from "./service.mjs";
export const sourceRoot = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function packageFileHash(filename) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    if (size > 1024 ** 3)
      throw new Error("A package file exceeds the build budget.");
    hash.update(chunk);
  }
  return hash.digest("hex");
}
export const signatureMessage = (hash) =>
  Buffer.from(`NexumAgent/archive/v1\n${hash}\n`);
function run(file, args, cwd) {
  const result = spawnSync(file, args, {
    cwd,
    env: {
      ...childEnvironment(),
      npm_config_userconfig: path.join(cwd, ".npmrc"),
      npm_config_globalconfig: path.join(cwd, ".npmrc"),
    },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error("An isolated package build command failed.");
  return result.stdout;
}
export async function fileInventory(directory) {
  const result = [];
  async function visit(relative = "") {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      if (/[\0-\x1f\x7f]/.test(name))
        throw new Error("Package paths cannot contain control characters.");
      const local = path.join(relative, name),
        file = path.join(directory, local),
        info = await lstat(file),
        portable = local.split(path.sep).join("/");
      if (info.isDirectory()) await visit(local);
      else if (info.isFile())
        result.push({
          path: portable,
          type: "file",
          size: info.size,
          sha256: await packageFileHash(file),
          mode: info.mode & 0o777,
        });
      else if (info.isSymbolicLink()) {
        const target = await readlink(file),
          resolved = path.resolve(path.dirname(file), target);
        if (
          path.isAbsolute(target) ||
          !resolved.startsWith(path.resolve(directory) + path.sep)
        )
          throw new Error("A package symlink escapes its payload.");
        result.push({ path: portable, type: "symlink", target });
      } else
        throw new Error(
          "Only regular files and contained symlinks belong in a package.",
        );
    }
  }
  await visit();
  return result;
}
export async function buildAgent({
  root = sourceRoot,
  outputDir,
  signingKeyFile,
  nodeRoot,
  compiledDir,
  dependenciesDir,
  prepareDependencies = true,
  pnpmCli: selectedPnpmCli,
} = {}) {
  if (process.versions.node !== NODE_VERSION)
    throw new Error("Build with the fixed Node version.");
  if (!outputDir || !signingKeyFile)
    throw new Error("Use explicit output and private signing-key paths.");
  const key = createPrivateKey(await readFile(signingKeyFile));
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Use an Ed25519 release signing key.");
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (
    typeof manifest.version !== "string" ||
    !/^[0-9][A-Za-z0-9._+-]{0,127}$/.test(manifest.version)
  )
    throw new Error(
      "The Agent version cannot be used as a safe release filename.",
    );
  const temporary = await mkdtemp(path.join(tmpdir(), "nexum-agent-build-"));
  try {
    const app = path.join(temporary, "app");
    await mkdir(app);
    if (compiledDir)
      await cp(compiledDir, path.join(app, "dist"), {
        recursive: true,
        filter: (s) => !s.endsWith(".map"),
      });
    else
      run(
        process.execPath,
        [
          path.join(root, "node_modules/typescript/bin/tsc"),
          "--project",
          path.join(root, "tsconfig.json"),
          "--outDir",
          path.join(app, "dist"),
          "--sourceMap",
          "false",
        ],
        root,
      );
    await cp(path.join(root, "contracts"), path.join(app, "contracts"), {
      recursive: true,
    });
    if (dependenciesDir)
      await cp(dependenciesDir, path.join(app, "node_modules"), {
        recursive: true,
      });
    else if (prepareDependencies) {
      await cp(path.join(root, "package.json"), path.join(app, "package.json"));
      await cp(
        path.join(root, "pnpm-lock.yaml"),
        path.join(app, "pnpm-lock.yaml"),
      );
      await writeFile(
        path.join(app, ".npmrc"),
        "registry=https://registry.npmjs.org/\nnode-linker=hoisted\n",
      );
      const pnpmCli = selectedPnpmCli ?? process.env.npm_execpath;
      if (
        !pnpmCli ||
        !path.isAbsolute(pnpmCli) ||
        !/pnpm\.(?:cjs|mjs|js)$/.test(pnpmCli)
      )
        throw new Error(
          "Use pnpm run build:candidate or an explicit trusted pnpm JavaScript entry.",
        );
      const version = run(process.execPath, [pnpmCli, "--version"], app).trim();
      if (version !== "10.34.5")
        throw new Error("Use the pinned package manager.");
      run(
        process.execPath,
        [
          pnpmCli,
          "install",
          "--prod",
          "--frozen-lockfile",
          "--config.node-linker=hoisted",
        ],
        app,
      );
      await rm(path.join(app, "pnpm-lock.yaml"));
      await rm(path.join(app, ".npmrc"));
    } else await mkdir(path.join(app, "node_modules"));
    await writeFile(
      path.join(app, "package.json"),
      JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          type: "module",
          private: true,
          engines: manifest.engines,
          dependencies: manifest.dependencies,
        },
        null,
        2,
      ) + "\n",
    );
    const runtime = path.join(temporary, "runtime");
    await mkdir(runtime);
    const base =
      nodeRoot ??
      (process.platform === "win32"
        ? path.dirname(process.execPath)
        : path.dirname(path.dirname(process.execPath)));
    const selected =
      process.platform === "win32"
        ? ["node.exe", "node_modules/npm", "npm.cmd", "npx.cmd"]
        : ["bin/node", "lib/node_modules/npm", "bin/npm", "bin/npx"];
    for (const relative of selected) {
      await mkdir(path.dirname(path.join(runtime, relative)), {
        recursive: true,
      });
      await cp(path.join(base, relative), path.join(runtime, relative), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    const node = path.join(
      runtime,
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
    if (run(node, ["--version"], temporary).trim() !== `v${NODE_VERSION}`)
      throw new Error("The staged Node runtime has the wrong version.");
    await cp(path.join(base, "LICENSE"), path.join(runtime, "LICENSE"));
    await mkdir(path.join(temporary, "scripts"));
    for (const name of ["service.mjs", "install-agent.mjs", "build-agent.mjs"])
      await cp(
        new URL("./" + name, import.meta.url),
        path.join(temporary, "scripts", name),
      );
    if (prepareDependencies && !dependenciesDir)
      run(
        node,
        [
          "--input-type=module",
          "-e",
          "await import('node-pty'); await import('koffi');",
        ],
        app,
      );
    const inventory = await fileInventory(temporary);
    if (
      inventory.some(
        (x) =>
          !["app", "runtime", "scripts"].includes(x.path.split("/")[0]) ||
          /^app\/(?:docs|state|logs|tmp|test|tests|archive)(?:\/|$)/.test(
            x.path,
          ) ||
          /^app\/(?:config\.json|\.env(?:\.|$))/.test(x.path),
      )
    )
      throw new Error(
        "The staged package contains excluded local or archived material.",
      );
    const release = {
      schemaVersion: 1,
      name: "nexum-agent",
      version: manifest.version,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: NODE_VERSION,
      files: inventory,
    };
    await writeFile(
      path.join(temporary, "manifest.json"),
      JSON.stringify(release) + "\n",
    );
    await mkdir(outputDir, { recursive: true });
    if ((await readdir(outputDir)).length)
      throw new Error(
        "Use an empty output directory; inspect existing candidate files before another build.",
      );
    const kit = path.join(outputDir, "installer-kit");
    await mkdir(kit);
    for (const name of [
      "service.mjs",
      "install-agent.mjs",
      "build-agent.mjs",
      "install.sh",
      "install.ps1",
    ])
      await cp(new URL("./" + name, import.meta.url), path.join(kit, name));
    const filename = `nexum-agent-${manifest.version}-${process.platform}-${process.arch}.tar.gz`,
      archive = path.resolve(outputDir, filename);
    try {
      await lstat(archive);
      throw new Error(
        "The output archive already exists; inspect it before repeating a build.",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    run(
      process.platform === "win32" ? "tar.exe" : "tar",
      ["-czf", archive, "-C", temporary, "."],
      root,
    );
    const hash = await packageFileHash(archive);
    const signed = {
      algorithm: "Ed25519",
      sha256: hash,
      signature: sign(null, signatureMessage(hash), key).toString("base64"),
    };
    await writeFile(archive + ".sig", JSON.stringify(signed) + "\n", {
      flag: "wx",
    });
    await writeFile(archive + ".sha256", `${hash}  ${filename}\n`, {
      flag: "wx",
    });
    return {
      archive,
      sha256: hash,
      signatureFile: archive + ".sig",
      manifest: release,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      ![
        "--out-dir",
        "--signing-key-file",
        "--node-root",
        "--pnpm-cli",
      ].includes(args[i]) ||
      !args[i + 1]
    )
      throw new Error(
        "Use explicit build output, key and optional Node runtime paths.",
      );
    options[
      {
        "--out-dir": "outputDir",
        "--signing-key-file": "signingKeyFile",
        "--node-root": "nodeRoot",
        "--pnpm-cli": "pnpmCli",
      }[args[i]]
    ] = path.resolve(args[i + 1]);
  }
  const result = await buildAgent(options);
  console.log(
    JSON.stringify({ archive: result.archive, sha256: result.sha256 }),
  );
}
