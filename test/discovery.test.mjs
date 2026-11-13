import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  boundedFile,
  discoverMaterials,
  enabledMaterials,
  parseSkillFrontmatter,
  selectorKey,
} from "../dist/work/discovery.js";

function fixture(t) {
  const temporary = mkdtempSync(path.join(tmpdir(), "nexum-discovery-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = realpathSync(temporary),
    home = path.join(root, "home"),
    work = path.join(root, "work"),
    project = path.join(root, "project");
  for (const folder of [home, work, project]) mkdirSync(folder);
  function write(base, relative, text) {
    const file = path.join(base, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return realpathSync(file);
  }
  const options = { agentId: "a", home, work, projectRoot: project };
  return { root, home, work, project, write, options };
}
const skill = (
  name,
  description = "用途说明",
  extra = "",
  body = "PRIVATE BODY\n",
) => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`;

test("root instruction priorities and Agent/Project ownership survive ignore rules; nested bodies stay unloaded", async (t) => {
  const { home, work, project, write, options } = fixture(t);
  write(home, ".agents/AGENTS.md", "personal agents");
  write(home, ".codex/AGENTS.md", "old codex");
  write(home, ".codex/AGENTS.override.md", "codex override");
  write(work, "AGENTS.md", "agent instructions");
  write(project, "AGENTS.md", "project base");
  write(project, "AGENTS.override.md", "project override");
  write(project, ".gitignore", "AGENTS.override.md\nignored/\n.git/\n");
  write(project, "src/AGENTS.md", "NESTED PRIVATE BODY");
  write(project, "src/AGENTS.override.md", "ignored override");
  write(project, "ignored/deep/AGENTS.md", "hidden");
  write(project, "ignored/.gitignore", "x".repeat(100000)); // A pruned subtree is never read.
  write(project, ".git/deep/AGENTS.md", "git internals");
  const result = await discoverMaterials(options);
  assert.deepEqual(
    result.instructions.map((item) => [item.scope.type, item.content]),
    [
      ["personal", "personal agents"],
      ["personal", "codex override"],
      ["agent", "agent instructions"],
      ["project", "project override"],
    ],
  );
  assert.equal(result.nestedInstructions.length, 1);
  assert.equal(result.nestedInstructions[0].kind, "agents");
  assert.equal(
    result.nestedInstructions[0].scope.root,
    path.join(project, "src"),
  );
  assert.equal(result.nestedInstructions[0].content, undefined);
  assert.match(result.nestedInstructions[0].origin.revision, /^stat:/);
  assert.doesNotMatch(JSON.stringify(result), /NESTED PRIVATE BODY/);
});

test("scoped ignore inheritance agrees with Git, including a re-included parent and anchored child rules", async (t) => {
  const { project, write, options, root } = fixture(t);
  const init = spawnSync("git", ["init", "--quiet", project], {
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  const empty = write(root, "empty-ignore", "");
  write(
    project,
    ".gitignore",
    "*.md\n!AGENTS.md\nsrc/*\nignored/\n!ignored/deep/AGENTS.md\n",
  );
  write(project, "src/.gitignore", "!deep/\n!AGENTS.md\n");
  write(project, "src/deep/.gitignore", "!CLAUDE.md\n/AGENTS.override.md\n");
  write(project, "src/deep/AGENTS.md", "included");
  write(project, "src/deep/AGENTS.override.md", "excluded override");
  write(project, "src/deep/CLAUDE.md", "included by deeper rule");
  write(project, "src/deep/GEMINI.md", "excluded");
  write(project, "ignored/deep/AGENTS.md", "parent remains excluded");
  write(project, "[literal]/.gitignore", "!CLAUDE.md\n");
  write(project, "[literal]/CLAUDE.md", "literal scope");
  write(project, "文档/.gitignore", "!CLAUDE.md\n");
  write(project, "文档/CLAUDE.md", "unicode literal");
  const paths = [
    "src/deep/AGENTS.md",
    "src/deep/AGENTS.override.md",
    "src/deep/CLAUDE.md",
    "src/deep/GEMINI.md",
    "ignored/deep/AGENTS.md",
    "[literal]/CLAUDE.md",
    "文档/CLAUDE.md",
  ];
  const check = spawnSync(
    "git",
    [
      "-c",
      `core.excludesFile=${empty}`,
      "-c",
      "core.ignorecase=false",
      "check-ignore",
      "--no-index",
      "-z",
      "--stdin",
    ],
    {
      cwd: project,
      input: paths.join("\0") + "\0",
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: empty,
      },
    },
  );
  assert.equal(check.status, 0, check.stderr);
  const ignored = new Set(check.stdout.split("\0").filter(Boolean));
  const result = await discoverMaterials(options);
  const discovered = new Set(
    result.nestedInstructions.map((item) =>
      path.relative(project, item.path).split(path.sep).join("/"),
    ),
  );
  for (const file of paths)
    assert.equal(discovered.has(file), !ignored.has(file), file);
});

test("visibility applies after valid same-name resolution and does not grant a losing personal Skill", async (t) => {
  const { home, work, project, write, options } = fixture(t);
  const winner = write(
    project,
    ".agents/skills/review/SKILL.md",
    skill("review", "project wins"),
  );
  write(
    project,
    ".codex/skills/review/SKILL.md",
    skill("review", "project loser"),
  );
  write(work, "skills/review/SKILL.md", skill("review", "agent loser"));
  write(
    home,
    ".agents/skills/review/SKILL.md",
    skill("review", "personal loser"),
  );
  write(
    home,
    ".codex/skills/.system/creator/SKILL.md",
    skill("creator", "system Skill"),
  );
  const discovered = await discoverMaterials({
    ...options,
    disabledItems: [{ kind: "skill", key: selectorKey("skill", winner) }],
  });
  assert.equal(
    discovered.skills.filter((item) => item.name === "review").length,
    1,
  );
  assert.equal(
    discovered.skills.find((item) => item.name === "review").disabled,
    true,
  );
  assert.equal(
    discovered.skills.find((item) => item.name === "review").skillFile,
    winner,
  );
  const effective = enabledMaterials(discovered);
  assert.deepEqual(
    effective.skills.map((item) => item.name),
    ["creator"],
  );
  assert.doesNotMatch(
    JSON.stringify(discovered),
    /PRIVATE BODY|personal loser|project loser|agent loser/,
  );
});

test("Skill YAML is parsed as data with a bounded header; extended metadata never becomes permissions or body", () => {
  const body = "这个正文可以很长。".repeat(10000);
  const text = skill(
    "sample",
    "'When: generate reports'",
    "compatibility: Node 24\nallowed-tools: Shell(all)\nmetadata:\n  author: test\n",
    body,
  );
  const value = parseSkillFrontmatter(Buffer.from(text), "sample");
  assert.deepEqual(value, {
    name: "sample",
    description: "When: generate reports",
    compatibility: "Node 24",
  });
  const crlf = skill("sample", "|\n  folded\n  description").replaceAll(
    "\n",
    "\r\n",
  );
  assert.match(
    parseSkillFrontmatter(Buffer.from(crlf), "sample").description,
    /folded/,
  );
  for (const input of [
    skill("wrong"),
    skill("sample", "&a description", "metadata: *a\n"),
    "---\nname: sample\nname: sample\ndescription: x\n---\n",
    skill("sample", "!!js/function x"),
    skill("sample", "x".repeat(1025)),
  ])
    assert.throws(() => parseSkillFrontmatter(Buffer.from(input), "sample"));
  assert.throws(
    () => parseSkillFrontmatter(Buffer.from(skill("bad--name")), "bad--name"),
    { code: "invalid_skill" },
  );
  const header = Buffer.from(skill("sample"));
  assert.equal(
    parseSkillFrontmatter(
      Buffer.concat([header, Buffer.from([0xff])]),
      "sample",
    ).name,
    "sample",
  );
});

test("canonical paths reject project directory escapes and a Skill file cannot escape its own root", async (t) => {
  const { root, project, write, options } = fixture(t);
  const external = path.join(root, "external");
  mkdirSync(external);
  write(external, "hidden/AGENTS.md", "must not discover");
  symlinkSync(external, path.join(project, "redirect"), "junction");
  const escaping = path.join(project, ".codex", "skills");
  mkdirSync(path.dirname(escaping));
  symlinkSync(external, escaping, "junction");
  if (process.platform !== "win32") {
    const privateFile = write(external, "private.md", "must not read");
    write(project, "src/AGENTS.md", "valid fallback");
    symlinkSync(privateFile, path.join(project, "src/AGENTS.override.md"));
    const skillRoot = path.join(project, ".agents/skills/escaped");
    mkdirSync(skillRoot, { recursive: true });
    symlinkSync(privateFile, path.join(skillRoot, "SKILL.md"));
  }
  const result = await discoverMaterials(options);
  assert.doesNotMatch(
    JSON.stringify(result),
    /must not discover|must not read/,
  );
  assert.equal(result.skills.length, 0);
  if (process.platform !== "win32")
    assert.equal(path.basename(result.nestedInstructions[0].path), "AGENTS.md");
});

test("effective directories alone consume the traversal bound; ignore control failures and cancellation do not return partial data", async (t) => {
  const { project, write, options } = fixture(t);
  write(project, ".gitignore", "ignored/\n");
  write(project, "ignored/a/b/c/AGENTS.md", "pruned");
  write(project, "src/deep/AGENTS.md", "included");
  assert.equal(
    (await discoverMaterials({ ...options, maxDirectories: 2 }))
      .nestedInstructions.length,
    1,
  );
  await assert.rejects(
    () => discoverMaterials({ ...options, maxDirectories: 1 }),
    { code: "discovery_limit" },
  );
  write(project, "src/.gitignore", "x".repeat(65537));
  await assert.rejects(() => discoverMaterials(options), {
    code: "material_too_large",
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => discoverMaterials({ ...options, signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("instruction bodies are complete or fail, while disabled root entries remain metadata only", async (t) => {
  const { project, write, options } = fixture(t);
  const file = write(project, "AGENTS.md", "x".repeat(65537));
  await assert.rejects(() => discoverMaterials(options), {
    code: "material_too_large",
  });
  const result = await discoverMaterials({
    ...options,
    disabledItems: [
      { kind: "instruction", key: selectorKey("instruction", file) },
    ],
  });
  assert.equal(result.instructions[0].disabled, true);
  assert.equal(result.instructions[0].content, undefined);
  assert.equal(enabledMaterials(result).instructions.length, 0);
  await assert.rejects(() => boundedFile(file, 10), {
    code: "material_too_large",
  });
});

test("the nested limit remains 100 even when the final directory has several instruction kinds", async (t) => {
  const { project, write, options } = fixture(t);
  for (let i = 0; i < 26; i++)
    for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "CONTEXT.md"])
      write(project, `dir${i.toString().padStart(2, "0")}/${name}`, "body");
  const result = await discoverMaterials(options);
  assert.equal(result.nestedInstructions.length, 100);
  assert.equal(result.nestedComplete, false);
});
