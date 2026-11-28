import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMaintenanceActions } from "./components/AgentMaintenanceActions";
import { messages } from "./i18n";

describe("Agent maintenance actions", () => {
  it("does not offer an offline restart that the existing start flow cannot complete", () => {
    const t = messages("en-US");
    for (const cloud of ["offline", "unknown"] as const) {
      const markup = renderToStaticMarkup(<AgentMaintenanceActions t={t} name="Test Agent" profile="development" cloud={cloud} onAction={() => {}}/>);
      const button = (action: string) => markup.match(new RegExp(`<button[^>]*data-agent-action="${action}"[^>]*>`))?.[0] ?? "";
      expect(button("restart")).toContain("disabled");
      expect(button("restart")).toContain(t.agentActionCloudRequired);
      for (const action of ["stop", "reinstall", "reset", "uninstall"]) expect(button(action)).not.toContain("disabled");
    }
  });

  it("disables all five controls when the current Native protocol cannot handle maintenance", () => {
    const markup = renderToStaticMarkup(<AgentMaintenanceActions t={messages("zh-CN")} name="Test Agent" profile="development" cloud="online"/>);
    expect(markup.match(/data-agent-action=/g)).toHaveLength(5);
    expect(markup.match(/ disabled=""/g)).toHaveLength(5);
  });
});
