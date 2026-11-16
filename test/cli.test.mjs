import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function invoke(...args) {
  const home = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-cli-command-")),
  );
  try {
    return spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      // Loading the actual CLI competes with the complete native Core matrix.
      // Its readiness is the assertion; this is not a startup-latency benchmark.
      timeout: 60_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("CLI documents explicit profile selection and actual native startup", () => {
  const result = invoke("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /run --profile development\|production/);
  assert.match(result.stdout, /experimental-vm-modules/);
  assert.equal(result.stderr, "");
});

test("CLI version matches package.json", () => {
  const result = invoke("--version");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), version);
  assert.equal(result.stderr, "");
});

test("CLI refuses unknown commands and missing or ambiguous profiles", () => {
  const result = invoke("connect");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /无效命令/);
  for (const args of [
    ["run"],
    ["run", "--profile", "test"],
    ["run", "--profile", "development", "--profile", "production"],
  ]) {
    const result = invoke(...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /明确选择/);
  }
});

test("a missing VM launch flag stops permanently before configuration or network access", () => {
  const result = invoke("run", "--profile", "development");
  assert.equal(
    result.status,
    0,
    JSON.stringify({
      error: result.error?.code,
      signal: result.signal,
      stderr: result.stderr,
    }),
  );
  assert.match(result.stderr, /vm_modules_required/);
});

