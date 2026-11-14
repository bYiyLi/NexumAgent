import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  Dir,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const distribution = process.env.NEXUM_MATERIAL_RETENTION_DIST
  ? pathToFileURL(
      path.resolve(process.env.NEXUM_MATERIAL_RETENTION_DIST) + path.sep,
    )
  : new URL("../dist/", import.meta.url);
const { MaterialRetention } = await import(
  new URL("runtime/material-retention.js", distribution).href
);
const grace = 7 * 86400000;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
async function enteredWithin(promise) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("the expected I/O barrier was not reached")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-material-retention-")),
  );
  mkdirSync(path.join(root, "work"));
  let now = 1700000000000;
  const live = new Set();
  const manager = new MaterialRetention(root, {
    now: () => now,
    liveSnapshotRefs: () => live,
    ...options,
  });
  const make = (relative, content = "fixed manual") => {
    const directory = path.join(root, relative);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "README.md"), content);
    return directory;
  };
  const catalog = (name = "catalog") =>
    make(path.join("work", "docs", ".catalog", hash(name)));
  const extension = (name = "extension") =>
    make(path.join("work", "docs", "extensions", name, "v1", hash(name)));
  const snapshot = (
    name = "snapshot",
    bundle = { view: {}, published: {} },
  ) => {
    const ref = `work/tmp/contexts/snapshot_${hash(name).slice(0, 32)}/bundle.json`;
    const directory = path.dirname(path.join(root, ref));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(root, ref), JSON.stringify(bundle));
    return { ref, directory, filename: path.join(root, ref) };
  };
  const markerFile = (directory) => {
    const ref = path.relative(root, directory).split(path.sep).join("/");
    return path.join(root, "state", "material-retention", `${hash(ref)}.json`);
  };
  const marker = (directory) =>
    JSON.parse(readFileSync(markerFile(directory), "utf8"));
  t.after(async () => {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    manager,
    live,
    catalog,
    extension,
    snapshot,
    marker,
    markerFile,
    now: () => now,
    advance: (milliseconds) => (now += milliseconds),
  };
}

async function retired(f, kind, directory) {
  const hold = await f.manager.hold(kind, directory);
  hold.release();
  await f.manager.sweep();
  assert.equal(f.marker(directory).unreferencedSince, f.now());
  f.advance(grace);
}

