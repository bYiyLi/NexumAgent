import { activeRunStatuses, type ActivityDetail, type ActivityResource, type ActivityRun, type ActivityStatus, type ActivityText } from "./agent-activity";

export type ActivityScope = { targetId: string; operationId: string; agentId: string; bootId: string };
export type ActivityRequest = { action: "list"; cursor: string } | { action: "detail"; runId: string } |
  { action: "part"; runId: string; kind: "code" | "input" | "logs"; offset: number };
export type ActivityPage = { runs: ActivityRun[]; nextCursor: string | null; partial: boolean };
export type ActivityPart = { kind: "code" | "input" | "logs"; offset: number; nextOffset: number; size: number; complete: boolean; text: string };
export type ActivityObservation = { run: ActivityRun; detail: ActivityDetail };
export type ReadActivity = (request: ActivityRequest) => Promise<ActivityPage | ActivityObservation | ActivityPart>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid activity response");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 1024): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}
function optionalString(value: unknown, max = 1024) {
  if (value === null || value === undefined || value === "") return undefined;
  if (!string(value, max)) throw new Error("invalid activity text");
  return value;
}
const runID = /^run_[0-9a-f]{32}$/;
const statuses = new Set<ActivityStatus>(["accepted", "preparing_inputs", "running", "waiting_input", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]);
function run(value: unknown): { run: ActivityRun; availability: Record<string, boolean>; errorMessage?: string } {
  const data = record(value);
  const availability = record(data.availability);
  if (!string(data.runId, 36) || !runID.test(data.runId) || !string(data.title, 1024) ||
      typeof data.status !== "string" || !statuses.has(data.status as ActivityStatus) ||
      !["inline", "named", "history"].includes(String(data.source)) || !string(data.acceptedAt, 64) || !Number.isFinite(Date.parse(data.acceptedAt)) ||
      ["code", "input", "logs", "result"].some(key => typeof availability[key] !== "boolean")) throw new Error("invalid Run");
  const started = optionalString(data.startedAt, 64);
  const finished = optionalString(data.finishedAt, 64);
  if ((started && !Number.isFinite(Date.parse(started))) || (finished && !Number.isFinite(Date.parse(finished)))) throw new Error("invalid Run time");
  const failure = data.error === null || data.error === undefined ? undefined : record(data.error);
  const errorMessage = failure ? optionalString(failure.message, 8192) : undefined;
  return { run: { id: data.runId, title: data.title || data.runId, status: data.status as ActivityStatus, acceptedAt: data.acceptedAt,
    startedAt: started, finishedAt: finished, project: optionalString(data.projectId, 256), scriptName: optionalString(data.scriptName),
    source: data.source === "inline" ? "inline" : data.source === "named" ? "script" : undefined },
    availability: availability as Record<string, boolean>, errorMessage };
}
function payload(value: unknown, scope: ActivityScope): Record<string, unknown> {
  const envelope = record(value);
  if (envelope.protocol !== 1 || !["development", "production"].includes(String(envelope.profile)) ||
      Object.entries(scope).some(([key, expected]) => !string(expected, 256) || !expected || envelope[key] !== expected)) throw new Error("stale activity scope");
  return record(envelope.activity);
}
function text(available: boolean): ActivityText { return { state: available ? "loading" : "unavailable" }; }

export function parseActivity(value: unknown, scope: ActivityScope, request: ActivityRequest): ActivityPage | ActivityObservation | ActivityPart {
  const body = payload(value, scope);
  if (request.action === "list") {
    const page = record(body.list);
    if (!Array.isArray(page.runs) || page.runs.length > 25 || typeof page.partial !== "boolean" ||
        (page.nextCursor !== null && (!string(page.nextCursor, 512) || !page.nextCursor))) throw new Error("invalid activity page");
    const observedAt = optionalString(page.observedAt, 64);
    if (!observedAt || !Number.isFinite(Date.parse(observedAt))) throw new Error("invalid observation time");
    const runs = page.runs.map(value => ({ ...run(value).run, observedAt }));
    if (new Set(runs.map(item => item.id)).size !== runs.length) throw new Error("duplicate Run");
    return { runs, nextCursor: page.nextCursor as string | null, partial: page.partial };
  }
  if (request.action === "part") {
    const p = record(body.part);
    if (p.kind !== request.kind || !Number.isSafeInteger(p.offset) || !Number.isSafeInteger(p.nextOffset) || !Number.isSafeInteger(p.size) ||
        Number(p.offset) < request.offset || Number(p.nextOffset) < Number(p.offset) || Number(p.size) < Number(p.nextOffset) ||
        typeof p.complete !== "boolean" || p.complete !== (Number(p.nextOffset) >= Number(p.size)) || !string(p.text, 16384) || (p.text === "" && !p.complete)) {
      throw new Error("invalid retained page");
    }
    return { kind: request.kind, offset: Number(p.offset), nextOffset: Number(p.nextOffset), size: Number(p.size), complete: p.complete, text: p.text };
  }
  const data = record(body.detail);
  const parsed = run(data.run);
  const observedAt = optionalString(data.observedAt, 64);
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) throw new Error("invalid observation time");
  parsed.run.observedAt = observedAt;
  if (parsed.run.id !== request.runId) throw new Error("mismatched Run");
  const savedResources = record(data.resources);
  if (!Array.isArray(savedResources.items) || savedResources.items.length > 64 || typeof savedResources.complete !== "boolean") throw new Error("invalid resources");
  const resources: ActivityResource[] = savedResources.items.map(value => {
    const item = record(value);
    if (!string(item.resourceId, 256) || !item.resourceId || !string(item.kind, 256) || !string(item.status, 256)) throw new Error("invalid resource");
    return { id: item.resourceId, name: item.resourceId, kind: item.kind, status: item.status };
  });
  const result = data.result === null || data.result === undefined ? undefined : record(data.result);
  const addArtifact = (item: Record<string, unknown>) => {
    if (string(item.uri, 8192) && string(item.name, 1024) && item.uri && item.name && !resources.some(resource => resource.id === item.uri)) {
      resources.push({ id: item.uri, name: item.name, kind: string(item.mimeType, 256) ? item.mimeType : undefined });
    }
  };
  if (result && Array.isArray(result.resources)) for (const value of result.resources) {
    addArtifact(record(value));
  }
  if (result && Array.isArray(result.content)) for (const value of result.content) {
    const item = record(value);
    if (item.type === "resource_link") addArtifact(item);
    else if (item.resource && typeof item.resource === "object" && !Array.isArray(item.resource)) addArtifact(record(item.resource));
  }
  const resultComplete = result && result.delivery ? record(result.delivery).complete !== false : true;
  const resultText: ActivityText = result ? { state: "available", text: JSON.stringify(result, null, 2), complete: Boolean(resultComplete && !data.unavailable) }
    : { state: activeRunStatuses.has(parsed.run.status) && !parsed.availability.result ? "pending" : "unavailable" };
  const wait = data.wait === null || data.wait === undefined ? undefined : record(data.wait);
  const waitRequest = wait ? record(wait.request) : undefined;
  const waitMessage = waitRequest ? optionalString(waitRequest.message, 8192) : undefined;
  const waitAt = wait ? optionalString(wait.createdAt, 64) : undefined;
  return { run: parsed.run, detail: { code: text(parsed.availability.code!), input: text(parsed.availability.input!), logs: text(parsed.availability.logs!),
    result: resultText, resources: { state: "available", items: resources, complete: savedResources.complete && !(parsed.availability.result && !result) && Boolean(resultComplete) },
    errorMessage: parsed.errorMessage, waitMessage, waitAt } };
}
