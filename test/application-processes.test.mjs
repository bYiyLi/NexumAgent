import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AgentError } from "../dist/contracts/errors.js";
import { callerKey } from "../dist/contracts/caller.js";
import { canonicalJson } from "../dist/contracts/json.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { ManagedProcess } from "../dist/process/managed.js";
import { normalizeLaunch } from "../dist/process/launch.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine } from "../dist/runtime/engine.js";
import { ProfileRetention } from "../dist/runtime/retention.js";
import { ArtifactStore } from "../dist/results/artifacts.js";
import {
  CONTROL_OWNER,
  CONTROL_VERSION,
} from "../dist/runtime/control-scripts.js";
import { shExtension } from "../dist/sdk/sh.js";
import { AgentAuthority } from "../dist/application/authority.js";
import { ApplicationProcesses } from "../dist/application/processes.js";

const caller = { principalId: "owner", clientId: "host", grantId: "grant" };
const sessionRef = "a".repeat(64);
const owner = {
  principalId: "owner",
  clientId: `nexum-console:${sessionRef}`,
  source: "owner_session",
  sessionRef,
};
const origin = {
  type: "platform",
  owner: CONTROL_OWNER,
  namespace: "sh",
  version: CONTROL_VERSION,
  revision: CONTROL_VERSION,
};
async function bounded(promise, ms = 5000) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: controller.signal }).then(() => {
        throw new Error("The native process fixture did not settle.");
      }),
    ]);
  } finally {
    controller.abort();
  }
}
async function fixture(t) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-console-process-")),
    ),
    work = path.join(root, "work"),
    a = path.join(root, "project-a"),
    b = path.join(root, "project-b");
  for (const directory of [work, a, b]) mkdirSync(directory);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const store = new SqliteStore(root, {
      agentId: "agent",
      profile: "development",
      cloudEnvironment: "development",
    }),
    resources = new ResourceManager(store, { cleanupTimeoutMs: 30 }),
    retention = new ProfileRetention(store, new ArtifactStore(root, "agent")),
    registry = new ExtensionRegistry(resources, {
      permissions: new Set([
        "sh.execute",
        "sh.read",
        "sh.control",
        "storage.reserve",
      ]),
      authorize() {},
      log() {},
      progress() {},
      storage: { reserve: (bytes) => retention.reserve(bytes) },
    }),
    handle = await registry.prepare(
      {
        apiVersion: 1,
        origin,
        permissions: ["sh.execute", "sh.read", "sh.control", "storage.reserve"],
      },
      shExtension,
    );
  registry.publish(handle);
  const modules = await ModuleLoader.create(work, store.bootId, {
      builtins: () => [],
      approvedPackages: () => new Map(),
    }),
    engine = new RunEngine(store, modules, new ScriptCatalog(work, "agent"), {
      resources,
      authorize(who, target) {
        if (target.run && target.run.callerKey !== callerKey(who))
          throw new AgentError("forbidden", "Wrong originating caller.");
      },
      loadWork: () => ({}),
      bindings: (services) => registry.bindings(services),
      encodeResult: async (value) => ({
        content: [],
        data: JSON.parse(canonicalJson(value)),
      }),
    }),
    contexts = Object.fromEntries(
      [
        ["project-a", a],
        ["project-b", b],
      ].map(([projectId, pwd]) => [
        projectId,
        store.openWork({
          callerKey: callerKey(caller),
          projectId,
          pwd,
          snapshotRef: "work/snapshot.json",
        }),
      ]),
    ),
    authority = new AgentAuthority(
      { ...store.binding, bootId: store.bootId },
      work,
    );
  const binding = {
    ...store.binding,
    bootId: store.bootId,
    connectionId: "console-process-connection",
  };
  authority.connect(binding);
  const policy = (roots = [a, b], projectId = null) =>
    authority.observe({
      caller: owner,
      connection: binding,
      authorization: {
        agentId: "agent",
        allowedRoots: roots,
        budgets: {},
        revision: "current-owner-policy",
        expiresAt: new Date(Date.now() + 25000).toISOString(),
        ...(projectId
          ? {
              projectId,
              projectRoot: projectId === "project-a" ? a : b,
              projectName: projectId,
            }
          : {}),
      },
    });
  policy();
  let failure, deniedId;
  const authorize = (who, row, action) => {
    assert.equal(who.source, "owner_session");
    if (who.principalId !== "owner")
      throw new AgentError(
        "forbidden",
        "Another owner cannot access these processes.",
      );
    authority.authorize(who, undefined, null);
    if (!row) return;
    if (failure) throw failure;
    if (row.resourceId === deniedId)
      throw new AgentError("forbidden", "Current resource access was removed.");
    const run = store.getRun(row.originRunId),
      context = store.getWork(run.contextId);
    authority.authorize(
      who,
      { type: "path", value: context.pwd, access: "read" },
      null,
    );
    if (typeof row.diagnostic.details?.cwd === "string")
      authority.authorize(
        who,
        { type: "path", value: row.diagnostic.details.cwd, access: "read" },
        null,
      );
    authority.authorize(
      who,
      {
        type: "resource",
        value: row.resourceId,
        access: action === "stop" ? "stop" : "read",
      },
      null,
    );
  };
  const processes = new ApplicationProcesses(resources, {
      authorize,
      now: () => 1234,
    }),
    instances = [];
  const start = async (script, input, projectId = "project-a") => {
    const result = await engine.start(caller, {
      contextId: contexts[projectId].contextId,
      script,
      input,
      waitMs: 3000,
    });
    assert.equal(
      result.run.status,
      "succeeded",
      JSON.stringify(result.run.error),
    );
    return result;
  };
  async function native(ignoreTerm = false) {
    const started = await start("return await sh.start(context.input);", {
      command: process.execPath,
      args: [
        "-e",
        `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}process.stdout.write('ready');setInterval(()=>{},1000);`,
      ],
      background: true,
    });
    const processId = started.result.data.processId;
    const output = await start("return await sh.get(context.input);", {
      processId,
      waitMs: 2000,
      maxBytes: 1000,
    });
    assert.match(JSON.stringify(output.result.data.output), /ready/);
    return { processId, run: started.run };
  }
  async function cold({
    projectId = "project-a",
    source = origin,
    details = {},
  } = {}) {
    const context = contexts[projectId];
    let run = store.acceptRun({
      callerKey: callerKey(caller),
      contextId: context.contextId,
      sourceKind: "inline",
      source: {},
    }).run;
    run = store.transitionRun(run.runId, run.revision, "preparing_inputs");
    run = store.transitionRun(run.runId, run.revision, "running");
    const signal = new AbortController(),
      instance = resources.instance(source, {
        signal: signal.signal,
        assertActive() {},
        authorize() {},
      });
    instances.push(instance);
    const api = instance.bind({
        runId: run.runId,
        signal: signal.signal,
        assertActive() {
          signal.signal.throwIfAborted();
        },
        authorize() {},
      }),
      managed = new ManagedProcess(
        root,
        normalizeLaunch(
          [{ command: process.execPath, args: [], cwd: context.pwd }],
          "start",
        ),
        "start",
      ),
      ref = await api.register({ kind: "sh.process", value: managed });
    managed.bind(ref);
    ref.report({ ...managed.details(), cwd: context.pwd, ...details });
    return { ref, managed, api, run };
  }
  t.after(async () => {
    const cleanup = await resources.shutdown();
    if (cleanup.unconfirmed.length)
      await bounded(
        Promise.all(
          cleanup.unconfirmed.map(async (item) => {
            while (store.getResource(item.id).closedAt === null)
              await once(resources, "change");
          }),
        ),
      );
    for (const instance of instances) await instance.stop();
    await registry.disable(handle);
    await retention.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    a,
    b,
    store,
    resources,
    authority,
    binding,
    processes,
    contexts,
    policy,
    native,
    cold,
    failWith(value) {
      failure = value;
    },
    denyResource(id) {
      deniedId = id;
    },
  };
}

