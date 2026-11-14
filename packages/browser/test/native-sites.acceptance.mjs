import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { nativeFixture } from "./helpers/native.mjs";

test(
  "native public Google Docs exports real DOCX content through the content and convenience entry points",
  { timeout: 120000 },
  async (t) => {
    const source = process.env.NEXUM_BROWSER_PUBLIC_DOC_URL,
      expected = process.env.NEXUM_BROWSER_PUBLIC_DOC_TEXT;
    assert.ok(
      source && expected,
      "Set the public Google Docs fixture URL and its expected document text explicitly.",
    );
    const url = new URL(source);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "docs.google.com");
    assert.match(url.pathname, /^\/document\/d\/[A-Za-z0-9_-]+\/edit$/);
    assert.equal(url.username + url.password, "");
    const f = await nativeFixture(t);
    const opened = await f.run(
      `const {createBrowserClient}=await import('nexum-browser');const selected=await createBrowserClient(browser).browsers.getDefault();const tab=await selected.tabs.new(context.input.url);await tab.playwright.waitForLoadState({state:'domcontentloaded',timeoutMs:30000});return {tabId:tab.id,url:await tab.url()};`,
      { url: source },
    );
    const actual = new URL(opened.result.data.url);
    assert.equal(actual.origin, url.origin);
    assert.equal(actual.pathname, url.pathname);
    const receipts = [];
    for (const alias of [false, true]) {
      const result = await f.run(
        `const {createBrowserClient}=await import('nexum-browser');const selected=await createBrowserClient(browser).browsers.getDefault();const tab=await selected.tabs.get(context.input.id);return await ${alias ? "tab.exportGsuite" : "tab.content.exportGsuite"}('docx');`,
        { id: opened.result.data.tabId },
      );
      const artifact = result.result.data,
        bytes = readFileSync(artifact.path),
        sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(bytes.subarray(0, 2).toString(), "PK");
      assert.equal(artifact.size, bytes.length);
      assert.equal(artifact.sha256, sha256);
      assert.equal(
        artifact.mimeType,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      const xml = execFileSync(
        process.platform === "win32" ? "tar" : "unzip",
        process.platform === "win32"
          ? ["-xOf", artifact.path, "word/document.xml"]
          : ["-p", artifact.path, "word/document.xml"],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      );
      assert.ok(
        xml.replace(/<[^>]+>/g, "").includes(expected),
        "The actual Office document must contain the independently specified public source text.",
      );
      receipts.push({
        entryPoint: alias ? "tab.exportGsuite" : "tab.content.exportGsuite",
        bytes: bytes.length,
        sha256,
      });
    }
    // Never emit response headers, signed redirect locations or document content.
    t.diagnostic(JSON.stringify({ source, receipts }));
  },
);
