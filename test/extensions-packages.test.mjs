import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  truncateSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectExtensionPackage,
  verifyExtensionPackage,
} from "../dist/extensions/packages.js";
import { ModuleLoader } from "../dist/runtime/modules.js";

const name = "@fixture/extension";
const script = (
  filename = "inspect.js",
  schema = { type: "object", additionalProperties: false },
) =>
  `/** ${JSON.stringify({ scriptName: filename, scriptDesc: "Inspect an endpoint", scriptWhenUse: "When endpoint inspection is needed", scriptInputSchema: schema, scriptOpenDefault: true })} */\nthrow new Error("script body must not be executed during preflight");\n`;
function write(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(
    filename,
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(value, null, 2),
  );
}
async function fixture(t, { pnpm = false } = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-extension-package-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, "work"),
    modules = path.join(work, "node_modules");
  const installed = path.join(modules, ...name.split("/"));
  const packageRoot = pnpm
    ? path.join(
        modules,
        ".pnpm",
        "fixture-extension@1.0.0",
        "node_modules",
        ...name.split("/"),
      )
    : installed;
  mkdirSync(packageRoot, { recursive: true });
  if (pnpm) {
    mkdirSync(path.dirname(installed), { recursive: true });
    symlinkSync(packageRoot, installed, "junction");
  }
  const sentinel = path.join(root, "evaluated");
  const manifest = {
    name,
    version: "1.0.0",
    type: "module",
    exports: {
      "./nexum": {
        types: "./dist/extension.d.ts",
        node: { import: "./dist/extension.js", require: "./dist/require.cjs" },
        default: "./dist/fallback.js",
      },
    },
    nexum: {
      apiVersion: 1,
      namespace: "fixtureSDK",
      permissions: ["network"],
      instructions: "./instructions/README.md",
      docs: "./docs",
      scripts: "./scripts",
      skills: "./skills",
    },
  };
  write(path.join(work, "package.json"), {
    private: true,
    type: "module",
    dependencies: { [name]: "1.0.0" },
  });
  write(path.join(packageRoot, "package.json"), manifest);
  write(
    path.join(packageRoot, "dist", "extension.js"),
    `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(sentinel)},"evaluated");export default function createExtension(){return {methods:{}};}\n`,
  );
  write(
    path.join(packageRoot, "dist", "require.cjs"),
    'throw new Error("wrong require condition");',
  );
  write(
    path.join(packageRoot, "dist", "fallback.js"),
    'throw new Error("wrong default condition");',
  );
  write(
    path.join(packageRoot, "dist", "extension.d.ts"),
    "export default function createExtension(host: unknown): {methods: Record<string,unknown>};\n",
  );
  write(
    path.join(packageRoot, "private-helper.js"),
    "export const shared = 1;\n",
  );
  write(
    path.join(packageRoot, ".private-metadata"),
    "private package metadata must only affect the aggregate revision",
  );
  write(
    path.join(packageRoot, "instructions", "README.md"),
    "# SDK usage rules\nUse the documented workflow.\n",
  );
  write(
    path.join(packageRoot, "docs", "README.md"),
    "# SDK manual\nUse the endpoint inspection capability.\n",
  );
  write(
    path.join(packageRoot, "docs", "reference", "example.md"),
    "# Example\nA longer example.\n",
  );
  write(
    path.join(packageRoot, "docs", ".secret"),
    "must not be automatically published",
  );
  write(
    path.join(packageRoot, "docs", "picture.bin"),
    Buffer.from([0, 1, 2, 3]),
  );
  write(path.join(packageRoot, "scripts", "inspect.js"), script());
  write(
    path.join(packageRoot, "skills", "endpoint-audit", "SKILL.md"),
    "---\nname: endpoint-audit\ndescription: Inspect endpoints using the SDK.\ncompatibility: Requires network access.\n---\n# Endpoint audit\nRead resources/example.txt when needed.\n",
  );
  write(
    path.join(
      packageRoot,
      "skills",
      "endpoint-audit",
      "resources",
      "example.txt",
    ),
    "a Skill-specific example",
  );
  const approved = new Map([[name, "1.0.0"]]);
  const policy = { builtins: () => [], approvedPackages: () => approved };
  const loader = await ModuleLoader.create(
    work,
    "extension-package-test",
    policy,
  );
  const options = {
    work,
    packageName: name,
    policy,
    resolveImport: loader.resolveImport.bind(loader),
    permissions: new Set(["network", "shell"]),
  };
  return {
    root,
    work,
    packageRoot,
    manifest,
    sentinel,
    approved,
    loader,
    options,
    saveManifest: () => write(path.join(packageRoot, "package.json"), manifest),
  };
}