function gateSecondBundleRead(t, filename) {
  const entered = deferred(),
    resume = deferred();
  const original = filesystem.open;
  let reads = 0;
  filesystem.open = async (...args) => {
    if (String(args[0]) === filename && ++reads === 2) {
      entered.resolve();
      await resume.promise;
    }
    return original(...args);
  };
  syncBuiltinESMExports();
  const restore = () => {
    resume.resolve();
    filesystem.open = original;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return { entered: entered.promise, resume: resume.resolve, restore };
}

function gateDirectoryRead(t, directory) {
  const entered = deferred(),
    resume = deferred();
  const original = Dir.prototype.read;
  let gated = false;
  Dir.prototype.read = async function (...args) {
    const entry = await original.apply(this, args);
    if (!gated && String(this.path) === directory) {
      gated = true;
      entered.resolve();
      await resume.promise;
    }
    return entry;
  };
  const restore = () => {
    resume.resolve();
    Dir.prototype.read = original;
  };
  t.after(restore);
  return { entered: entered.promise, resume: resume.resolve, restore };
}

test("material retention stays cold until real lifecycle work is requested", async (t) => {
  const admissions = [];
  const f = fixture(t, {
    reserve: async (bytes) => {
      admissions.push(bytes);
      return { release() {} };
    },
  });
  assert.equal(existsSync(path.join(f.root, "state")), false);
  assert.deepEqual(await f.manager.sweep(0), {
    processed: 0,
    removed: 0,
    errors: [],
  });
  assert.deepEqual(await f.manager.sweep(), {
    processed: 0,
    removed: 0,
    errors: [],
  });
  assert.equal(existsSync(path.join(f.root, "state")), false);
  assert.deepEqual(admissions, []);
  assert.deepEqual([...f.manager.activeDirectories()], []);
});

test("owner retention is fixed per material generation across restart; legacy markers keep seven days", async (t) => {
  const f = fixture(t, { retentionMs: 100 }),
    existing = f.catalog("existing-policy"),
    legacy = f.catalog("legacy-policy");
  for (const directory of [existing, legacy]) {
    const hold = await f.manager.hold("catalog", directory);
    hold.release();
  }
  const old = f.marker(legacy);
  delete old.retentionMs;
  const bytes = Buffer.alloc(4096, 32);
  Buffer.from(JSON.stringify(old)).copy(bytes);
  writeFileSync(f.markerFile(legacy), bytes);
  await f.manager.sweep();
  await f.manager.stop();

  const restarted = new MaterialRetention(f.root, {
    now: f.now,
    liveSnapshotRefs: () => f.live,
    retentionMs: 20,
  });
  t.after(() => restarted.stop());
  const fresh = f.catalog("new-policy"),
    hold = await restarted.hold("catalog", fresh);
  hold.release();
  await restarted.sweep();
  assert.equal(f.marker(existing).retentionMs, 100);
  assert.equal(f.marker(fresh).retentionMs, 20);
  f.advance(20);
  await restarted.sweep();
  assert.equal(existsSync(fresh), false);
  assert.equal(existsSync(existing), true);
  assert.equal(existsSync(legacy), true);
  f.advance(80);
  await restarted.sweep();
  assert.equal(existsSync(existing), false);
  assert.equal(existsSync(legacy), true);
  f.advance(grace - 100);
  await restarted.sweep();
  assert.equal(existsSync(legacy), false);
});

test("each new private marker reserves exactly 4096 bytes before allocation and reuses its original file", async (t) => {
  const admissions = [];
  let f, directory;
  f = fixture(t, {
    reserve: async (bytes) => {
      assert.equal(existsSync(f.markerFile(directory)), false);
      const admission = { bytes, released: false };
      admissions.push(admission);
      return {
        release() {
          assert.equal(statSync(f.markerFile(directory)).size, 4096);
          admission.released = true;
        },
      };
    },
  });
  directory = f.catalog();
  const [first, second] = await Promise.all([
    f.manager.hold("catalog", directory),
    f.manager.hold("catalog", directory),
  ]);
  assert.deepEqual(admissions, [{ bytes: 4096, released: true }]);
  const before = statSync(f.markerFile(directory));
  const initial = f.marker(directory);
  assert.equal(initial.kind, "catalog");
  assert.equal(initial.unreferencedSince, null);
  assert.equal(
    initial.ref,
    path.relative(f.root, directory).split(path.sep).join("/"),
  );
  assert.equal(f.manager.setPublished("catalog", directory), undefined);
  first.release();
  second.release();
  f.advance(1);
  assert.equal(f.manager.setPublished("catalog", null), undefined);
  await f.manager.sweep();
  assert.equal(f.marker(directory).unreferencedSince, f.now());
  assert.equal(f.manager.setPublished("catalog", directory), undefined);
  const after = statSync(f.markerFile(directory));
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, 4096);
  assert.equal(f.marker(directory).unreferencedSince, null);
  assert.equal(admissions.length, 1);
  assert.deepEqual(readdirSync(path.dirname(f.markerFile(directory))), [
    path.basename(f.markerFile(directory)),
  ]);
});

test("denied marker admission creates no marker and clears its pending protection", async (t) => {
  const denied = new Error("profile quota exceeded");
  const f = fixture(t, {
    reserve: async () => {
      throw denied;
    },
  });
  const directory = f.catalog();
  await assert.rejects(
    f.manager.hold("catalog", directory),
    (error) => error === denied,
  );
  assert.equal(existsSync(f.markerFile(directory)), false);
  assert.deepEqual([...f.manager.activeDirectories()], []);
});

