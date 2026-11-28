import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { clientUpdatePreview } from "./client-update";
import { messages } from "./i18n";
import { BootstrapView } from "./components/BootstrapView";
import { ProgressBar, progressPercent } from "./components/ui/progress";
import type { ClientUpdateState } from "./client-update";

const noop = () => {};

describe("client update on the existing splash", () => {
  it("checks for updates without claiming numeric progress", () => {
    const markup = renderToStaticMarkup(<BootstrapView t={messages("zh-CN")} state={{ phase: "checking" }}
      preview={false} onExit={noop} onRetry={noop} onEndPreview={noop}/>);
    expect(markup).toContain("正在检查更新");
    expect(markup).toContain("startup-wordmark");
    expect(markup).toContain("DESKTOP");
    expect(markup).toContain('role="progressbar"');
    expect(markup).not.toContain("aria-valuenow=");
    expect(markup).not.toContain("0.2.0");
    expect(markup).not.toContain("结束预览");
  });
  it("keeps the same splash and shows only a download's actual percentage", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const render = (phase: ClientUpdateState["phase"], preview = false) => renderToStaticMarkup(
        <BootstrapView t={t} state={{ phase: "update", update: clientUpdatePreview(phase, t) }}
          preview={preview} onExit={noop} onRetry={noop} onEndPreview={noop}/>);
      const markup = render("downloading", true);
      for (const content of [t.downloading, "0.1.0", "0.2.0", "68%", t.previewNote, t.exit, t.noAgentImpact, "startup-wordmark", "DESKTOP"]) expect(markup).toContain(content);
      expect(markup).toContain('aria-valuenow="68"');
      expect(markup).not.toMatch(/稍后更新|跳过|继续使用旧版|Skip update/);
      for (const phase of ["verifying", "installing", "restarting"] as const) {
        const html = render(phase);
        expect(html).toContain(t[phase]);
        expect(html).not.toContain("aria-valuenow=");
        expect(html).not.toContain("68%");
        expect(html).not.toContain(t.endPreview);
      }
      const failed = render("failed");
      expect(failed).toContain('role="alert"');
      expect(failed).toContain(t.updateFailed);
      expect(failed).toContain(t.retryUpdate);
      expect(failed).not.toContain('role="progressbar"');
      expect(failed).not.toContain(t.endPreview);
    }
  });
  it("bounds percentage and omits a numeric value when unknown", () => {
    expect(progressPercent(67.9)).toBe(67);
    expect(progressPercent(120)).toBe(100);
    expect(progressPercent(-1)).toBe(0);
    expect(progressPercent(NaN)).toBeNull();
    expect(renderToStaticMarkup(<ProgressBar value={null} label="未知进度" />)).not.toContain("aria-valuenow");
  });
});
