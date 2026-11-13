import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ScriptCatalog, scriptHeader } from "../dist/runtime/scripts.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ModuleLoader } from "../dist/runtime/modules.js";

function code(name, more = {}, body = "return context.input;") {
  return (
    "/**\n" +
    JSON.stringify(
      {
        scriptName: name,
        scriptDesc: "生成报告",
        scriptWhenUse: "需要报告时",
        scriptInputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
        ...more,
      },
      null,
      2,
    ) +
    "\n*/\n" +
    body
  );
}
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "nexum-scripts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "work"));
  const work = path.join(root, "work");
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  let sources = [];
  const catalog = new ScriptCatalog(work, "agent_test", () => sources);
  function extension(namespace, owner = namespace) {
    const directory = path.join(work, "node_modules", owner, "scripts");
    mkdirSync(directory, { recursive: true });
    const source = {
      type: "extension",
      owner,
      namespace,
      version: "1.0.0",
      directory,
    };
    sources.push(source);
    return source;
  }
  return {
    root,
    work,
    catalog,
    extension,
    setSources: (value) => (sources = value),
  };
}

test("only the first JSON block declares a script; names, booleans, dialects and fields are validated without execution", () => {
  assert.equal(scriptHeader("// plain\n" + code("report.js")), null);
  assert.equal(
    scriptHeader("/** ordinary docs */\n" + code("report.js")),
    null,
  );
  assert.equal(
    scriptHeader("\uFEFF\n " + code("report.js")).scriptName,
    "report.js",
  );
  for (const name of [
    "../x.js",
    "a/b.js",
    "/tmp/x.js",
    "CON.js",
    "name.js/",
    "x.JS",
  ])
    assert.throws(() => scriptHeader(code(name)), {
      code: "invalid_script_name",
    });
  assert.throws(() => scriptHeader('/** { "scriptName": '), {
    code: "invalid_script_header",
  });
  for (const value of [null, 1, "true"])
    assert.throws(
      () => scriptHeader(code("x.js", { scriptOpenDefault: value })),
      { code: "invalid_script_header" },
    );
  assert.throws(() => scriptHeader(code("x.js", { owner: "platform" })), {
    code: "invalid_script_header",
  });
  assert.throws(
    () =>
      scriptHeader(
        code("x.js", {
          scriptInputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
          },
        }),
      ),
    { code: "invalid_input_schema" },
  );
  assert.throws(
    () =>
      scriptHeader(
        code("x.js", {
          scriptInputSchema: { $ref: "https://outside.invalid/schema" },
        }),
      ),
    { code: "invalid_input_schema" },
  );
});

test("enrollment persists the complete source once, rejects changes and regenerates the manual from real headers", (t) => {
  const { catalog } = fixture(t);
  const source = code(
    "report.js",
    { scriptOpenDefault: true },
    'throw new Error("not run during enrollment");',
  );
  const first = catalog.enroll(source);
  assert.equal(first.saved, true);
  assert.equal(first.snapshot.code, source);
  assert.equal(first.snapshot.origin.type, "local");
  assert.equal(catalog.enroll(source).saved, false);
  assert.throws(() => catalog.enroll(source + "\n"), {
    code: "script_name_conflict",
  });
  assert.throws(() => catalog.enroll(code("Report.js")), {
    code: "script_name_conflict",
  });
  const index = readFileSync(path.join(catalog.docs, "scripts.md"), "utf8");
  assert.match(index, /report\.js/);
  assert.match(index, /additionalProperties/);
  assert.equal(
    catalog.resolve("report.js").metadata.scriptInputSchema.required[0],
    "title",
  );
  writeFileSync(
    first.snapshot.path,
    code("report.js", { scriptDesc: "新的描述" }),
  );
  catalog.refreshIndex();
  assert.match(
    readFileSync(path.join(catalog.docs, "scripts.md"), "utf8"),
    /新的描述/,
  );
  assert.throws(() => catalog.resolve("scripts/report.js"), {
    code: "script_not_found",
  });
  assert.throws(() => catalog.resolve("report.js", () => false), {
    code: "script_forbidden",
  });
});

test("a manual write failure reports the already-saved file and never silently undoes enrollment", (t) => {
  const { catalog } = fixture(t);
  mkdirSync(path.join(catalog.docs, "scripts.md"));
  assert.throws(
    () => catalog.enroll(code("kept.js")),
    (error) =>
      error.code === "script_index_failed" && error.details.saved === true,
  );
  assert.equal(catalog.resolve("kept.js").name, "kept.js");
});