test("retired generations receive seven full days after the last active reference disappears", async (t) => {
  const f = fixture(t),
    directory = f.catalog();
  const hold = await f.manager.hold("catalog", directory);
  f.manager.setPublished("catalog", directory);
  hold.release();
  const snapshot = f.snapshot("active", {
    view: { agent: { docs: { entry: path.join(directory, "README.md") } } },
    published: {},
  });
  f.live.add(snapshot.ref);
  f.advance(1);
  f.manager.setPublished("catalog", null);
  assert.equal(f.marker(directory).unreferencedSince, null);
  f.advance(10 * 86400000);
  f.live.clear();
  assert.equal((await f.manager.sweep()).removed, 0);
  assert.equal(f.marker(directory).unreferencedSince, f.now());
  f.advance(grace - 1);
  assert.equal((await f.manager.sweep()).removed, 0);
  assert.equal(existsSync(directory), true);
  f.advance(1);
  assert.equal((await f.manager.sweep()).removed, 1);
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(f.markerFile(directory)), false);
});

test("real live bundles protect their own snapshot, catalog and all published material reference forms", async (t) => {
  const f = fixture(t),
    catalog = f.catalog();
  const docs = f.extension("docs"),
    instructions = f.extension("instructions"),
    skills = f.extension("skills");
  const snapshot = f.snapshot("references", {
    view: { agent: { docs: { entry: path.join(catalog, "README.md") } } },
    published: {
      docs: [{ path: path.join(docs, "README.md") }],
      instructions: [{ path: path.join(instructions, "README.md") }],
      skills: [{ skillFile: path.join(skills, "SKILL.md") }],
    },
  });
  const generations = [catalog, docs, instructions, skills, snapshot.directory];
  for (const directory of generations) {
    const kind =
      directory === catalog
        ? "catalog"
        : directory === snapshot.directory
          ? "work"
          : "extension";
    (await f.manager.hold(kind, directory)).release();
  }
  f.live.add(snapshot.ref);
  f.advance(10 * 86400000);
  assert.equal((await f.manager.sweep()).removed, 0);
  for (const directory of generations) {
    assert.equal(existsSync(directory), true);
    assert.equal(f.marker(directory).unreferencedSince, null);
  }
  f.live.clear();
  assert.equal((await f.manager.sweep()).removed, 0);
  for (const directory of generations)
    assert.equal(f.marker(directory).unreferencedSince, f.now());
  f.advance(grace);
  assert.equal((await f.manager.sweep()).removed, generations.length);
  for (const directory of generations)
    assert.equal(existsSync(directory), false);
});

test("a hold acquired during the final asynchronous live-reference inspection prevents deletion", async (t) => {
  const f = fixture(t),
    directory = f.catalog();
  await retired(f, "catalog", directory);
  const snapshot = f.snapshot("unrelated");
  f.live.add(snapshot.ref);
  const gate = gateSecondBundleRead(t, snapshot.filename);
  const sweeping = f.manager.sweep();
  let held;
  try {
    await enteredWithin(gate.entered);
    held = await f.manager.hold("catalog", directory);
    gate.resume();
    assert.equal((await sweeping).removed, 0);
    assert.equal(existsSync(directory), true);
    assert.equal(existsSync(f.markerFile(directory)), true);
    assert.equal(f.manager.activeDirectories().has(directory), true);
  } finally {
    gate.resume();
    try {
      await sweeping.catch(() => {});
      held?.release();
    } finally {
      gate.restore();
    }
  }
});

test("new holds and publication reject a generation while its deletion is in flight", async (t) => {
  const f = fixture(t),
    directory = f.catalog();
  await retired(f, "catalog", directory);
  const gate = gateDirectoryRead(t, directory);
  const sweeping = f.manager.sweep();
  try {
    await enteredWithin(gate.entered);
    await assert.rejects(f.manager.hold("catalog", directory));
    assert.throws(() => f.manager.setPublished("catalog", directory));
    assert.equal(f.marker(directory).unreferencedSince < f.now(), true);
    gate.resume();
    assert.equal((await sweeping).removed, 1);
    assert.equal(existsSync(directory), false);
    assert.deepEqual([...f.manager.activeDirectories()], []);
  } finally {
    gate.resume();
    try {
      await sweeping.catch(() => {});
    } finally {
      gate.restore();
    }
  }
});

