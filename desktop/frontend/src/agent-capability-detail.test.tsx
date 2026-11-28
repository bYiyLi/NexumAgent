import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseAgentCapabilityDetail } from "./agent-capabilities-runtime";
import type { AgentCapability } from "./agent-capabilities";
import { AgentCapabilityDetail, CapabilityActions } from "./components/AgentCapabilityDetail";
import { messages } from "./i18n";

const scope = { targetId: "local", operationId: "operation", agentId: "agent", bootId: "boot" };
const item: AgentCapability = { id: `res_${"a".repeat(64)}`, name: "GitHub", kind: "mcp" };
const detail = () => ({ protocol: 1, profile: "development", ...scope, detail: {
  id: item.id, name: item.name, type: "mcp", configuration: { type: "http", headers: "[hidden]" },
  methods: [{ name: "search", description: "Search", parameters: [{ name: "query", type: "string", required: true }] }], methodsComplete: true,
} });

describe("capability detail", () => {
  it("accepts only the selected resource and current environment identity", () => {
    const parsed = parseAgentCapabilityDetail(detail(), scope, item);
    expect(parsed.methods[0].parameters[0]).toEqual({ name: "query", type: "string", location: undefined, required: true });
    expect(parsed.configuration).toEqual({ type: "http", headers: "[hidden]" });
    expect(() => parseAgentCapabilityDetail({ ...detail(), bootId: "old" }, scope, item)).toThrow();
    expect(() => parseAgentCapabilityDetail({ ...detail(), detail: { ...detail().detail, id: "another" } }, scope, item)).toThrow();
    expect(() => parseAgentCapabilityDetail({ ...detail(), detail: { ...detail().detail, type: "npm" } }, scope, item)).toThrow();
    expect(() => parseAgentCapabilityDetail({ ...detail(), detail: { ...detail().detail, methods: null } }, scope, item)).toThrow();
  });

  it("shows verified details and clearly disables unsupported maintenance", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const html = renderToStaticMarkup(<AgentCapabilityDetail t={t} detail={parseAgentCapabilityDetail(detail(), scope, item)}/>);
      expect(html).toContain("GitHub");
      expect(html).toContain("search");
      expect(html).toContain(t.agentCapabilityRedacted);
      const actions = renderToStaticMarkup(<CapabilityActions t={t} item={item} compact/>);
      expect(actions).toContain(t.agentCapabilityReconnectUnavailable);
      expect(actions).toContain(t.agentCapabilityRemoveUnavailable);
      expect(actions.match(/\sdisabled=""/g)).toHaveLength(2);
      const stdioActions = renderToStaticMarkup(<CapabilityActions t={t} item={item} transport="stdio"/>);
      expect(stdioActions).toContain(t.agentCapabilityRestart);
      const apiActions = renderToStaticMarkup(<CapabilityActions t={t} item={{ id: "api", name: "CRM", kind: "api" }} compact/>);
      expect(apiActions).not.toContain(t.agentCapabilityReconnect);
      expect(apiActions.match(/\sdisabled=""/g)).toHaveLength(1);
    }
  });
});
