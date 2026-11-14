import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendDiagnostic,
  MAX_DIAGNOSTIC_BYTES,
} from "../dist/application/diagnostics.js";
import { runAgent } from "../dist/application/main.js";

function fixture(t) {
  const home = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), "nexum-diagnostics-")),
  );
  const root = path.join(home, ".nexum-dev");
  mkdirSync(root, { mode: 0o700 });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    root,
    logs: path.join(root, "logs"),
    filename: path.join(root, "logs", "agent.log"),
  };
}

test("native diagnostics retain a bounded complete JSONL tail and fixed safe fields", (t) => {
  const f = fixture(t);
  appendDiagnostic(f.root, "development", "agent_connected", false);
  const record =
    JSON.stringify({ time: "old", message: "中".repeat(80) }) + "\n";
  const initial = record.repeat(
    Math.ceil((MAX_DIAGNOSTIC_BYTES + 500) / Buffer.byteLength(record)),
  );
  writeFileSync(f.filename, initial);
  appendDiagnostic(f.root, "development", "sensitive-token/path?secret", true);
  const bytes = readFileSync(f.filename);
  assert.ok(bytes.length <= MAX_DIAGNOSTIC_BYTES);
  assert.ok(bytes.length > MAX_DIAGNOSTIC_BYTES / 3);
  const lines = bytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    lines.slice(0, -1).every((line) => line.message === "中".repeat(80)),
  );
  assert.deepEqual(Object.keys(lines.at(-1)), [
    "time",
    "profile",
    "code",
    "retry",
  ]);
  assert.equal(lines.at(-1).code, "agent_failed");
  assert.equal(lines.at(-1).profile, "development");
  assert.equal(lines.at(-1).retry, true);
  assert.doesNotMatch(bytes.toString(), /sensitive-token|secret/);
  if (process.platform !== "win32")
    assert.equal(statSync(f.filename).mode & 0o777, 0o600);
});

test("a hard-linked diagnostic target cannot modify another retained file", (t) => {
  const f = fixture(t);
  mkdirSync(f.logs);
  const outside = path.join(f.home, "other-profile.log");
  writeFileSync(outside, "unchanged");
  linkSync(outside, f.filename);
  assert.throws(
    () => appendDiagnostic(f.root, "development", "agent_connected", false),
    { code: "agent_log_unavailable" },
  );
  assert.equal(readFileSync(outside, "utf8"), "unchanged");
});

test("a redirected log directory is rejected before writing another profile", (t) => {
  const f = fixture(t);
  const outside = path.join(f.home, "other-profile");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "agent.log"), "unchanged");
  symlinkSync(
    outside,
    f.logs,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => appendDiagnostic(f.root, "development", "agent_connected", false),
    { code: "storage_path_escape" },
  );
  assert.equal(
    readFileSync(path.join(outside, "agent.log"), "utf8"),
    "unchanged",
  );
});

test("invalid configuration is retained without credentials and a missing profile is not initialized", async (t) => {
  const f = fixture(t);
  writeFileSync(
    path.join(f.root, "config.json"),
    '{"token":"private-invalid-fixture"',
  );
  assert.equal(
    await runAgent("development", { version: "fixture", home: f.home }),
    0,
  );
  const log = readFileSync(f.filename, "utf8");
  assert.match(log, /invalid_configuration/);
  assert.doesNotMatch(log, /private-invalid-fixture|token/);
  const missing = path.join(f.home, "absent-home");
  mkdirSync(missing);
  assert.equal(
    await runAgent("development", { version: "fixture", home: missing }),
    0,
  );
  assert.equal(existsSync(path.join(missing, ".nexum-dev")), false);
});
