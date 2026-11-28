import { describe, expect, it } from "vitest";
import { parseActivity, type ActivityRequest, type ActivityScope } from "./agent-activity-runtime";

const scope: ActivityScope = { targetId: "local", operationId: "op", agentId: "agent", bootId: "boot" };
const id = "run_0123456789abcdef0123456789abcdef";
const run = { runId: id, title: "Actual run", status: "waiting_input", source: "named", projectId: "project_1", scriptName: "export.js",
  acceptedAt: "2026-11-27T12:00:00Z", startedAt: "2026-11-27T12:00:01Z", finishedAt: null, error: null,
  availability: { code: true, input: true, logs: true, result: false } };
function response(activity: unknown, override: Partial<ActivityScope> = {}) {
  return { protocol: 1, profile: "development", ...scope, ...override, activity };
}

describe("desktop Run activity observations", () => {
  it("accepts only the current Agent and retains pagination and partial state", () => {
    const request: ActivityRequest = { action: "list", cursor: "" };
    const page = { list: { runs: [run], partial: true, nextCursor: "next", observedAt: "2026-11-27T12:00:03Z" } };
    expect(parseActivity(response(page), scope, request)).toMatchObject({ runs: [{ id, title: "Actual run", status: "waiting_input" }], nextCursor: "next", partial: true });
    expect(() => parseActivity(response(page, { bootId: "old" }), scope, request)).toThrow();
    expect(() => parseActivity(response({ list: { runs: [run, run], partial: false, nextCursor: null, observedAt: "2026-11-27T12:00:03Z" } }), scope, request)).toThrow();
  });

  it("uses retained availability and keeps an unfinished result distinct from an empty result", () => {
    const request: ActivityRequest = { action: "detail", runId: id };
    const detail = { run, wait: { request: { message: "Choose a scope" }, createdAt: "2026-11-27T12:00:02Z" }, result: null,
      resources: { items: [], complete: true }, unavailable: null, observedAt: "2026-11-27T12:00:03Z" };
    expect(parseActivity(response({ detail }), scope, request)).toMatchObject({ run: { id }, detail: {
      code: { state: "loading" }, input: { state: "loading" }, logs: { state: "loading" }, result: { state: "pending" },
      waitMessage: "Choose a scope", resources: { state: "available", items: [], complete: true },
    } });
    expect(parseActivity(response({ detail: { ...detail, wait: { request: { message: "" }, createdAt: "2026-11-27T12:00:02Z" } } }), scope, request))
      .toMatchObject({ detail: { waitMessage: undefined } });
    expect(() => parseActivity(response({ detail: { ...detail, run: { ...run, runId: "run_ffffffffffffffffffffffffffffffff" } } }), scope, request)).toThrow();
  });

  it("validates original byte offsets instead of treating missing or clipped pages as complete", () => {
    const request: ActivityRequest = { action: "part", runId: id, kind: "code", offset: 0 };
    const part = { kind: "code", offset: 0, nextOffset: 9, size: 20, complete: false, text: "return 1;" };
    expect(parseActivity(response({ part }), scope, request)).toMatchObject(part);
    expect(() => parseActivity(response({ part: { ...part, kind: "logs" } }), scope, request)).toThrow();
    expect(() => parseActivity(response({ part: { ...part, nextOffset: -1 } }), scope, request)).toThrow();
    expect(() => parseActivity(response({ part: { ...part, complete: true } }), scope, request)).toThrow();
  });

  it("includes an artifact directly returned as result content", () => {
    const request: ActivityRequest = { action: "detail", runId: id };
    const detail = { run: { ...run, status: "succeeded", availability: { ...run.availability, result: true } }, wait: null,
      result: { content: [{ type: "resource_link", uri: "nexum://agents/a/resources/r", name: "report.txt", mimeType: "text/plain" }] },
      resources: { items: [], complete: true }, observedAt: "2026-11-27T12:00:03Z" };
    expect(parseActivity(response({ detail }), scope, request)).toMatchObject({ detail: { resources: { state: "available",
      items: [{ name: "report.txt", kind: "text/plain" }], complete: true } } });
  });
});
