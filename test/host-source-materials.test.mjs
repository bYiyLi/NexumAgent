import assert from "node:assert/strict";
import test from "node:test";
import { prepareSourceMaterials } from "../dist/host/source-materials.js";
import { HostService } from "../dist/host/service.js";

function sourceInput() {
  return { instanceId: "host_source", version: "1.2", description: "Read repository issues.",
    source: { kind: "mcp", objectId: "mcp_issues", name: "github", revision: "actual_revision",
      approvalRevision: "approved_revision", instanceId: "session_1", methods: [{
        id: "method_issues", operation: "tools/list-issues", metadata: {
          name: "tools/list-issues", path: ["tool_list-issues"], description: "List issues in the requested repository.",
          normalizes: true, permissions: ["mcp.use"], schemaDialect: "2020-12",
          inputSchema: { type: "object", required: ["repo"], additionalProperties: false,
            properties: { repo: { type: "string" } }, examples: [{ repo: "demo" }] },
        },
      }] } };
}

const filesOf = (result) => Object.fromEntries(result.files.map(({ name, content }) => [name, content]));
const exampleOf = (files) => /```javascript\n([\s\S]*?)\n```/.exec(files["references/calling.md"])[1];
const invokeExample = (name, binding, code) => new Function(name, `return (async () => {\n${code}\n})();`)(binding);

test("source materials retain exact MCP bracket keys and do not invent missing output declarations", async () => {
  const input = sourceInput();
  const result = prepareSourceMaterials("host_source", input);
  const files = filesOf(result);
  assert.deepEqual(result.source, input.source);
  assert.match(files["references/method-1.md"], /来源未声明 outputSchema/);
  assert.match(files["references/calling.md"], /github\["tool_list-issues"\]/);
  assert.doesNotMatch(files["references/calling.md"], /mcp\.github|github\.tool_list-issues/);
  let calls = 0;
  const observed = await invokeExample("github", { "tool_list-issues": async (arguments_) => {
    calls++;
    assert.deepEqual(arguments_, { repo: "demo" });
    return { content: [{ type: "text", text: "actual tool result" }] };
  } }, exampleOf(files));
  assert.equal(calls, 1);
  assert.equal(observed.content[0].text, "actual tool result");
  assert.match(files["SKILL.md"], /\]\(references\/method-1\.md\)/);
});

test("source materials compile declared schema dependencies and preserve the actual output schema", () => {
  const input = sourceInput();
  const method = input.source.methods[0].metadata;
  method.schemas = [{ $id: "urn:nexum-test:repository", type: "object", required: ["repo"],
    properties: { repo: { type: "string" } }, additionalProperties: false },
  { $id: "urn:nexum-test:count", type: "object", required: ["count"],
    properties: { count: { type: "integer" } } }];
  method.inputSchema = { $ref: "urn:nexum-test:repository", examples: [{ repo: "demo" }] };
  method.outputSchema = { $ref: "urn:nexum-test:count" };
  const files = filesOf(prepareSourceMaterials("host_source", input));
  assert.match(files["references/method-1.md"], /"outputSchema":\{"\$ref":"urn:nexum-test:count"\}/);
  assert.doesNotMatch(files["references/method-1.md"], /来源未声明 outputSchema/);
  method.outputSchema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object" };
  prepareSourceMaterials("host_source", input);
  method.outputSchema = { $ref: "urn:nexum-test:count" };
  method.schemas.pop();
  assert.throws(() => prepareSourceMaterials("host_source", input), { code: "invalid_sdk_schema" });
});

test("source materials use actual OpenAPI fallback names without guessing required business input", async () => {
  const input = sourceInput();
  input.source.kind = "api";
  input.source.objectId = "api_crm";
  input.source.name = "crm";
  input.source.methods = [{ id: "method_read", operation: "GET /customers/{customer-id}", metadata: {
    name: "GET /customers/{customer-id}", path: ["GET /customers/{customer-id}"], description: "Read customer.",
    normalizes: true, permissions: ["api.use"], schemaDialect: "2020-12",
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "object" } } },
    openapi: { reference: "source-1.json", errorsReference: "source-2.json", operation: {
      name: "GET /customers/{customer-id}", method: "GET", path: "/customers/{customer-id}",
      responses: { 204: { description: "No response body." } },
    } },
  } }];
  input.references = { "source-1.json": '{"openapi":"3.0.3"}', "source-2.json": '{"errors":{}}' };
  const result = prepareSourceMaterials("host_source", input);
  const files = filesOf(result);
  const code = exampleOf(files);
  assert.match(code, /async function invoke\(input\)/);
  assert.match(code, /crm\["GET \/customers\/\{customer-id\}"\]\(input\)/);
  assert.match(files["references/calling.md"], /openapi\.operation\.responses/);
  const actualInput = { path: { "customer-id": "confirmed-id" } };
  const response = await invokeExample("crm", { "GET /customers/{customer-id}": async (arguments_) => {
    assert.deepEqual(arguments_, actualInput);
    return { status: 204, headers: {}, data: null };
  } }, `${code}\nreturn await invoke(${JSON.stringify(actualInput)});`);
  assert.equal(response.status, 204);
  assert.equal(files["references/source-1.json"], input.references["source-1.json"]);
});

test("source materials accept the actual MCP resources.listTemplates method contract", async () => {
  const input = sourceInput();
  input.source.methods = [{ id: "templates", operation: "resources/templates/list", metadata: {
    name: "resources/listTemplates", path: ["resources", "listTemplates"], description: "List resource templates.",
    normalizes: true, permissions: ["mcp.use"], schemaDialect: "2020-12",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  } }];
  const code = exampleOf(filesOf(prepareSourceMaterials("host_source", input)));
  const result = await invokeExample("github", { resources: { listTemplates: async (arguments_) => {
    assert.deepEqual(arguments_, {});
    return { resourceTemplates: [] };
  } } }, `${code}\nreturn await invoke({});`);
  assert.deepEqual(result, { resourceTemplates: [] });
});

test("source preparation rejects stale identity, invalid examples and unsafe public reference files", () => {
  assert.throws(() => prepareSourceMaterials("other_host", sourceInput()), { code: "invalid_source_materials" });
  const invalidExample = sourceInput();
  invalidExample.source.methods[0].metadata.inputSchema.examples = [{ unknown: true }];
  assert.throws(() => prepareSourceMaterials("host_source", invalidExample), { code: "invalid_arguments" });
  for (const references of [{ "../private.json": "{}" }, { "source-1.json": "not a public JSON definition" }]) {
    assert.throws(() => prepareSourceMaterials("host_source", { ...sourceInput(), references }),
      { code: "invalid_source_materials" });
  }
  const service = new HostService("host_source", async () => { throw new Error("unexpected RPC"); });
  assert.throws(() => service.prepareSource(sourceInput(), new AbortController().signal),
    { code: "source_materials_unavailable" });
});

test("MCP materials use globalThis bracket access for hyphenated mcpServers names", async () => {
  const input = sourceInput();
  input.source.name = "remote-api";
  const files = filesOf(prepareSourceMaterials("host_source", input));
  assert.match(files["references/calling.md"], /globalThis\["remote-api"\]\["tool_list-issues"\]/);
  const observed = await invokeExample("globalThis", { "remote-api": { "tool_list-issues": async ({repo}) => repo } }, exampleOf(files));
  assert.equal(observed, "demo");
});
