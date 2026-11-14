/** Real signed payload under its native user service; ephemeral CI only. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { WebSocketServer } from "ws";
import {
  servicePlan,
  serviceAction,
  currentWindowsSid,
  childEnvironment,
  NODE_VERSION,
} from "./service.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.ok(process.env.RUNNER_TEMP);
const { values } = parseArgs({
  options: { home: { type: "string" }, "program-dir": { type: "string" } },
});
assert.ok(values.home && values["program-dir"]);
const temp = await realpath(process.env.RUNNER_TEMP),
  home = await realpath(values.home),
  program = await realpath(values["program-dir"]),
  root = path.join(home, ".nexum-dev"),
  entry = path.join(program, "app", "dist", "cli.js");
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
assert.ok(
  within(temp, home) && within(path.join(root, "program", "versions"), program),
);
assert.equal(path.basename(program).length, 64);
assert.match(path.basename(program), /^[0-9a-f]{64}$/);
const originalEntry = createHash("sha256")
  .update(await readFile(entry))
  .digest("hex");
const configPath = path.join(root, "config.json"),
  originalConfig = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(originalConfig.server_url, "http://127.0.0.1:9/");
assert.equal(originalConfig.token, "candidate-fixture-token");
if (process.platform === "linux") {
  const directory = `/run/user/${process.getuid()}`,
    info = await lstat(directory);
  assert.ok(info.isDirectory() && info.uid === process.getuid());
  process.env.XDG_RUNTIME_DIR = directory;
}
const plan = servicePlan({
  profile: "development",
  home,
  programDir: program,
  windowsSid: process.platform === "win32" ? currentWindowsSid() : undefined,
});
assert.equal(
  (await serviceAction(plan, "status", { isolatedHome: true })).registered,
  false,
  "The signed payload fixture must not replace an existing user service.",
);
const interrupted = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () =>
    interrupted.abort(new Error("Native payload CI interrupted.")),
  );
let failure,
  sequence = 0;
const peers = [],
  responses = new Map(),
  connections = new Set(),
  leaders = new Set();
const server = createServer(),
  wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 }),
  bindings = new WeakMap();
server.on("connection", (socket) => {
  connections.add(socket);
  socket.once("close", () => connections.delete(socket));
});
wss.on("headers", (headers, request) =>
  headers.push(
    "X-Nexum-Agent-Id: native-service-agent",
    "X-Nexum-Cloud-Environment: development",
    `X-Nexum-Connection-Id: ${bindings.get(request).connectionId}`,
  ),
);
server.on("upgrade", (request, socket, head) => {
  try {
    assert.equal(
      request.headers.authorization,
      "Bearer candidate-fixture-token",
    );
    assert.equal(request.headers["x-nexum-profile"], "development");
    assert.equal(request.headers["x-nexum-protocol-version"], "2");
    const binding = {
      agentId: "native-service-agent",
      profile: "development",
      cloudEnvironment: "development",
      connectionId: "native-service-" + randomUUID(),
      bootId: request.headers["x-nexum-boot-id"],
    };
    assert.equal(typeof binding.bootId, "string");
    bindings.set(request, binding);
    wss.handleUpgrade(request, socket, head, (peer) => {
      const current = { socket: peer, binding, closed: false };
      peers.push(current);
      peer.once("close", () => (current.closed = true));
      peer.on("error", () => {});
      peer.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === "result" || message.type === "error")
            responses.set(message.id, message);
          if (message.type === "invoke") {
            if (message.operation === "authorization.refresh")
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
            else
              peer.send(
                JSON.stringify({
                  type: "error",
                  id: message.id,
                  error: {
                    code: "fixture_unsupported",
                    message:
                      "This isolated service fixture does not implement that reverse operation.",
                  },
                }),
              );
          }
        } catch (error) {
          failure ??= error;
        }
      });
    });
  } catch (error) {
    failure ??= error;
    socket.destroy();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const source = `http://127.0.0.1:${server.address().port}`;
async function until(check, message, cleanup = false) {
  const end = performance.now() + 60000;
  while (performance.now() < end) {
    if (!cleanup) {
      interrupted.signal.throwIfAborted();
      if (failure) throw failure;
    }
    if (await check()) return;
    await delay(25);
  }
  throw new Error(message);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
function native(file, args) {
  return execFileSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    env: childEnvironment(),
    maxBuffer: 1024 * 1024,
  }).trim();
}
async function leader() {
  let pid;
  if (process.platform === "linux")
    pid = Number(
      native("systemctl", [
        "--user",
        "show",
        plan.label,
        "--property=MainPID",
        "--value",
      ]),
    );
  else if (process.platform === "darwin")
    pid = (await serviceAction(plan, "status", { isolatedHome: true })).pid;
  else {
    const node = path.join(program, "runtime", "node.exe"),
      literal = "'" + node.replaceAll("'", "''") + "'",
      output = native(
        path.join(
          process.env.SystemRoot,
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference='Stop';ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -eq ${literal}}|ForEach-Object{$_.ProcessId}) -Compress`,
        ],
      );
    const matches = JSON.parse(output);
    assert.equal(
      matches.length,
      1,
      "Only this installed fixture's actual native Node leader may match.",
    );
    pid = matches[0];
  }
  assert.ok(
    Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid),
  );
  leaders.add(pid);
  return pid;
}
async function invoke(peer, operation, input) {
  const id = `inv_native_service_${++sequence}`;
  peer.socket.send(
    JSON.stringify({
      type: "invoke",
      id,
      operation,
      input,
      context: {
        caller: {
          principalId: "native-service-owner",
          clientId: "native-service-fixture",
          grantId: "native-service-grant",
        },
        connection: peer.binding,
        authorization: {
          agentId: "native-service-agent",
          allowedRoots: [],
          budgets: {},
          revision: "one",
          expiresAt: new Date(Date.now() + 30000).toISOString(),
        },
      },
    }),
  );
  await until(
    () => responses.has(id),
    "The actual installed Agent did not answer its original invocation.",
  );
  const response = responses.get(id);
  responses.delete(id);
  assert.equal(response.type, "result", JSON.stringify(response));
  return response.output;
}
let installed = false;
try {
  await writeFile(
    configPath,
    JSON.stringify({ ...originalConfig, server_url: source }) + "\n",
    { mode: 0o600 },
  );
  installed = true; // Even an unknown registration result must be inspected during cleanup.
  await serviceAction(plan, "install", { isolatedHome: true });
  await serviceAction(plan, "start", { isolatedHome: true });
  await until(
    () => peers.length === 1,
    "The native service did not connect its actual installed CLI.",
  );
  const first = peers[0],
    opened = await invoke(first, "agent.open", {
      agentId: "native-service-agent",
    });
  assert.equal(opened.agent.runtime.nodeVersion, "v" + NODE_VERSION);
  assert.equal(opened.pwd, path.join(root, "work"));
  const firstPid = await leader();
  let result = await invoke(first, "agent.run.start", {
    contextId: opened.contextId,
    waitMs: 0,
    script: `const fs=await import('node:fs/promises'),path=await import('node:path');const file=path.join(context.pwd,'native-service-count.txt');let count=0;try{count=Number(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}await fs.writeFile(file,String(++count));return {answer:42,count};`,
  });
  const runId = result.run.runId;
  await until(async () => {
    if (result.run.endedAt !== null) return true;
    result = await invoke(first, "agent.run.get", {
      agentId: "native-service-agent",
      runId,
      waitMs: 1000,
    });
    return result.run.endedAt !== null;
  }, "The accepted installed-Agent Run did not finish.");
  assert.equal(result.run.status, "succeeded");
  assert.deepEqual(result.result.data, { answer: 42, count: 1 });
  await serviceAction(plan, "stop", { isolatedHome: true });
  await until(
    () => first.closed && !alive(firstPid),
    "The actual installed CLI did not close after native stop.",
  );
  await serviceAction(plan, "start", { isolatedHome: true });
  await until(
    () => peers.length === 2,
    "The actual installed CLI did not reconnect after native start.",
  );
  const second = peers[1];
  assert.notEqual(second.binding.bootId, first.binding.bootId);
  const history = await invoke(second, "agent.run.get", {
    agentId: "native-service-agent",
    runId,
    waitMs: 0,
  });
  assert.equal(history.run.status, "succeeded");
  assert.deepEqual(history.result.data, { answer: 42, count: 1 });
  assert.equal(
    await readFile(path.join(root, "work", "native-service-count.txt"), "utf8"),
    "1",
  );
  const secondPid = await leader();
  assert.notEqual(secondPid, firstPid);
  await serviceAction(plan, "stop", { isolatedHome: true });
  await until(
    () => second.closed && !alive(secondPid),
    "The second actual installed CLI did not close.",
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(entry))
      .digest("hex"),
    originalEntry,
  );
  console.log(
    JSON.stringify({
      stage: "installed-payload-service-passed",
      platform: process.platform,
      nodeVersion: NODE_VERSION,
      cliSha256: originalEntry,
      actualBoots: peers.length,
      historyReplayed: false,
    }),
  );
} finally {
  const cleanup = [];
  if (installed) {
    try {
      await serviceAction(plan, "remove", { isolatedHome: true });
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await until(
        async () =>
          !(await serviceAction(plan, "status", { isolatedHome: true }))
            .registered &&
          peers.every((peer) => peer.closed) &&
          [...leaders].every((pid) => !alive(pid)),
        "The installed payload fixture did not confirm native unregistration and all known leader closures.",
        true,
      );
    } catch (error) {
      cleanup.push(error);
    }
  }
  for (const peer of peers) peer.socket.terminate();
  for (const socket of connections) socket.destroy();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  console.log(
    JSON.stringify({
      stage: "installed-payload-service-cleanup",
      confirmed: cleanup.length === 0,
    }),
  );
  if (cleanup.length)
    throw new AggregateError(
      cleanup,
      "Native payload cleanup remains unconfirmed; retain its owned home.",
    );
}
