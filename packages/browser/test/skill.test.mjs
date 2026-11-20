import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const skillRoot = path.join(root, "skills", "browser-control");
const read = (relative) => readFileSync(path.join(skillRoot, relative), "utf8");
const skill = read("SKILL.md");
const references = path.join(skillRoot, "references");

test("extension instructions handle truncated skill and script indexes before Skill selection", () => {
  const entry = readFileSync(path.join(root, "instructions/README.md"), "utf8");
  assert.match(entry, /skillsComplete=false/);
  assert.match(entry, /agent.materialsIndex/);
  assert.match(entry, /agent.scripts.index/);
  assert.match(entry, /skillFile/);
});

test("Browser Skill selection boundaries and progressive routes are explicit", () => {
  assert.match(skill, /^---\nname: browser-control\ndescription: .+\n---\n/m);
  assert.match(skill.split("\n")[2], /浏览器/);
  const routes = skill.split("\n").filter((line) => line.startsWith("- **"));
  const find = (term) => routes.find((line) => line.includes(term)) ?? "";
  assert.match(find("发现浏览器"), /references\/bootstrap\.md/);
  assert.doesNotMatch(find("发现浏览器"), /api\.md|advanced\.md|downloads\.md/);
  assert.match(find("checkbox"), /references\/forms\.md/);
  assert.match(find("上传"), /references\/downloads\.md/);
  assert.match(find("连接失败"), /references\/errors\.md/);
  assert.match(find("精确参数"), /references\/api-index\.md/);
  assert.match(find("资产"), /references\/advanced\.md/);
  assert.doesNotMatch(skill, /\.\.\/\.\.\/docs\/|references\/usage\.md/);
});

test("all Browser Skill resources are reachable and links stay inside the Skill", () => {
  const visited = new Set();
  const pending = ["SKILL.md"];
  const matcher = /\]\(([^)#]+)(?:#[^)]+)?\)/g;
  while (pending.length) {
    const item = pending.pop();
    if (visited.has(item)) continue;
    const body = read(item);
    visited.add(item);
    for (const match of body.matchAll(matcher)) {
      const target = match[1];
      if (/^[a-z]+:\/\//i.test(target)) continue;
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(item), target));
      assert.ok(relative !== ".." && !relative.startsWith("../"), "escape: " + item + " -> " + target);
      assert.ok(statSync(path.join(skillRoot, relative)).isFile(), "missing: " + item + " -> " + target);
      pending.push(relative);
    }
  }
  const names = readdirSync(references).filter((name) => name.endsWith(".md"));
  for (const name of names) {
    assert.ok(visited.has("references/" + name), "unreachable reference: " + name);
  }
  assert.equal(names.includes("usage.md"), false);
});

test("Browser scripts and Skill auxiliaries have distinct invocation contracts", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.nexum.skills, "./skills");
  assert.equal(pkg.nexum.scripts, "./scripts");
  assert.ok(pkg.files.includes("skills"));
  assert.ok(pkg.files.includes("scripts"));
  assert.ok(!pkg.files.includes("docs"));
  assert.equal("docs" in pkg.nexum, false);
  assert.match(skill, /agent\.scripts/);
  assert.match(skill, /complete=false/);
  assert.match(read("references/scripts.md"), /agent\.scripts\.index/);
  assert.match(read("references/scripts.md"), /scriptName/);
});

test("API type and member indexes are generated from the exact SDK", () => {
  const check = spawnSync(process.execPath, ["tools/generate-skill-api-reference.mjs", "--check"], {
    cwd: root, encoding: "utf8"
  });
  assert.equal(check.status, 0, check.stderr + check.stdout);
  const index = read("references/api-index.md");
  const members = read("references/api-members.md");
  assert.match(index, /PlaywrightLocator/);
  assert.ok(members.includes("| `PlaywrightLocator` | `selectOption` |"));
  assert.match(index, /1 基行号/);
});

test("generated API line indexes identify the exact declared symbols", () => {
  const lines = read("references/api.md").split("\n");
  const index = read("references/api-index.md");
  const members = read("references/api-members.md");
  const types = [...index.matchAll(/^- \[([^\]]+)\]\(api\.md\) — 第 (\d+)(?:–(\d+))? 行$/gm)];
  assert.ok(types.length >= 140, "expected the full public API type inventory");
  for (const [, symbol, first, last] of types) {
    const number = Number(first);
    assert.ok(lines[number - 1].includes(symbol), symbol + " at " + first);
    assert.ok(Number(last ?? first) >= number);
  }
  const rows = [...members.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| (\d+) \|$/gm)];
  assert.ok(rows.length >= 300, "expected the complete public method/property index");
  for (const [, owner, member, number] of rows) {
    assert.ok(lines[Number(number) - 1]?.includes(member),
      owner + "." + member + " at " + number);
  }
});

test("downloads handle nil, ambiguous and permission failures", () => {
  const download = read("references/downloads.md");
  assert.match(download, /downloadRecordId/);
  assert.match(download, /Number.isSafeInteger/);
  assert.match(download, /file === null/);
  assert.match(download, /CAPABILITY_NOT_ALLOWED/);
  assert.match(download, /FILE_UNAVAILABLE/);
  assert.match(download, /waitForFileChooser/);
  assert.match(download, /context\.input\.filePath/);
});

test("model-facing JavaScript examples parse in async Run", () => {
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  for (const file of ["references/bootstrap.md", "references/interaction.md",
    "references/forms.md", "references/observation.md",
    "references/downloads.md", "references/tabs-and-observation.md"]) {
    const body = read(file);
    for (const match of body.matchAll(/```javascript\n([\s\S]*?)\n```/g)) {
      assert.doesNotThrow(() => new AsyncFunction(match[1]), file);
    }
  }
});
