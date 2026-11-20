import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const base = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(base, "../src/client/types.ts");
const references = path.resolve(base, "../skills/browser-control/references");
const types = (await readFile(source, "utf8")).trimEnd();

const preface = [
  "# 公开接口与数据类型",
  "",
  "此引用由本包的 `src/client/types.ts` 自动生成；仅当需要精确签名时按 [类型索引](api-index.md) 和 [成员索引](api-members.md) 找到对应行号，再读取本文件所需范围。",
  "",
  "类型存在不代表当前 Agent 已注册对应方法。实际可调用方法和输入 Schema 仍以本次 `agent.open` / SDK 注册能力为准。",
  "",
  "入口：`import { createBrowserClient } from \"@nexum-hub/browser\"`；`createBrowserClient(browser)` 使用当前 Run 注入的 `browser` 方法容器。不要把控制对象当成 MCP 结果输出。",
  "",
  "```typescript",
];
const full = [...preface, types, "```", ""].join("\n");
const offset = preface.length;
const sf = ts.createSourceFile("types.ts", types, ts.ScriptTarget.Latest, true);
const definitions = sf.statements.filter(n =>
  ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n));
const lineOf = n => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 + offset;
const lineEnd = n => sf.getLineAndCharacterOfPosition(n.end).line + 1 + offset;
const docName = n => n.name.text;
const items = definitions.map(n => ({
  name: docName(n),
  start: lineOf(n),
  end: lineEnd(n),
  members: ts.isInterfaceDeclaration(n) ? n.members :
    ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type) ? n.type.members : [],
}));
const mostUsed = [
  "BrowserClient", "Browsers", "Browser", "Tabs", "Tab",
  "PlaywrightAPI", "PlaywrightLocator", "PlaywrightDownload",
  "AXAPI", "ManagementCapability", "BrowserDownloadRecord", "ElementInfo",
];
const format = item =>
  `- [` + item.name + `](api.md) — 第 ` + item.start +
  (item.start === item.end ? "" : "–" + item.end) + " 行";
const listed = mostUsed.flatMap(name => items.filter(i => i.name === name));
const index = [
  "# Browser SDK 类型索引",
  "",
  "先定位真实方法或类型，再按下面的 **1 基行号**只读 [完整 SDK 类型](api.md) 的对应范围；需要具体成员行号时读取 [成员索引](api-members.md)。不要为了一个方法默认载入全部 TypeScript 声明。",
  "",
  "本索引与 `api.md` 均由 `src/client/types.ts` 同次生成。类型不证明当前插件已启用该方法，真实可用性以当前 Agent 注册能力和授权为准。",
  "",
  "同名类型可能由多个 TypeScript 声明合并而成，索引出现多个范围时需综合读取；不要只看首个片段。成员索引可按目标方法名进行文本搜索，仅读取匹配项及其完整声明，避免整篇载入。",
  "",
  "## 常用类型（优先定位）",
  "",
  ...listed.map(format),
  "",
  "## 所有公开类型",
  "",
  ...items.map(format),
  "",
].join("\n");
const memberRows = [];
for (const item of items) {
  for (const member of item.members) {
    if (!member.name || (!ts.isPropertySignature(member) && !ts.isMethodSignature(member))) continue;
    const key = member.name.getText(sf).replaceAll("|", "\\|");
    memberRows.push({owner:item.name,key,line:lineOf(member)});
  }
}
const members = [
  "# Browser SDK 成员定位",
  "",
  "已知方法或属性名称时先**按关键字搜索**本文件的匹配行（而非整篇加载），确认所属类型和行号；只按需要读取 [完整 SDK 类型](api.md) 的相应部分。若成员使用其他入参类型，再从 [类型索引](api-index.md) 补读对应定义。",
  "",
  "| 所属公开类型 | 方法或属性 | api.md 第几行 |",
  "| --- | --- | ---: |",
  ...memberRows.map(x => "| `" + x.owner + "` | `" + x.key + "` | " + x.line + " |"),
  "",
].join("\n");
const outputs = new Map([
  ["api.md", full],
  ["api-index.md", index],
  ["api-members.md", members],
]);
for (const [file, content] of outputs) {
  const target = path.join(references, file);
  if (process.argv.includes("--check")) {
    let actual;
    try { actual = await readFile(target, "utf8"); } catch { actual = null; }
    if (actual !== content) throw new Error("Browser Skill API " + file + " is not synchronized; run the generator.");
  } else {
    await writeFile(target, content);
  }
}
