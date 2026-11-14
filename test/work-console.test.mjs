import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { DocumentCatalog } from "../dist/work/catalog.js";
import { WorkService } from "../dist/work/service.js";
import { selectorKey } from "../dist/work/discovery.js";

const sessionRef = "1".repeat(64);
const owner = {
  principalId: "user",
  clientId: `nexum-console:${sessionRef}`,
  source: "owner_session",
  sessionRef,
};
const mcp = { principalId: "user", clientId: owner.clientId };
const skillText = (name = "review") =>
  `---\nname: ${name}\ndescription: inspect real repository materials\n---\nSKILL PRIVATE BODY\n`;
function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-work-console-")),
  );
  const work = path.join(root, "work"),
    home = path.join(root, "home"),
    project = path.join(root, "project"),
    other = path.join(root, "other");
  for (const directory of [work, home, project, other]) mkdirSync(directory);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const write = (base, relative, content) => {
    const filename = path.join(base, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content);
    return realpathSync.native(filename);
  };
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const scripts = new ScriptCatalog(work, "agent"),
    catalog = new DocumentCatalog(work, scripts, {
      builtins: () => [],
      approvedPackages: () => new Map(),
    });
  let disabled = [],
    allowed = true,
    hook = () => {};
  const service = new WorkService(store, scripts, catalog, {
    home,
    agent: { name: "fixture", version: "1", protocolVersion: "2" },
    authorize(caller, target) {
      if (!allowed || caller.principalId !== "user")
        throw Object.assign(new Error("denied"), { code: "forbidden" });
      hook(caller, target);
    },
    async resolveProject(_caller, target) {
      const value =
        target.projectId === "project"
          ? project
          : target.projectId === "other"
            ? other
            : null;
      if (!value)
        throw Object.assign(new Error("unknown"), {
          code: "project_not_found",
        });
      return {
        project: {
          projectId: target.projectId,
          name: target.projectId,
          root: value,
        },
        disabledItems: disabled,
      };
    },
  });
  t.after(async () => {
    await service.drain();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    home,
    project,
    other,
    store,
    service,
    write,
    inspect: (extra = {}, signal) =>
      service.inspect(
        owner,
        { agentId: "agent", projectId: "project", ...extra },
        signal,
      ),
    setDisabled: (value) => {
      disabled = value;
    },
    revoke: () => {
      allowed = false;
    },
    setHook: (value) => {
      hook = value;
    },
  };
}

test("owner inspection exposes disabled metadata by Agent/Project while ordinary open and effective indexes retain enabled filtering", async (t) => {
  const f = fixture(t);
  const agentInstruction = f.write(f.work, "AGENTS.md", "AGENT RULE");
  const instruction = f.write(f.project, "AGENTS.md", "DISABLED PROJECT BODY");
  const nested = f.write(f.project, "src/AGENTS.md", "DISABLED NESTED BODY");
  const file = f.write(
    f.project,
    ".agents/skills/review/SKILL.md",
    skillText(),
  );
  f.setDisabled([
    { kind: "instruction", key: selectorKey("instruction", instruction) },
    { kind: "instruction", key: selectorKey("instruction", nested) },
    { kind: "skill", key: selectorKey("skill", file) },
  ]);
  const inspected = await f.inspect();
  assert.equal(inspected.project.instructions.length, 0);
  assert.equal(inspected.project.skills.length, 0);
  assert.equal(inspected.project.nestedInstructions.length, 0);
  assert.equal(
    inspected.agent.management.instructions[0].path,
    agentInstruction,
  );
  assert.equal(inspected.agent.management.instructions[0].disabled, false);
  assert.equal(inspected.agent.management.instructions[0].content, undefined);
  const management = inspected.project.management;
  assert.equal(management.instructions[0].path, instruction);
  assert.equal(management.instructions[0].disabled, true);
  assert.equal(
    management.instructions[0].itemId,
    management.instructions[0].instructionId,
  );
  assert.equal(management.nestedInstructions[0].path, nested);
  assert.equal(management.skills[0].path, path.dirname(file));
  assert.equal(management.skills[0].disabled, true);
  assert.doesNotMatch(
    JSON.stringify(inspected),
    /DISABLED PROJECT BODY|DISABLED NESTED BODY|SKILL PRIVATE BODY/,
  );
  assert.doesNotMatch(
    readFileSync(inspected.project.materialsIndex, "utf8"),
    /DISABLED PROJECT BODY|review/,
  );
  const opened = await f.service.open(mcp, {
    agentId: "agent",
    projectId: "project",
  });
  assert.equal(opened.agent.management, undefined);
  assert.equal(opened.project.management, undefined);
  assert.equal(opened.project.descriptionItemId, null);
  assert.equal(opened.project.instructions.length, 0);
  assert.equal(opened.project.skills.length, 0);
});