const nativeCliOptions = {
  skip:
    process.platform === "win32"
      ? "Windows OS service stop is verified by its native service harness"
      : false,
};
test(
  "the native CLI connects its isolated development profile, runs real VM code and closes on an OS signal",
  nativeCliOptions,
  (t) => nativeCliScenario(t, false),
);
test(
  "the native CLI persists an unavailable Git probe diagnostic while VM execution and signal shutdown remain usable",
  nativeCliOptions,
  (t) => nativeCliScenario(t, true),
);
async function nativeCliScenario(t, unavailableProbe) {
  const home = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-cli-native-")),
  );
  const root = path.join(home, ".nexum-dev");
  mkdirSync(path.join(root, "work"), { recursive: true });
  writeFileSync(
    path.join(root, "work", "package.json"),
    '{"type":"module","private":true}',
  );
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  const received = new Map();
  let binding;
  let socket;
  let child;
  let stderr = "";
  server.on("connection", (value) => {
    sockets.add(value);
    value.once("close", () => sockets.delete(value));
  });
  wss.on("headers", (headers) =>
    headers.push(
      "X-Nexum-Agent-Id: cli-agent",
      "X-Nexum-Cloud-Environment: development",
      "X-Nexum-Connection-Id: cli-connection",
    ),
  );
  server.on("upgrade", (request, connection, head) => {
    assert.equal(request.headers.authorization, "Bearer fixture_cli_token");
    assert.equal(request.headers["x-nexum-profile"], "development");
    assert.equal(request.headers["x-nexum-protocol-version"], "2");
    binding = {
      agentId: "cli-agent",
      profile: "development",
      cloudEnvironment: "development",
      connectionId: "cli-connection",
      bootId: request.headers["x-nexum-boot-id"],
    };
    wss.handleUpgrade(request, connection, head, (peer) => {
      socket = peer;
      peer.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "result" || message.type === "error")
          received.set(message.id, message);

      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const source = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ server_url: source, token: "fixture_cli_token" }),
    { mode: 0o600 },
  );
  const exited = Promise.withResolvers();
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exited.promise, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited.promise;
      }
    }
    socket?.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  // Execute the real CLI and delegate to its original application dispatch.
  // The test-only wrapper records and rethrows the same exception before
  // wire sanitization, using only this fixture home and synthetic authority.
  const probeShell = path.join(home, "zsh");
  const probeObserved = path.join(home, "probe-observed");
  if (unavailableProbe)
    writeFileSync(
      probeShell,
      `#!/bin/sh\nprintf 'exit 17' > '${probeObserved.replaceAll("'", "'\\''")}'\nexit 17\n`,
      { mode: 0o700 },
    );
  const diagnostics = path.join(home, "invoke-diagnostics.mjs");
  writeFileSync(
    diagnostics,
    `import {AgentRuntime} from ${JSON.stringify(new URL("../dist/application/runtime.js", import.meta.url).href)};
${
  unavailableProbe
    ? `import {createRequire,syncBuiltinESMExports} from 'node:module';
const os=createRequire(import.meta.url)('node:os'),userInfo=os.userInfo;
os.userInfo=(...args)=>({...userInfo(...args),shell:${JSON.stringify(probeShell)}});syncBuiltinESMExports();`
    : ""
}
const dispatch=AgentRuntime.prototype.dispatch;
AgentRuntime.prototype.dispatch=async function(...args){
  try{return await Reflect.apply(dispatch,this,args);}
  catch(cause){
    try{process.stderr.write('native_cli_invoke_failed '+JSON.stringify({operation:args[0]?.operation,error:{code:typeof cause?.code==='string'?cause.code:null,name:typeof cause?.name==='string'?cause.name:null,message:typeof cause?.message==='string'?cause.message.slice(0,4096):null,stack:typeof cause?.stack==='string'?cause.stack.slice(0,8192):null}})+String.fromCharCode(10));}catch{}
    throw cause;
  }
};\n`,
  );
  child = spawn(
    process.execPath,
    [
      "--experimental-vm-modules",
      "--import",
      pathToFileURL(diagnostics).href,
      cli,
      "run",
      "--profile",
      "development",
    ],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  async function until(condition) {
    const deadline = Date.now() + 60000;
    while (!condition()) {
      assert.equal(child.exitCode, null, stderr);
      assert.equal(child.signalCode, null, stderr);
      assert.ok(
        Date.now() < deadline,
        stderr || "The actual CLI did not become ready.",
      );
      await delay(10);
    }
  }
  await until(() => stderr.includes("agent_connected"));
  let sequence = 0;
  async function invokeNative(operation, input, expected = "result") {
    const id = `inv_cli_${++sequence}`;
    const context = {
      caller: {
        principalId: "owner",
        clientId: "cli-test",
        grantId: "grant",
      },
      connection: binding,
      authorization: {
        agentId: "cli-agent",
        allowedRoots: [],
        budgets: {},
        revision: "one",
      },
    };
    socket.send(
      JSON.stringify({ type: "invoke", id, operation, context, input }),
    );
    await until(() => received.has(id));
    const response = received.get(id);
    assert.equal(
      response.type,
      expected,
      JSON.stringify({ operation, response, stderr: stderr.slice(-16384) }),
    );
    return expected === "result" ? response.output : response.error;
  }
  const opened = await invokeNative("agent.open", { agentId: "cli-agent" });
  assert.equal(opened.pwd, path.join(root, "work"));
  let run = await invokeNative("agent.run.start", {
    contextId: opened.contextId,
    script: "return {answer: 6 * 7};",
    waitMs: 0,
  });
  const terminal = new Set([
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
  ]);
  const deadline = Date.now() + 15000;
  while (!terminal.has(run.run.status)) {
    assert.ok(Date.now() < deadline, "The original CLI Run did not settle.");
    run = await invokeNative("agent.run.get", {
      agentId: "cli-agent",
      runId: run.run.runId,
      waitMs: 1000,
    });
  }
  assert.equal(run.run.status, "succeeded");
  assert.deepEqual(run.result.data, { answer: 42 });
  // Startup owns the daily Git check; the test never invokes the scheduler or
  // constructs a separate WorkGitMaintenance instance on the CLI's behalf.
  const gitState = path.join(root, "state", "work-git.json");
  const agentLog = path.join(root, "logs", "agent.log");
  const unavailableRecorded = () =>
    existsSync(agentLog) &&
    readFileSync(agentLog, "utf8")
      .split("\n")
      .slice(0, -1)
      .map((line) => JSON.parse(line))
      .some(
        (entry) =>
          entry.profile === "development" &&
          entry.code === "work_git_unavailable" &&
          entry.retry === false,
      );
  await until(() => existsSync(gitState) || unavailableRecorded());
  if (existsSync(gitState)) {
    assert.equal(unavailableProbe, false);
    const saved = JSON.parse(readFileSync(gitState, "utf8"));
    assert.equal(saved.schemaVersion, 1);
    const snapshot = saved.result;
    if (snapshot.status === "committed")
      assert.match(snapshot.commit, /^[0-9a-f]{40,64}$/);
    else {
      assert.equal(snapshot.status, "unavailable", JSON.stringify(snapshot));
      assert.equal(snapshot.reason, "git_unavailable");
    }
  } else {
    // Environment discovery can fail before Git has a maintenance record.
    // The real persisted profile diagnostic proves the startup attempt ran;
    // stdout alone and an absent state file are not successful evidence.
    assert.equal(unavailableRecorded(), true);
  }
  if (unavailableProbe)
    assert.equal(readFileSync(probeObserved, "utf8"), "exit 17");
  await invokeNative("agent.close", { contextId: opened.contextId });
  const denied = await invokeNative(
    "agent.run.start",
    { contextId: opened.contextId, script: "return 1;", waitMs: 0 },
    "error",
  );
  assert.equal(denied.code, "context_closed");
  assert.equal(denied.message, "The Agent operation failed.");
  await until(() => {
    const offset = stderr.indexOf("native_cli_invoke_failed ");
    return offset >= 0 && stderr.slice(offset).includes("\n");
  });
  const originalFailure = stderr
    .split("\n")
    .find((line) => line.startsWith("native_cli_invoke_failed "));
  assert.ok(originalFailure, "The original CLI exception diagnostic was lost.");
  const diagnostic = JSON.parse(
    originalFailure.slice("native_cli_invoke_failed ".length),
  );
  assert.equal(diagnostic.operation, "agent.run.start");
  assert.equal(diagnostic.error.code, "context_closed");
  child.kill("SIGTERM");
  const exit = await exited.promise;
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
}
