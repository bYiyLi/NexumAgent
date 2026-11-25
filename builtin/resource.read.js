/**
{
  "scriptName": "resource.read.js",
  "scriptDesc": "读取本 Agent 已登记的资源 URI。输入 {uri,mode?,startLine?,endLine?}；mode=auto（默认）/content/download。文本默认完整读取，行号从1开始且包含结束行；JSON 保留原文，图片/音频直接交付原生内容，其他文件返回原始文件下载 Offer。content 不解析 PDF/Office；download 不接受行范围。出现 NextLine 时按原 URI 续读；超限缩小文本范围或用 download；pending 仅等待领取，按原 transferId 查询。资源失效、撤权或内容变化时不猜路径。",
  "scriptWhenUse": "Host 无标准 resources/read，或需按行读取、原生媒体或下载原始文件时使用。",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "uri": {"type":"string","minLength":1,"maxLength":2048,"description":"本 Agent 已登记的真实 nexum://agents/.../resources/res_... URI。"},
      "mode": {"enum":["auto","content","download"],"description":"默认 auto；content 仅文本或原生媒体；download 获取原始文件。"},
      "startLine": {"type":"integer","minimum":1,"maximum":9007199254740991},
      "endLine": {"type":"integer","minimum":1,"maximum":9007199254740991}
    },
    "required": ["uri"],
    "allOf": [{"not":{"type":"object","required":["mode","startLine"],"properties":{"mode":{"const":"download"},"startLine":{}}}},{"not":{"type":"object","required":["mode","endLine"],"properties":{"mode":{"const":"download"},"endLine":{}}}}]
  }
}
*/
const { uri, mode = "auto", startLine, endLine } = context.input;
if (mode === "download") return await transfer.createDownload({ uri });
const result = await runtime.readResource({ uri, mode, ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }) });
if (result.kind === "file") return await transfer.createDownload({ uri });
return result.value;
