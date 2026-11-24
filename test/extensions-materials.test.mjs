import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import filesystem, { mkdtemp as builtinMkdtemp } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  statSync,
  cpSync,
  renameSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ExtensionMaterials } from "../dist/extensions/materials.js";
import { inspectExtensionPackage } from "../dist/extensions/packages.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { WorkService } from "../dist/work/service.js";
import { FixtureStore } from "./helpers/runtime-fixture.mjs";

function write(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(
    filename,
    typeof value === "object" && !Buffer.isBuffer(value)
      ? JSON.stringify(value)
      : value,
  );
}
async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-extension-materials-")),
  );
  const cleanups = [];
  t.after(() => {
    for (const cleanup of cleanups) cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const work = root,
    name = options.name ?? "@test/guidance",
    namespace = options.namespace ?? "guidance",
    version = options.version ?? "1.0.0";
  const source = path.join(work, "node_modules", ...name.split("/"));
  write(path.join(work, "package.json"), {
    type: "module",
    dependencies: { [name]: version },
  });
  write(path.join(source, "package.json"), {
    name,
    version,
    type: "module",
    exports: {
      "./nexum": { types: "./dist/nexum.d.ts", import: "./dist/nexum.js" },
    },
    nexum: {
      apiVersion: 1,
      namespace,
      permissions: [],

      instructions: "./rules/main.md",
      scripts: "./flows",
      skills: "./skills-source",
    },
  });
  write(
    path.join(source, "dist/nexum.js"),
    "export default function(){return {methods:{}};}\n",
  );
  write(
    path.join(source, "dist/nexum.d.ts"),
    "export default function():unknown;\n",
  );
  write(
    path.join(source, "skills-source/audit/references/manual/README.md"),
    "# Author manual\n[guide](guide.md#section)\n![picture](assets/picture.bin)\n[Skill](../../SKILL.md)\n```md\n[example](../private.txt)\n```\n`[inline](../private.txt)`\n",
  );
  write(
    path.join(source, "skills-source/audit/references/manual/guide.md"),
    "# Guide\n## section\nRead carefully.\n",
  );
  write(
    path.join(source, "skills-source/audit/references/manual/assets/picture.bin"),
    Buffer.from([0, 1, 2, 255]),
  );
  write(path.join(source, "skills-source/audit/references/manual/space file.md"), "# Spaces\n");
  write(
    path.join(source, "rules/main.md"),
    "# Rules\n[manual](../skills-source/audit/references/manual/README.md)\n",
  );
  write(
    path.join(source, "flows/report.js"),
    '/** {"scriptName":"report.js","scriptDesc":"Build a report","scriptWhenUse":"When a report is needed","scriptInputSchema":{"type":"object"},"scriptOpenDefault":true} */\nreturn 1;\n',
  );
  write(
    path.join(source, "skills-source/audit/SKILL.md"),
    "---\nname: audit\ndescription: Review guidance when an audit is needed.\ncompatibility: Requires this SDK.\n---\n# Audit\n[manual](references/manual/README.md)\nRead [check](references/check.txt) when auditing. For private composition only, read [helper](scripts/private-only.js) or [duplicate helper](scripts/report.js).\n",
  );
  write(
    path.join(source, "skills-source/audit/references/check.txt"),
    "real reference bytes",
  );
  for (const name of ["report.js", "private-only.js"])
    write(path.join(source, "skills-source/audit/scripts", name),
      `/** {"scriptName":"${name}","scriptDesc":"Private helper","scriptWhenUse":"Only inside this Skill","scriptInputSchema":{"type":"object"},"scriptOpenDefault":true} */\nreturn "private helper";\n`);
  write(
    path.join(source, "private.txt"),
    "private source must not enter the reading snapshot",
  );
  const policy = {
    builtins: () => [],
    approvedPackages: () => new Map([[name, version]]),
  };
  const loader = await ModuleLoader.create(work, "materials-test", policy);
  const packageOptions = {
    work,
    packageName: name,
    policy,
    permissions: new Set(),
    resolveImport: loader.resolveImport.bind(loader),
  };
  const inspect = () => inspectExtensionPackage(packageOptions);
  const descriptor = await inspect();
  const handle = (item = descriptor, id = "handle-one") => ({
    id,
    origin: item.source.origin,
    methods: [
      {
        name: "inspect",
        path: ["inspect"],
        description: "Inspect a resource",
        permissions: [],
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
        outputSchema: { type: "string" },
      },
    ],
  });
  return {
    root,
    work,
    source,
    descriptor,
    inspect,
    handle,
    policy,
    cleanup: (fn) => cleanups.push(fn),
  };
}

test("preparation keeps authored trees, fixed source hashes and complete references separate from synchronous discovery", async (t) => {
  const f = await fixture(t);
  const catalog = new ExtensionMaterials(f.work);
  assert.equal(existsSync(path.join(f.work, "skills")), false);
  assert.deepEqual(catalog.published(), {
    instructions: [],
    skills: [],
  });
  const prepared = await catalog.prepare(f.descriptor, f.handle());
  assert.deepEqual(catalog.published(), {
    instructions: [],
    skills: [],
  });
  assert.deepEqual(catalog.scriptSources(), []);
  assert.equal(
    readFileSync(path.join(prepared.directory, "skills/audit/references/manual/guide.md"), "utf8"),
    readFileSync(path.join(f.source, "skills-source/audit/references/manual/guide.md"), "utf8"),
  );
  assert.deepEqual(
    readFileSync(path.join(prepared.directory, "skills/audit/references/manual/assets/picture.bin")),
    Buffer.from([0, 1, 2, 255]),
  );
  const manual = readFileSync(
    path.join(prepared.directory, "skills/audit/references/manual/README.md"),
    "utf8",
  );
  assert.match(manual, /\[Skill\]\(\.\.\/\.\.\/SKILL.md\)/);
  assert.match(manual, /```md\n\[example\]\(\.\.\/private.txt\)\n```/);
  assert.match(manual, /`\[inline\]\(\.\.\/private.txt\)`/);
  assert.equal(prepared.diagnostics.length, 0);
  assert.equal(existsSync(path.join(prepared.directory, "private.txt")), false);
  assert.match(
    prepared.materials.instructions[0].content,
    /skills\/audit\/references\/manual\/README.md/,
  );
  assert.equal(prepared.materials.instructions[0].scope.type, "agent");
  const skill = prepared.materials.skills[0];
  assert.equal(skill.skillId, "guidance/audit");
  assert.equal(skill.name, "audit");
  assert.equal(skill.content, undefined);
  assert.match(
    readFileSync(skill.skillFile, "utf8"),
    /\[manual\]\(references\/manual\/README\.md\)/,
  );
  assert.equal(
    existsSync(path.resolve(skill.path, "references/manual/README.md")),
    true,
  );
  assert.equal(
    readFileSync(path.join(skill.path, "references/check.txt"), "utf8"),
    "real reference bytes",
  );
  const manifest = JSON.parse(
    readFileSync(path.join(prepared.directory, "manifest.json")),
  );
  assert.deepEqual(manifest.origin, f.descriptor.source.origin);
  assert.equal(
    manifest.files.find((file) => file.path === "skills/audit/references/manual/README.md").source
      .revision,
    f.descriptor.materials.skills.entries[0].directory.files.find(
      (file) => file.relativePath === "skills-source/audit/references/manual/README.md",
    ).revision,
  );
  assert.match(
    readFileSync(path.join(prepared.materials.skills[1].path, "references/method-1.md"), "utf8"),
    /inputSchema.*properties.*name/,
  );
  catalog.publish(prepared);
  assert.equal(catalog.published().skills[0].skillFile, prepared.materials.skills[0].skillFile);
  assert.equal(
    catalog.scriptSources()[0].directory,
    path.join(f.source, "flows"),
  );
  const scripts = new ScriptCatalog(f.work, "a", () => catalog.scriptSources());
  assert.equal(
    scripts.resolve("guidance/report.js").code.includes("return 1"),
    true,
  );
  assert.deepEqual(
    scripts.discover().entries
      .filter((item) => item.origin.type === "extension")
      .map((item) => item.scriptName),
    ["guidance/report.js"],
  );
  assert.throws(() => scripts.resolve("guidance/private-only.js"));
  assert.match(readFileSync(path.join(skill.path, "scripts/private-only.js"), "utf8"), /private helper/);
  catalog.withdraw("not-the-handle");
  assert.equal(catalog.published().skills.length, 2);
  catalog.withdraw(prepared.handleId);
  assert.deepEqual(catalog.published(), {
    instructions: [],
    skills: [],
  });
  assert.deepEqual(catalog.scriptSources(), []);
  assert.equal(existsSync(skill.skillFile), true);
});

test("identical snapshots are reused without rewriting and same-version changes retain old coordinates", async (t) => {
  const f = await fixture(t),
    catalog = new ExtensionMaterials(f.work);
  const first = await catalog.prepare(f.descriptor, f.handle());
  const timestamp = statSync(first.materials.skills[0].skillFile).mtimeMs;
  const repeat = await catalog.prepare(f.descriptor, f.handle());
  assert.equal(repeat.directory, first.directory);
  assert.equal(statSync(first.materials.skills[0].skillFile).mtimeMs, timestamp);
  write(path.join(f.source, "skills-source/audit/references/manual/guide.md"), "# New guide\n");
  const updated = await f.inspect(),
    second = await catalog.prepare(updated, f.handle(updated, "handle-two"));
  assert.notEqual(second.directory, first.directory);
  assert.match(
    readFileSync(path.join(first.directory, "skills/audit/references/manual/guide.md"), "utf8"),
    /Read carefully/,
  );
  assert.match(
    readFileSync(path.join(second.directory, "skills/audit/references/manual/guide.md"), "utf8"),
    /New guide/,
  );
  catalog.publish(first);
  const before = catalog.published();
  assert.throws(() => catalog.publish(second), { code: "namespace_conflict" });
  assert.equal(catalog.published(), before);
  catalog.withdraw(first.handleId);
  catalog.publish(second);
  assert.equal(catalog.published().skills[0].skillFile, second.materials.skills[0].skillFile);
});

test("missing Skill references fail publication while the prior complete Skill and independent scripts remain readable", async (t) => {
  const f = await fixture(t), materials = new ExtensionMaterials(f.work);
  const original = await materials.prepare(f.descriptor, f.handle());
  materials.publish(original);
  const published = materials.published();
  write(path.join(f.source, "skills-source/audit/SKILL.md"),
    "---\nname: audit\ndescription: Review guidance when an audit is needed.\n---\nRead [required contract](references/missing.md) before calling the SDK.\n");
  const descriptor = await f.inspect();
  await assert.rejects(materials.prepare(descriptor, f.handle(descriptor, "changed")), {
    code: "extension_material_link_unavailable",
  });
  assert.equal(materials.published(), published);
  assert.match(readFileSync(published.skills[0].skillFile, "utf8"), /references\/manual\/README.md/);
  const scripts = new ScriptCatalog(f.work, "a", () => materials.scriptSources());
  assert.equal(scripts.resolve("guidance/report.js").name, "guidance/report.js");
});

test("source changes, symlink escapes and retained snapshot corruption fail without changing published discovery", async (t) => {
  const f = await fixture(t),
    catalog = new ExtensionMaterials(f.work);
  const prepared = await catalog.prepare(f.descriptor, f.handle());
  catalog.publish(prepared);
  const before = catalog.published();
  write(path.join(f.source, "skills-source/audit/references/manual/guide.md"), "changed");
  await assert.rejects(catalog.prepare(f.descriptor, f.handle()), {
    code: "extension_package_changed",
  });
  assert.equal(catalog.published(), before);
  const changed = await f.inspect();
  const filename = path.join(f.source, "skills-source/audit/references/manual/guide.md");
  rmSync(filename);
  symlinkSync(path.join(f.root, "outside.md"), filename);
  write(path.join(f.root, "outside.md"), "outside");
  await assert.rejects(catalog.prepare(changed, f.handle(changed)), {
    code: "extension_package_changed",
  });
  rmSync(filename);
  write(filename, "changed");
  const current = await f.inspect(),
    another = await catalog.prepare(current, f.handle(current, "two"));
  write(another.materials.skills[0].skillFile, "tampered retained revision");
  await assert.rejects(catalog.prepare(current, f.handle(current, "two")), {
    code: "extension_material_conflict",
  });
  assert.equal(catalog.published(), before);
  const versionRoot = path.dirname(prepared.directory);
  assert.equal(
    readdirSync(versionRoot).some((name) => name.startsWith(".prepare-")),
    false,
  );
});

test("reading parents reject symlinks and source/handle/profile identities cannot be mixed", async (t) => {
  const f = await fixture(t),
    catalog = new ExtensionMaterials(f.work);
  await assert.rejects(
    catalog.prepare(f.descriptor, {
      ...f.handle(),
      origin: { ...f.descriptor.source.origin, owner: "other" },
    }),
    { code: "extension_material_source_mismatch" },
  );
  const otherWork = path.join(f.root, "other-work");
  mkdirSync(otherWork);
  await assert.rejects(
    new ExtensionMaterials(otherWork).prepare(f.descriptor, f.handle()),
    { code: "extension_material_source_mismatch" },
  );
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  mkdirSync(path.join(f.work, "cache"), { recursive: true });
  symlinkSync(outside, path.join(f.work, "cache", "materials"), "junction");
  await assert.rejects(catalog.prepare(f.descriptor, f.handle()), {
    code: "storage_path_escape",
  });
  assert.deepEqual(readdirSync(outside), []);
  assert.throws(() => catalog.publish({ ...f.handle(), materials: {} }), {
    code: "extension_material_source_mismatch",
  });
});

test("aggregate generated files, entry instructions and cancellation remain bounded without partial discovery", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new ExtensionMaterials(f.work, { maxFiles: 2 }).prepare(
      f.descriptor,
      f.handle(),
    ),
    { code: "extension_material_too_large" },
  );
  await assert.rejects(
    new ExtensionMaterials(f.work, { maxBytes: 100 }).prepare(
      f.descriptor,
      f.handle(),
    ),
    { code: "extension_material_too_large" },
  );
  const catalog = new ExtensionMaterials(f.work),
    controller = new AbortController();
  controller.abort(new Error("stop preparation"));
  await assert.rejects(
    catalog.prepare(f.descriptor, f.handle(), controller.signal),
    /stop preparation/,
  );
  assert.deepEqual(catalog.published(), {
    instructions: [],
    skills: [],
  });
  assert.throws(() => new ExtensionMaterials(f.work, { maxBytes: Infinity }), {
    code: "invalid_extension_limits",
  });
});

