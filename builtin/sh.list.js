/**
{
  "scriptName": "sh.list.js",
  "scriptDesc": "查询授权范围内受管进程。输入 {status?,state?,runId?,contextId?,limit?,cursor?}（可用 {}），limit 1–100。返回按活跃、已结束、不可用或关闭未确认分组的文本，含完整 processId 和控制状态。按 Next cursor 保持筛选续页；详情用 nexum/sh.get.js。",
  "scriptWhenUse": "定位原进程；普通 Run 满载时仍可使用。",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "status": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1024
      },
      "state": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1024
      },
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1024
      },
      "contextId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1024
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
    "description": "紧凑 Markdown 进程列表；显示实际状态、完整 processId、可用控制及必要退出信息，按实际页返回 Next cursor（若有）。"
  }
}
*/
const page = await sh.list(context.input);

// Keep the authoritative SDK's page and cursor; no additional traversal,
// filtering, state transitions, or script-specific delivery limit.
const groups = [
  { title: "Active / closing", items: [] },
  { title: "Finished", items: [] },
  { title: "Unavailable / unconfirmed", items: [] },
];
const label = value => /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)
  ? JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
  : value;

for (const item of page.items) {
  const unavailable = item.status === "unavailable" || item.state === "unavailable";
  const finished = !unavailable && item.status === "closed" && item.closedAt !== null;
  const active = !unavailable && item.closedAt === null &&
    (item.status === "registered" || item.status === "stopping") &&
    ["registered", "preparing", "running", "finishing", "stopping"].includes(item.state);
  const group = finished ? groups[1] : active ? groups[0] : groups[2];
  const facts = [label(item.state)];
  if (item.status !== item.state && item.status !== "registered") facts.push("status: " + label(item.status));
  facts.push(label(item.lifetime));
  if (item.pid !== null && !finished && !unavailable) facts.push("PID " + item.pid);
  if (item.exitCode !== null) facts.push("exit code " + item.exitCode);
  if (item.signal !== null) facts.push("signal " + label(item.signal));
  facts.push(item.controlAvailable ? "control available" : "control unavailable");
  if (finished) facts.push(item.outputComplete ? "output complete" : "output incomplete");
  if (!active && !finished) facts.push("closure unconfirmed");
  group.items.push("    " + label(item.processId) + " · " + facts.join(" · "));

  const details = item.details;
  const context = [];
  if (typeof details.executable === "string" && details.executable) context.push("Executable: " + label(details.executable));
  if (typeof details.cwd === "string" && details.cwd) context.push("cwd: " + label(details.cwd));
  if (item.originRunId !== null) context.push("Run: " + label(item.originRunId));
  if (typeof details.failure?.code === "string" && details.failure.code) context.push("Error: " + label(details.failure.code));
  if (context.length) group.items.push("      " + context.join(" · "));
}
const sections = groups.filter(group => group.items.length).map(group => "## " + group.title + "\n\n" + group.items.join("\n"));
const footer = page.items.length ? page.items.length + " processes returned." : "No processes on this page.";
sections.push(footer + (page.nextCursor !== null ? "\nNext cursor: " + JSON.stringify(page.nextCursor) + "\nContinue with the same filters and cursor." : ""));
return sections.join("\n\n");
