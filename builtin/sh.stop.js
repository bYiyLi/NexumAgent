/**
{
  "scriptName": "sh.stop.js",
  "scriptDesc": "停止原受管进程及后代。输入 {processId,graceMs?,forceMs?}，使用原 res_ ID，两个等待参数均为0–30000毫秒。返回停止回执，区分确认停止、已关闭、未确认关闭及输出收尾。未确认时查询原 Run 和 nexum/sh.get.js，不盲目重复停止。",
  "scriptWhenUse": "停止已有进程；普通 Run 满载仍可使用。",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "graceMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 30000
      },
      "forceMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 30000
      }
    },
    "required": [
      "processId"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "Markdown 停止回执，保留完整 processId、停止请求接受情况、实际关闭与进程树确认及输出收尾证据。"
  }
}
*/
const receipt = await sh.stop(context.input);
const facts = receipt.facts;
const confirmed = receipt.confirmed === true && facts.closed === true && facts.treeStopped === true;
const lines = [
  confirmed
    ? receipt.accepted ? "Process stopped." : "Process already closed."
    : "Stop not confirmed.",
  "Process: " + receipt.processId,
];
if (confirmed) {
  lines.push("Process tree closed.");
  if (!receipt.accepted) lines.push("No additional stop required.");
} else {
  lines.push(receipt.accepted ? "Stop request accepted." : "Stop request not accepted.");
  lines.push("Process closure: " + (facts.closed ? "closed" : "not confirmed") +
    " · Process tree: " + (facts.treeStopped ? "stopped" : "not confirmed"));
}
if (facts.exitCode !== null) lines.push("Exit code: " + facts.exitCode);
if (facts.exitSignal !== null) lines.push("Exit signal: " + JSON.stringify(facts.exitSignal));
if (facts.forceRequested) lines.push("Forced stop requested.");
lines.push(facts.outputComplete ? "Output capture complete." : "Output capture incomplete.");
if (!confirmed || !facts.outputComplete) {
  lines.push("Inspect the original process with nexum/sh.get.js before deciding on further action.");
}
return lines.join("\n");
