import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { nativeFixture } from "./helpers/native.mjs";

const sources = [
  {
    kind: "spreadsheets",
    url: process.env.NEXUM_BROWSER_PUBLIC_SHEET_URL,
    expected: process.env.NEXUM_BROWSER_PUBLIC_SHEET_TEXT,
    member: "xl/sharedStrings.xml",
    formats: [
      ["xlsx", false],
      ["xlsx", true],
      ["csv", false],
      ["pdf", true],
    ],
  },
  {
    kind: "presentation",
    url: process.env.NEXUM_BROWSER_PUBLIC_SLIDES_URL,
    expected: process.env.NEXUM_BROWSER_PUBLIC_SLIDES_TEXT,
    member: null,
    formats: [
      ["pptx", false],
      ["pptx", true],
      ["pdf", true],
    ],
  },
];

for (const source of sources) {
  test(
    `native public Google ${source.kind} exports real Office, PDF and supported text formats through both SDK entry points`,
    { timeout: 240000 },
    async (t) => {
      assert.ok(
        source.url && source.expected,
        "Select an anonymous public Google Workspace fixture and its independently specified expected text.",
      );
      const url = new URL(source.url);
      assert.equal(url.protocol, "https:");
      assert.equal(url.hostname, "docs.google.com");
      assert.match(
        url.pathname,
        new RegExp(`^/${source.kind}/d/[A-Za-z0-9_-]+/edit$`),
      );
      assert.equal(url.username + url.password, "");
      const f = await nativeFixture(t);
      t.diagnostic(JSON.stringify({ kind: source.kind, stage: "open" }));
      const opened = await f.run(
        `const {createBrowserClient}=await import('nexum-browser');const selected=await createBrowserClient(browser).browsers.get(context.input.fixtureBrowserId),tab=await selected.tabs.new(context.input.url);await tab.playwright.waitForLoadState({state:'load',timeoutMs:30000});if(context.input.kind==='presentation')await tab.playwright.locator('#filmstrip [id^="filmstrip-slide-0-"]').first().waitFor({state:'visible',timeoutMs:20000});return {id:tab.id,url:await tab.url()};`,
        { url: source.url, kind: source.kind },
      );
      const actual = new URL(opened.result.data.url);
      assert.equal(actual.origin, url.origin);
      assert.equal(actual.pathname, url.pathname);
      const receipts = [];
      for (const [format, alias] of source.formats) {
        t.diagnostic(
          JSON.stringify({
            kind: source.kind,
            stage: "export",
            format,
            entryPoint: alias ? "tab.exportGsuite" : "tab.content.exportGsuite",
          }),
        );
        const result = await f.run(
          `const {createBrowserClient}=await import('nexum-browser');const selected=await createBrowserClient(browser).browsers.get(context.input.fixtureBrowserId),tab=await selected.tabs.get(context.input.id);return await ${alias ? "tab.exportGsuite" : "tab.content.exportGsuite"}(context.input.format);`,
          { id: opened.result.data.id, format },
        );
        const artifact = result.result.data,
          bytes = readFileSync(artifact.path),
          sha256 = createHash("sha256").update(bytes).digest("hex");
        assert.equal(artifact.size, bytes.length);
        assert.equal(artifact.sha256, sha256);
        assert.equal(
          artifact.mimeType,
          {
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            csv: "text/csv",
            pdf: "application/pdf",
          }[format],
        );
        if (format === "xlsx" || format === "pptx") {
          assert.equal(bytes.subarray(0, 2).toString(), "PK");
          const archive = process.platform === "win32" ? "tar" : "unzip";
          const options = {
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 16 * 1024 * 1024,
          };
          const members = source.member
            ? [source.member]
            : execFileSync(
                archive,
                process.platform === "win32"
                  ? ["-tf", artifact.path]
                  : ["-Z1", artifact.path],
                options,
              )
                .split(/\r?\n/)
                .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
          assert.ok(
            members.length > 0 && members.length <= 200,
            "The public Office fixture has no bounded set of content entries.",
          );
          let matched = false;
          for (const member of members) {
            const xml = execFileSync(
              archive,
              process.platform === "win32"
                ? ["-xOf", artifact.path, member]
                : ["-p", artifact.path, member],
              options,
            );
            if (
              xml
                .replace(/<[^>]+>/g, "")
                .toLowerCase()
                .includes(source.expected.toLowerCase())
            ) {
              matched = true;
              break;
            }
          }
          assert.ok(
            matched,
            "The actual Office file must contain independently specified public source text.",
          );
        } else if (format === "csv") {
          assert.ok(
            bytes.toString("utf8").includes(source.expected),
            "The actual CSV must contain independently specified public source text.",
          );
        } else {
          assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
        }
        receipts.push({
          entryPoint: alias ? "tab.exportGsuite" : "tab.content.exportGsuite",
          format,
          bytes: bytes.length,
          sha256,
        });
      }
      // Keep document contents, response headers and signed redirect URLs out of logs.
      t.diagnostic(JSON.stringify({ source: source.url, receipts }));
    },
  );
}
