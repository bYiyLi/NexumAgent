import assert from "node:assert/strict";
import { createRequire } from "node:module";

const load = createRequire(new URL("../../dist/adapters/openapi-request.js", import.meta.url));
const swagger = load.resolve("swagger-client");
assert.equal(load.cache[swagger], undefined, "Swagger must not load before the first request");

const { normalizeOpenApiInput, buildOpenApiRequest } =
  await import("../../dist/adapters/openapi-request.js");
assert.equal(load.cache[swagger], undefined, "Importing the API adapter must stay lazy");
assert.equal(normalizeOpenApiInput({ body: "example" }, 1024).body, "example");
assert.equal(load.cache[swagger], undefined, "Input normalization must stay lazy");

const request = buildOpenApiRequest({
  document: {
    openapi: "3.1.0",
    info: { title: "test", version: "1" },
    paths: {
      "/items/{id}": {
        post: {
          operationId: "send",
          parameters: [],
          responses: { 200: { description: "ok" } },
          requestBody: { content: { "application/json": { schema: {} } } },
        },
      },
    },
  },
  operationId: "send",
  method: "post",
  path: "/items/{id}",
  serviceUrl: "https://approved.example/api",
  parameters: [],
  input: {},
  maxRequestBytes: 1024 * 1024,
});
assert.equal(request.method, "POST");
assert.ok(load.cache[swagger], "First real API request must load Swagger");
