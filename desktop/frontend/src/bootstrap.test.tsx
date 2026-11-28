import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BootstrapView } from "./components/BootstrapView";
import { activePreview, bootstrapPreviewStage, bootstrapPreviewStages, bootstrapRetryPreview, bootstrapState, type BootstrapState } from "./desktop-page";
import { messages } from "./i18n";

const noop = () => {};
describe("unified Bootstrap presentation", () => {
  it("renders all 19 stages in both locales on a single splash", () => {
    expect(bootstrapPreviewStages).toHaveLength(19);
    expect(new Set(bootstrapPreviewStages).size).toBe(19);
    const errors = ["initializationFailed","failed","verificationFailed","migrationFailed","incompatible","permissionFailed"];
    const updates = ["downloading","verifying","installing","restarting","failed","verificationFailed","permissionFailed"];
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      for (const stage of bootstrapPreviewStages) {
        const state = bootstrapState(true, false, stage, t);
        if (state.phase === "ready") throw new Error("Preview escaped bootstrap");
        const failed = errors.includes(stage);
        expect(bootstrapPreviewStage(state)).toBe(stage);
        const html = renderToStaticMarkup(<BootstrapView t={t} state={state} preview onRetry={noop} onExit={noop} onEndPreview={noop}
          onPreviewPhase={noop} onViewLogs={noop}/>);
        expect(html).toContain(`data-bootstrap-stage="${stage}"`);
        expect(html).toContain("startup-wordmark");
        expect(html).toContain("DESKTOP");
        expect(html.includes('role="progressbar"')).toBe(!failed);
        expect(html.includes('role="alert"')).toBe(failed);
        expect(html.includes("startup-error-mark")).toBe(failed);
        expect(html.includes("0.2.0")).toBe(updates.includes(stage));
        expect(html.includes('aria-valuenow="68"')).toBe(stage === "downloading");
        expect(html.includes(t.exit)).toBe(failed || stage === "downloading" || stage === "verifying");
        expect(html.includes(t.bootstrapViewLogs)).toBe(failed);
        expect(html.includes(t.bootstrapManualInstall)).toBe(stage === "permissionFailed");
        expect(html).toContain(t.endPreview);
        expect(html).not.toMatch(/跳过更新|稍后更新|Skip update/);
        expect(activePreview("production", stage)).toBeNull();
      }
    }
  });

  it("maps retries to safe preview stages; never treats manual install as retry", () => {
    const t = messages("zh-CN");
    const retry = (stage: (typeof bootstrapPreviewStages)[number]) => {
      const state = bootstrapState(true, false, stage, t);
      if (state.phase === "ready") throw new Error("unexpected ready");
      return bootstrapRetryPreview(state);
    };
    expect(retry("initializationFailed")).toBe("startup");
    expect(retry("failed")).toBe("downloading");
    expect(retry("verificationFailed")).toBe("checking");
    expect(retry("migrationFailed")).toBe("backup");
    expect(retry("incompatible")).toBe("checking");
    expect(retry("permissionFailed")).toBeNull();
    expect(bootstrapRetryPreview({phase:"migrationFailed", retryable:false})).toBeNull();
  });

  it("does not offer nonexistent real recovery actions", () => {
    const t = messages("en-US");
    const real = (state: Exclude<BootstrapState, {phase:"ready"}>) =>
      renderToStaticMarkup(<BootstrapView t={t} state={state} preview={false} onRetry={noop} onExit={noop} onEndPreview={noop}/>);
    expect(real({phase:"migrationFailed", retryable:false})).not.toContain(t.bootstrapSafeRetry);
    expect(real({phase:"update",update:{phase:"permissionFailed",currentVersion:"0.1.0",targetVersion:"0.2.0",message:t.bootstrapPermissionDetail}})).not.toContain(t.bootstrapManualInstall);
    expect(real({phase:"initializationFailed"})).not.toContain(t.bootstrapViewLogs);
    expect(real({phase:"migration"})).not.toContain(t.endPreview);
  });
});