test("safe version encoding and real Core platform descriptors use the same material protocol", async (t) => {
  const f = await fixture(t, { version: "1.0.0+build." + "a".repeat(128) });
  const platformRoot = path.join(f.root, "installed-agent");
  // Core may bind an already verified static descriptor to its own installed source, never the external package loader.
  const platform = structuredClone(f.descriptor);
  cpSync(f.source, platformRoot, { recursive: true });
  const relocate = (value) => {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && item.startsWith(f.source))
        value[key] = platformRoot + item.slice(f.source.length);
      else if (item && typeof item === "object") relocate(item);
    }
  };
  relocate(platform);
  platform.source.origin = {
    ...platform.source.origin,
    type: "platform",
    owner: "nexum-agent",
    namespace: "sh",
  };
  platform.packageName = "nexum-agent";
  const catalog = new ExtensionMaterials(f.work),
    prepared = await catalog.prepare(platform, f.handle(platform));
  assert.match(
    path.relative(f.work, prepared.directory),
    /extensions[/\\]sh[/\\]h-/,
  );
  assert.equal(prepared.scripts.type, "platform");
  catalog.publish(prepared);
  assert.equal(catalog.published().instructions[0].origin.type, "platform");
  assert.equal(catalog.published().skills[0].skillId, "sh/audit");
  assert.equal(prepared.scripts.directory, path.join(platformRoot, "flows"));
});

