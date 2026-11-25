/**
{
  "scriptName": "transfer.get.js",
  "scriptDesc": "查询原文件传输的实际状态、进度及结果证据，普通 Run 满载时仍可使用。输入 {transferId,waitMs?}，使用原 tr_ ID，waitMs 默认0、范围0–30000毫秒；非终态可等待下一次持久状态变化或超时后回读，不保证等待至完成，终态直接返回。返回紧凑文本，保留实际状态、进度、已知路径/资源 URI、必要期限、已提交文件的大小/SHA-256/Revision 及安全诊断。总量未知不推算百分比，100% 不等于成功；只有 succeeded 确认传输成功，下载成功不表示用户保存。preparing/pending/transferring/cancelling 未结束时按同一 transferId 继续观察；failed/cancelled/expired/interrupted 是终态，核对真实结果及文件证据后决定后续操作，不盲目重建。不返回传输凭据，不读取文件正文，不重新签发 URL 或创建传输。",
  "scriptWhenUse": "已知 transferId 时查询详情、等待或诊断；未知 ID 用 nexum/transfer.list.js，取消用 nexum/transfer.cancel.js。",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "transferId": {
        "type": "string",
        "pattern": "^tr_[0-9a-f]{32}$"
      },
      "waitMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 30000
      }
    },
    "required": [
      "transferId"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "单个传输的紧凑 Markdown 状态报告，保留完整 transferId、真实状态、可用进度、目标、完成证据、时间及安全诊断；不返回传输通道凭据或文件正文。"
  }
}
*/
const { transferId, ...options } = context.input;
const item = await transfer.get(transferId, options);

// Render the persisted snapshot, not a new transfer or a live file read.
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
  return i === 0 ? bytes + " B" : String(Number(n.toFixed(2))) + " " + units[i] + " (" + bytes + " B)";
}
function progress({ bytesTransferred, totalBytes }) {
  const transferred = size(bytesTransferred);
  if (totalBytes === null) return transferred + " transferred (total unknown)";
  const amount = transferred + " / " + size(totalBytes);
  if (bytesTransferred > totalBytes) return amount + " (exceeds reported total)";
  if (totalBytes === 0) return amount;
  const percent = bytesTransferred === totalBytes ? 100 : Math.min(99, Math.floor(bytesTransferred / totalBytes * 100));
  return amount + " (" + percent + "%)";
}

const lines = [
  "Transfer: " + label(item.transferId),
  "Direction: " + label(item.direction) + " · Status: " + label(item.status),
  "Progress: " + progress(item.progress),
];
function field(key, value) {
  if (typeof value === "string" && value) lines.push(key + ": " + label(value));
}
if (item.direction === "upload") {
  field("Target", item.path);
  if (item.file) {
    lines.push("", "## Recorded committed file");
    field("Path", item.file.path);
    field("File", item.file.name);
    lines.push("Size: " + size(item.file.size));
    field("MIME", item.file.mimeType);
    field("SHA-256", item.file.sha256);
    field("Revision", item.file.revision);
  }
} else if (item.direction === "download" && item.resource) {
  lines.push("", "## Fixed resource");
  field("File", item.resource.name);
  field("Resource", item.resource.uri);
  field("MIME", item.resource.mimeType);
  lines.push("Size: " + (item.resource.size === null ? "unknown" : size(item.resource.size)));
}
lines.push("");
field("Run", item.runId);
field("Created", item.createdAt);
field("Started", item.startedAt);
if (item.status === "pending" || item.status === "expired") field("Claim deadline", item.expiresAt);
field("Transfer deadline", item.deadlineAt);
field("Finished", item.finishedAt);
if (item.maxBytes !== null) lines.push("Byte limit: " + size(item.maxBytes));

// Persisted failures normally contain fixed safe operation messages. Do not
// copy arbitrary legacy messages or details (paths, tokens, stacks, etc.).
const safeMessages = new Set([
  "The transfer did not complete.",
  "The transfer stopped before successful completion.",
  "The previous Agent boot ended; no live stream controller was restored.",
]);
if (item.error !== null) {
  lines.push("", "## Diagnostic");
  const code = item.error?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]{0,255}$/.test(code)) field("Error", code);
  else lines.push("Error: retained diagnostic unavailable.");
  if (safeMessages.has(item.error?.message)) field("Message", item.error.message);
  const guidance = {
    checksum_mismatch: "Verify the original source bytes and expected SHA-256.",
    transfer_size_mismatch: "Verify the expected and actual file size.",
    stream_size_mismatch: "Verify the expected and actual byte count.",
    path_already_exists: "Inspect the original destination; use an authorized unused path if a new upload is needed.",
    transfer_persistence_failed: "The persisted outcome may be incomplete. Inspect the original transfer and destination before any new operation.",
    transfer_cleanup_unconfirmed: "Cleanup is not confirmed. Inspect the original transfer before any new operation.",
  };
  if (Object.hasOwn(guidance, code)) lines.push(guidance[code]);
}
lines.push("");
switch (item.status) {
  case "preparing":
    lines.push("Transfer is preparing.");
    break;
  case "pending":
    lines.push("Waiting for the original transfer channel to be claimed.");
    break;
  case "transferring":
    lines.push("Transfer still active; byte progress is not completion evidence.");
    break;
  case "cancelling":
    lines.push("Cancellation in progress; transfer closure is not confirmed.");
    break;
  case "succeeded":
    if (item.direction === "upload") {
      lines.push("Upload succeeded. " + (item.file ? "Recorded file commit confirmed; current file contents have not been re-read." : "Committed file metadata unavailable."));
    } else {
      lines.push("Download succeeded. User-side saving is not confirmed.");
    }
    break;
  case "failed":
    lines.push("Transfer failed. Inspect the original outcome before creating another transfer.");
    break;
  case "cancelled":
    lines.push("Transfer cancelled.");
    break;
  case "expired":
    lines.push("The original transfer offer expired; this query does not renew it.");
    break;
  case "interrupted":
    lines.push("Transfer interrupted; no automatic resume. Inspect the original outcome before creating another transfer.");
    break;
  default:
    lines.push("Transfer state is not recognized; do not infer completion.");
}
if (["preparing", "pending", "transferring", "cancelling"].includes(item.status)) {
  lines.push("Query the same transferId to continue observing.");
}
return lines.join("\n");
