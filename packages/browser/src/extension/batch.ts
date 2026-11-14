import type { Invocation } from "@nexum/extension-api";
import type { TabsContentResult } from "../client/types.js";
import { validateTarget } from "../client/serialize.js";
import { BrowserRuntime } from "./scope.js";
import { check, record, failure, type Target } from "./protocol.js";
function authority(call: Invocation, url: string): void {
  const parsed = new URL(url);
  check(
    ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password,
    "INVALID_ARGUMENT",
    "Batch page reading requires HTTP(S) URLs without credentials.",
  );
  call.authorize({ type: "url", value: parsed.href, access: "read" });
}
function nativeCode(cause: unknown): string | null {
  if (
    !cause ||
    typeof cause !== "object" ||
    Object.getPrototypeOf(cause) !== Error.prototype
  )
    return null;
  const code = Object.getOwnPropertyDescriptor(cause, "code"),
    effect = Object.getOwnPropertyDescriptor(cause, "effect");
  return code &&
    "value" in code &&
    typeof code.value === "string" &&
    effect &&
    "value" in effect
    ? code.value
    : null;
}
function truncate(value: string, length: number): string {
  let result = value.slice(0, length);
  if (result.length && /[\uD800-\uDBFF]/.test(result.at(-1)!))
    result = result.slice(0, -1);
  return result;
}
/** Actual temporary tabs, sharing only this invocation's ordinary managed scope. */
export async function collectTabContent(
  input: Record<string, unknown>,
  target: Target,
  call: Invocation,
  runtime: BrowserRuntime,
  remember: (target: Target, value: unknown, method: string) => void,
): Promise<TabsContentResult[]> {
  check(
    record(input.options) &&
      Array.isArray(input.options.urls) &&
      input.options.urls.length > 0 &&
      input.options.urls.length <= 8,
    "INVALID_ARGUMENT",
    "A batch reads one to eight pages.",
  );
  const options = input.options,
    urls = options.urls as string[];
  for (const url of urls) {
    check(
      typeof url === "string",
      "INVALID_ARGUMENT",
      "A page URL must be text.",
    );
    authority(call, url);
  }
  const deadline = Math.min(
    call.deadline,
    Date.now() +
      Math.min(
        30000,
        typeof options.timeoutMs === "number" ? options.timeoutMs : 30000,
      ),
  );
  const results: TabsContentResult[] = [];
  for (const url of urls) {
    call.signal.throwIfAborted();
    if (Date.now() >= deadline) {
      results.push({ url, title: null, content: null, truncated: false });
      continue;
    }
    let temporary: Target | undefined;
    try {
      const created = await runtime.action(
        "tabs.createTemporary",
        {
          target,
          url,
          options: {
            active: false,
            timeoutMs: Math.max(1, deadline - Date.now()),
          },
        },
        target,
        call,
        true,
      );
      check(
        record(created) && record(created.target),
        "PROTOCOL_MISMATCH",
        "A temporary page was not identified.",
      );
      temporary = validateTarget(created.target, true);
      remember(target, created, "tabs.new");
      await runtime.action(
        "playwright.waitForLoadState",
        {
          target: temporary,
          options: {
            state: "domcontentloaded",
            timeoutMs: Math.max(1, deadline - Date.now()),
          },
          background: true,
        },
        temporary,
        call,
        false,
      );
      const currentUrl = await runtime.action(
        "tab.url",
        { target: temporary, background: true },
        temporary,
        call,
        false,
      );
      check(
        typeof currentUrl === "string",
        "TARGET_GONE",
        "The temporary page no longer has a URL.",
      );
      authority(call, currentUrl);
      const title = await runtime.action(
        "tab.title",
        { target: temporary, background: true },
        temporary,
        call,
        false,
      );
      const value =
        options.contentType === "domSnapshot"
          ? await runtime.action(
              "playwright.domSnapshot",
              { target: temporary, background: true },
              temporary,
              call,
              false,
            )
          : await runtime.action(
              "tab.contentExport",
              {
                target: temporary,
                options: {
                  format: options.contentType === "html" ? "html" : "text",
                },
                background: true,
              },
              temporary,
              call,
              false,
            );
      const content =
        typeof value === "string"
          ? value
          : record(value) && typeof value.data === "string"
            ? value.data
            : null;
      check(
        content !== null,
        "PROTOCOL_MISMATCH",
        "The browser did not return the actual page text.",
      );
      results.push({
        url,
        title: typeof title === "string" ? title : null,
        content: truncate(content, 4096),
        truncated:
          content.length > 4096 || (record(value) && value.truncated === true),
      });
    } catch (cause) {
      call.signal.throwIfAborted();
      if (
        ![
          "TIMEOUT",
          "TARGET_GONE",
          "NAVIGATION_FAILED",
          "CDP_DISCONNECTED",
          "EXTENSION_OFFLINE",
          "UNKNOWN_RESULT",
        ].includes(nativeCode(cause) ?? "")
      )
        throw cause;
      results.push({ url, title: null, content: null, truncated: false });
    } finally {
      if (temporary) {
        try {
          await runtime.action(
            "tabs.closeTemporary",
            { target: temporary, id: temporary.tabId, background: true },
            temporary,
            call,
            true,
          );
          remember(temporary, null, "tab.close");
        } catch (cause) {
          if (nativeCode(cause) !== "TARGET_GONE") throw cause;
        }
      }
    }
  }
  // Preserve URL identity. Only actual page content is shortened to the batch budget.
  while (Buffer.byteLength(JSON.stringify(results)) > 60000) {
    let candidate: TabsContentResult | undefined;
    for (const row of results)
      if (
        row.content &&
        (!candidate || row.content.length > candidate.content!.length)
      )
        candidate = row;
    if (!candidate)
      throw failure(
        "OUTPUT_TOO_LARGE",
        "Page metadata alone exceeds the batch result budget.",
      );
    const excess = Buffer.byteLength(JSON.stringify(results)) - 60000;
    candidate.content = truncate(
      candidate.content!,
      Math.max(0, candidate.content!.length - Math.max(1, excess)),
    );
    candidate.truncated = true;
  }
  return results;
}
