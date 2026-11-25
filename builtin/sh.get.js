/**
{
  "scriptName": "sh.get.js",
  "scriptDesc": "读取原受管进程状态和增量输出。输入 {processId,cursor?,maxBytes?,waitMs?,encoding?}，processId 用原 res_ ID；maxBytes 1–1048576，waitMs 0–30000 毫秒，encoding 默认 auto，也可指定编码或 null（原始字节）。返回紧凑状态及顺序日志；原始字节附原生 File 和段范围。按 Next cursor 使用同一 ID、编码续读；改编码时省略 cursor 从保留日志起点重读。",
  "scriptWhenUse": "观察已有进程或等待输出；普通 Run 满载时仍可使用，不重建进程。",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1048576
      },
      "waitMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 30000
      },
      "encoding": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "auto",
              "utf8",
              "utf-8",
              "cp65001",
              "utf16le",
              "utf-16le",
              "ucs2",
              "ucs-2",
              "cp1200",
              "utf16be",
              "utf-16be",
              "cp1201",
              "latin1",
              "binary",
              "ascii",
              "base64",
              "base64url",
              "hex",
              "gbk",
              "gb2312",
              "cp936",
              "gb18030",
              "cp54936",
              "shift_jis",
              "shift-jis",
              "sjis",
              "windows-31j",
              "cp932",
              "big5",
              "cp950",
              "euc-kr",
              "cp949",
              "windows-874",
              "cp874",
              "ibm866",
              "cp866",
              "cp437",
              "cp850",
              "cp852",
              "cp855",
              "cp857",
              "cp858",
              "cp860",
              "cp861",
              "cp862",
              "cp863",
              "cp864",
              "cp865",
              "cp869",
              "windows-1250",
              "cp1250",
              "windows-1251",
              "cp1251",
              "windows-1252",
              "cp1252",
              "windows-1253",
              "cp1253",
              "windows-1254",
              "cp1254",
              "windows-1255",
              "cp1255",
              "windows-1256",
              "cp1256",
              "windows-1257",
              "cp1257",
              "windows-1258",
              "cp1258"
            ]
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "processId"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "anyOf": [
      {
        "type": "string",
        "description": "状态、顺序日志与续读游标的 Markdown 文本。"
      },
      {
        "type": "array",
        "items": [
          {
            "type": "string",
            "description": "同一 Markdown 报告，标明文件中各原始字节段的流、偏移和长度。"
          },
          {
            "type": "object",
            "description": "原生 File，按输出顺序连接本页原始字节段，非 JSON 字节数组。"
          }
        ],
        "minItems": 2,
        "maxItems": 2,
        "additionalItems": false
      }
    ],
    "description": "文本页返回字符串；含原生字节的页返回 [报告, File]。"
  }
}
*/
const page = await sh.get(context.input);

// Render only the current authoritative SDK page. Never re-decode bytes,
// restart a process, poll repeatedly, or introduce a second output limit.
const label = value => /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)
  ? JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
  : value;
const closed = page.status === "closed" && page.closedAt !== null && page.state !== "unavailable";
const facts = [label(page.state)];
if (page.status !== page.state && page.status !== "registered") facts.push("status: " + label(page.status));
facts.push(label(page.lifetime));
if (!closed && page.status !== "unavailable" && page.pid !== null) facts.push("PID " + page.pid);
if (page.exitCode !== null) facts.push("exit code " + page.exitCode);
if (page.signal !== null) facts.push("signal " + label(page.signal));
facts.push(page.controlAvailable ? "control available" : "control unavailable");
const sections = ["Process: " + label(page.processId) + "\n" + facts.join(" · ")];
const details = page.details;
const location = [];
if (typeof details.executable === "string" && details.executable) location.push("Executable: " + label(details.executable));
if (typeof details.cwd === "string" && details.cwd) location.push("cwd: " + label(details.cwd));
if (page.originRunId !== null) location.push("Run: " + label(page.originRunId));
if (typeof details.failure?.code === "string" && details.failure.code) location.push("Error: " + label(details.failure.code));
if (location.length) sections.push(location.join(" · "));
const raw = [];
const filename = page.processId + "-output.bin";
let rawBytes = 0;

// Merge only adjacent text blocks from the same stream. Preserve the exact
// text (including split lines, carriage returns and trailing whitespace).
// A longer code fence prevents log content from closing its own block.
function fenced(text) {
  let width = 3;
  for (const match of text.matchAll(/~+/g)) width = Math.max(width, match[0].length + 1);
  const fence = "~".repeat(width);
  return fence + "\n" + text + "\n" + fence;
}
let stream = null;
let pending = [];
function flush() {
  if (pending.length) sections.push("### " + stream + "\n\n" + fenced(pending.join("")));
  stream = null;
  pending = [];
}
for (const block of page.output) {
  if (typeof block.data === "string") {
    if (stream !== block.stream) flush();
    stream = block.stream;
    pending.push(block.data);
  } else {
    flush();
    const size = block.data.byteLength;
    if (size) {
      raw.push(block.data);
      sections.push("### " + block.stream + "\n\nRaw bytes: " + filename +
        " (offset " + rawBytes + ", length " + size + " bytes).");
      rawBytes += size;
    }
  }
}
flush();
if (!page.output.length) sections.push("No output on this read.");
const footer = [
  closed ? "Process closed." : "Process closure not confirmed.",
  page.outputComplete ? "Output capture complete." : "Output capture not complete.",
  page.hasMoreOutput ? "More retained output available." : "No more retained output at this read.",
];
if (page.truncated) footer.push("Earlier output was truncated by retention; the full original output is unavailable.");
if (details.outputEncodingUncertain === true) footer.push("Some output could not be decoded. Use the confirmed encoding or encoding:null without a cursor to re-read the retained output.");
if (page.nextCursor !== null) {
  footer.push("Next cursor: " + JSON.stringify(page.nextCursor));
  if (page.hasMoreOutput || (!closed && page.controlAvailable)) {
    footer.push("Continue with the same processId and encoding; pass the cursor.");
  }
} else if (!closed && page.controlAvailable) {
  footer.push("Output cursor not ready; query the same processId again.");
}
sections.push(footer.join("\n"));
const report = sections.join("\n\n");
if (!raw.length) return report;
const { File } = await import("node:buffer");
return [report, new File(raw, filename, { type: "application/octet-stream" })];
