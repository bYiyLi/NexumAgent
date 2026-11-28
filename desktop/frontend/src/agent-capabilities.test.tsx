import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentWorkspaceView } from "./components/AgentWorkspaceView";
import { messages } from "./i18n";
import { mergeCapabilityInventory, projectAgentCapabilities, type AgentCapabilitiesInventory, type CapabilityObservation } from "./agent-capabilities";
import type { AgentTarget } from "./agent-targets";

const current: AgentTarget = { id: "local", kind: "local", name: "Local", description: "Test Mac" };
const noop = () => undefined;
const summary = {
  name: "Actual Agent", platform: "macOS", arch: "ARM64", version: "1.2.3",
  runtime: "healthy" as const, management: "connected" as const, cloud: "offline" as const,
};

function view(locale: "zh-CN" | "en-US", options: { live?: boolean; capabilities?: AgentCapabilitiesInventory } = {}) {
  const t = messages(locale);
  return renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac onEndPreview={noop} onOpenMarketplace={noop}
    initialSection="capabilities" {...(options.live ? { liveSummary: summary } : {})}
    capabilities={options.capabilities}/>);
}

describe("Agent capability inventory UI", () => {
  it("keeps order and removes only entries absent from a complete observation", () => {
    const inventory: AgentCapabilitiesInventory = { state: "available", items: [
      { id: "a", name: "API", kind: "api" }, { id: "m", name: "MCP", kind: "mcp" },
    ] };
    const observation: CapabilityObservation = { state: "available", items: [
      { id: "m", name: "MCP", kind: "mcp", revision: "a".repeat(64) }, { id: "n", name: "npm", kind: "npm" },
    ], alerts: [] };
    expect(mergeCapabilityInventory(inventory, observation).items.map(item => item.id)).toEqual(["m", "n"]);
    const partial = mergeCapabilityInventory(inventory, { ...observation, state: "partial" });
    expect(partial.state).toBe("partial");
    expect(partial.items.map(item => item.id)).toEqual(["a", "m", "n"]);
    expect(mergeCapabilityInventory(inventory, { state: "unavailable", items: [], alerts: [] }).items).toEqual(inventory.items);
  });
  it("projects only current MCP, OpenAPI and installed npm resources into one mixed list", () => {
    expect(projectAgentCapabilities([
      { id: "m1", name: "GitHub", type: "mcp", description: "Remote tools" },
      { id: "a1", name: "CRM", type: "openapi" },
      { id: "n1", name: "@acme/lib", type: "npm" },
      { id: "s1", name: "Research", type: "skill" },
      { id: "r1", name: "script.run", type: "script" },
      { id: "i1", name: "AGENTS.md", type: "instruction" },
      { id: "bad", name: "Unknown", type: "future-kind" },
      { id: "", name: "Missing identity", type: "mcp" },
    ])).toEqual([
      { id: "m1", name: "GitHub", kind: "mcp", description: "Remote tools" },
      { id: "a1", name: "CRM", kind: "api" },
      { id: "n1", name: "@acme/lib", kind: "npm" },
    ]);
  });

  it("renders the agreed flat, mixed preview list in both locales", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const html = view(locale);
      for (const name of ["GitHub", "CRM API", "@nexum-hub/browser", "Filesystem", "@acme/data-utils"]) {
        expect(html).toContain(name);
      }
      expect(html).toContain('data-capability-kind="mcp"');
      expect(html).toContain('data-capability-kind="api"');
      expect(html).toContain('data-capability-kind="npm"');
      expect(html).toContain(t.remoteUiPreview);
      for (const description of [t.agentCapabilityExampleAPI, t.agentCapabilityExampleSDK, t.agentCapabilityExampleNpm]) expect(html).toContain(description);
      expect(html).toContain(t.agentWorkspaceBack);
      expect(html).toContain(`aria-label="${t.agentCapabilitiesAdd}"`);
      expect(html).not.toContain('aria-haspopup="menu"');
      expect(html).not.toContain(t.agentWorkspaceCapabilities);
      expect(html).not.toContain(t.agentWorkspaceCapabilitiesDetail);
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<hr");
      expect(html).not.toContain('role="separator"');
    }
  });

  it("does not substitute preview fixtures for a real Agent without an inventory", () => {
    const html = view("zh-CN", { live: true });
    expect(html).toContain(messages("zh-CN").agentCapabilitiesUnavailable);
    expect(html).not.toContain("GitHub");
    expect(html).not.toContain("@nexum-hub/browser");
    expect(html).not.toContain(messages("zh-CN").remoteUiPreview);
  });

  it("renders a supplied partial live inventory without inventing missing entries", () => {
    const capabilities: AgentCapabilitiesInventory = {
      state: "partial",
      items: [{ id: "m1", name: "GitHub", kind: "mcp" }],
    };
    const html = view("en-US", { live: true, capabilities });
    expect(html).toContain("GitHub");
    expect(html).toContain(messages("en-US").agentCapabilitiesPartial);
    expect(html).not.toContain("CRM API");
  });

  it("distinguishes a confirmed empty inventory from unavailable data", () => {
    const empty: AgentCapabilitiesInventory = { state: "available", items: [] };
    expect(view("zh-CN", { live: true, capabilities: empty })).toContain(messages("zh-CN").agentCapabilitiesEmpty);
    expect(view("zh-CN", { live: true })).toContain(messages("zh-CN").agentCapabilitiesUnavailable);
  });

  it("never labels an incomplete empty snapshot as a confirmed empty inventory", () => {
    const partial: AgentCapabilitiesInventory = { state: "partial", items: [] };
    const html = view("zh-CN", { live: true, capabilities: partial });
    expect(html).toContain(messages("zh-CN").agentCapabilitiesPartial);
    expect(html).not.toContain(messages("zh-CN").agentCapabilitiesEmpty);
  });

  it("places the highest confirmed capability alert on the workspace card", () => {
    const status: CapabilityObservation = { state: "partial", items: [{ id: "m1", name: "GitHub", kind: "mcp" }], severity: "problem", alerts: [
      { id: "m1", level: "problem", reason: "mcp_disconnected", observedAt: "2026-11-27T01:02:03Z" },
    ] };
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const html = renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac onEndPreview={noop} onOpenMarketplace={noop}
        liveSummary={summary} capabilityObservation={status}/>);
      expect(html).toContain(`${t.agentWorkspaceCapabilities} · ${t.agentCapabilitiesProblem}`);
      expect(html).toContain('data-notice="danger"');
      const list = renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac onEndPreview={noop} onOpenMarketplace={noop}
        liveSummary={summary} initialSection="capabilities" capabilities={{ state:"partial", items:status.items }} capabilityObservation={status}/>);
      expect(list).toContain(t.agentCapabilityDisconnected);
    }
  });

  it("retains both a disconnection and an awaiting-approval notice on one capability", () => {
    const status: CapabilityObservation = { state: "partial", items: [{ id: "m1", name: "GitHub", kind: "mcp" }], severity: "problem", alerts: [
      { id: "m1", level: "problem", reason: "mcp_disconnected", observedAt: "2026-11-27T01:02:03Z" },
      { id: "m1", level: "advice", reason: "configuration_pending_approval", observedAt: "2026-11-27T01:02:03Z" },
    ] };
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const html = renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac onEndPreview={noop} onOpenMarketplace={noop}
        liveSummary={summary} initialSection="capabilities" capabilities={{ state: "partial", items: status.items }} capabilityObservation={status}/>);
      expect(html).toContain(t.agentCapabilityDisconnected);
      expect(html).toContain(t.agentCapabilityConfigurationPending);
    }
  });

  it("shows direct maintenance actions and their actual progress", () => {
    const items = [
      { id: "m", name: "GitHub", kind: "mcp" as const, revision: "a".repeat(64) },
      { id: "n", name: "@test/package", kind: "npm" as const, revision: "b".repeat(64) },
    ];
    const status: CapabilityObservation = { state: "available", items, severity: "advice", alerts: [
      { id: "n", level: "advice", reason: "npm_update_available", version: "2.0.0", observedAt: "2026-11-27T01:02:03Z" },
    ], operations: [{ id: "m", name: "GitHub", action: "remove", status: "executing" }] };
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const html = renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac onEndPreview={noop} onOpenMarketplace={noop}
        liveSummary={summary} initialSection="capabilities" capabilities={{ state: "available", items }} capabilityObservation={status}
        maintainCapability={async () => {}} reconnectCapability={async () => "succeeded"}/>);
      expect(html).toContain(t.agentCapabilityExecuting);
      expect(html).toContain(`aria-label="${t.agentCapabilityUpdate} @test/package"`);
      expect(html).toContain(`aria-label="${t.agentCapabilityUninstall} @test/package"`);
      expect(html).not.toContain(t.agentCapabilityRemoveUnavailable);
    }
  });
});
