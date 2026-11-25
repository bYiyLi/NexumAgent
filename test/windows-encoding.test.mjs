import assert from "node:assert/strict";
import test from "node:test";
import { readWindowsCodePages } from "../dist/process/windows-encoding.js";
import { selectWindowsFallback, windowsLegacyEncoding } from "../dist/process/output-encoding.js";

test("legacy fallback prefers observed console, then OEM, then ANSI and skips UTF-8 or unsupported pages", () => {
  const pages={source:"windows-system-and-host-console",hostConsoleInput:null,hostConsoleOutput:932,oem:936,ansi:1252};
  assert.equal(selectWindowsFallback(pages),932);
  assert.equal(selectWindowsFallback({...pages,hostConsoleOutput:65001}),936);
  assert.equal(selectWindowsFallback({...pages,hostConsoleOutput:null,oem:9999}),1252);
  assert.equal(selectWindowsFallback({...pages,hostConsoleOutput:65001,oem:65001,ansi:65001}),0);
  assert.equal(selectWindowsFallback(undefined),0);
  for (const page of [437,850,852,855,858,860,862,863,865,866,874,932,936,949,950,1250,1251,1252,1253,1254,1255,1256,1257,1258,54936])
    assert.ok(windowsLegacyEncoding(page), String(page));
  assert.equal(windowsLegacyEncoding(65001),undefined);
  assert.equal(windowsLegacyEncoding(1200),undefined);
});

test("system code page facts are native, optional, and never claim child output encoding", () => {
  const observed=readWindowsCodePages();
  if(process.platform!=="win32"){
    assert.equal(observed,undefined);
    return;
  }
  assert.ok(observed);
  assert.equal(observed.source,"windows-system-and-host-console");
  assert.ok(Number.isInteger(observed.ansi)&&observed.ansi>0);
  assert.ok(Number.isInteger(observed.oem)&&observed.oem>0);
  for(const key of ["hostConsoleInput","hostConsoleOutput"])
    assert.ok(observed[key]===null || Number.isInteger(observed[key])&&observed[key]>0);
});

test("official sh.get encoding schema matches the owning decoder labels", async () => {
  const {readFile}=await import("node:fs/promises");
  const {outputEncodingLabels}=await import("../dist/process/output-encoding.js");
  const body=await readFile(new URL("../builtin/sh.get.js",import.meta.url),"utf8");
  const schema=JSON.parse(body.slice(body.indexOf("{"),body.indexOf("*/")).trim());
  assert.deepEqual(schema.scriptInputSchema.properties.encoding.anyOf[0].enum,outputEncodingLabels);
});
