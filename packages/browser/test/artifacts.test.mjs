import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  existsSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  materializeArtifact,
  materializeAssetDownloads,
  materializeAssetBundle,
} from "../dist/extension/artifacts.js";
const target = {
  browserId: "browser-artifacts",
  bootId: "boot-artifacts",
  browserSessionId: "session-artifacts",
  generation: 1,
  tabId: "1",
  pageVersion: 3,
};
const sourceUrl = "https://fixture.test/page";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function exact(actual, expected) {
  assert.equal(actual.length, expected.length);
  assert.equal(hash(actual), hash(expected));
}
function files(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const filename = path.join(root, name),
      stat = lstatSync(filename);
    if (stat.isDirectory()) out.push(...files(filename));
    else out.push(filename);
  }
  return out;
}
function fixture(t, authorize = () => {}) {
  // Match native realpath spelling rather than Windows' inherited 8.3 TMP path.
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-browser-artifacts-")),
    ),
    work = path.join(root, "work"),
    pwd = path.join(root, "project");
  mkdirSync(work);
  mkdirSync(pwd);
  const controller = new AbortController(),
    grants = [];
  const call = {
    context: { runId: "run_artifacts_fixture", pwd },
    signal: controller.signal,
    deadline: Date.now() + 60000,
    authorize(value) {
      grants.push({ ...value });
      authorize(value);
    },
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, work, pwd, call, controller, grants };
}
function asset(id, name = "same.txt", data = Buffer.from(`actual ${id}`)) {
  return {
    id,
    kind: "other",
    url: `https://fixture.test/${id}`,
    name,
    mimeType: "text/plain",
    data,
  };
}
function bundle(assets = [], failures = []) {
  return {
    inventoryId: "inventory-fixed",
    target,
    pageUrl: sourceUrl,
    assets,
    failures,
  };
}

test("native and UTF-8 text artifacts contain exact >64KiB data, actual hashes and durable files without metadata hooks", async (t) => {
  const f = fixture(t),
    backing = Buffer.alloc(180000, 0x61),
    view = new Uint8Array(backing.buffer, backing.byteOffset + 5, 150000);
  let hooks = 0;
  Object.defineProperty(view, "privateController", {
    get() {
      hooks++;
      throw Error("private");
    },
  });
  const artifact = await materializeArtifact(
    {
      data: view,
      name: "content.bin",
      mimeType: "application/x-fixture",
      sourceUrl,
    },
    f.call,
    f.work,
  );
  assert.equal(hooks, 0);
  assert.equal(artifact.size, 150000);
  assert.equal(artifact.mimeType, "application/x-fixture");
  exact(readFileSync(artifact.path), Buffer.alloc(150000, 0x61));
  assert.equal(artifact.sha256, hash(readFileSync(artifact.path)));
  assert.equal(Object.hasOwn(artifact, "privateController"), false);
  const text = "真实文本🙂\n".repeat(20000),
    document = await materializeArtifact(
      { text, name: "document.md", mimeType: "text/markdown", sourceUrl },
      f.call,
      f.work,
    );
  exact(readFileSync(document.path), Buffer.from(text));
  assert.equal(document.size, Buffer.byteLength(text));
  assert.equal(document.sha256, hash(Buffer.from(text)));
  assert.equal(
    files(f.work).length,
    2,
    "native staging files are removed after final copies exist",
  );
  backing.fill(0);
  f.controller.abort();
  assert.equal(readFileSync(artifact.path)[0], 0x61);
  assert.equal(readFileSync(document.path, "utf8"), text);
});

test("path artifacts preserve source bytes, explicit MIME and no-replace destinations", async (t) => {
  const f = fixture(t),
    original = Buffer.alloc(90000, 4),
    source = path.join(f.pwd, "source.data");
  writeFileSync(source, original);
  const artifact = await materializeArtifact(
    {
      path: source,
      name: "source.data",
      mimeType: "application/x-source",
      expectedSize: original.length,
      sourceUrl,
    },
    f.call,
    f.work,
    { destination: "saved.data" },
  );
  assert.equal(artifact.path, path.join(f.pwd, "saved.data"));
  assert.equal(artifact.mimeType, "application/x-source");
  exact(readFileSync(artifact.path), original);
  writeFileSync(source, "changed");
  await assert.rejects(
    materializeArtifact({ path: source }, f.call, f.work, {
      destination: "saved.data",
    }),
    { code: "EEXIST" },
  );
  exact(readFileSync(artifact.path), original);
  assert.ok(
    f.grants.some(
      (grant) =>
        grant.type === "path" &&
        grant.value === source &&
        grant.access === "read",
    ),
  );
  assert.ok(
    f.grants.some((grant) => grant.type === "url" && grant.value === sourceUrl),
  );
});

