import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  parseOpenApi,
  openApiLimits,
} from "../dist/adapters/openapi-schema.js";

function input(document, references = []) {
  return {
    name: "crm",
    revision: "approved-one",
    document: {
      location: "https://spec.example/api/openapi.json",
      bytes: typeof document === "string" ? document : JSON.stringify(document),
    },
    references,
    serviceUrl: "https://api.example/v1",
  };
}
function source(version = "3.1.0", schema = { type: "string" }) {
  return {
    openapi: version,
    info: { title: "Fixture API", version: "1.0.0" },
    paths: {
      "/thing": {
        get: {
          operationId: "getThing",
          responses: {
            200: {
              description: "OK",
              content: { "application/json": { schema } },
            },
          },
        },
      },
    },
  };
}
const parse = (value) => parseOpenApi(value, openApiLimits(value.limits));

test("standard parser accepts JSON/YAML matrices and payload validators keep OAS3.0 draft4 and OAS3.1 null semantics", async () => {
  const old = await parse(
    input(
      source("3.0.4", {
        type: "number",
        minimum: 1,
        exclusiveMinimum: true,
        nullable: true,
      }),
    ),
  );
  const validate = old.compile(
    old.document.paths["/thing"].get.responses["200"].content[
      "application/json"
    ].schema,
    "request",
  );
  validate(null);
  validate(2);
  assert.throws(() => validate(1), { code: "api_invalid_arguments" });
  const modern = await parse(
    input(source("3.1.2", { type: ["string", "null"], minLength: 2 })),
  );
  const check = modern.compile(
    modern.document.paths["/thing"].get.responses["200"].content[
      "application/json"
    ].schema,
    "response",
  );
  check(null);
  check("okay");
  assert.throws(() => check("a"), { code: "api_invalid_response" });
  const yaml =
    "openapi: 3.0.0\ninfo:\n  title: YAML API\n  version: 1.0.0\npaths:\n  /thing:\n    get:\n      responses:\n        '200':\n          description: OK\n";
  assert.equal((await parse(input(yaml))).sourceVersion, "3.0.0");
});

test("Swagger 2 definitions and fixed cross-file references retain real JSON Pointer and recursive schema validation", async () => {
  const swagger = {
    swagger: "2.0",
    info: { title: "Legacy", version: "1" },
    paths: {
      "/thing": {
        get: {
          responses: {
            200: { description: "ok", schema: { $ref: "#/definitions/Thing" } },
          },
        },
      },
    },
    definitions: {
      Thing: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          child: { $ref: "#/definitions/Thing" },
        },
      },
    },
  };
  const legacy = await parse(input(swagger));
  const check = legacy.compile(
    legacy.document.paths["/thing"].get.responses["200"].schema,
    "response",
  );
  check({ name: "a", child: { name: "b" } });
  assert.throws(() => check({ child: {} }), { code: "api_invalid_response" });
  const external = input(source("3.1.0", { $ref: "./schemas.json#/Thing" }), [
    {
      location: "https://spec.example/api/schemas.json",
      bytes: JSON.stringify({ Thing: { type: "integer", minimum: 3 } }),
    },
  ]);
  const parsed = await parse(external),
    validate = parsed.compile(
      parsed.document.paths["/thing"].get.responses["200"].content[
        "application/json"
      ].schema,
      "request",
    );
  validate(4);
  assert.throws(() => validate(2), { code: "api_invalid_arguments" });
  assert.match(parsed.revision, /^sha256:[0-9a-f]{64}$/);
});

test("standard structure, unknown dialects and unsupported advanced identifiers fail explicitly", async () => {
  await assert.rejects(parse(input({ openapi: "3.1.0" })), {
    code: "api_invalid_specification",
  });
  await assert.rejects(parse(input(source("3.2.0"))), {
    code: "api_unsupported_version",
  });
  await assert.rejects(
    parse(
      input({
        ...source(),
        jsonSchemaDialect: "https://unknown.example/dialect",
      }),
    ),
    { code: "api_unsupported_schema_dialect" },
  );
  const parsed = await parse(input(source()));
  assert.throws(
    () =>
      parsed.compile(
        { $schema: "https://unknown.example/dialect", type: "string" },
        "request",
      ),
    { code: "api_unsupported_schema_dialect" },
  );
  assert.throws(
    () => parsed.compile({ $id: "urn:unknown", type: "string" }, "request"),
    { code: "api_unsupported_reference" },
  );
  assert.throws(
    () => parsed.compile({ type: "string", nullable: true }, "request"),
    { code: "api_unsupported_schema_keyword" },
  );
});

