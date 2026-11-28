import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentWorkspaceView } from "./components/AgentWorkspaceView";
import type { AgentActivityInventory } from "./agent-activity";
import type { AgentTarget } from "./agent-targets";
import { messages } from "./i18n";

const current: AgentTarget = { id: "local", kind: "local", name: "Local", description: "Test Mac" };
const liveSummary = { name: "Real Agent", platform: "macOS", arch: "ARM64", version: "1.2.3", runtime: "healthy" as const, management: "connected" as const, cloud: "online" as const };
const noop = () => undefined;
function view(locale: "zh-CN" | "en-US", options: { live?: boolean; activity?: AgentActivityInventory } = {}) {
  return renderToStaticMarkup(<AgentWorkspaceView t={messages(locale)} current={current} isMac onEndPreview={noop} onOpenMarketplace={noop}
    initialSection="activity" {...(options.live ? { liveSummary } : {})} activity={options.activity}/>);
}

describe("Agent run activity", () => {
  it("shows one untitled list with the actual status names in the explicit preview", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const html = view(locale);
      expect(html).toContain(t.remoteUiPreview);
      expect(html).not.toMatch(/<h[12]\b/);
      expect(html.match(/<ul\b/g)).toHaveLength(1);
      expect(html.indexOf(t.agentActivityExampleExport)).toBeLessThan(html.indexOf(t.agentActivityExampleIndex));
      expect(html.indexOf(t.agentActivityExampleIndex)).toBeLessThan(html.indexOf(t.agentActivityExampleDigest));
      for (const label of [t.agentActivityWaiting, t.agentActivityRunning, t.agentActivitySucceeded, t.agentActivityFailed, t.agentActivityCancelled, t.agentActivityInterrupted]) expect(html).toContain(label);
    }
  });

  it("never presents preview examples as real history", () => {
    const html = view("zh-CN", { live: true });
    expect(html).toContain(messages("zh-CN").agentActivityUnavailable);
    expect(html).not.toContain(messages("zh-CN").agentActivityExampleExport);
    expect(html).not.toContain(messages("zh-CN").remoteUiPreview);
  });

  it("keeps an incomplete list distinct from a confirmed empty history", () => {
    const t = messages("en-US");
    const incomplete = view("en-US", { live: true, activity: { state: "partial", items: [] } });
    expect(incomplete).toContain(t.agentActivityIncomplete);
    expect(incomplete).not.toContain(t.agentActivityEmpty);
    expect(view("en-US", { live: true, activity: { state: "available", items: [] } })).toContain(t.agentActivityEmpty);
  });

  it("renders only supplied runs when an inventory is provided", () => {
    const activity: AgentActivityInventory = { state: "partial", items: [
      { id: "run_actual", title: "A retained run", status: "preparing_inputs", acceptedAt: "2026-11-27T12:00:00Z" },
    ] };
    const html = view("en-US", { live: true, activity });
    expect(html).toContain("A retained run");
    expect(html).toContain(messages("en-US").agentActivityPreparing);
    expect(html).toContain(messages("en-US").agentActivityIncomplete);
    expect(html).not.toContain(messages("en-US").agentActivityExampleExport);
  });
});
