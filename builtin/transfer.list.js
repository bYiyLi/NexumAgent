/**
{
  "scriptName": "transfer.list.js",
  "scriptDesc": "查询当前 Agent 已登记且当前授权可见的文件传输，普通 Run 满载时可使用控制预留。输入 {direction?,status?,runId?,limit?,cursor?}，全部可选，{} 查询首批；direction 为 upload/download，status 为 preparing/pending/transferring/cancelling/succeeded/failed/cancelled/expired/interrupted，limit 默认20、范围1–100。返回按活跃、成功及其他终态分组的文本，保留完整 transferId、实际状态、目标与已传输字节；总大小未知时不推算百分比，100% 不代表成功，仅以 succeeded 确认传输成功，download 的 succeeded 不代表用户已保存文件。出现 Next cursor（即使本页为空）时保持原筛选并传 cursor 续页，不解析或猜测游标；无游标表示当前查询结束。详情/等待用 nexum/transfer.get.js（原 transferId），需要取消时用 nexum/transfer.cancel.js；列表不创建、重试或取消传输。",
  "scriptWhenUse": "定位已有上传/下载或诊断未完成传输；不用于浏览器下载目录或新建传输。",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "direction": {
        "type": "string",
        "enum": [
          "upload",
          "download"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "preparing",
          "pending",
          "transferring",
          "cancelling",
          "succeeded",
          "failed",
          "cancelled",
          "expired",
          "interrupted"
        ]
      },
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "按实际传输状态分组的紧凑 Markdown 单页，保留完整 transferId、方向、状态、目标、进度、必要诊断及 SDK 原 nextCursor（若有）。"
  }
}
*/
const page = await transfer.list(context.input);

// Project only the authoritative page; do not fetch more pages, modify
// transfers, or impose a second delivery budget.
const groups = [
  { title: "Active", lines: [] },
  { title: "Succeeded", lines: [] },
  { title: "Other terminal outcomes", lines: [] },
  { title: "Other / unknown status", lines: [] },
];
const active = new Set(["preparing", "pending", "transferring", "cancelling"]);
const terminal = new Set(["failed", "cancelled", "expired", "interrupted"]);
const label = value => /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)
  ? JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
  : value;

function size(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (i === 0 ? String(n) : String(Number(n.toFixed(2)))) + " " + units[i];
}

function progress({ bytesTransferred, totalBytes }) {
  const transferred = size(bytesTransferred);
  if (totalBytes === null) return transferred + " transferred (total unknown)";
  const amount = transferred + " / " + size(totalBytes);
  if (bytesTransferred > totalBytes) return amount + " (exceeds reported total)";
  if (totalBytes === 0) return amount;
  // Do not round an incomplete byte count up to 100%.
  const percent = bytesTransferred === totalBytes ? 100 : Math.min(99, Math.floor(bytesTransferred / totalBytes * 100));
  return amount + " (" + percent + "%)";
}

for (const item of page.transfers) {
  const group = active.has(item.status) ? groups[0]
    : item.status === "succeeded" ? groups[1]
    : terminal.has(item.status) ? groups[2] : groups[3];
  group.lines.push("    " + label(item.transferId) + " · " + label(item.direction) + " · " + label(item.status) + " · " + progress(item.progress));
  const facts = [];
  const path = item.direction === "upload" ? item.file?.path || item.path : null;
  if (typeof path === "string" && path) facts.push("Path: " + label(path));
  else {
    const name = item.direction === "download" ? item.resource?.name : item.file?.name;
    if (typeof name === "string" && name) facts.push("File: " + label(name));
  }
  if (item.runId !== null) facts.push("Run: " + label(item.runId));
  if (typeof item.createdAt === "string") facts.push("Created: " + label(item.createdAt));
  if (typeof item.error?.code === "string" && item.error.code) facts.push("Error: " + label(item.error.code));
  if (facts.length) group.lines.push("      " + facts.join(" · "));
}
const sections = groups.filter(group => group.lines.length).map(group => "## " + group.title + "\n\n" + group.lines.join("\n"));
const footer = page.transfers.length ? page.transfers.length + " transfers returned." : "No transfers on this page.";
sections.push(footer + (page.nextCursor !== null ? "\nNext cursor: " + JSON.stringify(page.nextCursor) + "\nContinue with the same filters and cursor." : ""));
return sections.join("\n\n");
