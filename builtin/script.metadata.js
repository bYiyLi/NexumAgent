/**
{
  "scriptName": "script.metadata.js",
  "scriptDesc": "读取当前 Work 已登记且授权的脚本完整 JSON 头部，不执行目标。输入 {path:string}，使用 Open 中该脚本的实际绝对路径。返回原始 scriptName、scriptDesc、scriptWhenUse、scriptInputSchema、可选 scriptOutputSchema/scriptOpenDefault。执行时使用 Open 的公开 scriptName；变更或不可用时刷新原 Context。",
  "scriptWhenUse": "描述不足以构造参数或判断返回值时使用；无需先读取本脚本元数据。",
  "scriptInputSchema": {
    "type":"object",
    "properties":{"path":{"type":"string","minLength":1}},
    "required":["path"],
    "additionalProperties":false
  },
  "scriptOutputSchema": {
    "type":"object",
    "properties":{"scriptName":{"type":"string"},"scriptDesc":{"type":"string"},"scriptWhenUse":{"type":"string"},"scriptInputSchema":{"anyOf":[{"type":"object"},{"type":"boolean"}]},"scriptOutputSchema":{"anyOf":[{"type":"object"},{"type":"boolean"}]},"scriptOpenDefault":{"type":"boolean"}},
    "required":["scriptName","scriptDesc","scriptWhenUse","scriptInputSchema"],
    "additionalProperties":false
  }
}
*/
return await runtime.scriptMetadata(context.input);