test("Console controls the actual background resource after Project closure without creating another Run", async (t) => {
  const f = await fixture(t),
    { processId, run } = await f.native();
  assert.equal(run.status, "succeeded");
  f.store.closeWork(f.contexts["project-a"].contextId, callerKey(caller));
  const count = f.store.listRuns({}, "test", 100).runs.length;
  const before = f.processes.get(owner, { processId });
  assert.equal(before.projectId, "project-a");
  assert.equal(before.lifetime, "background");
  assert.equal(before.controlAvailable, true);
  assert.equal(before.closedAt, null);
  assert.equal(before.details.rootExited, false);
  assert.equal(before.details.cwd, f.a);
  const page = f.processes.list(owner, { projectId: "project-a" });
  assert.equal(page.observedAt, 1234);
  assert.deepEqual(
    page.items.map((item) => item.processId),
    [processId],
  );
  const changed = once(f.resources, "change");
  const stopped = await f.processes.stop(owner, { processId });
  assert.equal(stopped.accepted, true);
  if (stopped.item.closedAt === null) {
    await bounded(changed);
    await bounded(
      (async () => {
        while (f.store.getResource(processId).closedAt === null)
          await once(f.resources, "change");
      })(),
    );
  }
  const actual = f.processes.get(owner, { processId });
  assert.notEqual(actual.closedAt, null);
  assert.equal(actual.details.closed, true);
  assert.equal(actual.details.treeStopped, true);
  assert.equal(actual.controlAvailable, false);
  assert.equal((await f.processes.stop(owner, { processId })).accepted, false);
  assert.equal(f.store.listRuns({}, "test", 100).runs.length, count);
  assert.equal(
    f.store.getWork(f.contexts["project-a"].contextId).status,
    "closed",
  );
  assert.equal(JSON.stringify(actual).includes("setInterval"), false);
});

