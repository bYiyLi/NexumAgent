import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { DocumentCatalog } from "../dist/work/catalog.js";
import { WorkService } from "../dist/work/service.js";
import { selectorKey } from "../dist/work/discovery.js";
import { canonicalJson } from "../dist/contracts/json.js";

const caller = { principalId: "user", clientId: "client" };
const skill = (name, description = "用途") =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBODY FOR ${name}\n`;
function fixture(t) {
  const temporary = mkdtempSync(path.join(tmpdir(), "nexum-work-"));
  const root = realpathSync.native(temporary),
    work = path.join(root, "work"),
    home = path.join(root, "home"),
    project = path.join(root, "project"),
    secondProject = path.join(root, "other-project");
  for (const directory of [work, home, project, secondProject])
    mkdirSync(directory);
  function write(base, relative, text) {
    const filename = path.join(base, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, text);
    return realpathSync.native(filename);
  }
  write(
    work,
    "package.json",
    JSON.stringify({ type: "module", dependencies: { tiny: "1.0.0" } }),
  );
  write(
    work,
    "node_modules/tiny/package.json",
    JSON.stringify({
      name: "tiny",
      version: "1.0.0",
      description: "tiny installed library",
      types: "index.d.ts",
      homepage: "https://example.com/tiny?token=should-not-persist",
    }),
  );
  write(
    work,
    "node_modules/tiny/index.d.ts",
    "export declare function tiny(): number;\n",
  );
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const scripts = new ScriptCatalog(work, "agent");
  const policy = {
    builtins: () => ["fs", "path", "timers"],
    approvedPackages: () => new Map([["tiny", "1.0.0"]]),
  };
  const catalog = new DocumentCatalog(work, scripts, policy);
  let disabled = [],
    published = { instructions: [], skills: [], docs: [] },
    allowed = true,
    beforeCommit = () => {},
    authorizationHook = () => {},
    resolveHook = async () => {};
  let projectName = "Original";
  const service = new WorkService(store, scripts, catalog, {
    home,
    agent: { name: "test Agent", version: "0.0.1", protocolVersion: "2" },
    authorize(who, target) {
      if (!allowed || who.principalId !== caller.principalId)
        throw Object.assign(new Error("forbidden"), { code: "forbidden" });
      if (target.action === "commit") beforeCommit();
      return authorizationHook(who, target);
    },
    resolveProject: async (_who, target, signal) => {
      await resolveHook(signal);
      if (target.projectId === "project" || target.path === project)
        return {
          project: {
            projectId: "project",
            name: projectName,
            root: project,
            description: "last known summary",
          },
          disabledItems: disabled,
        };
      if (target.projectId === "other" || target.path === secondProject)
        return {
          project: { projectId: "other", name: "Other", root: secondProject },
          disabledItems: [],
        };
      throw Object.assign(new Error("unknown project"), {
        code: "project_not_found",
      });
    },
    materials: () => published,
  });
  const lifetime = new AbortController();
  const open = (input = {}, signal) =>
    service.open(
      caller,
      { agentId: "agent", ...input },
      signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
    );
  t.after(async () => {
    lifetime.abort();
    await service.drain();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    home,
    project,
    aliasProject: path.join(temporary, "project"),
    secondProject,
    store,
    scripts,
    policy,
    catalog,
    service,
    write,
    open,
    setDisabled: (value) => (disabled = value),
    setPublished: (value) => (published = value),
    setBeforeCommit: (fn) => (beforeCommit = fn),
    setAuthorization: (fn) => (authorizationHook = fn),
    setResolver: (fn) => (resolveHook = fn),
    setName: (name) => (projectName = name),
    revoke: () => (allowed = false),
  };
}

test("native sync and async identities agree for aliased paths before Project resolution and visibility", async (t) => {
  const f = fixture(t);
  const file = f.write(f.project, "AGENTS.md", "x".repeat(65537));
  f.setDisabled([
    { kind: "instruction", key: selectorKey("instruction", file) },
  ]);
  const opened = await f.open({ path: f.aliasProject });
  assert.equal(opened.project.root, await realpath(f.aliasProject));
  assert.equal(opened.project.root, f.project);
  assert.equal(f.store.root, await realpath(f.root));
  assert.equal(opened.agent.paths.work, await realpath(f.work));
  assert.equal(opened.project.instructions.length, 0);
});

test("work authorization fails closed for async/boolean callbacks and fixes caller identity before queued work", async (t) => {
  const f = fixture(t);
  for (const invalid of [
    () => false,
    async () => {},
    async () => {
      throw new Error("denied");
    },
  ]) {
    f.setAuthorization(invalid);
    await assert.rejects(
      () => f.open(),
      (error) => error.code === "authorization_configuration",
    );
  }
  f.setAuthorization(() => {});
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  f.setResolver(async () => {
    enter();
    await barrier;
  });
  const mutable = { ...caller };
  const pending = f.service.open(mutable, {
    agentId: "agent",
    projectId: "project",
  });
  await entered;
  mutable.principalId = "replacement";
  mutable.clientId = "replacement";
  release();
  const result = await pending;
  assert.equal(f.store.getWork(result.contextId).callerKey, callerKey(caller));
});

test("published guidance and module policy use fixed values across asynchronous catalog generation", async (t) => {
  const f = fixture(t);
  const published = {
    instructions: [
      {
        instructionId: "nexum/entry",
        kind: "platform",
        path: null,
        content: "original instruction",
        truncated: false,
        scope: { type: "agent", root: f.work },
        origin: {
          type: "platform",
          owner: "nexum",
          namespace: "nexum",
          version: "1",
          revision: "one",
        },
      },
    ],
    skills: [],
    docs: [],
  };
  f.setPublished(published);
  const approved = new Map([["tiny", "1.0.0"]]);
  f.policy.approvedPackages = () => approved;
  const refresh = f.catalog.refresh.bind(f.catalog);
  f.catalog.refresh = (...args) => {
    const pending = refresh(...args);
    published.instructions[0].content = "replacement instruction";
    approved.set("tiny", "2.0.0");
    f.policy.builtins = () => ["net"];
    return pending;
  };
  const result = await f.open();
  assert.equal(result.agent.instructions[0].content, "original instruction");
  assert.deepEqual(result.agent.modules.builtinFamilies, [
    "fs",
    "path",
    "timers",
  ]);
  assert.match(
    readFileSync(result.agent.modules.packagesIndex, "utf8"),
    /批准版本：1\.0\.0/,
  );
});

test("a replaced local Skill requires refresh before its body or resources can be read", async (t) => {
  const f = fixture(t);
  const file = f.write(
    f.home,
    ".agents/skills/review/SKILL.md",
    skill("review"),
  );
  f.write(path.dirname(file), "references/detail.md", "detail");
  const opened = await f.open();
  const id = opened.agent.skills[0].skillId;
  f.write(path.dirname(file), "SKILL.md", skill("review", "updated metadata"));
  for (const relative of [undefined, "references/detail.md"])
    await assert.rejects(
      () => f.service.readMaterial(caller, opened.contextId, id, relative),
      (error) => error.code === "material_changed",
    );
  const refreshed = await f.open({ contextId: opened.contextId });
  assert.equal(refreshed.revision, 2);
  assert.match(
    (
      await f.service.readMaterial(caller, opened.contextId, id)
    ).bytes.toString(),
    /updated metadata/,
  );
});

test("Agent-only open returns grouped real environment, instructions, metadata and a readable versioned manual", async (t) => {
  const { open, home, work, write, service } = fixture(t);
  write(home, ".codex/AGENTS.md", "personal rule");
  write(work, "AGENTS.md", "agent rule");
  write(home, ".agents/skills/review/SKILL.md", skill("review"));
  const first = await open();
  assert.equal(first.revision, 1);
  assert.equal(first.project, null);
  assert.equal(first.pwd, work);
  assert.equal(first.paths, undefined);
  assert.equal(first.instructions, undefined);
  assert.equal(first.context, undefined);
  assert.equal(first.examples, undefined);
  assert.equal(first.agent.agentId, "agent");
  assert.equal(first.agent.runtime.nodeVersion, process.version);
  assert.equal(first.agent.runtime.arch, process.arch);
  assert.equal(first.agent.system.platform, process.platform);
  assert.equal(first.agent.paths.work, work);
  assert.deepEqual(
    first.agent.instructions.map((item) => item.content),
    ["personal rule", "agent rule"],
  );
  assert.equal(first.agent.skills[0].name, "review");
  assert.equal(first.agent.skills[0].content, undefined);
  assert.doesNotMatch(JSON.stringify(first), /BODY FOR review/);
  assert.match(
    readFileSync(first.agent.docs.entry, "utf8"),
    /Nexum Agent 使用手册/,
  );
  const packages = readFileSync(first.agent.modules.packagesIndex, "utf8");
  assert.match(packages, /tiny installed library/);
  assert.match(packages, /available/);
  assert.doesNotMatch(packages, /should-not-persist/);
  assert.equal(service.get(caller, first.contextId).revision, 1);
});

test("Project open separates its instructions/Skills and applies local visibility before both model and stored effective indexes", async (t) => {
  const { open, service, home, project, write, setDisabled } = fixture(t);
  write(
    home,
    ".agents/skills/review/SKILL.md",
    skill("review", "personal loser"),
  );
  const rootInstruction = write(project, "AGENTS.md", "PROJECT HIDDEN RULE");
  const winner = write(
    project,
    ".agents/skills/review/SKILL.md",
    skill("review", "PROJECT HIDDEN SKILL"),
  );
  write(project, "src/AGENTS.md", "nested body");
  write(project, "README.md", "# Project\n\n介绍\t说明");
  setDisabled([
    { kind: "instruction", key: selectorKey("instruction", rootInstruction) },
    { kind: "skill", key: selectorKey("skill", winner) },
  ]);
  const opened = await open({ projectId: "project" });
  assert.equal(opened.pwd, project);
  assert.equal(opened.project.projectId, "project");
  assert.equal(opened.project.instructions.length, 0);
  assert.equal(opened.project.skills.length, 0);
  assert.equal(opened.agent.skills.length, 0);
  assert.equal(opened.project.nestedInstructions[0].content, undefined);
  assert.match(opened.project.description, /# Project\\n/);
  for (const text of [
    JSON.stringify(opened),
    readFileSync(opened.agent.materialsIndex, "utf8"),
    readFileSync(opened.project.materialsIndex, "utf8"),
  ])
    assert.doesNotMatch(text, /PROJECT HIDDEN|personal loser/);
  await assert.rejects(
    () =>
      service.readMaterial(
        caller,
        opened.contextId,
        "local:" + selectorKey("skill", winner),
      ),
    { code: "material_forbidden" },
  );
});

test("refresh commits a new revision without changing captured snapshots; failure preserves the previous public view", async (t) => {
  const { open, service, store, work, write } = fixture(t);
  const file = write(work, "AGENTS.md", "first rule");
  const original = await open();
  const captured = store.getWork(original.contextId);
  writeFileSync(file, "second rule");
  const refreshed = await open({ contextId: original.contextId });
  assert.equal(refreshed.revision, 2);
  assert.equal(refreshed.agent.instructions[0].content, "second rule");
  const oldBundle = JSON.parse(
    readFileSync(path.join(store.root, captured.snapshotRef), "utf8"),
  );
  assert.equal(oldBundle.view.agent.instructions[0].content, "first rule");
  writeFileSync(file, "x".repeat(65537));
  await assert.rejects(() => open({ contextId: original.contextId }), {
    code: "material_too_large",
  });
  assert.equal(service.get(caller, original.contextId).revision, 2);
  assert.equal(
    service.get(caller, original.contextId).agent.instructions[0].content,
    "second rule",
  );
});

test("same-work refreshes serialize, keep independent work identities and reject all forms of rebinding", async (t) => {
  const { open, store, project } = fixture(t);
  const a = await open({ projectId: "project" }),
    b = await open({ projectId: "project" });
  assert.notEqual(a.contextId, b.contextId);
  const [x, y] = await Promise.all([
    open({ contextId: a.contextId }),
    open({ contextId: a.contextId }),
  ]);
  assert.deepEqual([x.revision, y.revision], [2, 3]);
  assert.equal(store.getWork(b.contextId).revision, 1);
  await assert.rejects(
    () => open({ contextId: a.contextId, projectId: "other" }),
    { code: "context_binding_mismatch" },
  );
  const bare = await open();
  await assert.rejects(
    () => open({ contextId: bare.contextId, path: project }),
    { code: "context_binding_mismatch" },
  );
});

test("Project close cannot race a new open/refresh into reviving old work; new catalog identities remain independent", async (t) => {
  const { open, service, store, setBeforeCommit } = fixture(t);
  const existing = await open({ projectId: "project" });
  setBeforeCommit(() => store.closeWork(existing.contextId, callerKey(caller)));
  await assert.rejects(() => open({ projectId: "project" }), {
    code: "project_closed",
  });
  setBeforeCommit(() => {});
  await assert.rejects(() => open({ contextId: existing.contextId }), {
    code: "context_closed",
  });
  const receipt = service.close(caller, existing.contextId);
  assert.equal(receipt.agentConfirmed, true);
  const other = await open({ projectId: "other" });
  assert.equal(other.project.projectId, "other");
});

test("cancellation while resolving or scanning cannot publish a new work and never replaces a previous revision", async (t) => {
  const { open, service, store, setResolver } = fixture(t);
  const original = await open({ projectId: "project" });
  const entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  setResolver(async () => {
    entered.resolve();
    await gate.promise;
  });
  const controller = new AbortController();
  const request = open({ contextId: original.contextId }, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(() => request, { name: "AbortError" });
  gate.resolve();
  await service.drain();
  assert.equal(store.getWork(original.contextId).revision, 1);
  assert.equal(service.get(caller, original.contextId).revision, 1);
});

test("mandatory instructions remain whole; large optional metadata uses complete local indexes and an exact combined model budget", async (t) => {
  const { open, work, home, write } = fixture(t);
  write(work, "AGENTS.md", "MANDATORY RULE");
  for (let i = 0; i < 80; i++) {
    const name = `skill-${i}`;
    write(
      home,
      `.agents/skills/${name}/SKILL.md`,
      skill(name, "说明".repeat(500)),
    );
  }
  const opened = await open();
  const bytes = Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(opened) }],
      structuredContent: opened,
    }),
  );
  assert.ok(bytes <= 128 * 1024, bytes);
  assert.equal(opened.agent.instructions[0].content, "MANDATORY RULE");
  assert.equal(opened.agent.skillsComplete, false);
  assert.ok(opened.agent.skills.length < 80);
  assert.equal(
    JSON.parse(readFileSync(opened.agent.materialsIndex, "utf8")).skills.length,
    80,
  );
  assert.ok(
    opened.warnings.some((item) => item.code === "work_display_budget"),
  );
});

test("an oversized mandatory instruction set fails rather than truncating and creating a normal context", async (t) => {
  const { open, work, project, write } = fixture(t);
  write(work, "AGENTS.md", "a".repeat(60000));
  write(project, "AGENTS.md", "b".repeat(60000));
  await assert.rejects(() => open({ projectId: "project" }), {
    code: "work_materials_too_large",
  });
});

test("platform/SDK guidance and namespaced Skills keep Agent scope, versioned paths and owner provenance", async (t) => {
  const { open, work, write, setPublished, service } = fixture(t);
  const directory = path.join(
    work,
    "docs/extensions/browser/1.0.0/rev/skills/audit",
  );
  const file = write(directory, "SKILL.md", skill("audit"));
  const manual = write(
    work,
    "docs/extensions/browser/1.0.0/rev/manual/README.md",
    "browser manual",
  );
  const owner = {
    type: "extension",
    owner: "@example/browser",
    namespace: "browser",
    version: "1.0.0",
    revision: "rev",
  };
  setPublished({
    instructions: [
      {
        instructionId: "browser/entry",
        kind: "sdk",
        path: null,
        content: "SDK ENTRY RULE",
        scope: { type: "agent", root: work },
        origin: owner,
        truncated: false,
      },
    ],
    skills: [
      {
        skillId: "browser/audit",
        name: "audit",
        description: "audit pages",
        path: directory,
        skillFile: file,
        scope: { type: "agent", root: work },
        origin: owner,
      },
    ],
    docs: [
      {
        name: "browser",
        description: "浏览器使用手册",
        path: manual,
        owner: owner.owner,
        version: owner.version,
      },
    ],
  });
  const opened = await open({ projectId: "project" });
  assert.equal(opened.agent.instructions[0].content, "SDK ENTRY RULE");
  assert.equal(opened.project.instructions.length, 0);
  assert.equal(opened.agent.skills[0].skillId, "browser/audit");
  assert.equal(opened.agent.skills[0].origin.version, "1.0.0");
  assert.match(readFileSync(opened.agent.docs.entry, "utf8"), /浏览器使用手册/);
  assert.match(
    (
      await service.readMaterial(caller, opened.contextId, "browser/audit")
    ).bytes.toString(),
    /BODY FOR audit/,
  );
});

test("managed material reads grant only enabled winners, exact instructions and canonical Skill subtrees", async (t) => {
  const { open, service, home, write, root } = fixture(t);
  write(home, ".agents/AGENTS.md", "personal instruction");
  const file = write(home, ".agents/skills/review/SKILL.md", skill("review"));
  write(path.dirname(file), "references/detail.md", "detail");
  write(root, "private.txt", "outside");
  const opened = await open(),
    entry = opened.agent.skills[0],
    instruction = opened.agent.instructions[0];
  assert.equal(
    (
      await service.readMaterial(
        caller,
        opened.contextId,
        entry.skillId,
        "references/detail.md",
      )
    ).bytes.toString(),
    "detail",
  );
  await assert.rejects(
    () =>
      service.readMaterial(
        caller,
        opened.contextId,
        entry.skillId,
        "../../../../private.txt",
      ),
    (error) => error.code === "material_path_escape" || error.code === "ENOENT",
  );
  await assert.rejects(
    () =>
      service.readMaterial(
        caller,
        opened.contextId,
        instruction.instructionId,
        "another.md",
      ),
    { code: "material_path_escape" },
  );
  service.close(caller, opened.contextId);
  await assert.rejects(
    () => service.readMaterial(caller, opened.contextId, entry.skillId),
    { code: "context_closed" },
  );
});

test("the real work provider feeds captured Project identity and pwd to accepted execution across refresh and close", async (t) => {
  const { open, service, store, scripts, policy, work, setName } = fixture(t);
  const first = await open({ projectId: "project" });
  const captured = store.getWork(first.contextId),
    gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const loader = await ModuleLoader.create(work, store.bootId, policy);
  let block = true;
  const engine = new RunEngine(store, loader, scripts, {
    authorize() {},
    loadWork: async (record) => {
      if (block) {
        entered.resolve();
        await gate.promise;
      }
      return service.load(record);
    },
    bindings: () => ({}),
    encodeResult: async (value) => ({
      content: [],
      data: JSON.parse(canonicalJson(value)),
    }),
  });
  const started = await engine.start(caller, {
    contextId: first.contextId,
    script: "return {name:context.project.name,pwd:context.pwd};",
    waitMs: 0,
  });
  await entered.promise;
  setName("Renamed");
  await open({ contextId: first.contextId });
  service.close(caller, first.contextId);
  block = false;
  gate.resolve();
  const done = await engine.observe(caller, started.run.runId, 3000);
  assert.equal(done.run.status, "succeeded");
  assert.equal(done.result.data.name, "Original");
  assert.equal(done.result.data.pwd, captured.pwd);
  assert.equal(done.run.source.workRevision, 1);
  assert.match(done.run.logsRef, /^logs\/runs\//);
});

test("generated manuals keep old reading coordinates and an invalid package cannot be advertised as available", async (t) => {
  const { open, work, write, catalog } = fixture(t);
  const first = await open(),
    body = readFileSync(first.agent.docs.entry, "utf8");
  write(
    work,
    "node_modules/tiny/package.json",
    JSON.stringify({
      name: "tiny",
      version: "2.0.0",
      description: "changed version",
    }),
  );
  const second = await open();
  assert.notEqual(second.agent.docs.entry, first.agent.docs.entry);
  assert.equal(readFileSync(first.agent.docs.entry, "utf8"), body);
  const data = await catalog.refresh();
  assert.equal(data.packages[0].status, "changed");
});