test("only trusted owner sessions can inspect or read disabled materials and inspection cannot change an existing Project binding", async (t) => {
  const f = fixture(t),
    instruction = f.write(f.project, "AGENTS.md", "DISABLED RULE"),
    file = f.write(f.project, ".agents/skills/review/SKILL.md", skillText());
  f.write(path.dirname(file), "references/detail.md", "real detail");
  f.setDisabled([
    { kind: "instruction", key: selectorKey("instruction", instruction) },
    { kind: "skill", key: selectorKey("skill", file) },
  ]);
  await assert.rejects(
    f.service.inspect(mcp, { agentId: "agent", projectId: "project" }),
    { code: "material_forbidden" },
  );
  await assert.rejects(
    f.service.inspect(
      { ...mcp, source: "owner_session" },
      { agentId: "agent", projectId: "project" },
    ),
    { code: "invalid_caller" },
  );
  await assert.rejects(f.inspect({ path: f.project }), {
    code: "invalid_work_inspection",
  });
  await assert.rejects(f.service.inspect(owner, { agentId: "agent" }), {
    code: "invalid_work_inspection",
  });
  const inspected = await f.inspect(),
    id = inspected.project.management.instructions[0].itemId,
    skillId = inspected.project.management.skills[0].itemId;
  assert.equal(
    (
      await f.service.readMaterial(owner, inspected.contextId, id)
    ).bytes.toString(),
    "DISABLED RULE",
  );
  assert.match(
    (
      await f.service.readMaterial(owner, inspected.contextId, skillId)
    ).bytes.toString(),
    /SKILL PRIVATE BODY/,
  );
  for (const target of [id, skillId])
    await assert.rejects(
      f.service.readMaterial(mcp, inspected.contextId, target),
      { code: "material_forbidden" },
    );
  await assert.rejects(
    f.service.readMaterialEntries(mcp, inspected.contextId, skillId),
    { code: "material_forbidden" },
  );
  assert.deepEqual(
    await f.service.readMaterialEntries(
      owner,
      inspected.contextId,
      skillId,
      "references",
    ),
    { entries: [{ displayPath: "references/detail.md", kind: "file" }] },
  );
  f.write(f.project, "AGENTS.md", "DISABLED RULE CHANGED");
  await assert.rejects(f.service.readMaterial(owner, inspected.contextId, id), {
    code: "material_changed",
  });
  await assert.rejects(
    f.inspect({ projectId: "other", contextId: inspected.contextId }),
    { code: "context_binding_mismatch" },
  );
  assert.equal(
    f.service.get(owner, inspected.contextId).project.projectId,
    "project",
  );
  f.revoke();
  await assert.rejects(f.service.readMaterial(owner, inspected.contextId, id), {
    code: "forbidden",
  });
});

test(
  "a disabled personal instruction keeps its explicitly discovered canonical file even when its entry is linked",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const actual = f.write(f.other, "personal.md", "PERSONAL LINKED RULE");
    mkdirSync(path.join(f.home, ".codex"));
    symlinkSync(actual, path.join(f.home, ".codex", "AGENTS.md"));
    f.setDisabled([
      { kind: "instruction", key: selectorKey("instruction", actual) },
    ]);
    const inspected = await f.inspect();
    const item = inspected.agent.management.instructions.find(
      (item) => item.path === actual,
    );
    assert.equal(item.disabled, true);
    assert.equal(item.content, undefined);
    assert.equal(
      (
        await f.service.readMaterial(owner, inspected.contextId, item.itemId)
      ).bytes.toString(),
      "PERSONAL LINKED RULE",
    );
    await assert.rejects(
      f.service.readMaterial(
        owner,
        inspected.contextId,
        item.itemId,
        "../sibling.md",
      ),
      { code: "material_path_escape" },
    );
    await assert.rejects(
      f.service.readMaterial(mcp, inspected.contextId, item.itemId),
      { code: "material_forbidden" },
    );
  },
);

test("a README changing between summary and full-description evidence remains an optional warning", async (t) => {
  const f = fixture(t);
  f.write(f.project, "README.md", "first description");
  const original = fsPromises.readdir;
  let projectReads = 0,
    changed = false;
  fsPromises.readdir = async function (filename, ...args) {
    if (filename === f.project && ++projectReads === 3) {
      f.write(f.project, "README.md", "replacement description");
      changed = true;
    }
    return Reflect.apply(original, this, [filename, ...args]);
  };
  syncBuiltinESMExports();
  try {
    const inspected = await f.inspect();
    assert.equal(
      changed,
      true,
      "The actual README must change before its second evidence read.",
    );
    assert.equal(inspected.project.descriptionItemId, null);
    assert.ok(
      inspected.warnings.some((item) => item.code === "readme_unavailable"),
    );
    assert.equal(inspected.project.projectId, "project");
  } finally {
    fsPromises.readdir = original;
    syncBuiltinESMExports();
  }
});

