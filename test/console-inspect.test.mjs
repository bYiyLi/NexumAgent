import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectConsoleAgent } from "../dist/host/console-inspect.js";

function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-console-inspect-")),
  );
  const work = root;
  mkdirSync(work, { recursive: true });
  writeFileSync(
    path.join(work, "AGENTS.md"),
    "Read-only fixture instructions\n",
  );
  mkdirSync(path.join(work, "scripts"));
  writeFileSync(
    path.join(work, "scripts", "review.js"),
    '/**\n{"scriptName":"review.js","scriptDesc":"Review files","scriptWhenUse":"Review","scriptInputSchema":{"type":"object"}}\n*/\nreturn true;\n',
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, work };
}

test("Console snapshot is read-only, includes effective local/script/package records and sampled Node RSS", async (t) => {
  const f = fixture(t);
  const output = await inspectConsoleAgent({
    agentId: "agent-test",
    work: f.work,
    home: null,
    sources: [],
    approvedPackages: new Map([["alpha", "1.0.0"]]),
    signal: new AbortController().signal,
  });
  assert.ok(
    output.resources.some(
      (entry) => entry.type === "instruction" && entry.name === "AGENTS.md",
    ),
  );
  assert.ok(
    output.resources.some(
      (entry) => entry.type === "script" && entry.name === "review.js",
    ),
  );
  assert.ok(
    output.resources.some(
      (entry) => entry.type === "npm" && entry.name === "alpha",
    ),
  );
  assert.equal(output.telemetry.scope, "node_host");
  assert.ok(output.telemetry.memoryRssMb > 0);
  assert.ok(
    output.telemetry.cpuPercent >= 0 && output.telemetry.cpuPercent <= 100,
  );
  assert.ok(Number.isFinite(Date.parse(output.observedAt)));
  assert.equal(existsSync(path.join(f.work, "tmp", "contexts")), false);
});

test("generated MCP skills remain linked to their actual approved source", async (t) => {
  const f = fixture(t);
  const output = await inspectConsoleAgent({
    agentId: "agent-test",
    work: f.work,
    home: null,
    sources: [
      {
        source: { kind: "mcp", objectId: "src-1", name: "GitHub MCP" },
        materials: {
          instructions: [],
          skills: [
            {
              skillId: "mcp-skill-1",
              name: "github-issues",
              description: "GitHub issues",
              origin: { owner: "mcp:src-1" },
            },
          ],
          scriptSources: [],
        },
      },
    ],
    approvedPackages: new Map(),
    signal: new AbortController().signal,
  });
  const source = output.resources.find(
    (item) => item.type === "mcp" && item.name === "GitHub MCP",
  );
  const skill = output.resources.find(
    (item) => item.type === "skill" && item.name === "github-issues",
  );
  assert.ok(source && skill);
  assert.equal(skill.parentId, source.id);
  assert.equal(
    new Set(output.resources.map((r) => r.id)).size,
    output.resources.length,
  );
});

test("Console inspection honors cancelled reads without returning misleading empty data", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    inspectConsoleAgent({
      agentId: "agent-test",
      work: f.work,
      home: null,
      sources: [],
      approvedPackages: new Map(),
      signal: controller.signal,
    }),
  );
});

test("Scripts from two enabled source namespaces preserve distinct qualified identities", async (t) => {
  const f = fixture(t);
  const sources = ["alpha", "beta"].map((name) => {
    const directory = path.join(
      f.work,
      "node_modules",
      "@demo",
      name,
      "scripts",
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "shared.js"),
      '/**\n{"scriptName":"shared.js","scriptDesc":"Source-specific script","scriptWhenUse":"Review","scriptInputSchema":{"type":"object"}}\n*/\nreturn true;\n',
    );
    return {
      source: { kind: "extension", objectId: name, name },
      materials: {
        instructions: [],
        skills: [],
        scriptSources: [
          {
            type: "extension",
            owner: "@demo/" + name,
            namespace: name,
            version: "1.0.0",
            directory,
          },
        ],
      },
    };
  });
  const result = await inspectConsoleAgent({
    agentId: "agent-test",
    work: f.work,
    home: null,
    sources,
    approvedPackages: new Map(),
    signal: new AbortController().signal,
  });
  const items = result.resources.filter((item) => item.type === "script");
  const a = items.find((item) => item.name === "alpha/shared.js");
  const b = items.find((item) => item.name === "beta/shared.js");
  assert.ok(
    a && b,
    JSON.stringify({ items, warnings: result.warnings, all: result.resources }),
  );
  assert.notEqual(a.id, b.id);
});

