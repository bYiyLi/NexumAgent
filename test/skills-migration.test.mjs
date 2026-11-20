import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { methodSkill, writeMethodSkill } from "../dist/work/method-skills.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { WorkService } from "../dist/work/service.js";
import { RunEngine } from "../dist/runtime/engine.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { validateContract } from "../dist/contracts/validation.js";
import { fileURLToPath } from "node:url";
import { parseSkillFrontmatter } from "../dist/work/discovery.js";

const caller = { principalId: "user", clientId: "client" };
function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-skills-migration-")),
  );
  const work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, work, cleanup: (fn) => cleanups.push(fn) };
}
const origin = {
  type: "platform",
  owner: "nexum-test",
  namespace: "state",
  version: "1",
  revision: "real-source",
};
function assertClosedSkill(entry) {
  const seen = new Set();
  const read = (filename) => {
    assert.ok(filename.startsWith(entry.path + path.sep));
    if (seen.has(filename)) return;
    seen.add(filename);
    const text = readFileSync(filename, "utf8")
      .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
      .replace(/`[^`]*`/g, "");
    if (!filename.endsWith(".md")) return;
    for (const [, href] of text.matchAll(/\]\(<?([^\s)>]+)>?\)/g)) {
      if (/^(?:https?:|#)/.test(href)) continue;
      read(
        path.resolve(
          path.dirname(filename),
          decodeURIComponent(href.split("#")[0]),
        ),
      );
    }
  };
  read(entry.skillFile);
  return seen;
}

test("preserved browser-control and script-authoring Skills retain valid selection metadata and a readable reference closure", () => {
  for (const relative of [
    "../skills/script-authoring/",
    "../packages/browser/skills/browser-control/",
  ]) {
    const root = fileURLToPath(new URL(relative, import.meta.url));
    const directory = root.replace(/[\\/]$/, "");
    const skillFile = path.join(directory, "SKILL.md");
    const metadata = parseSkillFrontmatter(
      readFileSync(skillFile),
      path.basename(directory),
    );
    assert.ok(metadata.description.length > 0);
    assert.ok(assertClosedSkill({ path: directory, skillFile }).size >= 2);
  }
});

test("generated Skill is a closed projection of actual prepared Registry metadata, including dialects and referenced schemas", async (t) => {
  const f = fixture(t),
    store = new SqliteStore(f.root, {
      agentId: "agent",
      profile: "development",
      cloudEnvironment: "test",
    });
  const resources = new ResourceManager(store),
    registry = new ExtensionRegistry(resources, {
      permissions: new Set(),
      authorize() {},
      log() {},
      progress() {},
    });
  f.cleanup(async () => {
    await registry.disable(handle);
    await resources.shutdown();
    store.close();
  });
  const schema = {
    $id: "urn:fixture:input",
    type: "object",
    properties: { requiredValue: { $ref: "urn:fixture:value" } },
    required: ["requiredValue"],
    additionalProperties: false,
  };
  const handle = await registry.prepare(
    { apiVersion: 1, origin, permissions: [] },
    () => ({
      methods: {
        read: {
          description: "读取指定值",
          permissions: [],
          inputSchema: schema,
          schemaDialect: "draft7",
          schemas: [{ $id: "urn:fixture:value", type: "integer", minimum: 7 }],
          outputSchema: { type: "integer" },
          handle: (input) => input.requiredValue,
        },
        unknownOutput: {
          description: "返回来源的原始结果",
          permissions: [],
          inputSchema: false,
          schemaDialect: "draft7",
          handle() {},
        },
      },
    }),
  );
  const generated = methodSkill({
    name: "fixture-values",
    description: "需要从测试来源读取指定值时使用。",
    origin,
    bindingPath: ["state"],
    methods: handle.methods,
  });
  const directory = path.join(
    f.work,
    "skills",
    ".generated",
    "platform",
    "state",
    generated.revision,
  );
  await writeMethodSkill(f.work, directory, generated.files);
  const entry = {
    path: directory,
    skillFile: path.join(directory, "SKILL.md"),
  };
  assert.equal(assertClosedSkill(entry).size, generated.files.size);
  for (const [index, expected] of handle.methods.entries()) {
    const text = readFileSync(
      path.join(directory, `references/method-${index + 1}.md`),
      "utf8",
    );
    const actual = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
    assert.deepEqual(actual, expected);
    if (index === 1) {
      assert.equal(actual.inputSchema, false);
      assert.equal(Object.hasOwn(actual, "outputSchema"), false);
      assert.match(text, /来源未声明 outputSchema/);
    }
  }
  assert.match(
    generated.files.get("references/errors.md"),
    /details\.errors.*path.*keyword.*expected/,
  );
});

test("every generated Skill write admits exact UTF-8 bytes, rechecks paths and releases reservations on denial or I/O failure", async (t) => {
  const f = fixture(t),
    directory = path.join(
      f.work,
      "skills",
      ".generated",
      "platform",
      "state",
      "a".repeat(64),
    );
  const files = new Map([
    ["SKILL.md", "入口 🧪"],
    ["references/method.md", "实际参数"],
  ]);
  let released = 0,
    admitted = [];
  await writeMethodSkill(f.work, directory, files, async (bytes) => {
    admitted.push(bytes);
    return {
      release() {
        released++;
      },
    };
  });
  assert.deepEqual(
    admitted,
    [...files.values()].map((text) => Buffer.byteLength(text)),
  );
  assert.equal(released, files.size);
  assert.equal(
    readFileSync(path.join(directory, "SKILL.md"), "utf8"),
    "入口 🧪",
  );
  const refusal = new Error("quota refused"),
    denied = path.join(f.work, "skills", "denied");
  await assert.rejects(
    writeMethodSkill(f.work, denied, files, async () => {
      throw refusal;
    }),
    (error) => error === refusal,
  );
  assert.equal(existsSync(denied), false);
  await assert.rejects(
    writeMethodSkill(
      f.work,
      directory,
      new Map([["SKILL.md", "different revision"]]),
      async () => ({
        release() {
          released++;
        },
      }),
    ),
    { code: "skill_revision_conflict" },
  );
  assert.equal(released, files.size + 1);
  assert.equal(
    readFileSync(path.join(directory, "SKILL.md"), "utf8"),
    "入口 🧪",
  );
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  const attacked = path.join(f.work, "skills", "attacked");
  await assert.rejects(
    writeMethodSkill(f.work, attacked, files, async () => {
      symlinkSync(outside, attacked, "junction");
      return {
        release() {
          released++;
        },
      };
    }),
    { code: "storage_path_escape" },
  );
  assert.equal(existsSync(path.join(outside, "SKILL.md")), false);
});

test("Skill-private scripts stay readable but never enter independent script discovery, indexes, Schema selection or scriptName execution", async (t) => {
  const f = fixture(t),
    store = new SqliteStore(f.root, {
      agentId: "agent",
      profile: "development",
      cloudEnvironment: "test",
    });
  const scripts = new ScriptCatalog(f.work, "agent"),
    policy = {
      builtins: () => ["fs", "path"],
      approvedPackages: () => new Map(),
    };
  const code = (name, body) =>
    `/** ${JSON.stringify({ scriptName: name, scriptDesc: "测试脚本", scriptWhenUse: "测试操作", scriptInputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, scriptOpenDefault: true })} */\n${body}`;
  const privateRoot = path.join(scripts.skills, "private-resources");
  mkdirSync(path.join(privateRoot, "scripts"), { recursive: true });
  writeFileSync(
    path.join(privateRoot, "SKILL.md"),
    "---\nname: private-resources\ndescription: 需要本 Skill 私有辅助资源时使用。\n---\n按需读取 [辅助脚本](scripts/private-only.js)。\n",
  );
  writeFileSync(
    path.join(privateRoot, "scripts/private-only.js"),
    code("private-only.js", 'return "private";'),
  );
  writeFileSync(
    path.join(privateRoot, "scripts/registered.js"),
    code("registered.js", 'return "wrong private duplicate";'),
  );
  scripts.enroll(
    code(
      "registered.js",
      'return {source:"registered",value:context.input.value};',
    ),
  );
  const service = new WorkService(store, scripts, policy, {
    home: null,
    agent: { name: "test", version: "1", protocolVersion: "2" },
    authorize() {},
    resolveProject() {
      throw new Error("no Project");
    },
  });
  const loader = await ModuleLoader.create(f.work, store.bootId, policy),
    engine = new RunEngine(store, loader, scripts, {
      authorize() {},
      loadWork: (work) => service.load(work),
      bindings: () => ({}),
      encodeResult: async (value) => ({ content: [], data: value }),
    });
  f.cleanup(async () => {
    await service.drain();
    store.close();
  });
  const opened = await service.open(caller, { agentId: "agent" });
  assert.equal(Object.hasOwn(opened.agent, "docs"), false);
  validateContract("wire.output:agent.open", opened);
  for (const agent of [
    { ...opened.agent, docs: {} },
    { ...opened.agent, paths: { ...opened.agent.paths, docs: "removed" } },
    {
      ...opened.agent,
      modules: { ...opened.agent.modules, packagesIndex: "removed" },
    },
  ])
    assert.throws(
      () => validateContract("wire.output:agent.open", { ...opened, agent }),
      { code: "invalid_arguments" },
    );
  assert.deepEqual(
    scripts.discover().entries.map((item) => item.scriptName),
    ["registered.js"],
  );
  assert.equal(opened.agent.scripts.total, 1);
  assert.deepEqual(opened.agent.scripts.items[0].scriptInputSchema.required, [
    "value",
  ]);
  assert.doesNotMatch(
    readFileSync(opened.agent.scripts.index, "utf8"),
    /private-only/,
  );
  const selected = opened.agent.skills.find(
    (entry) => entry.name === "private-resources",
  );
  assert.match(
    (
      await service.readMaterial(
        caller,
        opened.contextId,
        selected.skillId,
        "scripts/private-only.js",
      )
    ).bytes.toString(),
    /return "private"/,
  );
  const run = async (scriptName, input) => {
    const started = await engine.start(caller, {
      contextId: opened.contextId,
      scriptName,
      input,
      waitMs: 0,
    });
    return engine.observe(caller, started.run.runId, 3000);
  };
  const success = await run("registered.js", { value: 9 });
  assert.equal(success.run.status, "succeeded");
  assert.deepEqual(success.result.data, { source: "registered", value: 9 });
  const invalid = await run("registered.js", { value: "invalid" });
  assert.equal(invalid.run.status, "failed");
  assert.equal(invalid.run.error.code, "invalid_arguments");
  const privateRun = await run("private-only.js", { value: 9 });
  assert.equal(privateRun.run.status, "failed");
  assert.equal(scripts.discover().entries.length, 1);
});