test("README identity captures the actual selected file and revision privately, supports full text and requires refresh after change", async (t) => {
  const f = fixture(t),
    body =
      "# README\n" + "完整内容。".repeat(15000) + "\nONLY-FULL-README-TAIL";
  const selected = f.write(f.project, "Readme.MD", body);
  f.write(f.project, "README.txt", "lower priority");
  const inspected = await f.inspect();
  assert.match(inspected.project.descriptionItemId, /^readme:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(inspected), /ONLY-FULL-README-TAIL/);
  const read = await f.service.readMaterial(
    owner,
    inspected.contextId,
    inspected.project.descriptionItemId,
  );
  assert.equal(read.path, selected);
  assert.equal(read.bytes.toString(), body);
  await assert.rejects(
    f.service.readMaterial(
      owner,
      inspected.contextId,
      inspected.project.descriptionItemId,
      "../README.txt",
    ),
    { code: "material_path_escape" },
  );
  f.write(f.project, "Readme.MD", body + " changed");
  await assert.rejects(
    f.service.readMaterial(
      owner,
      inspected.contextId,
      inspected.project.descriptionItemId,
    ),
    { code: "material_changed" },
  );
  const refreshed = await f.inspect({ contextId: inspected.contextId });
  assert.equal(refreshed.contextId, inspected.contextId);
  assert.equal(refreshed.revision, 2);
  assert.notEqual(
    refreshed.project.descriptionItemId,
    inspected.project.descriptionItemId,
  );
  assert.equal(
    (
      await f.service.readMaterial(
        owner,
        refreshed.contextId,
        refreshed.project.descriptionItemId,
      )
    ).bytes.toString(),
    body + " changed",
  );
});

test("missing or external linked README never fabricates a description material identity", async (t) => {
  const f = fixture(t);
  assert.equal((await f.inspect()).project.descriptionItemId, null);
  if (process.platform !== "win32") {
    const outside = f.write(f.other, "README.md", "outside description");
    symlinkSync(outside, path.join(f.project, "README.md"));
    const inspected = await f.inspect();
    assert.equal(inspected.project.descriptionItemId, null);
    assert.doesNotMatch(JSON.stringify(inspected), /outside description/);
  }
});

test("Skill subtree uses safe root-relative paths and rejects escapes, redirected children and changed winners", async (t) => {
  const f = fixture(t),
    file = f.write(f.project, ".agents/skills/review/SKILL.md", skillText()),
    root = path.dirname(file);
  f.write(root, "references/detail.md", "detail");
  f.write(root, "assets/data.json", "{}");
  const inspected = await f.inspect(),
    id = inspected.project.management.skills[0].itemId;
  assert.deepEqual(
    (await f.service.readMaterialEntries(owner, inspected.contextId, id))
      .entries,
    [
      { displayPath: "SKILL.md", kind: "file" },
      { displayPath: "assets", kind: "directory" },
      { displayPath: "assets/data.json", kind: "file" },
      { displayPath: "references", kind: "directory" },
      { displayPath: "references/detail.md", kind: "file" },
    ],
  );
  await assert.rejects(
    f.service.readMaterialEntries(
      owner,
      inspected.contextId,
      id,
      "../../../../other",
    ),
    { code: "material_path_escape" },
  );
  await assert.rejects(
    f.service.readMaterialEntries(owner, inspected.contextId, id, f.other),
    { code: "material_path_escape" },
  );
  const link = path.join(root, "outside");
  symlinkSync(f.other, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    f.service.readMaterialEntries(owner, inspected.contextId, id),
    { code: "material_path_escape" },
  );
  rmSync(link);
  f.write(root, "SKILL.md", skillText("changed"));
  await assert.rejects(
    f.service.readMaterialEntries(owner, inspected.contextId, id),
    { code: "material_changed" },
  );
});

test("Skill subtree rejects aggregate byte or entry overflow and honors cancellation and current authorization", async (t) => {
  const f = fixture(t),
    file = f.write(f.project, ".agents/skills/review/SKILL.md", skillText()),
    root = path.dirname(file);
  const inspected = await f.inspect(),
    id = inspected.project.management.skills[0].itemId;
  const controller = new AbortController();
  controller.abort(new Error("cancelled tree"));
  await assert.rejects(
    f.service.readMaterialEntries(
      owner,
      inspected.contextId,
      id,
      undefined,
      controller.signal,
    ),
    /cancelled tree/,
  );
  for (let index = 0; index < 1000; index++)
    f.write(root, `many/f${String(index).padStart(4, "0")}`, "");
  await assert.rejects(
    f.service.readMaterialEntries(owner, inspected.contextId, id),
    { code: "material_tree_too_large" },
  );
  rmSync(path.join(root, "many"), { recursive: true });
  for (let index = 0; index < 300; index++)
    f.write(
      root,
      `long/${String(index).padStart(4, "0")}-${"长".repeat(70)}`,
      "",
    );
  await assert.rejects(
    f.service.readMaterialEntries(owner, inspected.contextId, id),
    { code: "material_tree_too_large" },
  );
  f.revoke();
  await assert.rejects(
    f.service.readMaterialEntries(owner, inspected.contextId, id),
    { code: "forbidden" },
  );
});
