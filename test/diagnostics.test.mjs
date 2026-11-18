import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
import { WebSocketServer } from "ws";
import {
  appendDiagnostic,
  MAX_DIAGNOSTIC_BYTES,
  startupFailureDetails,
} from "../dist/application/diagnostics.js";
import { runAgent } from "../dist/application/main.js";
import { AgentError } from "../dist/contracts/errors.js";

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
  appendDiagnostic(f.root, "development", "control_unavailable", true);
  assert.deepEqual(
    readFileSync(f.filename, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).code),
    ["agent_connected", "control_unavailable"],
  );
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

test("connection diagnostics keep only safe timestamps, reasons and retry measurements", (t) => {
  const f = fixture(t);
  appendDiagnostic(f.root, "development", "agent_connection_lost", true, {
    reason: "heartbeat_timeout",
    lastPingAt: "2026-11-16T13:01:00.000Z",
    closeCode: 1006,
    offlineMs: 1200,
    attempt: 2,
    retryDelayMs: 2000,
    httpStatus: 502,
  });
  appendDiagnostic(f.root, "development", "agent_connection_lost", true, {
    reason: "private-secret",
    lastPingAt: "token:private-secret",
    closeCode: -20,
    offlineMs: -1,
    httpStatus: 900,
    extra: "private-secret",
  });
  const [valid, rejected] = readFileSync(f.filename, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(valid.reason, "heartbeat_timeout");
  assert.equal(valid.lastPingAt, "2026-11-16T13:01:00.000Z");
  assert.equal(valid.closeCode, 1006);
  assert.equal(valid.offlineMs, 1200);
  assert.equal(valid.attempt, 2);
  assert.equal(valid.retryDelayMs, 2000);
  assert.equal(valid.httpStatus, 502);
  assert.deepEqual(Object.keys(rejected), ["time", "profile", "code", "retry"]);
  assert.doesNotMatch(readFileSync(f.filename, "utf8"), /private-secret/);
});

test("nested startup failures disclose stable phase, source module, and recovery but never secrets", (t) => {
  const f = fixture(t);
  const secret = "nx_agt_should-never-enter-a-diagnostic";
  const underlying = Object.assign(new TypeError(`connection secret=${secret}`), {
    code: "ERR_SQLITE_ERROR",
    stack: `TypeError: ${secret}\n    at Database.run (C:\\Users\\Private\\${secret}\\dist\\storage\\sqlite.js:298:42)\n`,
  });
  const outer = new AgentError("storage_error", `secret=${secret}`, undefined, {
    cause: underlying,
  });
  const attemptId = "db96f7d4-436b-4a70-b00d-e2f3a50c8e93";
  const details = startupFailureDetails(outer, "core_initialize", attemptId);
  assert.equal(details.failureCode, "storage_error");
  assert.equal(details.sourceCode, "ERR_SQLITE_ERROR");
  assert.equal(details.exceptionType, "TypeError");
  assert.equal(details.sourceModule, "storage/sqlite");
  assert.equal(details.sourceLine, 298);
  assert.equal(details.recoveryCode, "inspect_storage");
  appendDiagnostic(f.root, "development", "agent_startup_failed", false, details);
  const text = readFileSync(f.filename, "utf8");
  const record = JSON.parse(text.trim());
  assert.equal(record.attemptId, attemptId);
  assert.equal(record.phase, "core_initialize");
  assert.equal(record.sourceModule, "storage/sqlite");
  assert.match(record.recoveryHint, /SQLite/);
  assert.doesNotMatch(text, /nx_agt|Private|Users|connection secret|TypeError:|\\\\dist/);
});

test("unknown native failures never log arbitrary codes, full paths or raw messages", (t) => {
  const f = fixture(t);
  const secret = "nx_agt_DO_NOT_PRINT";
  const failure = Object.assign(new Error(secret), {
    code: secret,
    stack: `Error: ${secret}\n    at nowhere (/home/${secret}/other/private-source.js:1:1)`,
  });
  const details = startupFailureDetails(failure, "core_initialize");
  appendDiagnostic(f.root, "development", "agent_startup_failed", false, {
    ...details,
    exceptionType: "TokenNotAnException",
    sourceModule: "private/secret",
    recoveryCode: secret,
    extra: secret,
  });
  const event = JSON.parse(readFileSync(f.filename, "utf8").trim());
  assert.equal(event.failureCode, "unclassified_failure");
  assert.equal(event.exceptionType, undefined);
  assert.equal(event.sourceModule, undefined);
  assert.equal(event.recoveryCode, undefined);
  assert.doesNotMatch(JSON.stringify(event), /nx_agt|private-source|home\//);
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
    78,
  );
  const log = readFileSync(f.filename, "utf8");
  assert.match(log, /invalid_configuration/);
  const parsed = log.trim().split("\n").map(JSON.parse);
  assert.ok(parsed.some((event) =>
    event.code === "agent_startup_failed" &&
    event.phase === "profile_load" &&
    event.failureCode === "invalid_configuration" &&
    event.exceptionType === "AgentError" &&
    event.recoveryCode === "check_configuration" &&
    /^[0-9a-f-]{36}$/.test(event.attemptId),
  ));
  assert.doesNotMatch(log, /private-invalid-fixture|token/);
  const missing = path.join(f.home, "absent-home");
  mkdirSync(missing);
  assert.equal(
    await runAgent("development", { version: "fixture", home: missing }),
    78,
  );
  assert.equal(existsSync(path.join(missing, ".nexum-dev")), false);
});

test("Cloud rejects a credential: connection remains blocked without retrying", {
  timeout: 15000,
}, async (t) => {
  const f = fixture(t);
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (_request, socket) => {
    socket.end(
      "HTTP/1.1 401 Unauthorized\r\n" +
      "X-Nexum-Error-Code: invalid_agent_credential\r\n" +
      "Content-Length: 0\r\nConnection: close\r\n\r\n",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(path.join(f.root, "config.json"), JSON.stringify({
    server_url: `http://127.0.0.1:${server.address().port}/`,
    token: "nx_agt_DO_NOT_PRINT",
  }), { mode: 0o600 });
  const result = await runAgent("development", {
    version: "test", home: f.home,
    attemptId: "7b5d0d98-2628-4aac-bb15-69dfa9467d12",
  });
  assert.equal(result, 78);
  const text = readFileSync(f.filename, "utf8");
  const events = text.trim().split("\n").map(JSON.parse);
  assert.ok(events.some((event) =>
    event.code === "invalid_agent_credential" && event.retry === false));
  assert.ok(events.some((event) =>
    event.code === "agent_startup_failed" &&
    event.phase === "control_connect" &&
    event.failureCode === "invalid_agent_credential"));
  assert.doesNotMatch(text, /nx_agt_DO_NOT_PRINT/);
});

test("authenticated Cloud handshake followed by fatal Core init records the true stage", {
  timeout: 15000,
}, async (t) => {
  const f = fixture(t);
  const http = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const peers = [];
  ws.on("headers", (headers) => {
    headers.push(
      "X-Nexum-Agent-Id: synthetic-agent",
      "X-Nexum-Cloud-Environment: development",
      "X-Nexum-Connection-Id: con_synthetic",
    );
  });
  http.on("upgrade", (request, socket, head) => {
    ws.handleUpgrade(request, socket, head, (peer) =>
      ws.emit("connection", peer, request));
  });
  ws.on("connection", (peer) => peers.push(peer));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const peer of peers) peer.terminate();
    await new Promise((resolve) => ws.close(resolve));
    await new Promise((resolve) => http.close(resolve));
  });
  const token = "fixture-secret-token-never-log";
  writeFileSync(path.join(f.root, "config.json"), JSON.stringify({
    server_url: `http://127.0.0.1:${http.address().port}/`,
    token,
  }), { mode: 0o600 });
  const attemptId = "9d1bb763-d3d4-46cc-9c6e-7c010d25e5ff";
  const result = await runAgent("development", {
    version: "test",
    home: f.home,
    attemptId,
    runtime: { shutdownWaitMs: -1 },
  });
  assert.equal(result, 78, "permanent invalid configuration needs a non-retry result");
  const lines = readFileSync(f.filename, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(lines.some((event) =>
    event.code === "agent_boot_stage" &&
    event.phase === "core_initialize" &&
    event.attemptId === attemptId,
  ));
  const failure = lines.find((event) => event.code === "agent_startup_failed");
  assert.equal(failure.phase, "core_initialize");
  assert.equal(failure.failureCode, "invalid_configuration");
  assert.equal(failure.attemptId, attemptId);
  assert.equal(failure.exceptionType, "AgentError");
  assert.equal(failure.sourceModule, "application/runtime");
  assert.doesNotMatch(readFileSync(f.filename, "utf8"), /fixture-secret-token|synthetic-agent/);
});
