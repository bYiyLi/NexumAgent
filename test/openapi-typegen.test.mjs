import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareOpenApi } from "../dist/adapters/openapi.js";
import { generateOpenApiTypes } from "../dist/adapters/openapi-typegen.js";

test("generated operation types preserve parameter locations, body media, recursive results and reject wrong argument/result types", async (t) => {
  const spec = {
    openapi: "3.1.0",
    info: { title: "Typed", version: "1" },
    components: {
      schemas: {
        Node: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: {
            id: { type: "integer" },
            child: { $ref: "#/components/schemas/Node" },
          },
        },
      },
    },
    paths: {
      "/nodes/{id}": {
        get: {
          operationId: "readNode",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
            { in: "query", name: "limit", schema: { type: "integer" } },
          ],
          responses: {
            200: {
              description: "Node",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Node" },
                },
              },
            },
          },
        },
      },
      "/upload": {
        post: {
          operationId: "upload",
          requestBody: {
            required: true,
            content: {
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          responses: { 204: { description: "Done" } },
        },
      },
    },
  };
  const adapter = await prepareOpenApi({
    name: "typed",
    revision: "approved-types",
    serviceUrl: "https://api.example/v1",
    document: {
      location: "https://spec.example/openapi.json",
      bytes: JSON.stringify(spec),
    },
  });
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-openapi-types-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "api.ts");
  writeFileSync(
    file,
    adapter.documentation.types +
      `
declare const client:ApiClient;
async function use(){
  const response=await client.readNode({path:{id:"actual"},query:{limit:5}});
  const value:number=response.data.id;
  const nested:number|undefined=response.data.child?.id;
  await client.upload({body:new Uint8Array([1,2,3])});
  // @ts-expect-error path id is a string in the imported source
  await client.readNode({path:{id:5}});
  // @ts-expect-error query limit is numeric, not a string
  await client.readNode({path:{id:"x"},query:{limit:"wrong"}});
  // @ts-expect-error response Node.id remains numeric
  const wrong:string=response.data.id;
  // @ts-expect-error request body is required
  await client.upload({});
  return [value,nested];
}
`,
  );
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((item) =>
      ts.flattenDiagnosticMessageText(item.messageText, "\n"),
    ),
    [],
  );
});

test("generated source types retain valid additional keys and optional tuple prefixes while intersecting enum and const with type", (t) => {
  const schemas = {
    extra: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "integer" }, note: { type: "boolean" } },
      additionalProperties: { type: "string" },
    },
    tuple: {
      type: "array",
      prefixItems: [{ type: "integer" }, { type: "string" }],
      items: false,
    },
    requiredTuple: {
      type: "array",
      prefixItems: [{ type: "integer" }, { type: "string" }],
      items: false,
      minItems: 1,
    },
    enumeration: { type: "integer", enum: ["invalid", 1] },
    nullableEnumeration: { type: "integer", nullable: true, enum: [1] },
    constant: { type: "integer", const: "invalid" },
  };
  const source = generateOpenApiTypes(
    Object.entries(schemas).map(([name, schema]) => ({
      name,
      parameters: [],
      requestBody: {
        required: true,
        content: { "application/json": { schema } },
      },
      responses: {},
    })),
    (value) => value,
    (parameter) => parameter.schema,
    1000000,
  );
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-openapi-types-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "schema.ts");
  writeFileSync(
    file,
    source +
      `
declare const client:ApiClient;
client.extra({body:{id:1,extra:"valid"}});
client.extra({body:{id:1,note:true,extra:"valid"}});
client.tuple({body:[]});
client.tuple({body:[1]});
client.tuple({body:[1,"valid"]});
client.requiredTuple({body:[1]});
client.enumeration({body:1});
// @ts-expect-error declared property retains its own type
client.extra({body:{id:"invalid"}});
// @ts-expect-error optional prefix still preserves positional types
client.tuple({body:["invalid"]});
// @ts-expect-error required tuple prefix cannot be omitted
client.requiredTuple({body:[]});
// @ts-expect-error the enum is intersected with the numeric type
client.enumeration({body:"invalid"});
// @ts-expect-error contradictory type and const produce never
client.constant({body:"invalid"});
// @ts-expect-error nullable changes type, but does not extend enum
client.nullableEnumeration({body:null});
`,
  );
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: [],
  });
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")),
    [],
  );
});