test("URL denial precedes file IO and revocation after copying removes undelivered artifacts", async (t) => {
  const forbidden = Object.assign(Error("not allowed"), { code: "forbidden" }),
    first = fixture(t, (grant) => {
      if (grant.type === "url") throw forbidden;
    });
  await assert.rejects(
    materializeArtifact(
      {
        data: Buffer.from("secret"),
        name: "private.txt",
        mimeType: "text/plain",
        sourceUrl,
      },
      first.call,
      first.work,
    ),
    (error) => error === forbidden,
  );
  assert.deepEqual(files(first.work), []);
  assert.equal(existsSync(path.join(first.work, "tmp")), false);
  let count = 0;
  const later = fixture(t, (grant) => {
    if (grant.type === "url" && ++count === 2) throw forbidden;
  });
  await assert.rejects(
    materializeArtifact(
      {
        data: Buffer.alloc(100000, 9),
        name: "later.txt",
        mimeType: "text/plain",
        sourceUrl,
      },
      later.call,
      later.work,
    ),
    (error) => error === forbidden,
  );
  assert.deepEqual(files(later.work), []);
  for (const value of [
    "https://user:password@fixture.test/file",
    "javascript:alert(1)",
    "not a url",
  ]) {
    await assert.rejects(
      materializeArtifact(
        {
          text: "x",
          name: "bad.txt",
          mimeType: "text/plain",
          sourceUrl: value,
        },
        later.call,
        later.work,
      ),
      { code: "PROTOCOL_MISMATCH" },
    );
  }
});

test("asset downloads preserve each actual success and source failure without exposing private exception text", async (t) => {
  const f = fixture(t),
    result = await materializeAssetDownloads(
      {
        files: [
          {
            url: sourceUrl + "/first",
            name: "first.txt",
            mimeType: "text/plain",
            data: Buffer.from("actual first"),
          },
          {
            url: sourceUrl + "/bad",
            name: "bad.txt",
            mimeType: "text/plain",
            data: { privateController: "secret" },
          },
        ],
        failures: [{ url: sourceUrl + "/absent", reason: "REMOTE_NOT_FOUND" }],
      },
      f.call,
      f.work,
    );
  assert.equal(result.files.length, 1);
  exact(readFileSync(result.files[0].path), Buffer.from("actual first"));
  assert.equal(result.files[0].url, sourceUrl + "/first");
  assert.deepEqual(result.failures, [
    { url: sourceUrl + "/absent", reason: "REMOTE_NOT_FOUND" },
    { url: sourceUrl + "/bad", reason: "INVALID_ARGUMENT" },
  ]);
  assert.equal(files(f.work).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /privateController|secret/);
});

test("current policy/configuration errors abort batches and remove prior undelivered successful copies", async (t) => {
  class SourceConfigError extends Error {
    code = "INVALID_ARGUMENT";
  }
  const config = new SourceConfigError("private policy diagnostics"),
    counts = new Map();
  const f = fixture(t, (grant) => {
    if (grant.type === "url") {
      const count = (counts.get(grant.value) ?? 0) + 1;
      counts.set(grant.value, count);
      if (grant.value.endsWith("/two") && count === 2) throw config;
    }
  });
  await assert.rejects(
    materializeAssetDownloads(
      {
        files: [
          {
            url: sourceUrl + "/one",
            name: "one.txt",
            mimeType: "text/plain",
            data: Buffer.from("one"),
          },
          {
            url: sourceUrl + "/two",
            name: "two.txt",
            mimeType: "text/plain",
            data: Buffer.from("two"),
          },
        ],
        failures: [],
      },
      f.call,
      f.work,
    ),
    (error) => error === config,
  );
  assert.deepEqual(files(f.work), []);
});

