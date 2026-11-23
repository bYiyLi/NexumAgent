import assert from "node:assert/strict";
import test from "node:test";
import { maintenanceExtension } from "../dist/sdk/maintenance.js";
import { compileMethodSchema } from "../dist/contracts/validation.js";

test("every built-in maintenance method compiles under the strict declared JSON Schema dialect", () => {
  const methods = maintenanceExtension().methods;
  assert.ok(Object.keys(methods).length >= 14);
  for (const [name, method] of Object.entries(methods))
    assert.doesNotThrow(() => compileMethodSchema(method.inputSchema, method.schemaDialect), "invalid method schema: " + name);
});

test("MCP add/update accept native mcpServers stdio, SSE and Streamable HTTP single-entry requests", () => {
  const methods = maintenanceExtension().methods;
  const valid = [
    { filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } },
    { "remote-api": { type: "sse", url: "https://example.test/sse", headers: { Authorization: "Bearer token" } } },
    { "remote-api": { url: "https://example.test/mcp", headers: { Authorization: "Bearer "+"$"+"{env:API_TOKEN}" } } },
  ];
  const invalid = [
    { filesystem: { command: "npx", url: "https://example.test" } },
    { filesystem: { type: "stdio" } },
    { name: "filesystem", config: { command: "npx" } },
    { filesystem: { command: "npx" }, other: { url: "https://example.test/mcp" } },
  ];
  for (const name of ["mcp.add", "mcp.update"]) {
    const validate = compileMethodSchema(methods[name].inputSchema, methods[name].schemaDialect);
    for (const input of valid) assert.doesNotThrow(() => validate(input), name + " should accept " + JSON.stringify(input));
    for (const input of invalid) assert.throws(() => validate(input), name + " accepted " + JSON.stringify(input));
  }
});