test("explicit package preflight uses native import conditions and returns fixed five-contribution sources without evaluation", async (t) => {
  const f = await fixture(t);
  const descriptor = await inspectExtensionPackage(f.options);
  assert.equal(existsSync(f.sentinel), false);
  assert.equal(
    fileURLToPath(descriptor.entry.url),
    path.join(f.packageRoot, "dist", "extension.js"),
  );
  assert.equal(descriptor.packageName, name);
  assert.equal(descriptor.version, "1.0.0");
  assert.equal(descriptor.root, f.packageRoot);
  assert.equal(descriptor.source.origin.owner, name);
  assert.equal(descriptor.source.origin.namespace, "fixtureSDK");
  assert.equal(descriptor.source.origin.revision, descriptor.revision);
  assert.deepEqual(descriptor.source.permissions, ["network"]);
  assert.match(descriptor.manifest.revision, /^sha256:[0-9a-f]{64}$/);
  assert.match(descriptor.entry.revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    descriptor.materials.instructions.relativePath,
    "instructions/README.md",
  );
  assert.equal(
    descriptor.materials.scripts.entries[0].scriptName,
    "fixtureSDK/inspect.js",
  );
  assert.equal(
    descriptor.materials.scripts.entries[0].metadata.scriptOpenDefault,
    true,
  );
  assert.deepEqual(
    descriptor.materials.scripts.entries[0].metadata.scriptInputSchema,
    { type: "object", additionalProperties: false },
  );
  assert.equal(
    descriptor.materials.skills.entries[0].publicName,
    "fixtureSDK/endpoint-audit",
  );
  assert.equal(
    descriptor.materials.skills.entries[0].metadata.name,
    "endpoint-audit",
  );
  assert.equal(
    descriptor.materials.skills.entries[0].metadata.compatibility,
    "Requires network access.",
  );
  assert.ok(
    descriptor.materials.skills.entries[0].directory.files.some((file) =>
      file.relativePath.endsWith("resources/example.txt"),
    ),
  );
  assert.equal(
    descriptor.materials.docs.files.some((file) =>
      file.relativePath.includes(".secret"),
    ),
    false,
  );
  assert.equal(
    JSON.stringify(descriptor).includes("private package metadata"),
    false,
  );
  assert.equal(JSON.stringify(descriptor).includes(".private-metadata"), false);
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(descriptor.source.permissions));
  await verifyExtensionPackage(descriptor, f.options);
  assert.equal(existsSync(f.sentinel), false);
  await import(descriptor.entry.url);
  assert.equal(readFileSync(f.sentinel, "utf8"), "evaluated");
  await verifyExtensionPackage(descriptor, f.options);
});

test("pnpm's managed package symlink is accepted but aliases and foreign installation roots are refused", async (t) => {
  const f = await fixture(t, { pnpm: true });
  const descriptor = await inspectExtensionPackage(f.options);
  assert.equal(descriptor.root, realpathSync.native(f.packageRoot));
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  write(path.join(outside, "package.json"), f.manifest);
  const installed = path.join(f.work, "node_modules", ...name.split("/"));
  rmSync(installed, { recursive: true });
  symlinkSync(outside, installed, "junction");
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_path_escape",
  });
  assert.equal(existsSync(f.sentinel), false);
});

test("only actual approved direct dependencies can enter static extension preparation", async (t) => {
  const f = await fixture(t);
  for (const packageName of [
    "../extension",
    "@fixture/../../extension",
    "file:extension",
    "C:\\extension",
    "@fixture/extension/nexum",
  ])
    await assert.rejects(
      inspectExtensionPackage({ ...f.options, packageName }),
      { code: "invalid_extension_package" },
    );
  write(path.join(f.work, "package.json"), { dependencies: {} });
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_not_direct_dependency",
  });
  write(path.join(f.work, "package.json"), {
    devDependencies: { [name]: "1.0.0" },
  });
  f.approved.clear();
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_not_approved",
  });
  f.approved.set(name, "1.0.1");
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_package_changed",
  });
  f.approved.set(name, "1.0.0");
  f.manifest.name = "renamed-package";
  f.saveManifest();
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_package_changed",
  });
  f.manifest.name = name;
  f.manifest.version = "1.0.0-01";
  f.saveManifest();
  f.approved.set(name, f.manifest.version);
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_not_approved",
  });
  assert.equal(existsSync(f.sentinel), false);
});

