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
import { fileURLToPath } from "node:url";
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
      timeout: 10_000,
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
  assert.equal(result.status, 0);
  assert.match(result.stderr, /vm_modules_required/);
});

test(
  "the native CLI connects its isolated development profile, runs real VM code and closes on an OS signal",
  {
    skip:
      process.platform === "win32"
        ? "Windows OS service stop is verified by its native service harness"
        : false,
  },
  async (t) => {
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
          if (
            message.type === "invoke" &&
            message.operation === "authorization.refresh"
          )
            peer.send(
              JSON.stringify({
                type: "result",
                id: message.id,
                output: {
                  authorization: {
                    ...message.context.authorization,
                    expiresAt: new Date(Date.now() + 30000).toISOString(),
                  },
                },
              }),
            );
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
    child = spawn(
      process.execPath,
      ["--experimental-vm-modules", cli, "run", "--profile", "development"],
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
      const deadline = Date.now() + 15000;
      while (!condition()) {
        assert.equal(child.exitCode, null, stderr);
        assert.ok(
          Date.now() < deadline,
          stderr || "The actual CLI did not become ready.",
        );
        await delay(10);
      }
    }
    await until(() => stderr.includes("agent_connected"));
    let sequence = 0;
    async function invokeNative(operation, input) {
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
          expiresAt: new Date(Date.now() + 30000).toISOString(),
        },
      };
      socket.send(
        JSON.stringify({ type: "invoke", id, operation, context, input }),
      );
      await until(() => received.has(id));
      const response = received.get(id);
      assert.equal(response.type, "result", JSON.stringify(response));
      return response.output;
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
    await until(() => existsSync(gitState));
    const saved = JSON.parse(readFileSync(gitState, "utf8"));
    assert.equal(saved.schemaVersion, 1);
    const snapshot = saved.result;
    if (snapshot.status === "committed")
      assert.match(snapshot.commit, /^[0-9a-f]{40,64}$/);
    else {
      assert.equal(snapshot.status, "unavailable", JSON.stringify(snapshot));
      assert.equal(snapshot.reason, "git_unavailable");
    }
    child.kill("SIGTERM");
    const exit = await exited.promise;
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  },
);
