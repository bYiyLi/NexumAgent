import { discoverMaterials } from "./helpers/discovery-reference.mjs";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const distribution = process.env.NEXUM_MATERIAL_QUOTA_DIST
  ? pathToFileURL(
      path.resolve(process.env.NEXUM_MATERIAL_QUOTA_DIST) + path.sep,
    )
  : new URL("../dist/", import.meta.url);
const load = (name) => import(new URL(name, distribution).href);
const { FixtureStore } = await load("../test/helpers/runtime-fixture.mjs");
const { ScriptCatalog } = await load("runtime/scripts.js");
const { ModuleLoader } = await load("runtime/modules.js");
const { ExecutionFixture } = await load("../test/helpers/runtime-fixture.mjs");
const { WorkService } = await import("./helpers/work-reference.mjs");
const { ExtensionMaterials } = await load("extensions/materials.js");
const { inspectExtensionPackage } = await load("extensions/packages.js");
const caller = { principalId: "user", clientId: "client", grantId: "grant" };
const deferred = () => Promise.withResolvers();
async function enteredWithin(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("expected admission barrier was not reached")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function write(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(
    filename,
    typeof value === "object" && !Buffer.isBuffer(value)
      ? JSON.stringify(value)
      : value,
  );
}
function files(directory) {
  const result = new Map();
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory())
      for (const [name, bytes] of files(filename)) result.set(name, bytes);
    else if (entry.isFile()) result.set(filename, readFileSync(filename));
  }
  return result;
}
function admissionRecorder(directory) {
  const admissions = [];
  return {
    admissions,
    reserve: async (bytes) => {
      assert.ok(
        admissions.every((entry) => entry.released),
        "writes must settle before releasing admission",
      );
      const before = files(directory());
      const entry = { bytes, released: false };
      admissions.push(entry);
      return {
        release() {
          assert.equal(entry.released, false);
          const changed = [...files(directory())].filter(
            ([name, bytes]) => !before.get(name)?.equals(bytes),
          );
          assert.equal(
            changed.length,
            1,
            "one admitted body must be completely written before release",
          );
          assert.equal(changed[0][1].length, bytes);
          entry.name = changed[0][0];
          entry.body = changed[0][1];
          entry.released = true;
        },
      };
    },
  };
}
function baseFixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-material-quota-")),
  );
  const work = root,
    project = path.join(root, "project");
  mkdirSync(work, { recursive: true });
  mkdirSync(project);
  write(path.join(work, "package.json"), { type: "module" });
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, work, project, cleanup: (fn) => cleanups.push(fn) };
}
function workFixture(t, options = {}) {
  const f = baseFixture(t);
  const store = new FixtureStore(f.root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const scripts = new ScriptCatalog(f.work, "agent");
  const policy = { builtins: () => [], approvedPackages: () => new Map() };
  let allowed = true,
    reserve = options.reserve;
  const service = new WorkService(store, scripts, policy, {
      discover: discoverMaterials,
    home: null,
    agent: { name: "资料测试 🧪", version: "0.0.1", protocolVersion: "2" },
    authorize() {
      if (!allowed)
        throw Object.assign(new Error("revoked"), { code: "forbidden" });
    },
    resolveProject: async () => ({
      project: { projectId: "project", name: "项目", root: f.project },
      disabledItems: [],
    }),
    reserve: (bytes) => reserve?.(bytes),
    ...options.workOptions,
  });
  const lifetime = new AbortController();
  f.cleanup(async () => {
    lifetime.abort();
    await service.drain();
    store.close();
  });
  return {
    ...f,
    store,
    scripts,
    policy,
    service,
    open: (input = {}, signal = lifetime.signal) =>
      service.open(caller, { agentId: "agent", ...input }, signal),
    revoke: () => {
      allowed = false;
    },
    setReserve: (fn) => {
      reserve = fn;
    },
    snapshots: path.join(f.work, "tmp", "contexts"),
  };
}
async function extensionFixture(t, options = {}) {
  const f = baseFixture(t),
    name = "@test/quota",
    version = "1.0.0",
    namespace = "quota";
  const source = path.join(f.work, "node_modules", ...name.split("/"));
  write(path.join(f.work, "package.json"), {
    type: "module",
    dependencies: { [name]: version },
  });
  write(path.join(source, "package.json"), {
    name,
    version,
    type: "module",
    exports: {
      "./nexum": { types: "./dist/nexum.d.ts", import: "./dist/nexum.js" },
    },
    nexum: {
      apiVersion: 1,
      namespace,
      permissions: [],

      instructions: "./rules.md",
      scripts: "./flows",
      skills: "./skills",
    },
  });
  write(
    path.join(source, "dist/nexum.js"),
    "export default function(){return {methods:{}};}\n",
  );
  write(
    path.join(source, "dist/nexum.d.ts"),
    "export default function(): unknown;\n",
  );
  write(
    path.join(source, "skills/review/references/manual/README.md"),
    "# 中文 🧪\n[guide](guide.md)\n![bytes](bytes.bin)\n",
  );
  write(path.join(source, "skills/review/references/manual/guide.md"), "# 使用方法\n");
  write(path.join(source, "skills/review/references/manual/bytes.bin"), Buffer.from([0, 255, 1, 128]));
  write(
    path.join(source, "rules.md"),
    "# 必须遵守\n[manual](skills/review/references/manual/README.md)\n",
  );
  write(
    path.join(source, "flows/report.js"),
    '/** {"scriptName":"report.js","scriptDesc":"报告","scriptWhenUse":"组合","scriptInputSchema":{"type":"object"}} */\nreturn 1;\n',
  );
  write(
    path.join(source, "skills/review/SKILL.md"),
    "---\nname: review\ndescription: Review this extension.\n---\n# Review\n[manual](references/manual/README.md)\n",
  );
  const policy = {
    builtins: () => [],
    approvedPackages: () => new Map([[name, version]]),
  };
  const loader = await ModuleLoader.create(f.work, "quota-test", policy);
  const descriptor = await inspectExtensionPackage({
    work: f.work,
    packageName: name,
    policy,
    permissions: new Set(),
    resolveImport: loader.resolveImport.bind(loader),
  });
  const handle = {
    id: "handle-quota",
    origin: descriptor.source.origin,
    methods: [
      {
        name: "inspect",
        path: ["inspect"],
        description: "Inspect",
        permissions: [],
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ],
  };
  const materials = new ExtensionMaterials(
    f.work,
    typeof options === "function" ? options(f) : options,
  );
  return {
    ...f,
    source,
    descriptor,
    handle,
    materials,
    reading: path.join(f.work, "cache", "materials", "extensions"),
  };
}

for (const project of [false, true])
  test(`Work ${project ? "Project" : "Agent"} snapshot admits every complete UTF-8 body before writing`, async (t) => {
    const f = workFixture(t),
      recorder = admissionRecorder(() => f.snapshots);
    f.setReserve(recorder.reserve);
    const opened = await f.open(project ? { projectId: "project" } : {});
    assert.equal(opened.revision, 1);
    assert.equal(recorder.admissions.length, project ? 4 : 3);
    assert.deepEqual(
      recorder.admissions.map((item) => path.basename(item.name)),
      project
        ? ["agent.json", "scripts.md", "project.json", "bundle.json"]
        : ["agent.json", "scripts.md", "bundle.json"],
    );
    assert.equal(
      [...files(f.snapshots).values()].reduce(
        (sum, bytes) => sum + bytes.length,
        0,
      ),
      recorder.admissions.reduce((sum, item) => sum + item.bytes, 0),
    );
  });

for (const failure of [1, 2, 3, 4])
  test(`Work denial at snapshot body ${failure} publishes no work or failed snapshot`, async (t) => {
    const denied = new Error("quota denied"),
      f = workFixture(t);
    let calls = 0,
      releases = 0;
    f.setReserve(async () => {
      if (++calls === failure) throw denied;
      return {
        release() {
          releases++;
        },
      };
    });
    await assert.rejects(
      f.open({ projectId: "project" }),
      (error) => error === denied,
    );
    assert.equal(calls, failure);
    assert.equal(releases, failure - 1);
    assert.deepEqual([...files(f.snapshots)], []);
    assert.equal(f.store.workSnapshotRefs().size, 0);
  });

test("Work rechecks current authorization after admission waits and releases without writing", async (t) => {
  const entered = deferred(),
    resume = deferred(),
    f = workFixture(t);
  let releases = 0;
  f.setReserve(async () => {
    entered.resolve();
    await resume.promise;
    return {
      release() {
        releases++;
      },
    };
  });
  const pending = f.open({ projectId: "project" });
  try {
    await enteredWithin(entered.promise);
    assert.deepEqual([...files(f.snapshots)], []);
    f.revoke();
    resume.resolve();
    await assert.rejects(pending, { code: "forbidden" });
    assert.equal(releases, 1);
    assert.deepEqual([...files(f.snapshots)], []);
    assert.equal(f.store.workSnapshotRefs().size, 0);
  } finally {
    resume.resolve();
    await pending.catch(() => {});
    await f.service.drain();
  }
});

test("Work cancellation during admission joins actual cleanup before releasing its reservation", async (t) => {
  const entered = deferred(),
    resume = deferred(),
    f = workFixture(t),
    controller = new AbortController();
  let releases = 0;
  f.setReserve(async () => {
    entered.resolve();
    await resume.promise;
    return {
      release() {
        releases++;
      },
    };
  });
  const pending = f.open({}, controller.signal);
  const rejection = assert.rejects(pending, { name: "AbortError" });
  try {
    await enteredWithin(entered.promise);
    controller.abort();
    await rejection;
    assert.equal(
      releases,
      0,
      "an aborted observer cannot claim in-flight allocation was released",
    );
    resume.resolve();
    await f.service.drain();
    assert.equal(releases, 1);
    assert.deepEqual([...files(f.snapshots)], []);
  } finally {
    controller.abort();
    resume.resolve();
    await rejection;
    await f.service.drain();
  }
});

test("ExtensionMaterials admits actual copied, generated and manifest bytes, then holds until withdrawal", async (t) => {
  let reading;
  const recorder = admissionRecorder(() => reading);
  const f = await extensionFixture(t, { reserve: recorder.reserve });
  reading = f.reading;
  const prepared = await f.materials.prepare(f.descriptor, f.handle);
  assert.deepEqual(f.materials.published(), {
    instructions: [],
    skills: [],
  });
  assert.equal(f.materials.activeDirectories().has(prepared.directory), true);
  assert.equal(
    recorder.admissions.every((item) => item.released),
    true,
  );
  assert.equal(path.basename(recorder.admissions.at(-1).name), "manifest.json");
  const actual = files(prepared.directory);
  assert.equal(actual.size, recorder.admissions.length);
  assert.equal(
    [...actual.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    recorder.admissions.reduce((sum, item) => sum + item.bytes, 0),
  );
  assert.deepEqual(
    readFileSync(path.join(prepared.directory, "skills/review/references/manual/bytes.bin")),
    Buffer.from([0, 255, 1, 128]),
  );
  const manifest = JSON.parse(
    readFileSync(path.join(prepared.directory, "manifest.json"), "utf8"),
  );
  for (const item of manifest.files)
    assert.equal(
      actual.get(path.join(prepared.directory, item.path)).length,
      item.size,
    );
  f.materials.publish(prepared);
  assert.equal(f.materials.published().skills.length, 2);
  f.materials.withdraw(f.handle.id);
  assert.deepEqual([...f.materials.activeDirectories()], []);
});

test("ExtensionMaterials rejects before every copied/generated/manifest body and releases only accepted reservations", async (t) => {
  const baseline = await extensionFixture(t),
    prepared = await baseline.materials.prepare(
      baseline.descriptor,
      baseline.handle,
    );
  const bodyCount = files(prepared.directory).size;
  for (let failure = 1; failure <= bodyCount; failure++) {
    const denied = new Error(`quota body ${failure}`);
    let calls = 0,
      releases = 0;
    const f = await extensionFixture(t, {
      reserve: async () => {
        if (++calls === failure) throw denied;
        return {
          release() {
            releases++;
          },
        };
      },
    });
    await assert.rejects(
      f.materials.prepare(f.descriptor, f.handle),
      (error) => error === denied,
    );
    assert.equal(calls, failure);
    assert.equal(releases, failure - 1);
    assert.deepEqual([...files(f.reading)], []);
    assert.deepEqual([...f.materials.activeDirectories()], []);
    assert.deepEqual(f.materials.published(), {
      instructions: [],
      skills: [],
    });
  }
});

test("ExtensionMaterials abort during manifest admission releases after no manifest write and no publication", async (t) => {
  const baseline = await extensionFixture(t),
    prepared = await baseline.materials.prepare(
      baseline.descriptor,
      baseline.handle,
    );
  const bodyCount = files(prepared.directory).size,
    entered = deferred(),
    resume = deferred(),
    controller = new AbortController();
  let calls = 0,
    releases = 0;
  const f = await extensionFixture(t, {
    reserve: async () => {
      if (++calls === bodyCount) {
        entered.resolve();
        await resume.promise;
      }
      return {
        release() {
          releases++;
        },
      };
    },
  });
  const pending = f.materials.prepare(
    f.descriptor,
    f.handle,
    controller.signal,
  );
  try {
    await enteredWithin(entered.promise);
    assert.equal(
      [...files(f.reading).keys()].some(
        (name) => path.basename(name) === "manifest.json",
      ),
      false,
    );
    controller.abort();
    resume.resolve();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(calls, bodyCount);
    assert.equal(releases, bodyCount);
    assert.deepEqual([...files(f.reading)], []);
    assert.deepEqual([...f.materials.activeDirectories()], []);
  } finally {
    controller.abort();
    resume.resolve();
    await pending.catch(() => {});
  }
});
test("ExtensionMaterials failed manifest I/O releases its actual admission and cleans its private stage", async (t) => {
  let admissions = 0,
    releases = 0;
  const f = await extensionFixture(t, {
    reserve: async () => {
      admissions++;
      return {
        release() {
          releases++;
        },
      };
    },
  });
  const original = filesystem.writeFile,
    failed = new Error("disk write failed");
  filesystem.writeFile = async (...args) => {
    if (path.basename(String(args[0])) === "manifest.json") throw failed;
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.materials.prepare(f.descriptor, f.handle),
      (error) => error === failed,
    );
    assert.equal(releases, admissions);
    assert.deepEqual([...files(f.reading)], []);
    assert.deepEqual([...f.materials.activeDirectories()], []);
  } finally {
    filesystem.writeFile = original;
    syncBuiltinESMExports();
  }
});

test("real accepted Run scope protects an old Work/catalog snapshot across refresh and close", async (t) => {
  const f = workFixture(t);
  let engine;
  const service = new WorkService(f.store, f.scripts, f.policy, {
      discover: discoverMaterials,
    home: null,
    agent: { name: "Agent", version: "1", protocolVersion: "2" },
    authorize() {},
    resolveProject: async () => {
      throw new Error("no Project");
    },
  });
  f.cleanup(() => service.drain());
  const opened = await service.open(
    caller,
    { agentId: "agent" },
    AbortSignal.timeout(5000),
  );
  const old = f.store.getWork(opened.contextId),
    oldDirectory = path.dirname(path.join(f.root, old.snapshotRef));
  const loader = await ModuleLoader.create(f.work, f.store.bootId, f.policy),
    entered = deferred(),
    resume = deferred();
  engine = new ExecutionFixture(f.store, loader, f.scripts, {
    authorize() {},
    loadWork: (record) => service.load(record),
    bindings: () => ({
      wait: async () => {
        entered.resolve();
        await resume.promise;
      },
    }),
    encodeResult: async (value) => ({ content: [], data: value }),
  });
  const started = await engine.start(caller, {
    contextId: opened.contextId,
    script: "await wait(); return 1;",
    waitMs: 0,
  });
  try {
    await enteredWithin(entered.promise);
    assert.equal(engine.activeSnapshotRefs().has(old.snapshotRef), true);
    write(path.join(f.work, "AGENTS.md"), "new mandatory generation");
    await service.open(
      caller,
      { agentId: "agent", contextId: opened.contextId },
      AbortSignal.timeout(5000),
    );
    service.close(caller, opened.contextId);
    assert.equal(existsSync(oldDirectory), true);
    resume.resolve();
    const finished = await engine.observe(caller, started.run.runId, 3000);
    assert.equal(finished.run.status, "succeeded");
    assert.equal(engine.activeSnapshotRefs().size, 0);
  } finally {
    resume.resolve();
    await engine.observe(caller, started.run.runId, 3000);
  }
});

test("Work failed atomic I/O releases admission and preserves its previous published revision", async (t) => {
  const f = workFixture(t),
    original = await f.open();
  const previous = f.store.getWork(original.contextId);
  let releases = 0;
  f.setReserve(async () => {
    const directories = readdirSync(f.snapshots).filter(
      (name) => name !== path.basename(path.dirname(previous.snapshotRef)),
    );
    assert.equal(directories.length, 1);
    mkdirSync(path.join(f.snapshots, directories[0], "agent.json"));
    return {
      release() {
        releases++;
      },
    };
  });
  await assert.rejects(f.open({ contextId: original.contextId }));
  assert.equal(releases, 1);
  assert.equal(f.store.getWork(original.contextId).revision, 1);
  assert.equal(
    f.store.getWork(original.contextId).snapshotRef,
    previous.snapshotRef,
  );
  assert.deepEqual(readdirSync(f.snapshots), [
    path.basename(path.dirname(previous.snapshotRef)),
  ]);
});

test("pending extension preparation remains private and withdrawal removes its current tree immediately", async (t) => {
  const entered = deferred(), resume = deferred();
  let calls = 0, releases = 0;
  const f = await extensionFixture(t, { reserve: async () => {
    if (++calls === 1) { entered.resolve(); await resume.promise; }
    return { release() { releases++; } };
  }});
  const pending = f.materials.prepare(f.descriptor, f.handle);
  try {
    await enteredWithin(entered.promise);
    assert.ok([...f.materials.activeDirectories()].some(dir => path.basename(dir).startsWith(".prepare-")));
    assert.deepEqual(f.materials.published(), { instructions: [], skills: [] });
    resume.resolve();
    const prepared = await pending;
    assert.equal(releases, calls);
    f.materials.publish(prepared);
    assert.equal(existsSync(prepared.materials.skills[0].skillFile), true);
    f.materials.withdraw(f.handle.id);
    assert.equal(existsSync(prepared.directory), false);
    assert.deepEqual([...f.materials.activeDirectories()], []);
  } finally {
    resume.resolve();
    await pending.catch(() => {});
  }
});
