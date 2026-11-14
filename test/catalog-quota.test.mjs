import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const distribution = process.env.NEXUM_CATALOG_QUOTA_DIST
  ? pathToFileURL(path.resolve(process.env.NEXUM_CATALOG_QUOTA_DIST) + path.sep)
  : new URL("../dist/", import.meta.url);
const { DocumentCatalog } = await import(
  new URL("work/catalog.js", distribution).href
);

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

function fixture(t, reserve, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-catalog-quota-")),
  );
  const work = path.join(root, "work");
  mkdirSync(work);
  let scriptText = "# 脚本目录\n\n中文与 emoji 🧪\n";
  const scripts = {
    work,
    discover: () => ({ entries: [], warnings: [] }),
    indexText: () => scriptText,
    refreshIndex: () => assert.fail("catalog writes must use its admission"),
  };
  const catalog = new DocumentCatalog(
    work,
    scripts,
    { builtins: () => [], approvedPackages: () => new Map() },
    { ...options, reserve },
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    work,
    catalog,
    setScriptText: (text) => (scriptText = text),
  };
}

test("every generated catalog write reserves its actual UTF-8 bytes before writing and releases after publication", async (t) => {
  const reservations = [];
  let work;
  const f = fixture(t, async (bytes) => {
    assert.ok(reservations.every((entry) => entry.released));
    const before = files(work);
    const reservation = { bytes, released: false };
    reservations.push(reservation);
    return {
      release() {
        assert.equal(reservation.released, false);
        const changed = [...files(work)].filter(
          ([filename, contents]) =>
            !contents.equals(before.get(filename) ?? Buffer.alloc(0)),
        );
        assert.equal(changed.length, 1);
        assert.equal(changed[0][1].byteLength, bytes);
        reservation.released = true;
      },
    };
  });
  work = f.work;
  const result = await f.catalog.refresh();
  assert.equal(reservations.length, 6);
  assert.equal(files(f.work).size, 6);
  assert.equal(readFileSync(result.entry, "utf8"), result.content);
  assert.ok(reservations.every((entry) => entry.released));

  await f.catalog.refresh();
  assert.equal(
    reservations.length,
    6,
    "identical generated files need no allocation",
  );
});

for (let deniedWrite = 1; deniedWrite <= 6; deniedWrite++) {
  test(`catalog admission failure at write ${deniedWrite} performs no unreserved write`, async (t) => {
    let admissions = 0,
      releases = 0;
    const denied = new Error("profile space unavailable");
    const f = fixture(t, async () => {
      admissions++;
      if (admissions === deniedWrite) throw denied;
      return { release: () => releases++ };
    });
    await assert.rejects(f.catalog.refresh(), (error) => error === denied);
    assert.equal(admissions, deniedWrite);
    assert.equal(releases, deniedWrite - 1);
    const published = files(f.work);
    assert.equal(published.size, deniedWrite - 1);
    assert.ok(
      [...published.keys()].every(
        (filename) => !path.basename(filename).startsWith("."),
      ),
    );
    assert.equal(existsSync(path.join(f.work, "docs", "README.md")), false);
  });
}

test("catalog write failure releases its reservation after I/O settles", async (t) => {
  let releases = 0,
    work;
  const f = fixture(t, async () => {
    mkdirSync(path.join(work, "docs", "scripts.md"));
    return { release: () => releases++ };
  });
  work = f.work;
  await assert.rejects(f.catalog.refresh());
  assert.equal(releases, 1);
  assert.equal(files(work).size, 0);
  assert.deepEqual(readdirSync(path.join(work, "docs")).sort(), [
    "packages",
    "scripts.md",
  ]);
});

test("cancellation during admission releases the reservation without writing", async (t) => {
  const controller = new AbortController();
  const cancelled = new Error("cancelled during quota admission");
  let releases = 0;
  const f = fixture(t, async () => {
    controller.abort(cancelled);
    return { release: () => releases++ };
  });
  await assert.rejects(
    f.catalog.refresh([], controller.signal),
    (error) => error === cancelled,
  );
  assert.equal(releases, 1);
  assert.equal(files(f.work).size, 0);
});

