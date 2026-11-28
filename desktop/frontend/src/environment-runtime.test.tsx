import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { agentTargets } from "./agent-targets";
import { connectionErrorKey, emptyRemoteDraft, parseEnvironmentAttempt, parseEnvironmentSnapshot, savedRemoteDraft } from "./environment-runtime";
import { messages } from "./i18n";
import { AddRemoteView } from "./components/AddRemoteView";
import { RemoteConnectionView } from "./components/RemoteConnectionView";
import { WorkspaceView } from "./components/WorkspaceView";

const local = { id: "local", kind: "local", hostname: "Local", host: "", port: 0,
  username: "", authType: "", platform: "darwin", arch: "arm64", connected: true, hasSavedCredential: false };
const remote = { id: "remote-1", kind: "ssh", hostname: "Remote", host: "fixture.test", port: 22,
  username: "fixture", authType: "key", platform: "linux", arch: "amd64", connected: true, hasSavedCredential: true };
const verify = { id: "attempt-1", phase: "verify", errorCode: "", fingerprint: "SHA256:fixture", keyType: "ssh-ed25519", environmentId: "", warning: "" };

describe("real environment state", () => {
  it("rejects malformed, missing and duplicate environment snapshots", () => {
    expect(() => parseEnvironmentSnapshot({})).toThrow();
    expect(() => parseEnvironmentSnapshot({ revision: 1, environments: [remote], attempt: null })).toThrow();
    expect(() => parseEnvironmentSnapshot({ revision: 1, environments: [local, local], attempt: null })).toThrow();
    expect(() => parseEnvironmentSnapshot({ revision: 1, environments: [local, { ...remote, port: 0 }], attempt: null })).toThrow();
    expect(() => parseEnvironmentAttempt({ ...verify, fingerprint: "" })).toThrow();
    expect(() => parseEnvironmentAttempt({ ...verify, phase: "connected" })).toThrow();
  });

  it("uses actual remote identity and connection state, not a sample target", () => {
    const state = parseEnvironmentSnapshot({ revision: 3, environments: [local, remote], attempt: verify });
    const targets = agentTargets(undefined, "Local", messages("en-US"), state.environments);
    expect(targets.map(t => t.id)).toEqual(["local", "remote-1"]);
    expect(targets[1]).toMatchObject({ kind: "ssh", name: "Remote", connected: true });
    expect(savedRemoteDraft(state.environments[1])).toEqual({ host: "fixture.test", port: "22", user: "fixture", auth: "key" });
  });

  it("distinguishes unreachable hosts from timeouts and asks to re-enter unsaved credentials", () => {
    expect(connectionErrorKey("network")).toBe("remoteNetworkError");
    expect(connectionErrorKey("timeout")).toBe("remoteTimeout");
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const status = renderToStaticMarkup(<RemoteConnectionView t={t} draft={emptyRemoteDraft()} stage="failed" preview={false}
        attempt={{ ...verify, phase: "failed", errorCode: "network" }} onBack={() => {}}/>);
      expect(status).toContain(t.remoteNetworkError);
      expect(status).toContain(t.remoteEditConfig);
      expect(status).not.toContain(t.remoteReconnect);
    }
  });

  it("renders actual fingerprint and form in production mode, without sample controls", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const draft = emptyRemoteDraft();
      const form = renderToStaticMarkup(<AddRemoteView t={t} initialDraft={draft} preview={false}
        onConnect={() => {}} onCancel={() => {}}/>);
      expect(form).not.toContain(t.remoteUiPreview);
      expect(form).toContain(t.remoteRememberCredential);
      const status = renderToStaticMarkup(<RemoteConnectionView t={t} draft={draft} stage="verify" preview={false}
        attempt={parseEnvironmentAttempt(verify)} onBack={() => {}}/>);
      expect(status).toContain("SHA256:fixture");
      expect(status).not.toContain(t.remoteFingerprintSample);
      expect(status).not.toContain(t.remotePreviewStage);
      const target = agentTargets(undefined, "Local", t,
        parseEnvironmentSnapshot({ revision: 3, environments: [local, remote], attempt: null }).environments)[1];
      const workspace = renderToStaticMarkup(<WorkspaceView current={target} t={t}/>);
      expect(workspace).toContain(t.sshConnected);
      expect(workspace).toContain(t.targetUnconnected);
    }
  });
});
