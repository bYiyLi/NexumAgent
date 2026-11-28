import { messages, type Messages } from "./i18n";
import type { EnvironmentView } from "./environment-runtime";
import { remoteEndpoint } from "./remote-draft";
import { savedRemoteDraft } from "./environment-runtime";

export type AgentTarget = {
  id: string;
  name: string;
  kind: "local" | "preview" | "ssh";
  connected?: boolean;
  environment?: EnvironmentView;
  description: string;
  endpoint?: string;
};

// The shell does not discover Agent installations or establish connections yet.
// Only development builds expose clearly marked fixtures for UI verification.
export function agentTargets(profile?: string, hostname?: string, t: Messages = messages("zh-CN"), real: readonly EnvironmentView[] = []): AgentTarget[] {
  const targets: AgentTarget[] = [
    { id: "local", name: t.local, kind: "local", description: hostname?.trim() || t.localDescription },
  ];
  for (const view of real) {
    if (view.kind !== "ssh") continue;
    targets.push({ id: view.id, name: view.hostname || view.host, kind: "ssh", description: view.platform + " · " + view.arch,
      endpoint: remoteEndpoint(savedRemoteDraft(view)), connected: view.connected, environment: view });
  }
  if (profile === "development") {
    targets.push(
      { id: "preview-linux", name: t.linuxPreview, kind: "preview", description: t.remotePreview, endpoint: "dev@192.0.2.10" },
      { id: "preview-windows", name: t.windowsPreview, kind: "preview", description: t.remotePreview, endpoint: "user@192.0.2.20" },
    );
  }
  return targets;
}

export function selectedTarget(targets: AgentTarget[], id: string): AgentTarget {
  return targets.find(target => target.id === id) ?? targets[0]!;
}
