/**
{
  "scriptName": "script.list.js",
  "scriptDesc": "搜索当前 Work 的完整已登记脚本目录。输入 {query?:string,offset?:integer,limit?:integer}，query 按名称或描述匹配，省略列出全部，limit 默认 20（1–50）。返回 scripts（scriptName、description、path）、nextOffset（null 无下一页）、complete。按原 query 和 nextOffset 续读；complete=false 时报告发现不完整，不据此断言脚本不存在。选中后用 nexum/script.metadata.js 读取完整参数。",
  "scriptWhenUse": "可能存在合适的本地脚本但未入选默认列表，或需要查找已有同名脚本时使用。",
  "scriptInputSchema": {
    "type":"object",
    "properties":{"query":{"type":"string","maxLength":256},"offset":{"type":"integer","minimum":0,"maximum":100000},"limit":{"type":"integer","minimum":1,"maximum":50}},
    "additionalProperties":false
  },
  "scriptOutputSchema": {
    "type":"object",
    "properties":{"scripts":{"type":"array","items":{"type":"object","properties":{"scriptName":{"type":"string"},"description":{"type":"string"},"path":{"type":"string"}},"required":["scriptName","description","path"],"additionalProperties":false}},"nextOffset":{"type":["integer","null"]},"complete":{"type":"boolean"}},
    "required":["scripts","nextOffset","complete"],
    "additionalProperties":false
  }
}
*/
return await runtime.scriptList(context.input ?? {});
