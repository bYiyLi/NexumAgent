import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { previewAgentMaterials, type AgentMaterialsInventory } from "./agent-materials";
import { AgentMaterialDetail, PreviewMaterialRemoval } from "./components/AgentMaterialsView";
import { AgentWorkspaceView } from "./components/AgentWorkspaceView";
import { messages, type Locale } from "./i18n";
import type { AgentTarget } from "./agent-targets";

const current: AgentTarget = { id: "local", kind: "local", name: "Local", description: "Test Mac" };
const noop = () => undefined;
const summary = { name: "Actual Agent", platform: "macOS", arch: "ARM64", version: "1.2.3",
  runtime: "healthy" as const, management: "connected" as const, cloud: "online" as const };

function view(locale: Locale, options: { live?: boolean; materials?: AgentMaterialsInventory } = {}) {
  return renderToStaticMarkup(<AgentWorkspaceView t={messages(locale)} current={current} isMac onEndPreview={noop}
    onOpenMarketplace={noop} initialSection="materials" {...(options.live ? { liveSummary: summary } : {})} materials={options.materials}/>);
}

describe("Agent AI materials", () => {
  it("shows the most urgent notice and orders the real materials by urgency", () => {
    const t = messages("zh-CN");
    const materials: AgentMaterialsInventory = { state: "available", items: [
      { id: "normal", name: "Normal", kind: "instruction" },
      { id: "update", name: "Update", kind: "skill", notice: "update" },
      { id: "advice", name: "Advice", kind: "skill", notice: "advice" },
      { id: "danger", name: "Danger", kind: "script", notice: "danger", problem: "invalid_input_schema" },
    ] };
    const overview = renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac onEndPreview={noop}
      onOpenMarketplace={noop} liveSummary={summary} materials={materials}/>);
    expect(overview).toContain(`data-notice="danger"`);
    expect(overview).toContain(t.agentMaterialsDanger);
    const list = view("zh-CN", { live: true, materials });
    expect(list.indexOf("Danger")).toBeLessThan(list.indexOf("Advice"));
    expect(list.indexOf("Advice")).toBeLessThan(list.indexOf("Update"));
    expect(list.indexOf("Update")).toBeLessThan(list.indexOf("Normal"));
    const detail = renderToStaticMarkup(<AgentMaterialDetail t={t} item={materials.items[3]}/>);
    expect(detail).toContain(t.agentMaterialsInvalidScriptSchema);
    const unknownArchived = renderToStaticMarkup(<AgentMaterialDetail t={t}
      item={{ id: "archived", name: "Archived", kind: "skill", notice: "advice", updateCheck: "unknown" }}/>);
    expect(unknownArchived).toContain(t.agentMaterialsAdviceDescription);
    expect(unknownArchived).toContain(t.agentMaterialsUpdateUnknown);
  });

  it("shows advice before updates and counts updates when no higher notice exists", () => {
    const t = messages("zh-CN");
    const render = (items: AgentMaterialsInventory["items"]) => renderToStaticMarkup(
      <AgentWorkspaceView t={t} current={current} isMac onEndPreview={noop} onOpenMarketplace={noop}
        liveSummary={summary} materials={{ state: "available", items }}/>,
    );
    const updates: AgentMaterialsInventory["items"] = [
      { id: "first", name: "First", kind: "skill", notice: "update" },
      { id: "second", name: "Second", kind: "skill", notice: "update" },
    ];
    const advice = render([...updates, { id: "archived", name: "Archived", kind: "skill", notice: "advice" }]);
    expect(advice).toContain('data-notice="advice"');
    expect(advice).toContain(t.agentMaterialsAdvice);
    expect(advice).not.toContain('data-notice="update"');
    const onlyUpdates = render(updates);
    expect(onlyUpdates).toContain('data-notice="update"');
    expect(onlyUpdates).toContain(t.agentMaterialsUpdateCount.replace("{count}", "2"));
  });

  it("renders the approved mixed list with no extra heading or search in both languages", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const html = view(locale);
      const names = ["script-authoring", "image-report.js", "AGENTS.md", "page-audit", "nexum/file.list.js", "writing-assistant"];
      expect(names.map(name => html.indexOf(name))).toEqual([...names.map(name => html.indexOf(name))].sort((a, b) => a - b));
      for (const name of names) expect(html).toContain(name);
      for (const kind of ["skill", "script", "instruction"]) expect(html).toContain(`data-material-kind="${kind}"`);
      expect(html).toContain(t.remoteUiPreview);
      expect(html).toContain(t.agentWorkspaceBack);
      expect(html).toContain(`aria-label="${t.agentCapabilitiesAdd}"`);
      expect(html).not.toContain("<h1");
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<hr");
      expect(html).not.toContain('role="tab');
    }
  });

  it("keeps example data out of a real workspace and distinguishes incomplete states", () => {
    const t = messages("zh-CN");
    const unavailable = view("zh-CN", { live: true });
    expect(unavailable).toContain(t.agentMaterialsUnavailable);
    expect(unavailable).not.toContain("script-authoring");
    expect(unavailable).not.toContain(t.remoteUiPreview);
    expect(view("zh-CN", { live: true, materials: { state: "loading", items: [] } })).toContain(t.agentMaterialsLoading);
    expect(view("zh-CN", { live: true, materials: { state: "available", items: [] } })).toContain(t.agentMaterialsEmpty);
    const partial = view("zh-CN", { live: true, materials: { state: "partial", items: [] } });
    expect(partial).toContain(t.agentMaterialsPartial);
    expect(partial).not.toContain(t.agentMaterialsEmpty);
    const actual = view("zh-CN", { live: true, materials: { state: "partial", items: [{ id: "actual", name: "Actual", kind: "skill" }] } });
    expect(actual).toContain("Actual");
    expect(actual).toContain(t.agentMaterialsPartial);
    expect(actual).not.toContain("page-audit");
  });

  it("hides stale materials when the Agent loses its Cloud connection", () => {
    const t = messages("zh-CN");
    const html = renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac onEndPreview={noop}
      onOpenMarketplace={noop} initialSection="materials" liveSummary={{ ...summary, cloud: "offline" }}
      materials={{ state: "available", items: [{ id: "actual", name: "Local material", kind: "skill", notice: "danger" }] }}/>);
    expect(html).not.toContain("Local material");
    expect(html).toContain(t.agentMaterialsUnavailable);
  });

  it("renders read-only detail content appropriate to each example type", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const inventory = previewAgentMaterials(t);
      const render = (index: number) => renderToStaticMarkup(<AgentMaterialDetail t={t} item={inventory.items[index]}/>);
      const skill = render(0);
      expect(skill).toContain(t.agentMaterialsWhen);
      expect(skill).toContain(t.agentMaterialsFiles);
      expect(skill).toContain("SKILL.md");
      expect(skill).toContain("references/authoring.md");
      const script = render(1);
      expect(script).toContain(t.agentMaterialsInputs);
      expect(script).toContain(t.agentMaterialsRequired);
      expect(script).toContain(t.agentMaterialsOutput);
      expect(script).toContain(t.agentMaterialsSource);
      const instruction = render(2);
      expect(instruction).toContain(t.agentMaterialsScope);
      expect(instruction).toContain(t.agentMaterialsExampleInstruction1);
      expect(instruction).not.toContain("<textarea");
    }
  });

  it("reports missing or mismatched details instead of fabricating content", () => {
    const t = messages("en-US");
    const item = { id: "actual", name: "Actual", kind: "skill" as const };
    expect(renderToStaticMarkup(<AgentMaterialDetail t={t} item={item}/>)).toContain(t.agentMaterialsDetailsUnavailable);
    const mismatched = { ...item, detail: previewAgentMaterials(t).items[1].detail };
    expect(renderToStaticMarkup(<AgentMaterialDetail t={t} item={mismatched}/>)).toContain(t.agentMaterialsDetailsUnavailable);
  });

  it("offers removal only for explicitly marked preview examples", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const items = previewAgentMaterials(t).items;
      const render = (index: number, preview: boolean) => renderToStaticMarkup(
        <PreviewMaterialRemoval t={t} item={items[index]} preview={preview} onRemove={noop}/>,
      );
      expect(render(1, true)).toContain(t.agentMaterialsDeleteScript);
      expect(render(5, true)).toContain(t.agentMaterialsDeleteSkill);
      for (const index of [0, 2, 3, 4]) expect(render(index, true)).toBe("");
      expect(render(1, false)).toBe("");
      expect(render(5, false)).toBe("");
      const instruction = { ...items[2], previewRemoval: { location: "example" } };
      expect(renderToStaticMarkup(<PreviewMaterialRemoval t={t} item={instruction} preview onRemove={noop}/>)).toBe("");
    }
  });
});
