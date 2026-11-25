/**
{
  "scriptName": "sh.resize.js",
  "scriptDesc": "调整已启动的受管 PTY 终端尺寸，普通 Run 满载时仍可使用。输入 {processId,cols,rows}，均必填；processId 使用原 res_ ID（不是 OS PID），cols 为列数、rows 为行数，均为 1–1000 的整数。仅用于以 tty:true 启动且仍可控制的进程；普通管道不支持 resize，不转换终端类型、不重启进程。成功返回原 processId 和已接受的列数、行数，不代表终端应用已完成重绘。需要确认应用响应时用 nexum/sh.get.js 查看原进程输出；参数错误时修正行列；非 PTY、进程已关闭或授权被拒绝时停止调整；超时或结果未知时先查询原 Run 及原进程，不盲目重试。",
  "scriptWhenUse": "调整已有交互式 CLI/全屏终端行列，不用于浏览器窗口。",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "cols": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000
      },
      "rows": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000
      }
    },
    "required": [
      "processId",
      "cols",
      "rows"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "终端尺寸调整回执，包含完整 processId 和已接受的 cols、rows；不表示应用已完成重绘。"
  }
}
*/
const receipt = await sh.resize(context.input);
return [
  "Terminal resize accepted.",
  "Process: " + receipt.processId,
  "Size: " + receipt.cols + " columns × " + receipt.rows + " rows",
].join("\n");