test("namespace lookup, source disabling, path containment and portable collisions cannot fall back to another library", (t) => {
  const { catalog, root, extension, setSources } = fixture(t);
  const source = extension("browser", "@example/browser");
  writeFileSync(path.join(source.directory, "capture.js"), code("capture.js"));
  assert.equal(
    catalog.resolve("browser/capture.js").origin.owner,
    "@example/browser",
  );
  assert.throws(() => catalog.resolve("capture.js"));
  assert.equal(
    catalog.discover((origin) => origin.owner !== source.owner).entries.length,
    0,
  );
  setSources([]);
  assert.throws(() => catalog.resolve("browser/capture.js"), {
    code: "script_not_found",
  });
  setSources([
    source,
    { ...source, owner: "@different/browser", namespace: "Browser" },
  ]);
  assert.throws(() => catalog.discover(), { code: "namespace_conflict" });
  setSources([{ ...source, namespace: "fetch" }]);
  assert.throws(() => catalog.discover(), { code: "invalid_namespace" });
  setSources([]);
  const external = path.join(root, "outside");
  mkdirSync(external);
  writeFileSync(path.join(external, "escape.js"), code("escape.js"));
  symlinkSync(external, path.join(catalog.local, "redirect"), "junction");
  // File aliases must remain inside the declared source even when they have valid headers.
  if (process.platform !== "win32") {
    symlinkSync(
      path.join(external, "escape.js"),
      path.join(catalog.local, "escape.js"),
    );
    assert.throws(() => catalog.resolve("escape.js"), {
      code: "script_path_escape",
    });
    assert.equal(catalog.discover().warnings[0].code, "script_path_escape");
  }
  rmSync(catalog.local, { recursive: true, force: true });
  symlinkSync(external, catalog.local, "junction");
  assert.throws(() => catalog.enroll(code("escape.js")), {
    code: "storage_path_escape",
  });
});

test("open uses Agent-wide 30 default + Top 20 slots with local priority, source fairness and complete schemas", (t) => {
  const { catalog, extension } = fixture(t);
  for (let n = 0; n < 2; n++)
    writeFileSync(
      path.join(catalog.local, `local${n}.js`),
      code(`local${n}.js`, { scriptOpenDefault: true }),
    );
  const a = extension("alpha"),
    b = extension("beta");
  const usage = [];
  for (const source of [a, b]) {
    for (let n = 0; n < 40; n++)
      writeFileSync(
        path.join(
          source.directory,
          `default${n.toString().padStart(2, "0")}.js`,
        ),
        code(`default${n.toString().padStart(2, "0")}.js`, {
          scriptOpenDefault: true,
        }),
      );
    for (let n = 0; n < 15; n++) {
      const filename = `top${n.toString().padStart(2, "0")}.js`;
      writeFileSync(path.join(source.directory, filename), code(filename));
      usage.push({
        owner: source.owner,
        scriptName: source.namespace + "/" + filename,
        count: n + 1,
        lastStartedAt: n,
      });
    }
  }
  const selected = catalog.select(usage);
  assert.equal(selected.total, 112);
  assert.equal(selected.items.length, 50);
  assert.equal(selected.complete, false);
  assert.equal(selected.items[0].scriptName, "local0.js");
  assert.equal(
    selected.items.filter(
      (item) => item.reason === "default" && item.origin.owner === a.owner,
    ).length,
    14,
  );
  assert.equal(
    selected.items.filter(
      (item) => item.reason === "default" && item.origin.owner === b.owner,
    ).length,
    14,
  );
  assert.equal(selected.items[30].executions, 15);
  assert.equal(selected.items[30].scriptName, "alpha/top14.js");
  assert.equal(selected.items[30].scriptInputSchema.required[0], "title");
  assert.equal(catalog.select([]).items.length, 30); // Never fill frequency slots with invented history.
  const bounded = catalog.select(usage, () => true, 1);
  assert.equal(bounded.items.length, 0);
  assert.equal(bounded.omitted.length, 50);
  assert.equal(bounded.complete, false);
});

test("frequency comes from retained started runs with trusted owner/name and excludes preparation failures", (t) => {
  const { root } = fixture(t),
    store = new SqliteStore(root, {
      agentId: "a",
      profile: "development",
      cloudEnvironment: "test",
    });
  t.after(() => store.close());
  const work = store.openWork({
    callerKey: "caller",
    pwd: root,
    snapshotRef: "work.json",
  });
  function accepted(callerKey = "caller") {
    return store.acceptRun({
      callerKey,
      contextId: work.contextId,
      sourceKind: "inline",
      source: {},
    }).run;
  }
  let failed = accepted();
  failed = store.transitionRun(
    failed.runId,
    failed.revision,
    "preparing_inputs",
    { source: { origin: { owner: "local:a" } }, scriptName: "prepare.js" },
  );
  store.transitionRun(failed.runId, failed.revision, "failed");
  let run = accepted();
  run = store.transitionRun(run.runId, run.revision, "preparing_inputs", {
    source: { origin: { owner: "local:a" } },
    scriptName: "started.js",
  });
  run = store.transitionRun(run.runId, run.revision, "running");
  store.requestStop(run.runId, { kind: "cancel" });
  assert.deepEqual(
    store.scriptUsage("caller").map((item) => ({ ...item })),
    [
      {
        owner: "local:a",
        scriptName: "started.js",
        count: 1,
        lastStartedAt: run.startedAt,
      },
    ],
  );
  assert.equal(store.scriptUsage("other").length, 0);
  store.close();
});

test("native compilation is separate from invocation and rejects syntax before side effects or actual-start counting", async (t) => {
  const { work } = fixture(t);
  const loader = await ModuleLoader.create(work, "testcompile", {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  let called = 0;
  const entry = loader.compile("mark(); return 3;", { mark: () => called++ });
  assert.equal(called, 0);
  assert.equal(await entry(), 3);
  assert.equal(called, 1);
  assert.throws(() => loader.compile("return {", {}), { name: "SyntaxError" });
  assert.equal(called, 1);
});