test(
  "bounded stop reports unknown closure while a real POSIX process still ignores SIGTERM",
  {
    skip:
      process.platform === "win32"
        ? "The POSIX signal grace fixture uses SIGTERM handlers."
        : false,
  },
  async (t) => {
    const f = await fixture(t),
      { processId } = await f.native(true);
    const stopped = await f.processes.stop(owner, { processId });
    assert.equal(stopped.accepted, true);
    assert.equal(stopped.item.closedAt, null);
    assert.equal(stopped.item.details.closed, false);
    assert.equal(stopped.item.details.stopRequested, true);
    assert.equal(stopped.item.status, "unconfirmed");
    await bounded(
      (async () => {
        while (f.store.getResource(processId).closedAt === null)
          await once(f.resources, "change");
      })(),
    );
    assert.notEqual(f.processes.get(owner, { processId }).closedAt, null);
  },
);

test("fresh Agent roots govern Console access without borrowing another Project policy cell", async (t) => {
  const f = await fixture(t),
    current = await f.cold();
  f.policy([f.a], "project-b"); // A different Project cell cannot grant Agent-wide access.
  f.policy([]);
  assert.throws(() => f.processes.get(owner, { processId: current.ref.id }), {
    code: "path_not_allowed",
  });
  await assert.rejects(f.processes.stop(owner, { processId: current.ref.id }), {
    code: "path_not_allowed",
  });
  assert.deepEqual(f.processes.list(owner).items, []);
  f.policy([f.a]);
  assert.equal(
    f.processes.get(owner, { processId: current.ref.id }).controlAvailable,
    true,
  );
  f.authority.revoke(owner);
  assert.throws(() => f.processes.list(owner), { code: "forbidden" });
});

test("only current-boot built-in resource identities are accepted and private Core ports do not enter SDK facades", async (t) => {
  const f = await fixture(t),
    current = await f.cold(),
    external = await f.cold({
      source: { ...origin, type: "extension", owner: "@fixture/external" },
    });
  assert.equal(Object.hasOwn(current.api, "inspectResource"), false);
  assert.equal(Object.hasOwn(current.api, "disposeResource"), false);
  assert.throws(() => f.processes.get(caller, { processId: current.ref.id }), {
    code: "forbidden",
  });
  assert.throws(
    () => f.processes.get(owner, { processId: String(process.pid) }),
    { code: "invalid_process_id" },
  );
  await assert.rejects(
    f.processes.stop(owner, { processId: external.ref.id }),
    { code: "process_unavailable" },
  );
  assert.deepEqual(
    f.processes.list(owner).items.map((item) => item.processId),
    [current.ref.id],
  );
  const snapshot = f.processes.get(owner, { processId: current.ref.id });
  snapshot.details.cwd = "modified-copy";
  assert.equal(
    f.processes.get(owner, { processId: current.ref.id }).details.cwd,
    f.a,
  );
  await f.resources.shutdown();
  f.store.close();
  const nextBoot = "boot_" + "b".repeat(32),
    newStore = new SqliteStore(f.root, f.store.binding, Date.now(), nextBoot),
    newManager = new ResourceManager(newStore);
  t.after(() => newStore.close());
  const after = new ApplicationProcesses(newManager, { authorize() {} });
  assert.throws(() => after.get(owner, { processId: current.ref.id }), {
    code: "resource_unavailable",
  });
  await assert.rejects(after.stop(owner, { processId: current.ref.id }), {
    code: "resource_unavailable",
  });
  assert.deepEqual(after.list(owner).items, []);
});

test("history pagination obeys whole-page bytes, current denials and opaque caller/filter binding", async (t) => {
  const f = await fixture(t),
    ids = [];
  for (let n = 0; n < 7; n++)
    ids.push(
      (
        await f.cold({
          details: {
            executable: "x".repeat(14000),
            command: "must-not-leak",
            env: { TOKEN: "must-not-leak" },
          },
        })
      ).ref.id,
    );
  const other = await f.cold({ projectId: "project-b" });
  f.denyResource(ids[0]);
  let page = f.processes.list(owner, { projectId: "project-a", limit: 100 });
  assert(page.nextCursor);
  assert(Buffer.byteLength(JSON.stringify(page)) <= 65536);
  const seen = new Set();
  while (true) {
    for (const item of page.items) {
      assert(!seen.has(item.processId));
      seen.add(item.processId);
      assert(!JSON.stringify(item).includes("must-not-leak"));
      assert.equal(item.projectId, "project-a");
    }
    if (!page.nextCursor) break;
    assert.throws(
      () =>
        f.processes.list(owner, {
          projectId: "project-b",
          cursor: page.nextCursor,
        }),
      { code: "invalid_cursor" },
    );
    page = f.processes.list(owner, {
      projectId: "project-a",
      limit: 100,
      cursor: page.nextCursor,
    });
    assert(Buffer.byteLength(JSON.stringify(page)) <= 65536);
  }
  assert.equal(seen.size, 6);
  assert(!seen.has(other.ref.id));
  class SourceConfigError extends AgentError {}
  const failure = new SourceConfigError(
    "forbidden",
    "The authorization source configuration is broken.",
  );
  f.failWith(failure);
  assert.throws(
    () => f.processes.list(owner),
    (error) => error === failure,
  );
});