test("valid long extension namespaces still generate standard single-hyphen Skill names at the truncation boundary", async (t) => {
  const f = await fixture(t, { namespace: "A".repeat(39) + "_B" });
  const prepared = await new ExtensionMaterials(f.work).prepare(f.descriptor, f.handle());
  const generated = prepared.materials.skills.find((skill) => skill.name !== "audit");
  assert.ok(generated);
  assert.doesNotMatch(generated.name, /--/);
  assert.match(generated.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(generated.name.length <= 64);
});

test("rewritten mandatory instructions cannot expand beyond 64 KiB", async (t) => {
  const f = await fixture(t);
  renameSync(path.join(f.source, "skills-source"), path.join(f.source, "s"));
  const filename = path.join(f.source, "package.json"),
    manifest = JSON.parse(readFileSync(filename));
  manifest.nexum.skills = "./s";
  write(filename, manifest);
  const line = "[x](../s/audit/SKILL.md)\n";
  const body = line.repeat(Math.floor(65535 / Buffer.byteLength(line)));
  assert.ok(Buffer.byteLength(body) < 65536);
  write(path.join(f.source, "rules/main.md"), body);
  const descriptor = await f.inspect(),
    catalog = new ExtensionMaterials(f.work);
  await assert.rejects(catalog.prepare(descriptor, f.handle(descriptor)), {
    code: "extension_material_too_large",
  });
  assert.equal(catalog.published().instructions.length, 0);
});

test("local file links map to fixed declared copies and Windows device namespaces get safe directory names", async (t) => {
  const f = await fixture(t, { namespace: "aux" });
  const file = path.join(f.source, "skills-source/audit/references/manual/guide.md");
  write(
    path.join(f.source, "skills-source/audit/references/manual/README.md"),
    `[fixed](${pathToFileURL(file).href})\n`,
  );
  const descriptor = await f.inspect(),
    prepared = await new ExtensionMaterials(f.work).prepare(
      descriptor,
      f.handle(descriptor),
    );
  assert.match(
    path.relative(f.work, prepared.directory),
    /extensions[/\\]x-617578[/\\]/,
  );
  assert.match(
    readFileSync(path.join(prepared.directory, "skills/audit/references/manual/README.md"), "utf8"),
    /\[fixed\]\(<guide.md>\)/,
  );
  assert.equal(prepared.diagnostics.length, 0);
});

test("an injected stage symlink is rejected before any nested directory is created outside", async (t) => {
  const f = await fixture(t);
  write(
    path.join(f.source, "skills-source/audit/references/manual/assets/nested/extra.bin"),
    Buffer.from([7]),
  );
  const descriptor = await f.inspect(),
    catalog = new ExtensionMaterials(f.work);
  const parent = path.join(f.work, "cache/materials/extensions/guidance/1.0.0"),
    outside = path.join(f.root, "outside");
  mkdirSync(parent, { recursive: true });
  mkdirSync(outside);
  const originalMkdtemp = filesystem.mkdtemp;
  let injected = false;
  // Use the real OS directory, then finish the attack before prepare resumes.
  // fs.watch delivery cannot provide this ordering under concurrent CI load.
  const attackedMkdtemp = async (prefix, ...options) => {
    const temporary = await originalMkdtemp(prefix, ...options);
    if (prefix === path.join(parent, ".prepare-")) {
      const manual = path.join(temporary, "skills", "audit", "references", "manual"),
        target = path.join(manual, "assets");
      mkdirSync(manual, { recursive: true });
      symlinkSync(outside, target, "junction");
      assert.equal(lstatSync(target).isSymbolicLink(), true);
      assert.equal(realpathSync.native(target), outside);
      injected = true;
    }
    return temporary;
  };
  let failure;
  try {
    filesystem.mkdtemp = attackedMkdtemp;
    syncBuiltinESMExports();
    assert.equal(builtinMkdtemp, attackedMkdtemp);
    await catalog.prepare(descriptor, f.handle(descriptor)).catch((error) => {
      failure = error;
    });
  } finally {
    filesystem.mkdtemp = originalMkdtemp;
    syncBuiltinESMExports();
  }
  assert.equal(filesystem.mkdtemp, originalMkdtemp);
  assert.equal(builtinMkdtemp, originalMkdtemp);
  assert.equal(injected, true);
  assert.equal(failure?.code, "extension_path_escape");
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(catalog.published().skills.length, 0);
});

test("unmatched Markdown brackets have bounded linear preparation work", async (t) => {
  const f = await fixture(t);
  write(path.join(f.source, "skills-source/audit/references/manual/README.md"), "[".repeat(1024 * 1024));
  const descriptor = await f.inspect();
  const runner = `import {ExtensionMaterials} from ${JSON.stringify(new URL("../dist/extensions/materials.js", import.meta.url).href)};const item=${JSON.stringify({ work: f.work, descriptor, handle: f.handle(descriptor) })};const prepared=await new ExtensionMaterials(item.work).prepare(item.descriptor,item.handle);if(prepared.diagnostics.length!==0)throw new Error("unexpected diagnostics");`;
  await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", runner],
    { timeout: 8000, windowsHide: true },
  );
});

