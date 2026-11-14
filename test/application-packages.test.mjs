import assert from "node:assert/strict";
import {
  copyFileSync,
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
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ApprovedPackageCatalog } from "../dist/application/packages.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { privateMaintenanceWrite } from "../dist/maintenance/credentials.js";

const binding = { agentId: "agent", profile: "development" };
const names = ["alpha", "beta", "unapproved"];
function fixture(t) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-approved-packages-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (
    versions = { alpha: "1.0.0", beta: "1.0.0", unapproved: "1.0.0" },
  ) => {
    const manifest = JSON.stringify({
      name: "private-agent-work",
      type: "module",
      dependencies: versions,
    });
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: versions },
        ...Object.fromEntries(
          Object.entries(versions).map(([name, version]) => [
            `node_modules/${name}`,
            { name, version },
          ]),
        ),
      },
    });
    writeFileSync(path.join(work, "package.json"), manifest);
    writeFileSync(path.join(work, "package-lock.json"), lock);
    for (const [name, version] of Object.entries(versions)) {
      const directory = path.join(work, "node_modules", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({
          name,
          version,
          type: "module",
          exports: "./index.js",
        }),
      );
      writeFileSync(
        path.join(directory, "index.js"),
        `export const value=${JSON.stringify(`${name}@${version}`)};`,
      );
    }
    return { manifest, lock };
  };
  const snapshot = (name, action = "install", version = "1.0.0") => ({
    target: { name, action, version: action === "remove" ? null : version },
    manifest: readFileSync(path.join(work, "package.json"), "utf8"),
    lock: readFileSync(path.join(work, "package-lock.json"), "utf8"),
  });
  write();
  return {
    root,
    work,
    write,
    snapshot,
    file: path.join(root, "state", "maintenance", "packages.json"),
  };
}

test("installed work packages grant nothing until one explicit verified target is privately accepted, and restart restores only that target", async (t) => {
  const f = fixture(t),
    catalog = await ApprovedPackageCatalog.open(f.root, binding);
  const loader = await ModuleLoader.create(f.work, "approval_first", {
    builtins: () => [],
    approvedPackages: () => catalog.approvedPackages(),
  });
  for (const name of names)
    assert.throws(() => loader.resolveImport(name), {
      code: "module_not_allowed",
    });
  await catalog.accept(f.snapshot("alpha"));
  assert.deepEqual([...catalog.approvedPackages()], [["alpha", "1.0.0"]]);
  assert.throws(() => loader.resolveImport("beta"), {
    code: "module_not_allowed",
  });
  assert.throws(() => loader.resolveImport("unapproved"), {
    code: "module_not_allowed",
  });
  const imported = await loader.execute(
    'return (await import("alpha")).value;',
    { context: {} },
  );
  assert.equal(imported, "alpha@1.0.0");
  const copy = catalog.approvedPackages();
  copy.set("unapproved", "1.0.0");
  assert.equal(catalog.approvedPackages().has("unapproved"), false);
  const restored = await ApprovedPackageCatalog.open(f.root, binding);
  assert.deepEqual([...restored.approvedPackages()], [["alpha", "1.0.0"]]);
  const saved = JSON.parse(readFileSync(f.file, "utf8"));
  assert.equal(saved.manifest, f.snapshot("alpha").manifest);
  assert.equal(saved.lock, f.snapshot("alpha").lock);
  assert.deepEqual(saved.approved, { alpha: "1.0.0" });
  if (process.platform !== "win32")
    assert.equal(statSync(f.file).mode & 0o077, 0);
});

test("subsequent approval keeps previous exact versions, adds only its target and removes only the explicit target", async (t) => {
  const f = fixture(t),
    catalog = await ApprovedPackageCatalog.open(f.root, binding);
  await catalog.accept(f.snapshot("alpha"));
  f.write({ alpha: "2.0.0", beta: "1.0.0", unapproved: "1.0.0" });
  assert.equal(catalog.approvedPackages().size, 0);
  await catalog.accept(f.snapshot("beta"));
  assert.deepEqual(
    [...catalog.approvedPackages()],
    [
      ["alpha", "1.0.0"],
      ["beta", "1.0.0"],
    ],
  );
  const loader = await ModuleLoader.create(f.work, "approval_next", {
    builtins: () => [],
    approvedPackages: () => catalog.approvedPackages(),
  });
  assert.throws(() => loader.resolveImport("alpha"), {
    code: "module_changed",
  });
  assert.throws(() => loader.resolveImport("unapproved"), {
    code: "module_not_allowed",
  });
  await catalog.accept(f.snapshot("alpha", "update", "2.0.0"));
  assert.deepEqual(
    [...catalog.approvedPackages()],
    [
      ["alpha", "2.0.0"],
      ["beta", "1.0.0"],
    ],
  );
  f.write({ beta: "1.0.0", unapproved: "1.0.0" });
  await catalog.accept(f.snapshot("alpha", "remove"));
  assert.deepEqual([...catalog.approvedPackages()], [["beta", "1.0.0"]]);
  assert.deepEqual(
    [
      ...(
        await ApprovedPackageCatalog.open(f.root, binding)
      ).approvedPackages(),
    ],
    [["beta", "1.0.0"]],
  );
});

