import { describe, expect, it } from "vitest";
import { agentTargets, selectedTarget } from "./agent-targets";

describe("desktop titlebar targets", () => {
  it("defaults to the local target without claiming an Agent connection", () => {
    const targets = agentTargets("production", " workstation ");
    expect(targets).toEqual([{ id: "local", name: "本机", kind: "local", description: "workstation" }]);
    expect(selectedTarget(targets, "local")).toBe(targets[0]);
  });

  it("never exposes preview targets in production or during initial loading", () => {
    for (const profile of [undefined, "", "production", "unknown"]) {
      expect(agentTargets(profile).map(target => target.id)).toEqual(["local"]);
    }
  });

  it("allows explicit selection of development previews and falls back if a target is missing", () => {
    const targets = agentTargets("development");
    expect(targets[0]?.name).toBe("本机");
    expect(selectedTarget(targets, "preview-linux")).toMatchObject({ kind: "preview", name: "Development Server", endpoint: "dev@192.0.2.10" });
    expect(selectedTarget(targets, "preview-windows")).toMatchObject({ kind: "preview", name: "Test Server", endpoint: "user@192.0.2.20" });
    expect(selectedTarget(targets, "missing").id).toBe("local");
    expect(selectedTarget(agentTargets("production"), "preview-linux").id).toBe("local");
  });
});