test("catalog rechecks its generated directory after asynchronous admission", async (t) => {
  let releases = 0,
    work,
    outside;
  const f = fixture(t, async () => {
    rmSync(path.join(work, "docs"), { recursive: true });
    symlinkSync(outside, path.join(work, "docs"), "dir");
    return { release: () => releases++ };
  });
  work = f.work;
  outside = path.join(f.root, "outside");
  mkdirSync(outside);
  await assert.rejects(
    f.catalog.refresh(),
    (error) => error.code === "storage_path_escape",
  );
  assert.equal(releases, 1);
  assert.deepEqual(readdirSync(outside), []);
});

test("the immutable catalog is held through admission and published only after complete generated writes", async (t) => {
  const events = [];
  let admissions = 0,
    heldDirectory;
  const materialRetention = {
    async hold(kind, directory) {
      assert.equal(kind, "catalog");
      assert.deepEqual([...files(directory)], []);
      heldDirectory = directory;
      events.push("hold");
      return {
        release() {
          assert.equal(events.at(-1), "published");
          events.push("release");
          heldDirectory = undefined;
        },
      };
    },
    setPublished(key, directory) {
      assert.equal(key, "catalog");
      assert.equal(directory, heldDirectory);
      assert.deepEqual(readdirSync(directory).sort(), [
        "README.md",
        "packages.md",
        "scripts.md",
      ]);
      assert.equal(files(f.work).size, 6);
      events.push("published");
    },
  };
  const f = fixture(
    t,
    async () => {
      if (++admissions > 1) assert.ok(heldDirectory);
      return { release() {} };
    },
    { materialRetention },
  );
  assert.deepEqual([...f.catalog.activeDirectories()], []);
  const result = await f.catalog.refresh();
  assert.deepEqual(events, ["hold", "published", "release"]);
  assert.deepEqual(
    [...f.catalog.activeDirectories()],
    [path.dirname(result.entry)],
  );
});

test("a failed catalog generation releases its hold and preserves the prior published generation", async (t) => {
  const published = [],
    holds = [];
  let fail = false,
    admissions = 0;
  const denied = new Error("profile quota exceeded");
  const f = fixture(
    t,
    async () => {
      if (fail && ++admissions === 2) throw denied;
      return { release() {} };
    },
    {
      materialRetention: {
        async hold(kind, directory) {
          const held = { kind, directory, released: false };
          holds.push(held);
          return { release: () => (held.released = true) };
        },
        setPublished: (key, directory) => published.push({ key, directory }),
      },
    },
  );
  const first = await f.catalog.refresh();
  f.setScriptText("# a replacement generation\n");
  fail = true;
  await assert.rejects(f.catalog.refresh(), (error) => error === denied);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    key: "catalog",
    directory: path.dirname(first.entry),
  });
  assert.equal(holds.length, 2);
  assert.ok(holds.every((held) => held.released));
  assert.deepEqual(
    [...f.catalog.activeDirectories()],
    [path.dirname(first.entry)],
  );

  fail = false;
  const replacement = await f.catalog.refresh();
  assert.notEqual(replacement.entry, first.entry);
  assert.equal(published.length, 2);
  assert.deepEqual(published[1], {
    key: "catalog",
    directory: path.dirname(replacement.entry),
  });
  assert.deepEqual(
    [...f.catalog.activeDirectories()],
    [path.dirname(replacement.entry)],
  );
  assert.ok(holds.every((held) => held.released));
});

test("cancellation during a catalog hold releases it without publishing the generation", async (t) => {
  const controller = new AbortController();
  const cancelled = new Error("cancelled during material hold");
  let releases = 0,
    publications = 0;
  const f = fixture(t, undefined, {
    materialRetention: {
      async hold() {
        controller.abort(cancelled);
        return { release: () => releases++ };
      },
      setPublished: () => publications++,
    },
  });
  await assert.rejects(
    f.catalog.refresh([], controller.signal),
    (error) => error === cancelled,
  );
  assert.equal(releases, 1);
  assert.equal(publications, 0);
  assert.equal(
    files(f.work).size,
    1,
    "the earlier mutable script index is separate",
  );
  assert.deepEqual([...f.catalog.activeDirectories()], []);
});