test("publication and live-reference inspection never reconstruct missing generation directories", async (t) => {
  const f = fixture(t),
    directory = f.catalog();
  (await f.manager.hold("catalog", directory)).release();
  rmSync(directory, { recursive: true });
  assert.throws(() => f.manager.setPublished("catalog", directory));
  assert.equal(existsSync(directory), false);
  assert.deepEqual([...f.manager.activeDirectories()], []);

  const snapshot = f.snapshot("missing");
  (await f.manager.hold("work", snapshot.directory)).release();
  f.live.add(snapshot.ref);
  rmSync(snapshot.directory, { recursive: true });
  await assert.rejects(f.manager.sweep());
  assert.equal(existsSync(snapshot.directory), false);
});

test("an ancestor redirect during final live inspection cannot delete an unmanaged reading tree", async (t) => {
  const f = fixture(t),
    directory = f.catalog();
  await retired(f, "catalog", directory);
  const snapshot = f.snapshot("redirect-barrier");
  f.live.add(snapshot.ref);
  const catalogRoot = path.dirname(directory),
    savedRoot = catalogRoot + "-saved";
  const outside = path.join(f.root, "unmanaged"),
    outsideGeneration = path.join(outside, path.basename(directory));
  mkdirSync(outsideGeneration, { recursive: true });
  writeFileSync(path.join(outsideGeneration, "README.md"), "must survive");
  const gate = gateSecondBundleRead(t, snapshot.filename);
  const sweeping = f.manager.sweep();
  try {
    await enteredWithin(gate.entered);
    renameSync(catalogRoot, savedRoot);
    symlinkSync(outside, catalogRoot, "junction");
    gate.resume();
    const result = await sweeping;
    assert.equal(result.removed, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(
      readFileSync(path.join(outsideGeneration, "README.md"), "utf8"),
      "must survive",
    );
    assert.equal(
      existsSync(path.join(savedRoot, path.basename(directory))),
      true,
    );
  } finally {
    gate.resume();
    try {
      await sweeping.catch(() => {});
    } finally {
      gate.restore();
    }
  }
});

test("cleanup honors a maximum batch of 100 across a persistent directory cursor", async (t) => {
  const f = fixture(t);
  const generations = [];
  for (let index = 0; index < 105; index++) {
    const directory = f.catalog(`batch-${index}`);
    generations.push(directory);
    (await f.manager.hold("catalog", directory)).release();
  }
  assert.throws(() => f.manager.sweep(101));
  const firstObservation = await f.manager.sweep(100),
    secondObservation = await f.manager.sweep(100);
  assert.equal(firstObservation.processed, 100);
  assert.equal(secondObservation.processed, 6);
  assert.equal(firstObservation.removed + secondObservation.removed, 0);
  f.advance(grace);
  let removed = 0;
  for (let batch = 0; batch < 10 && removed < generations.length; batch++) {
    const result = await f.manager.sweep(100);
    assert.ok(result.processed > 0 && result.processed <= 100);
    assert.deepEqual(result.errors, []);
    removed += result.removed;
  }
  assert.equal(removed, generations.length);
  for (const directory of generations)
    assert.equal(existsSync(directory), false);
});

test("an ancestor redirect after a native leaf read cannot mutate the unmanaged destination", async (t) => {
  const f = fixture(t),
    directory = f.catalog();
  await retired(f, "catalog", directory);
  const catalogRoot = path.dirname(directory),
    savedRoot = catalogRoot + "-saved";
  const outside = path.join(f.root, "unmanaged"),
    outsideGeneration = path.join(outside, path.basename(directory));
  mkdirSync(outsideGeneration, { recursive: true });
  writeFileSync(
    path.join(outsideGeneration, "README.md"),
    "must survive queued I/O",
  );
  const gate = gateDirectoryRead(t, directory);
  const sweeping = f.manager.sweep();
  try {
    await enteredWithin(gate.entered);
    let nativeProtection = false;
    try {
      renameSync(catalogRoot, savedRoot);
    } catch (cause) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EBUSY"].includes(cause.code)
      )
        throw cause;
      // Windows holds the ancestor in place while this actual Dir is open.
      // Verify that native protection and real cleanup instead of skipping.
      nativeProtection = true;
      assert.equal(realpathSync.native(catalogRoot), catalogRoot);
      assert.equal(existsSync(savedRoot), false);
      assert.equal(
        readFileSync(path.join(directory, "README.md"), "utf8"),
        "fixed manual",
      );
    }
    if (!nativeProtection) symlinkSync(outside, catalogRoot, "junction");
    gate.resume();
    const result = await sweeping;
    assert.equal(result.removed, nativeProtection ? 1 : 0);
    assert.equal(result.errors.length, nativeProtection ? 0 : 1);
    assert.ok(result.processed <= 100);
    assert.equal(
      readFileSync(path.join(outsideGeneration, "README.md"), "utf8"),
      "must survive queued I/O",
    );
    if (nativeProtection) {
      assert.equal(existsSync(directory), false);
      assert.equal(existsSync(f.markerFile(directory)), false);
      await f.manager.stop();
      assert.throws(() => f.manager.sweep(), {
        code: "material_retention_closed",
      });
    } else {
      assert.equal(
        readFileSync(
          path.join(savedRoot, path.basename(directory), "README.md"),
          "utf8",
        ),
        "fixed manual",
      );
    }
  } finally {
    gate.resume();
    try {
      await sweeping.catch(() => {});
    } finally {
      gate.restore();
    }
  }
});