test("on-demand instruction detail contains only a current discovered instruction", async (t) => {
  const f = fixture(t);
  const args = {
    agentId: "agent-test",
    work: f.work,
    home: null,
    sources: [],
    approvedPackages: new Map([["alpha", "1.0.0"]]),
    signal: new AbortController().signal,
  };
  const list = await inspectConsoleAgent(args);
  const item = list.resources.find(
    (r) => r.type === "instruction" && r.name === "AGENTS.md",
  );
  assert.ok(item && item.path === path.join(f.work, "AGENTS.md"));
  assert.equal(Object.hasOwn(list, "instruction"), false);
  assert.equal(Object.hasOwn(item, "content"), false);
  const detail = await inspectConsoleAgent({
    ...args,
    requestedResourceId: item.id,
  });
  assert.equal(detail.instruction?.id, item.id);
  assert.equal(detail.instruction?.path, item.path);
  assert.equal(typeof detail.instruction?.content, "string");
  assert.ok(detail.instruction.content.length > 0);
  await assert.rejects(
    inspectConsoleAgent({
      ...args,
      requestedResourceId: "res_" + "0".repeat(64),
    }),
    (error) => error.code === "resource_not_found",
  );
  const other = list.resources.find((r) => r.type === "npm");
  assert.ok(other);
  await assert.rejects(
    inspectConsoleAgent({ ...args, requestedResourceId: other.id }),
    (error) => error.code === "resource_not_found",
  );
});