test("unapproved refs cannot trigger HTTP or file reads and fixed source budget/cancellation checks precede parsing", async (t) => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.end('{"type":"string"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/private.json`;
  await assert.rejects(parse(input(source("3.1.0", { $ref: url }))), {
    code: "api_invalid_specification",
  });
  await assert.rejects(
    parse(
      input(source("3.1.0", { $ref: "file:///unapproved-private-file.json" })),
    ),
    { code: "api_invalid_specification" },
  );
  assert.equal(requests, 0);
  const small = input(source());
  small.limits = { documentBytes: 16 };
  await assert.rejects(parse(small), { code: "api_document_too_large" });
  const stopped = new AbortController();
  stopped.abort(new Error("stop parse"));
  await assert.rejects(
    parseOpenApi(input(source()), openApiLimits(), stopped.signal),
    /stop parse/,
  );
});

test("request/response direction respects readOnly/writeOnly required fields and native binary size constraints", async () => {
  const parsed = await parse(input(source("3.0.3")));
  const schema = {
    type: "object",
    required: ["id", "password", "file"],
    properties: {
      id: { type: "integer", readOnly: true },
      password: { type: "string", writeOnly: true },
      file: { type: "string", format: "binary", minLength: 2, maxLength: 4 },
    },
  };
  parsed.compile(
    schema,
    "request",
  )({ password: "secret", file: new Blob(["abc"]) });
  parsed.compile(schema, "response")({ id: 1, file: new Uint8Array([1, 2]) });
  assert.throws(
    () =>
      parsed.compile(
        schema,
        "request",
      )({ password: "secret", file: new Blob(["toolong"]) }),
    { code: "api_invalid_arguments" },
  );
});

test("native binary bridging never relaxes ordinary string length or original non-string type assertions", async () => {
  const parsed = await parse(input(source("3.1.0")));
  const binary = parsed.compile(
    { type: "string", format: "binary", minLength: 5, maxLength: 8 },
    "request",
  );
  assert.throws(() => binary("x"), { code: "api_invalid_arguments" });
  binary("valid");
  binary(new Blob(["valid"]));
  assert.throws(() => binary(new Blob(["x"])), {
    code: "api_invalid_arguments",
  });
  const integer = parsed.compile(
    { type: "integer", format: "binary" },
    "request",
  );
  assert.throws(() => integer("x"), { code: "api_invalid_arguments" });
  integer(7);
  parsed.compile(
    {},
    "request",
  )(new Blob(["raw octet-stream without a schema"]));
});

test("native references cannot bypass target/sibling intersections, including siblings inside reference chains", async () => {
  const doc = source("3.1.0");
  doc.components = {
    schemas: {
      Target: { type: "string", maxLength: 3 },
      Integer: { type: "integer" },
      Binary: { type: "string", format: "binary", minLength: 2 },
      Chain: {
        $ref: "#/components/schemas/Target",
        type: "string",
        format: "binary",
        maxLength: 10,
      },
    },
  };
  const parsed = await parse(input(doc));
  const constrained = parsed.compile(
    {
      $ref: "#/components/schemas/Target",
      type: "string",
      format: "binary",
      maxLength: 10,
    },
    "request",
  );
  assert.throws(() => constrained("12345"), { code: "api_invalid_arguments" });
  assert.throws(() => constrained(new Blob(["12345"])), {
    code: "api_unsupported_binary_schema",
  });
  const impossible = parsed.compile(
    { $ref: "#/components/schemas/Integer", type: "string", format: "binary" },
    "request",
  );
  assert.throws(() => impossible("abc"), { code: "api_invalid_arguments" });
  assert.throws(() => impossible(new Blob(["abc"])), {
    code: "api_unsupported_binary_schema",
  });
  assert.throws(
    () =>
      parsed.compile(
        { $ref: "#/components/schemas/Chain" },
        "request",
      )(new Blob(["12345"])),
    { code: "api_unsupported_binary_schema" },
  );
  parsed.compile(
    { $ref: "#/components/schemas/Binary" },
    "request",
  )(new Blob(["valid"]));
});