test("protocol, reserved namespace, permission and types declarations fail before entry evaluation", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.manifest);
  for (const [change, code] of [
    [
      (manifest) => (manifest.nexum.apiVersion = 2),
      "invalid_extension_manifest",
    ],
    [(manifest) => (manifest.nexum.namespace = "output"), "invalid_namespace"],
    [(manifest) => (manifest.nexum.namespace = "console"), "invalid_namespace"],
    [(manifest) => (manifest.nexum.namespace = "foo.bar"), "invalid_namespace"],
    [
      (manifest) => (manifest.nexum.permissions = ["invented"]),
      "invalid_extension_permissions",
    ],
    [
      (manifest) => (manifest.nexum.permissions = ["network", "network"]),
      "invalid_extension_permissions",
    ],
    [
      (manifest) => (manifest.nexum.owner = "nexum"),
      "invalid_extension_manifest",
    ],
    [
      (manifest) =>
        (manifest.exports["./nexum"] = {
          import: "./dist/extension.js",
          types: "./dist/extension.d.ts",
        }),
      "invalid_extension_types",
    ],
    [
      (manifest) => (manifest.exports["./nexum"].types = "./dist/missing.d.ts"),
      "ENOENT",
    ],
    [
      (manifest) => (manifest.exports["./nexum"].types = "./docs/README.md"),
      "invalid_extension_types",
    ],
    [(manifest) => (manifest.nexum.docs = "./missing-docs"), "ENOENT"],
    [(manifest) => (manifest.nexum.docs = "."), "invalid_extension_source"],
    [
      (manifest) => (manifest.nexum.instructions = "../outside.md"),
      "invalid_extension_source",
    ],
  ]) {
    Object.keys(f.manifest).forEach((key) => delete f.manifest[key]);
    Object.assign(f.manifest, structuredClone(original));
    change(f.manifest);
    f.saveManifest();
    await assert.rejects(inspectExtensionPackage(f.options), { code });
    assert.equal(existsSync(f.sentinel), false);
  }
});

test("bad script headers, schema and Skill frontmatter cannot yield a partial package", async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.packageRoot, "scripts", "inspect.js");
  write(filename, script("wrong.js"));
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "script_header_mismatch",
  });
  write(filename, script("inspect.js", { type: "impossible" }));
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "invalid_input_schema",
  });
  write(filename, script());
  const skill = path.join(
    f.packageRoot,
    "skills",
    "endpoint-audit",
    "SKILL.md",
  );
  write(skill, "---\nname: wrong-name\ndescription: wrong directory\n---\n");
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "invalid_skill",
  });
  write(
    skill,
    "---\nname: endpoint-audit\ndescription: &shared aliased\ncompatibility: *shared\n---\n",
  );
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "invalid_skill",
  });
  assert.equal(existsSync(f.sentinel), false);
});

test("declared materials and Skill resources cannot borrow files from another source subtree", async (t) => {
  const f = await fixture(t);
  const skill = path.join(f.packageRoot, "skills", "endpoint-audit");
  symlinkSync(
    path.join(f.packageRoot, "docs"),
    path.join(skill, "borrowed-docs"),
    "junction",
  );
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_path_escape",
  });
  rmSync(path.join(skill, "borrowed-docs"), { recursive: true });
  const docs = path.join(f.packageRoot, "docs"),
    external = path.join(f.root, "external-docs");
  mkdirSync(external);
  write(path.join(external, "README.md"), "outside material");
  renameSync(docs, docs + "-old");
  symlinkSync(external, docs, "junction");
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_path_escape",
  });
  assert.equal(existsSync(f.sentinel), false);
});

test("canonical aliases cannot turn nested dependency files into owned docs or types", async (t) => {
  const f = await fixture(t);
  const foreign = path.join(f.packageRoot, "node_modules", "foreign");
  write(
    path.join(foreign, "docs", "README.md"),
    "# Foreign dependency documentation\n",
  );
  write(
    path.join(foreign, "types", "index.d.ts"),
    "export interface Foreign {}\n",
  );
  const docs = path.join(f.packageRoot, "docs");
  renameSync(docs, docs + "-original");
  symlinkSync(path.join(foreign, "docs"), docs, "junction");
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_path_escape",
  });
  rmSync(docs, { recursive: true });
  renameSync(docs + "-original", docs);
  symlinkSync(
    path.join(foreign, "types"),
    path.join(f.packageRoot, "type-alias"),
    "junction",
  );
  f.manifest.exports["./nexum"].types = "./type-alias/index.d.ts";
  f.saveManifest();
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_path_escape",
  });
  assert.equal(existsSync(f.sentinel), false);
});

test("a native resolved runtime entry must not be an alias for a nested dependency", async (t) => {
  const f = await fixture(t);
  const foreign = path.join(f.packageRoot, "node_modules", "foreign", "dist");
  write(
    path.join(foreign, "entry.js"),
    "throw new Error('foreign entry must not execute');\n",
  );
  symlinkSync(foreign, path.join(f.packageRoot, "entry-alias"), "junction");
  f.manifest.exports["./nexum"].node.import = "./entry-alias/entry.js";
  f.saveManifest();
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_path_escape",
  });
  assert.equal(existsSync(f.sentinel), false);
});

