/**
{
  "scriptName": "sh.signal.js",
  "scriptDesc": "向已有受管进程投递明确指定的信号，普通 Run 满载时仍可使用。输入 {processId,signal}，均必填；processId 使用原 res_ ID（不使用 OS PID），signal 使用目标平台支持的 SIG 名称。macOS/Linux 向原受管进程组投递；Windows 仅支持 SIGKILL（Job 强制终止）及 PTY 的 SIGINT（终端中断输入）。不支持的信号直接报错，不替换信号。返回 Signal delivered/not delivered、processId 和实际 Mechanism；投递成功不证明程序已处理信号或进程已退出。需要确认退出、未投递或结果未知时用 nexum/sh.get.js 查询原进程；结果未知时先查原 Run，不盲目重投。需要完整停止并确认收尾时使用 nexum/sh.stop.js，不自动升级强制停止。",
  "scriptWhenUse": "明确需要指定信号时使用。",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "signal": {
        "type": "string",
        "pattern": "^SIG[A-Z0-9]+$",
        "maxLength": 32
      }
    },
    "required": [
      "processId",
      "signal"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "简洁信号投递回执，包含完整 processId、requested 信号、实际投递与 mechanism（process-group/job-object/terminal-input）；未投递不等于已退出。"
  }
}
*/
const receipt = await sh.signal(context.input);
const lines = [
  (receipt.delivered ? "Signal delivered: " : "Signal not delivered: ") + receipt.requested,
  "Process: " + receipt.processId,
  "Mechanism: " + receipt.mechanism,
];
if (receipt.delivered) {
  lines.push("Delivery does not confirm signal handling or process exit.");
} else {
  lines.push("Check the original process with nexum/sh.get.js before deciding on further action.");
}
return lines.join("\n");