test("bundles publish real disambiguated files and a final manifest with relative paths and exact partial success counts", async (t) => {
  const f = fixture(t),
    input = bundle(
      [
        asset("one"),
        asset("two"),
        asset("bad", "bad.txt", { invalid: "private" }),
      ],
      [
        {
          id: "absent",
          url: sourceUrl + "/absent",
          name: "absent.txt",
          reason: "REMOTE_NOT_FOUND",
        },
      ],
    );
  const result = await materializeAssetBundle(input, f.call, f.work),
    manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(result.assets.length, 2);
  assert.equal(result.failures.length, 2);
  assert.equal(result.summary.requestedCount, 4);
  assert.equal(result.summary.downloadedCount, 2);
  assert.equal(result.summary.failedCount, 2);
  assert.ok(result.summary.elapsedMs >= 0);
  assert.notEqual(result.assets[0].path, result.assets[1].path);
  assert.equal(path.dirname(result.manifestPath), result.directoryPath);
  assert.equal(path.basename(result.manifestPath), "manifest.json");
  assert.equal(manifest.inventoryId, input.inventoryId);
  assert.deepEqual(manifest.target, target);
  assert.equal(manifest.pageUrl, sourceUrl);
  assert.deepEqual(manifest.summary, result.summary);
  for (let i = 0; i < 2; i++) {
    const returned = result.assets[i],
      saved = manifest.assets[i];
    assert.equal(saved.file, path.basename(returned.path));
    assert.equal(Object.hasOwn(saved, "path"), false);
    assert.equal(saved.sha256, hash(readFileSync(returned.path)));
    exact(
      readFileSync(path.join(result.directoryPath, saved.file)),
      input.assets[i].data,
    );
  }
  assert.equal(files(result.directoryPath).length, 3);
  assert.equal(
    files(f.work).length,
    3,
    "no staging content remains outside the returned bundle",
  );
  assert.equal(result.failures[1].reason, "INVALID_ARGUMENT");
  f.controller.abort();
  assert.equal(existsSync(result.manifestPath), true);
});

test("bundle preflight rejects duplicate identities/getters before publication; manifest failure cleans the whole undelivered directory", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    materializeAssetBundle(
      bundle([asset("same"), asset("same")]),
      f.call,
      f.work,
    ),
    { code: "PROTOCOL_MISMATCH" },
  );
  assert.deepEqual(files(f.work), []);
  let hooks = 0;
  const unsafe = { name: "unsafe" };
  Object.defineProperty(unsafe, "data", {
    get() {
      hooks++;
      throw Error("getter");
    },
    enumerable: true,
  });
  await assert.rejects(materializeArtifact(unsafe, f.call, f.work), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(hooks, 0);
  class SourceConfigError extends Error {
    code = "path_not_allowed";
  }
  const blocked = new SourceConfigError("manifest policy"),
    later = fixture(t, (grant) => {
      if (
        grant.type === "path" &&
        grant.access === "write" &&
        grant.value.endsWith("manifest.json")
      )
        throw blocked;
    });
  await assert.rejects(
    materializeAssetBundle(bundle([asset("real")]), later.call, later.work),
    (error) => error === blocked,
  );
  assert.deepEqual(files(later.work), []);
  assert.equal(
    readdirSync(
      path.join(later.work, "tmp", "browser", later.call.context.runId),
    ).some((name) => name.endsWith("-assets")),
    false,
  );
});

test("cancellation/deadlines fail closed and no artifact conversion invokes fetch or imports the Agent services", async (t) => {
  const f = fixture(t);
  f.controller.abort();
  await assert.rejects(
    materializeArtifact(
      { text: "x", name: "x.txt", mimeType: "text/plain" },
      f.call,
      f.work,
    ),
    { code: "CANCELLED" },
  );
  await assert.rejects(
    materializeAssetBundle(
      bundle(),
      {
        ...f.call,
        signal: new AbortController().signal,
        deadline: Date.now() - 1,
      },
      f.work,
    ),
    { code: "DEADLINE_EXCEEDED" },
  );
  assert.deepEqual(files(f.work), []);
  const module = new URL("../dist/extension/artifacts.js", import.meta.url)
    .href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
 import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
 let io=0;globalThis.fetch=()=>{throw Error('unexpected network')};for(const name of ['mkdir','open','readFile','writeFile'])fs[name]=()=>{io++;throw Error('unexpected file IO')};syncBuiltinESMExports();
 const api=await import(${JSON.stringify(module)});assert.equal(io,0);assert.deepEqual(Object.keys(api).sort(),['materializeArtifact','materializeAssetBundle','materializeAssetDownloads']);
 `,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr.slice(-2000));
});

test("bundle member prefixes remain within the filesystem filename limit without losing original names or bytes", async (t) => {
  const f = fixture(t),
    filename = "x".repeat(251) + ".txt",
    bytes = Buffer.from("long name actual content");
  const result = await materializeAssetBundle(
    bundle([asset("long", filename, bytes)]),
    f.call,
    f.work,
  );
  assert.equal(result.assets.length, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(result.assets[0].name, filename);
  assert.ok(Buffer.byteLength(path.basename(result.assets[0].path)) <= 255);
  exact(readFileSync(result.assets[0].path), bytes);
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.assets[0].file, path.basename(result.assets[0].path));
});
