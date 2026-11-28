import type { Messages } from "./i18n";

// These fields describe an observation of a Run. Text comes from the Run's
// retained snapshot, never from the current script file or a new execution.
export type ActivityStatus = "accepted" | "preparing_inputs" | "running" | "waiting_input" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type ActivityText = { state: "available"; text: string; complete: boolean } | { state: "unavailable" | "pending" | "loading" };
export type ActivityResource = { id: string; name: string; kind?: string; status?: string };
export type ActivityResources = { state: "available"; items: readonly ActivityResource[]; complete: boolean } | { state: "unavailable" };
export type ActivityDetail = {
  code: ActivityText;
  input: ActivityText;
  logs: ActivityText;
  result: ActivityText;
  resources: ActivityResources;
  waitMessage?: string;
  errorMessage?: string;
  waitAt?: string;
};
export type ActivityRun = {
  id: string;
  title: string;
  status: ActivityStatus;
  acceptedAt: string;
  startedAt?: string;
  finishedAt?: string;
  observedAt?: string;
  project?: string;
  scriptName?: string;
  source?: "inline" | "script";
  detail?: ActivityDetail;
};
export type AgentActivityInventory = {
  state: "loading" | "available" | "partial" | "unavailable";
  items: readonly ActivityRun[];
};

export const unavailableAgentActivity: AgentActivityInventory = { state: "unavailable", items: [] };
export const activeRunStatuses = new Set<ActivityStatus>(["accepted", "preparing_inputs", "running", "waiting_input", "cancelling"]);

// This fixture is used only in the explicitly selected Desktop development preview.
export function previewAgentActivity(t: Messages): AgentActivityInventory {
  const snapshot = (text: string): ActivityText => ({ state: "available", text, complete: true });
  return { state: "available", items: [
    { id: "run_demo_export", title: t.agentActivityExampleExport, status: "waiting_input", acceptedAt: "2026-11-27T13:47:08Z", startedAt: "2026-11-27T13:47:09Z", observedAt: "2026-11-27T13:48:27Z", project: t.agentActivityExampleProject, scriptName: "reports/export.js", detail: {
      waitMessage: t.agentActivityExampleWait, waitAt: "2026-11-27T13:47:32Z",
      code: snapshot('const { reportId, formats } = context.input;\n\nconst reply = await runtime.requestInput({\n  message: "请选择附件范围",\n});\n\nreturn { reportId, formats, scope: reply.input.scope };'),
      input: snapshot('{\n  "reportId": "MONTH-2026-11",\n  "formats": ["pdf", "csv"]\n}'),
      logs: snapshot("21:47:09  Reading the attachment list\n21:47:32  Waiting for input"),
      result: { state: "pending" }, resources: { state: "available", items: [], complete: true },
    } },
    { id: "run_demo_index", title: t.agentActivityExampleIndex, status: "running", acceptedAt: "2026-11-27T13:43:30Z", startedAt: "2026-11-27T13:43:31Z", observedAt: "2026-11-27T13:48:27Z", project: t.agentActivityExampleKnowledge, source: "inline", detail: {
      code: snapshot("const { collection, batchSize } = context.input;\nreturn { collection, batchSize };"),
      input: snapshot('{\n  "collection": "internal-docs",\n  "batchSize": 200\n}'),
      logs: snapshot("21:43:31  Synchronization started\n21:45:06  Processed 128 documents"),
      result: { state: "pending" }, resources: { state: "available", items: [], complete: true },
    } },
    { id: "run_demo_digest", title: t.agentActivityExampleDigest, status: "failed", acceptedAt: "2026-11-27T13:32:07Z", startedAt: "2026-11-27T13:32:08Z", finishedAt: "2026-11-27T13:32:20Z", project: t.agentActivityExampleKnowledge, scriptName: "reports/digest.js", detail: {
      errorMessage: t.agentActivityExampleFailure,
      code: snapshot('const response = await fetch("https://example.invalid/digest");\nreturn response.json();'),
      input: snapshot('{\n  "date": "2026-11-27"\n}'), logs: snapshot("21:32:08  Reading today's records\n21:32:20  HTTP 503"),
      result: { state: "unavailable" }, resources: { state: "available", items: [], complete: true },
    } },
    { id: "run_demo_crm", title: t.agentActivityExampleCRM, status: "succeeded", acceptedAt: "2026-11-27T13:18:00Z", startedAt: "2026-11-27T13:18:02Z", finishedAt: "2026-11-27T13:18:34Z", scriptName: "crm/sync.js", detail: {
      code: snapshot("const { records } = context.input;\nreturn { count: records.length };"),
      input: snapshot('{\n  "records": ["example"]\n}'), logs: snapshot("21:18:02  Synchronization started\n21:18:34  Synchronization completed"),
      result: snapshot('{\n  "count": 1\n}'), resources: { state: "available", items: [], complete: true },
    } },
    { id: "run_demo_cancelled", title: t.agentActivityExampleFolders, status: "cancelled", acceptedAt: "2026-11-27T12:54:02Z", startedAt: "2026-11-27T12:54:03Z", finishedAt: "2026-11-27T12:54:10Z", detail: {
      code: { state: "unavailable" }, input: { state: "unavailable" }, logs: { state: "unavailable" }, result: { state: "unavailable" }, resources: { state: "unavailable" },
    } },
    { id: "run_demo_interrupted", title: t.agentActivityExamplePreview, status: "interrupted", acceptedAt: "2026-11-27T12:39:11Z", startedAt: "2026-11-27T12:39:12Z", finishedAt: "2026-11-27T12:40:36Z", detail: {
      code: { state: "unavailable" }, input: { state: "unavailable" }, logs: { state: "unavailable" }, result: { state: "unavailable" }, resources: { state: "unavailable" },
    } },
  ] };
}