test("public material collisions and invalid UTF-8 are explicit rather than silently pruned", async (t) => {
  const f = await fixture(t);
  const docs = path.join(f.packageRoot, "docs");
  write(path.join(docs, "README.md"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(inspectExtensionPackage(f.options), {
    code: "extension_material_encoding",
  });
  write(path.join(docs, "README.md"), "# Valid documentation\n");
  const first = path.join(docs, "Å.md"),
    second = path.join(docs, "A\u030a.md");
  write(first, "first");
  write(second, "second");
  if (realpathSync.native(first) !== realpathSync.native(second))
    await assert.rejects(inspectExtensionPackage(f.options), {
      code: "extension_material_conflict",
    });
  else {
    rmSync(first);
    write(
      path.join(f.packageRoot, "scripts", "inspect.js"),
      script("INSPECT.js"),
    );
    await assert.rejects(inspectExtensionPackage(f.options), {
      code: "script_header_mismatch",
    });
  }
  assert.equal(existsSync(f.sentinel), false);
});

test("same-version helper and declared resource changes produce new stable revisions while nested dependencies stay outside this snapshot", async (t) => {
  const f = await fixture(t);
  const first = await inspectExtensionPackage(f.options),
    repeat = await inspectExtensionPackage(f.options);
  assert.equal(repeat.revision, first.revision);
  write(
    path.join(f.packageRoot, "private-helper.js"),
    "export const shared=2;\n",
  );
  const second = await inspectExtensionPackage(f.options);
  assert.notEqual(second.revision, first.revision);
  await assert.rejects(verifyExtensionPackage(first, f.options), {
    code: "extension_package_changed",
  });
  write(
    path.join(f.packageRoot, "docs", "picture.bin"),
    Buffer.from([9, 8, 7, 6]),
  );
  const third = await inspectExtensionPackage(f.options);
  assert.notEqual(third.revision, second.revision);
  write(path.join(f.packageRoot, "node_modules", "foreign", "package.json"), {
    name: "foreign",
    version: "1.0.0",
  });
  write(
    path.join(f.packageRoot, "node_modules", "foreign", "index.js"),
    'throw new Error("must not be evaluated or hashed");',
  );
  const excluded = await inspectExtensionPackage(f.options);
  assert.equal(excluded.revision, third.revision);
  assert.equal(excluded.fileCount, third.fileCount);
  assert.equal(excluded.totalBytes, third.totalBytes);
  assert.equal(existsSync(f.sentinel), false);
});

test("verification rejects removed or replaced source and current approval changes without evaluation", async (t) => {
  const f = await fixture(t);
  const descriptor = await inspectExtensionPackage(f.options);
  rmSync(path.join(f.packageRoot, "docs", "README.md"));
  await assert.rejects(verifyExtensionPackage(descriptor, f.options), {
    code: "extension_package_changed",
  });
  write(
    path.join(f.packageRoot, "docs", "README.md"),
    "# Replacement source\n",
  );
  const replacement = await inspectExtensionPackage(f.options);
  f.approved.clear();
  await assert.rejects(verifyExtensionPackage(replacement, f.options), {
    code: "extension_package_changed",
  });
  assert.equal(existsSync(f.sentinel), false);
});

test("file, byte and directory budgets stop bounded preparation before evaluating the extension", async (t) => {
  const f = await fixture(t);
  for (const limits of [
    { maxFiles: 1 },
    { maxBytes: 128 },
    { maxDirectories: 1 },
  ])
    await assert.rejects(inspectExtensionPackage({ ...f.options, limits }), {
      code: "extension_source_limit",
    });
  for (const limits of [
    { maxFiles: 0 },
    { maxBytes: -1 },
    { maxDirectories: Infinity },
  ])
    await assert.rejects(inspectExtensionPackage({ ...f.options, limits }), {
      code: "invalid_extension_limits",
    });
  const target = path.join(f.packageRoot, "private-binary.bin");
  write(target, "");
  truncateSync(target, 32 * 1024 * 1024);
  const inspected = await inspectExtensionPackage(f.options);
  assert.ok(inspected.totalBytes >= 32 * 1024 * 1024);
  assert.equal(
    inspected.materials.docs.files.some((file) => file.path === target),
    false,
  );
  const controller = new AbortController();
  controller.abort(new Error("preflight cancelled"));
  await assert.rejects(
    inspectExtensionPackage({ ...f.options, signal: controller.signal }),
    /preflight cancelled/,
  );
  assert.equal(existsSync(f.sentinel), false);
});