test("any manifest or lock drift immediately denies new and cached native imports, including after catalog restart", async (t) => {
  const f = fixture(t),
    catalog = await ApprovedPackageCatalog.open(f.root, binding);
  await catalog.accept(f.snapshot("alpha"));
  const loader = await ModuleLoader.create(f.work, "approval_drift", {
    builtins: () => [],
    approvedPackages: () => catalog.approvedPackages(),
  });
  assert.equal(
    await loader.execute('return (await import("alpha")).value;', {
      context: {},
    }),
    "alpha@1.0.0",
  );
  const original = f.snapshot("alpha");
  for (const file of ["package.json", "package-lock.json"]) {
    const filename = path.join(f.work, file),
      body = readFileSync(filename, "utf8");
    writeFileSync(filename, `${body}\n`);
    assert.equal(catalog.approvedPackages().size, 0);
    assert.equal(
      (await ApprovedPackageCatalog.open(f.root, binding)).approvedPackages()
        .size,
      0,
    );
    await assert.rejects(
      loader.execute('return (await import("alpha")).value;', { context: {} }),
      { code: "module_not_allowed" },
    );
    writeFileSync(filename, body);
    assert.equal(catalog.approvedPackages().get("alpha"), "1.0.0");
  }
  rmSync(path.join(f.work, "package-lock.json"));
  assert.equal(catalog.approvedPackages().size, 0);
  await assert.rejects(catalog.accept(original), {
    code: "package_approval_changed",
  });
  assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")).approved, {
    alpha: "1.0.0",
  });
});

test("accept rejects mismatched actual files, invalid targets and contradictory plans without persisting approval", async (t) => {
  const f = fixture(t),
    catalog = await ApprovedPackageCatalog.open(f.root, binding),
    actual = f.snapshot("alpha");
  for (const bad of [
    { ...actual, target: { ...actual.target, name: "../escape" } },
    { ...actual, target: { ...actual.target, version: "latest" } },
    { ...actual, target: { ...actual.target, version: "2.0.0" } },
    {
      ...actual,
      target: { ...actual.target, action: "remove", version: null },
    },
    { ...actual, target: { ...actual.target, action: "execute" } },
    { ...actual, manifest: "[]" },
  ])
    await assert.rejects(catalog.accept(bad), {
      code: "package_approval_invalid",
    });
  await assert.rejects(
    catalog.accept({ ...actual, manifest: actual.manifest + "\n" }),
    { code: "package_approval_changed" },
  );
  assert.equal(catalog.approvedPackages().size, 0);
  await catalog.accept(actual);
  assert.deepEqual([...catalog.approvedPackages()], [["alpha", "1.0.0"]]);
});

test("private records are bound to this root, Agent and profile and malformed or hard-linked state never falls back to work dependencies", async (t) => {
  const f = fixture(t),
    catalog = await ApprovedPackageCatalog.open(f.root, binding);
  await catalog.accept(f.snapshot("alpha"));
  for (const other of [
    { ...binding, agentId: "other" },
    { ...binding, profile: "production" },
  ])
    await assert.rejects(ApprovedPackageCatalog.open(f.root, other), {
      code: "package_approval_invalid",
    });
  const second = fixture(t);
  mkdirSync(path.dirname(second.file), { recursive: true });
  copyFileSync(f.file, second.file);
  await assert.rejects(ApprovedPackageCatalog.open(second.root, binding), {
    code: "package_approval_invalid",
  });
  const original = JSON.parse(readFileSync(f.file, "utf8"));
  await privateMaintenanceWrite(f.root, ["packages.json"], {
    ...original,
    approved: { alpha: "^1.0.0" },
  });
  await assert.rejects(ApprovedPackageCatalog.open(f.root, binding), {
    code: "package_approval_invalid",
  });
  await privateMaintenanceWrite(f.root, ["packages.json"], original);
  linkSync(f.file, path.join(f.root, "linked-record.json"));
  await assert.rejects(ApprovedPackageCatalog.open(f.root, binding), {
    code: "credential_file_invalid",
  });
});

test("redirected work or control files grant no access and cannot be accepted as verified evidence", async (t) => {
  const f = fixture(t),
    other = fixture(t),
    catalog = await ApprovedPackageCatalog.open(f.root, binding);
  await catalog.accept(f.snapshot("alpha"));
  const actual = f.snapshot("alpha");
  if (process.platform !== "win32") {
    rmSync(path.join(f.work, "package.json"));
    symlinkSync(
      path.join(other.work, "package.json"),
      path.join(f.work, "package.json"),
    );
    assert.equal(catalog.approvedPackages().size, 0);
    await assert.rejects(catalog.accept(actual));
    rmSync(path.join(f.work, "package.json"));
    writeFileSync(path.join(f.work, "package.json"), actual.manifest);
  }
  rmSync(f.work, { recursive: true, force: true });
  symlinkSync(
    other.work,
    f.work,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(catalog.approvedPackages().size, 0);
  await assert.rejects(catalog.accept(actual), {
    code: "package_approval_changed",
  });
});