test("a large generation continues across bounded pages and remains closed to new holds until completion", async (t) => {
  const f = fixture(t),
    directory = f.catalog();
  for (let index = 0; index < 250; index++)
    writeFileSync(path.join(directory, `file-${index}.txt`), "retired leaf");
  await retired(f, "catalog", directory);
  const first = await f.manager.sweep(100);
  assert.equal(first.processed, 100);
  assert.equal(first.removed, 0);
  assert.equal(existsSync(directory), true);
  await assert.rejects(
    f.manager.hold("catalog", directory),
    (error) => error.code === "material_retiring",
  );
  assert.throws(
    () => f.manager.setPublished("catalog", directory),
    (error) => error.code === "material_retiring",
  );
  let removed = 0;
  for (let batch = 0; batch < 5 && !removed; batch++) {
    const result = await f.manager.sweep(100);
    assert.ok(result.processed > 0 && result.processed <= 100);
    assert.deepEqual(result.errors, []);
    removed += result.removed;
  }
  assert.equal(removed, 1);
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(f.markerFile(directory)), false);
});

test("retired leaf symlinks are unlinked without following their external targets", async (t) => {
  const f = fixture(t),
    directory = f.catalog();
  const outside = path.join(f.root, "unmanaged");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "keep.txt"), "preserve target");
  symlinkSync(outside, path.join(directory, "linked-directory"), "junction");
  await retired(f, "catalog", directory);
  const result = await f.manager.sweep(100);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(
    readFileSync(path.join(outside, "keep.txt"), "utf8"),
    "preserve target",
  );
  assert.equal(existsSync(directory), false);
});

test("stop closes the lifecycle cursor and every pending generation directory handle", async (t) => {
  const f = fixture(t),
    directory = f.catalog();
  await retired(f, "catalog", directory);
  const original = filesystem.opendir,
    handles = [];
  filesystem.opendir = async (...args) => {
    const handle = await original(...args);
    handles.push(handle);
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const result = await f.manager.sweep(1);
    assert.equal(result.processed, 1);
    assert.equal(result.removed, 0);
    assert.equal(handles.length, 2);
    await f.manager.stop();
    for (const handle of handles)
      await assert.rejects(
        handle.read(),
        (error) => error.code === "ERR_DIR_CLOSED",
      );
    assert.equal(existsSync(directory), true);
    assert.equal(existsSync(f.markerFile(directory)), true);
  } finally {
    await f.manager.stop();
    filesystem.opendir = original;
    syncBuiltinESMExports();
  }
});

