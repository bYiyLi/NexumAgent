import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
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
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-scripts-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(root, { recursive: true });
  const work = root;
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
  const index = readFileSync(path.join(catalog.local, "index.md"), "utf8");
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
    readFileSync(path.join(catalog.local, "index.md"), "utf8"),
    /新的描述/,
  );
  assert.throws(() => catalog.resolve("scripts/report.js"), {
    code: "script_not_found",
  });
  assert.throws(() => catalog.resolve("report.js", () => false), {
    code: "script_forbidden",
  });
  rmSync(first.snapshot.path);
  assert.throws(() => catalog.resolve("report.js"), {
    code: "script_not_found",
  });
});

test("a manual write failure reports the already-saved file and never silently undoes enrollment", (t) => {
  const { catalog } = fixture(t);
  mkdirSync(path.join(catalog.local, "index.md"));
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
    catalog.discover((origin) => origin.owner !== source.owner).entries
      .filter((item) => item.origin.type === "extension").length,
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

test("open catalog returns every authorized script independent of defaults and usage", (t) => {
  const { catalog, extension } = fixture(t);
  const builtinCount = catalog.discover().entries.length;
  const expected = builtinCount + 112;
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
  assert.equal(selected.total, expected);
  assert.equal(selected.items.length, expected);
  assert.equal(selected.complete, true);
  assert.equal(selected.items.filter((item) => item.origin.owner === a.owner).length, 55);
  assert.equal(selected.items.filter((item) => item.origin.owner === b.owner).length, 55);
  assert.ok(selected.items.find((item) => item.scriptName === "alpha/top14.js").scriptInputSchema.required.includes("title"));
  assert.equal(catalog.select([]).items.length, expected);
  assert.equal(catalog.select(usage, () => true, 1).items.length, expected);
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

test("output contracts are optional Draft 7 metadata in both headers and the index", (t) => {
  const { catalog } = fixture(t);
  const schema = { type: "object", properties: { value: { type: "integer" } } };
  assert.deepEqual(scriptHeader(code("x.js", { scriptOutputSchema: schema })).scriptOutputSchema, schema);
  assert.equal(scriptHeader(code("x.js", { scriptOutputSchema: false })).scriptOutputSchema, false);
  assert.equal(Object.hasOwn(scriptHeader(code("x.js")), "scriptOutputSchema"), false);
  for (const output of [null, { type: "unknown" }, { $ref: "https://example.invalid/schema" }]) {
    assert.throws(() => scriptHeader(code("x.js", { scriptOutputSchema: output })), { code: "invalid_output_schema" });
  }
});

test("Run preparation compiles an exact script header once per preparation and rechecks changed sources", async (t) => {
  const {work,catalog}=fixture(t);
  const {Ajv}=await import("ajv");
  const {RunPreparation}=await import("../dist/host/run-preparation.js");
  const {createHash}=await import("node:crypto");
  const inputId="urn:nexum:test:prepare-input", outputId="urn:nexum:test:prepare-output";
  const schema=(type)=>({$id:inputId,type:"object",properties:{value:{type}},required:["value"],additionalProperties:false});
  const original=code("reuse.js",{scriptInputSchema:schema("integer"),scriptOutputSchema:{$id:outputId,type:"integer"}});
  const revised=code("reuse.js",{scriptInputSchema:schema("string")});
  const originalCompile=Ajv.prototype.compile;
  const descriptor=Object.getOwnPropertyDescriptor(Ajv.prototype,"compile");
  const counts=new Map();
  Ajv.prototype.compile=function(input,...args){
    if(input?.$id===inputId||input?.$id===outputId) counts.set(input.$id,(counts.get(input.$id)??0)+1);
    return Reflect.apply(originalCompile,this,[input,...args]);
  };
  const prepare=new RunPreparation(work,"agent_test","host_test");
  const request={instanceId:"host_test",runId:"run_test",sources:[],input:{value:7}};
  const run=(value)=>prepare.prepare({...request,...value},new AbortController().signal);
  const count=(id)=>counts.get(id)??0;
  try {
    const first=run({code:original});
    assert.equal(count(inputId),1,"enroll, readback, index and input use the same parsed header");
    assert.equal(count(outputId),1);
    assert.equal(first.code,original);
    assert.equal(first.metadata.scriptInputSchema.properties.value.type,"integer");
    assert.equal(run({scriptName:"reuse.js"}).code,original);
    assert.equal(count(inputId),2);
    assert.equal(count(outputId),2);
    assert.throws(()=>run({scriptName:"reuse.js",input:{value:"wrong"}}),{code:"invalid_arguments"});
    assert.equal(count(inputId),3);
    writeFileSync(path.join(catalog.local,"reuse.js"),revised);
    assert.equal(run({scriptName:"reuse.js",input:{value:"new"}}).metadata.scriptInputSchema.properties.value.type,"string");
    assert.equal(count(inputId),4,"same name and schema ID must not reuse an older revision");
    assert.throws(()=>run({scriptName:"reuse.js"}),{code:"invalid_arguments"});
    assert.equal(count(inputId),5);
    const replay={name:first.name,code:original,origin:{...first.origin,revision:createHash("sha256").update(original).digest("hex")}};
    assert.equal(run({replay}).code,original);
    assert.equal(count(inputId),6);
    assert.equal(count(outputId),4);
    assert.throws(()=>run({replay:{...replay,code:revised}}),{code:"snapshot_changed"});
    assert.equal(count(inputId),6);
    assert.ok(!JSON.stringify(first).includes("validateInput"));
  } finally {
    if(descriptor)Object.defineProperty(Ajv.prototype,"compile",descriptor);
    else delete Ajv.prototype.compile;
  }
});
