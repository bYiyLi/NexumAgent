# 可复用脚本的 JSON 头部

```javascript
/**
{
  "scriptName": "format-title.js",
  "scriptDesc": "清理文本两端空白",
  "scriptWhenUse": "需要重复格式化标题时",
  "scriptInputSchema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": { "title": { "type": "string" } },
    "required": ["title"],
    "additionalProperties": false
  }
}
*/
return { title: context.input.title.trim() };
```

**保存并执行**：把这段源码传给 `agent.run.start.script`，同时设置 `input: {"title": "  周报  "}`；本次运行和脚本收录分别核对。

**仅保存**：从本次 `agent.open.agent.paths.scripts` 取得脚本库目录，将源码写成 `format-title.js`；新文件用 `fs.writeFile(target, source, {flag: "wx"})` 避免覆盖。刷新 `agent.open` 确认已发现；不运行刚保存的业务代码。

已登记的脚本只在使用当前公开名称及其输入 Schema 时通过 `agent.run.start.scriptName` 调用。历史 `replayRunId` 会另启 Run，不用于检查或更新脚本。
