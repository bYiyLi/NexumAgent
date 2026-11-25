# 可复用脚本的 JSON 头部

```javascript
/**
{
  "scriptName": "format-title.js",
  "scriptDesc": "清理标题两端空白；输入 {title:string}，返回字符串。",
  "scriptWhenUse": "需要重复格式化标题时",
  "scriptInputSchema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": { "title": { "type": "string" } },
    "required": ["title"],
    "additionalProperties": false
  },
  "scriptOutputSchema": {"type":"string"}
}
*/
return context.input.title.trim();
```

**保存并执行**：把这段源码传给 `agent.run.start.script`，同时设置 `input: {"title": "  周报  "}`；本次运行和脚本收录分别核对。

**仅保存**：从本次 Open 的 `agent.paths.scripts` 取得脚本库目录，将上述源码作为 input.source、实际脚本库绝对路径作为 input.directory，在获准的保存 Run 中执行下方代码；wx 避免覆盖。刷新 `agent.open` 确认已发现；不运行刚保存的业务代码。

```javascript
const fs = await import("node:fs/promises");
const path = await import("node:path");
const target = path.join(context.input.directory, "format-title.js");
await fs.writeFile(target, context.input.source, { flag: "wx", encoding: "utf8" });
if (await fs.readFile(target, "utf8") !== context.input.source) throw new Error("Script readback differs");
return target;
```

仅在获准执行时，以刷新后 Open 返回的公开 scriptName 执行；历史 replayRunId 会另启 Run，不用于检查或更新脚本。