test("stop joins pending marker admission and refuses later lifecycle work without allocating its marker", async (t) => {
  const entered = deferred(),
    resume = deferred();
  let released = 0;
  const f = fixture(t, {
    reserve: async () => {
      entered.resolve();
      await resume.promise;
      return {
        release() {
          released++;
        },
      };
    },
  });
  const directory = f.catalog(),
    holding = f.manager.hold("catalog", directory);
  const rejected = assert.rejects(holding, {
    code: "material_retention_closed",
  });
  let stopped = false,
    stopping;
  try {
    await enteredWithin(entered.promise);
    stopping = f.manager.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    await assert.rejects(f.manager.hold("catalog", directory), {
      code: "material_retention_closed",
    });
    assert.throws(() => f.manager.setPublished("new", directory), {
      code: "material_retention_closed",
    });
    assert.throws(() => f.manager.sweep(), {
      code: "material_retention_closed",
    });
    resume.resolve();
    await rejected;
    await stopping;
    assert.equal(stopped, true);
    assert.equal(released, 1);
    assert.equal(existsSync(f.markerFile(directory)), false);
    assert.deepEqual([...f.manager.activeDirectories()], []);
  } finally {
    resume.resolve();
    await rejected;
    await stopping;
  }
});

test("stop joins an accepted native marker write, fsync and close before confirming closure", async (t) => {
  const f = fixture(t),
    directory = f.catalog(),
    entered = deferred(),
    resume = deferred();
  const original = filesystem.open;
  let nativeClosed = false;
  filesystem.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]) === f.markerFile(directory) && args[1] & 1) {
      const write = handle.writeFile.bind(handle),
        close = handle.close.bind(handle);
      handle.writeFile = async (...values) => {
        entered.resolve();
        await resume.promise;
        return write(...values);
      };
      handle.close = async () => {
        await close();
        nativeClosed = true;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  const holding = f.manager.hold("catalog", directory);
  const rejected = assert.rejects(holding, {
    code: "material_retention_closed",
  });
  let stopping,
    stopped = false;
  try {
    await enteredWithin(entered.promise);
    stopping = f.manager.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(nativeClosed, false);
    assert.equal(statSync(f.markerFile(directory)).size, 0);
    resume.resolve();
    await rejected;
    await stopping;
    assert.equal(nativeClosed, true);
    assert.equal(statSync(f.markerFile(directory)).size, 4096);
    assert.equal(stopped, true);
    assert.deepEqual([...f.manager.activeDirectories()], []);
  } finally {
    resume.resolve();
    try {
      await rejected;
      await stopping;
    } finally {
      filesystem.open = original;
      syncBuiltinESMExports();
    }
  }
});

test("hard-linked private markers cannot mutate another profile's lifecycle facts or admit deletion", async (t) => {
  const f = fixture(t),
    directory = f.catalog();
  await retired(f, "catalog", directory);
  const outsideRoot = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-external-marker-")),
  );
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));
  const outside = path.join(outsideRoot, "other-profile-marker.json");
  linkSync(f.markerFile(directory), outside);
  const before = readFileSync(outside);
  assert.throws(() => f.manager.setPublished("catalog", directory), {
    code: "invalid_material_marker",
  });
  await assert.rejects(f.manager.hold("catalog", directory), {
    code: "invalid_material_marker",
  });
  const result = await f.manager.sweep(100);
  assert.equal(result.removed, 0);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ["invalid_material_marker"],
  );
  assert.deepEqual(readFileSync(outside), before);
  assert.equal(existsSync(directory), true);
  assert.equal(existsSync(f.markerFile(directory)), true);
});
