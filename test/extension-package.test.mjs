import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildExtensionApi,
  agentRoot,
} from "../scripts/build-extension-api.mjs";

const npmCli = path.join(
  process.platform === "win32"
    ? path.dirname(process.execPath)
    : path.dirname(path.dirname(process.execPath)),
  process.platform === "win32"
    ? "node_modules/npm/bin/npm-cli.js"
    : "lib/node_modules/npm/bin/npm-cli.js",
);
const command = (args, cwd) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
test("public extension tarball is generated from source, standalone, type-only and contains no private runtime", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "nexum-public-types-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = path.join(root, "package");
  await mkdir(pkg);
  const { declarations } = await buildExtensionApi({
    outDir: path.join(pkg, "dist"),
  });
  assert.match(declarations, /ExtensionFactory/);
  assert.match(declarations, /MaintenanceService/);
  assert.match(declarations, /TransferService/);
  assert.doesNotMatch(
    declarations,
    /class\s|SqliteStore|ResourceManager|RunEngine|ArtifactStore|loadProfileConfig|from ["']\.\.?\//,
  );
  await cp(
    path.join(agentRoot, "packages/extension-api/package.json"),
    path.join(pkg, "package.json"),
  );
  await cp(
    path.join(agentRoot, "packages/extension-api/README.md"),
    path.join(pkg, "README.md"),
  );
  const pack = JSON.parse(
    command(
      [
        npmCli,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        root,
      ],
      pkg,
    ),
  )[0];
  assert.deepEqual(pack.files.map((f) => f.path).sort(), [
    "README.md",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json",
  ]);
  const consumer = path.join(root, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  command(
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--offline",
      "--package-lock=false",
      path.join(root, pack.filename),
    ],
    consumer,
  );
  await writeFile(
    path.join(consumer, "consumer.ts"),
    `import type {ExtensionFactory, Invocation, TransferService, HostRequestServices} from '@nexum/extension-api';\nconst factory: ExtensionFactory = host => ({methods:{hello:{description:'hello',permissions:[],schemaDialect:'2020-12',inputSchema:{type:'object'},handle:(_input,call:Invocation)=>{const transfer:TransferService=call.transfer;return {ready:!!transfer,context:host.context};}}}});\nexport default factory;\n`,
  );
  command(
    [
      path.join(agentRoot, "node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--typeRoots",
      path.join(agentRoot, "node_modules/@types"),
      path.join(consumer, "consumer.ts"),
    ],
    consumer,
  );
  const installed = path.join(consumer, "node_modules/@nexum/extension-api");
  const before = (await readdir(consumer)).sort();
  assert.equal(
    command(
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(new URL("./dist/index.js", new URL("file://" + installed + "/")).href)}); console.log('ready')`,
      ],
      consumer,
    ).trim(),
    "ready",
  );
  assert.deepEqual((await readdir(consumer)).sort(), before);
  assert.equal(
    (await readFile(path.join(installed, "dist/index.js"), "utf8"))
      .trim()
      .endsWith("export {};"),
    true,
  );
});