test("Console Skill details read current nested text files but never arbitrary paths or symlinks", async (t) => {
  const f = fixture(t);
  const home = path.join(f.root, "home");
  const skillRoot = path.join(home, ".agents", "skills", "code-review");
  mkdirSync(path.join(skillRoot, "references", "examples"), { recursive: true });
  writeFileSync(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: code-review\ndescription: Review code safely\n---\n\n# Review\n",
  );
  writeFileSync(
    path.join(skillRoot, "references", "examples", "guide.md"),
    "# Review steps\n\nVerify the actual diff.\n",
  );
  writeFileSync(path.join(f.root, "outside.md"), "private marker");
  symlinkSync(path.join(f.root, "outside.md"), path.join(skillRoot, "references", "leak.md"));
  const options = {
    agentId: "agent-test",
    work: f.work,
    home,
    sources: [],
    approvedPackages: new Map(),
    signal: new AbortController().signal,
  };
  const inventory = await inspectConsoleAgent(options);
  const skill = inventory.resources.find((item) => item.type === "skill" && item.name === "code-review");
  assert.ok(skill && /^res_[0-9a-f]{64}$/.test(skill.id));
  assert.equal(Object.hasOwn(inventory, "skill"), false);
  const result = await inspectConsoleAgent({ ...options, requestedResourceId: skill.id });
  assert.equal(result.skill?.id, skill.id);
  assert.equal(result.skill.selected.displayPath, "SKILL.md");
  assert.match(result.skill.selected.content, /# Review/);
  assert.ok(result.skill.entries.some((item) => item.kind === "directory" && item.displayPath === "references/examples"));
  assert.ok(result.skill.entries.some((item) => item.kind === "file" && item.displayPath === "references/examples/guide.md"));
  assert.ok(!result.skill.entries.some((item) => item.displayPath.endsWith("leak.md")));
  assert.ok(!JSON.stringify(result.skill).includes(f.root));

  const file = await inspectConsoleAgent({
    ...options, requestedResourceId: skill.id, requestedFilePath: "references/examples/guide.md",
  });
  assert.match(file.skill.selected.content, /Verify the actual diff/);
  writeFileSync(path.join(skillRoot, "references", "examples", "guide.md"), "# Changed content\n");
  const changed = await inspectConsoleAgent({
    ...options, requestedResourceId: skill.id, requestedFilePath: "references/examples/guide.md",
  });
  assert.match(changed.skill.selected.content, /Changed content/);
  assert.notEqual(changed.skill.selected.revision, file.skill.selected.revision);

  for (const bad of ["../../outside.md", "references/leak.md", "SKILL.md/../../outside.md", "/etc/passwd"]) {
    await assert.rejects(
      inspectConsoleAgent({ ...options, requestedResourceId: skill.id, requestedFilePath: bad }),
      (error) => error.code === "skill_file_unavailable",
      bad,
    );
  }
  await assert.rejects(
    inspectConsoleAgent({ ...options, requestedResourceId: "res_" + "0".repeat(64), requestedFilePath: "SKILL.md" }),
    (error) => error.code === "resource_not_found",
  );
  const instruction = inventory.resources.find((entry) => entry.type === "instruction");
  assert.ok(instruction);
  await assert.rejects(
    inspectConsoleAgent({ ...options, requestedResourceId: instruction.id, requestedFilePath: "SKILL.md" }),
    (error) => error.code === "resource_not_found",
  );
  writeFileSync(path.join(skillRoot, "references", "examples", "guide.md"), "x".repeat(65537));
  const longFile = await inspectConsoleAgent({
    ...options, requestedResourceId: skill.id, requestedFilePath: "references/examples/guide.md",
  });
  assert.equal(longFile.skill.selected.truncated, true);
  assert.ok(Buffer.byteLength(longFile.skill.selected.content, "utf8") <= 65536);
  writeFileSync(path.join(skillRoot, "references", "examples", "guide.md"), "x".repeat(1024 * 1024 + 1));
  await assert.rejects(
    inspectConsoleAgent({ ...options, requestedResourceId: skill.id, requestedFilePath: "references/examples/guide.md" }),
    (error) => error.code === "material_too_large",
  );
});


test("Console script detail resolves the current registered file by opaque resource ID", async (t) => {
  const f = fixture(t);
  const options = {
    agentId: "agent-test",
    work: f.work,
    home: null,
    sources: [],
    approvedPackages: new Map(),
    signal: new AbortController().signal,
  };
  const inventory = await inspectConsoleAgent(options);
  const item = inventory.resources.find(
    (entry) => entry.type === "script" && entry.name === "review.js",
  );
  assert.ok(item && item.id.startsWith("res_"));
  assert.equal(Object.hasOwn(inventory, "script"), false);
  assert.equal(Object.hasOwn(item, "code"), false);
  const first = await inspectConsoleAgent({
    ...options,
    requestedResourceId: item.id,
  });
  assert.equal(first.script.id, item.id);
  assert.equal(first.script.scriptName, "review.js");
  assert.equal(first.script.scriptDesc, "Review files");
  assert.equal(first.script.scriptWhenUse, "Review");
  assert.deepEqual(first.script.scriptInputSchema, { type: "object" });
  assert.equal(first.script.scriptOpenDefault, false);
  assert.equal(first.script.origin.type, "local");
  assert.equal(first.script.origin.namespace, null);
  assert.match(first.script.code, /return true;/);
  assert.equal(first.script.codeComplete, true);

  writeFileSync(path.join(f.work, "scripts", "review.js"),
    '/**\n{"scriptName":"review.js","scriptDesc":"Updated review","scriptWhenUse":"Review now","scriptInputSchema":{"type":"object"},"scriptOpenDefault":true}\n*/\nreturn false;\n');
  const updated = await inspectConsoleAgent({
    ...options,
    requestedResourceId: item.id,
  });
  assert.equal(updated.script.scriptDesc, "Updated review");
  assert.equal(updated.script.scriptWhenUse, "Review now");
  assert.equal(updated.script.scriptOpenDefault, true);
  assert.match(updated.script.code, /return false;/);

  await assert.rejects(
    inspectConsoleAgent({
      ...options,
      requestedResourceId: "res_" + "0".repeat(64),
    }),
    (error) => error.code === "resource_not_found",
  );
  const instruction = inventory.resources.find(
    (entry) => entry.type === "instruction",
  );
  assert.ok(instruction);
  const wrongType = await inspectConsoleAgent({
    ...options,
    requestedResourceId: instruction.id,
  });
  assert.equal(Object.hasOwn(wrongType, "script"), false);
});

test("Console MCP details use published method metadata and never expose unrelated source data", async (t) => {
  const f = fixture(t);
  const options = {
    agentId: "agent-test",
    work: f.work,
    home: null,
    sources: [
      {
        source: {
          kind: "mcp", objectId: "github", name: "GitHub",
          methods: [
            { operation: "tools/get_issue", metadata: { description: "Read issue", inputSchema: { type: "object", properties: { owner: { type: "string" } } }, outputSchema: { type: "object" }, headers: { Authorization: "secret-token" } } },
            { operation: "resources/read", metadata: { description: "Not a tool", inputSchema: { type: "object" } } },
          ],
        },
        materials: { instructions: [], skills: [], scriptSources: [] },
      },
      {
        source: {
          kind: "mcp", objectId: "private-other", name: "Private",
          methods: [{ operation: "tools/private_action", metadata: { description: "Private", inputSchema: { type: "object" } } }],
        },
        materials: { instructions: [], skills: [], scriptSources: [] },
      },
    ],
    approvedPackages: new Map(),
    signal: new AbortController().signal,
  };
  const inventory = await inspectConsoleAgent(options);
  const id = inventory.resources.find((item) => item.type === "mcp" && item.name === "GitHub")?.id;
  assert.ok(id);
  const result = await inspectConsoleAgent({ ...options, requestedResourceId: id });
  assert.equal(result.mcp.id, id);
  assert.equal(result.mcp.state, "published");
  assert.equal(result.mcp.complete, true);
  assert.deepEqual(result.mcp.tools.map((tool) => tool.name), ["get_issue"]);
  assert.deepEqual(result.mcp.tools[0].inputSchema.properties.owner, { type: "string" });
  assert.deepEqual(result.mcp.tools[0].outputSchema, { type: "object" });
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  assert.ok(!JSON.stringify(result).includes("private_action"));
  await assert.rejects(
    inspectConsoleAgent({ ...options, requestedResourceId: "res_" + "f".repeat(64) }),
    { code: "resource_not_found" },
  );
});