test("published guidance integrates with WorkService and old work retains fixed Skill resources after withdrawal", async (t) => {
  const f = await fixture(t),
    catalog = new ExtensionMaterials(f.work),
    prepared = await catalog.prepare(f.descriptor, f.handle());
  const store = new FixtureStore(f.root, {
    agentId: "a",
    profile: "development",
    cloudEnvironment: "test",
  });
  f.cleanup(() => store.close());
  const scripts = new ScriptCatalog(f.work, "a", () => catalog.scriptSources());
  const service = new WorkService(store, scripts, f.policy, {
    home: null,
    agent: { name: "test", version: "1", protocolVersion: "1" },
    authorize() {},
    resolveProject() {
      throw new Error("no project expected");
    },
    materials: () => catalog.published(),
  });
  catalog.publish(prepared);
  const caller = { principalId: "user", clientId: "client" };
  const opened = await service.open(caller, { agentId: "a" });
  assert.equal(opened.project, null);
  assert.equal(
    opened.agent.instructions.some(
      (item) => item.instructionId === "guidance/instructions",
    ),
    true,
  );
  assert.equal(
    opened.agent.skills.some((item) => item.skillId === "guidance/audit"),
    true,
  );
  catalog.withdraw(prepared.handleId);
  const read = await service.readMaterial(
    caller,
    opened.contextId,
    "guidance/audit",
    "references/check.txt",
  );
  assert.equal(read.bytes.toString(), "real reference bytes");
  const fresh = await service.open(caller, { agentId: "a" });
  assert.equal(
    fresh.agent.skills.some((item) => item.skillId === "guidance/audit"),
    false,
  );
});
