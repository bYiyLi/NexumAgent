/**
{
  "scriptName": "transfer.cancel.js",
  "scriptDesc": "请求取消已登记且当前授权可控制的上传或下载，普通 Run 满载时仍可使用控制预留。输入 {transferId}，必填，使用原 tr_ ID。返回简洁文本，分别报告取消请求是否受理及原传输实际状态；accepted 仅表示受理，不代表已经停止。cancelling 尚未完成，使用 nexum/transfer.get.js 按原 transferId（可选 waitMs 0–30000）确认终态；只有 cancelled 表示确认取消。succeeded/failed/expired/interrupted 等已结束状态不改写为 cancelled。取消与文件提交可能并发，不能据受理推断文件未提交。已结束不重复取消；结果未知时先查询原 Run 和 transferId，不盲目重试。不会删除已提交文件、回滚、重建通道或恢复传输。",
  "scriptWhenUse": "明确要求停止已有传输；未知 ID 先用 nexum/transfer.list.js。",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "transferId": {
        "type": "string",
        "pattern": "^tr_[0-9a-f]{32}$"
      }
    },
    "required": [
      "transferId"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "紧凑取消回执，包含原 transferId、方向、实际状态、请求受理事实及必要安全诊断/后续查询提示，不返回完整传输对象或凭据。"
  }
}
*/
const receipt = await transfer.cancel(context.input.transferId);
const item = receipt.transfer;
const accepted = receipt.accepted === true;
const status = item.status;
const terminal = new Set(["cancelled", "succeeded", "failed", "expired", "interrupted"]);
const label = value => /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)
  ? JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
  : value;

let heading;
switch (status) {
  case "cancelled":
    heading = accepted ? "Transfer cancelled." : "Transfer already cancelled.";
    break;
  case "succeeded":
    heading = accepted ? "Transfer succeeded." : "Transfer already succeeded.";
    break;
  case "failed":
    heading = "Transfer failed.";
    break;
  case "expired":
    heading = "Transfer expired.";
    break;
  case "interrupted":
    heading = "Transfer interrupted.";
    break;
  default:
    heading = accepted ? "Cancellation accepted." : "Cancellation not accepted.";
}
const lines = [
  heading,
  "Transfer: " + label(item.transferId),
  "Direction: " + label(item.direction) + " · Status: " + label(status),
];
if (terminal.has(status)) {
  lines.push(accepted ? "Cancellation request accepted." : status === "cancelled" ? "No additional cancellation required." : "Cancellation was not applied.");
  if (status !== "cancelled") lines.push("Final outcome: " + label(status) + "; cancellation not confirmed.");
  if (typeof item.finishedAt === "string") lines.push("Finished: " + label(item.finishedAt));
} else {
  lines.push(status === "cancelling" ? "Cancellation in progress; closure is not confirmed." : "Transfer closure is not confirmed.");
}
if (status === "succeeded") {
  lines.push("Cancellation did not undo the successful transfer.");
} else if (!terminal.has(status)) {
  lines.push("Cancellation does not prove that no file was committed.");
}
const code = item.error?.code;
if (typeof code === "string" && /^[a-z][a-z0-9_]{0,255}$/.test(code)) lines.push("Error: " + code);
else if (item.error !== null) lines.push("Error: retained diagnostic unavailable.");
if (!terminal.has(status)) {
  lines.push("Query the original transferId with nexum/transfer.get.js to confirm the actual outcome.");
} else if (status === "failed" || status === "interrupted") {
  lines.push("Inspect the original outcome with nexum/transfer.get.js before deciding on further action.");
}
return lines.join("\n");
