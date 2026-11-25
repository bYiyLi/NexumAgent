/**
{
  "scriptName": "sh.write.js",
  "scriptDesc": "向原受管进程写入文本或关闭 stdin。输入 {processId,data?:string,eof?:boolean}，原 res_ ID，至少提供 data 或 eof=true；UTF-8 最多1 MiB，不含 NUL、不补换行。eof=true 仅普通管道，先写后关闭。返回接受字节数及 EOF 回执，不回显输入、不证明业务完成。未知时查原 Run 和 nexum/sh.get.js，不盲目重试。",
  "scriptWhenUse": "提交已有进程的 stdin 或终端输入；普通 Run 满载仍可使用。",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "data": {
        "type": "string",
        "maxLength": 1048576
      },
      "eof": {
        "type": "boolean"
      }
    },
    "required": [
      "processId"
    ],
    "additionalProperties": false,
    "anyOf": [
      {
        "required": [
          "data"
        ],
        "properties": {
          "data": {}
        }
      },
      {
        "required": [
          "eof"
        ],
        "properties": {
          "eof": {
            "const": true
          }
        }
      }
    ]
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "文本写入回执，包含完整 processId、实际接受的输入字节数及 EOF 确认（如已关闭普通管道 stdin）。"
  }
}
*/
const receipt = await sh.write(context.input);
const lines = ["Input accepted.", "Process: " + receipt.processId, "Bytes written: " + receipt.bytes];
if (receipt.eof) lines.push("Stdin closed.");
return lines.join("\n");
