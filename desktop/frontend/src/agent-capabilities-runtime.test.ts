import { describe, expect, it } from "vitest";
import { parseAgentCapabilities, parseCapabilityObservation, type CapabilityScope } from "./agent-capabilities-runtime";

const scope: CapabilityScope = { targetId: "local", operationId: "operation", agentId: "agent", bootId: "boot" };
const snapshot = () => ({ protocol: 1, profile: "development", ...scope, state: "available", items: [
  { id: "m", name: "GitHub", type: "mcp" }, { id: "a", name: "CRM", type: "openapi" }, { id: "n", name: "@acme/installed", type: "npm" },
] });

describe("real Agent capability inventory", () => {
  it("projects the authenticated mixed list and preserves empty versus partial", () => {
    expect(parseAgentCapabilities(snapshot(), scope)).toEqual({ state: "available", items: [
      { id: "m", name: "GitHub", kind: "mcp" }, { id: "a", name: "CRM", kind: "api" }, { id: "n", name: "@acme/installed", kind: "npm" },
    ] });
    expect(parseAgentCapabilities({ ...snapshot(), items: [] }, scope)).toEqual({ state: "available", items: [] });
    expect(parseAgentCapabilities({ ...snapshot(), state: "partial", items: [] }, scope)).toEqual({ state: "partial", items: [] });
  });

  it("rejects other targets, operations, Agents, boots and invalid resources", () => {
    for (const key of ["targetId", "operationId", "agentId", "bootId"]) {
      expect(() => parseAgentCapabilities({ ...snapshot(), [key]: "stale" }, scope)).toThrow();
    }
    for (const patch of [
      { protocol: 2 }, { profile: "unknown" }, { state: "loading" }, { items: null },
      { items: [{ id: "s", name: "Skill", type: "skill" }] },
      { items: [snapshot().items[0], snapshot().items[0]] },
      { items: [{ id: "x", name: "\n", type: "mcp" }] },
      { items: Array.from({ length: 201 }, (_, id) => ({ id: String(id), name: "pkg", type: "npm" })) },
    ]) expect(() => parseAgentCapabilities({ ...snapshot(), ...patch }, scope)).toThrow();
  });

  it("binds alerts to observed capabilities and checks severity and session", () => {
    const value = { scope, state: "partial", facts: [{ id: "m", name: "GitHub", type: "mcp" }],
      alerts: [{ id: "m", level: "problem", reason: "mcp_disconnected", observedAt: "2026-11-27T01:02:03Z" }], severity: "problem" };
    expect(parseCapabilityObservation(value, scope)).toMatchObject({ severity: "problem", alerts: [{ id: "m" }] });
    expect(() => parseCapabilityObservation({ ...value, scope: { ...scope, bootId: "old" } }, scope)).toThrow();
    expect(() => parseCapabilityObservation({ ...value, severity: "advice" }, scope)).toThrow();
    expect(() => parseCapabilityObservation({ ...value, alerts: [{ ...value.alerts[0], id: "other" }] }, scope)).toThrow();
  });

  it("keeps an operation outcome after removal while rejecting invalid progress", () => {
    const value = { scope, state: "available", facts: [], alerts: [], operations: [
      { id: "gone", name: "GitHub", action: "remove", status: "succeeded" },
    ] };
    expect(parseCapabilityObservation(value, scope).operations?.[0]).toMatchObject({ id: "gone", status: "succeeded" });
    expect(() => parseCapabilityObservation({ ...value, operations: [{ ...value.operations[0], status: "imagined" }] }, scope)).toThrow();
    expect(() => parseCapabilityObservation({ ...value, operations: [{ ...value.operations[0], errorCode: "unsafe\ntext" }] }, scope)).toThrow();
    expect(() => parseCapabilityObservation({ ...value, operations: [value.operations[0], value.operations[0]] }, scope)).toThrow();
  });
});
