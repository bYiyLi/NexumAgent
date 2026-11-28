import type { AgentCapabilityDetail } from "./agent-capabilities";

// These records are reachable only from the explicit development workspace preview.
export const previewCapabilityDetails: Record<string, AgentCapabilityDetail> = {
  "preview-mcp-github": {
    id: "preview-mcp-github", name: "GitHub", kind: "mcp",
    configuration: { type: "http", url: "https://mcp.example.com/github", headers: { Authorization: "[hidden]" } },
    methods: [
      { name: "search_repositories", description: "Search GitHub repositories", parameters: [{ name: "query", type: "string", required: true }] },
      { name: "list_issues", description: "List repository issues", parameters: [{ name: "owner", type: "string", required: true }, { name: "repo", type: "string", required: true }] },
    ], methodsComplete: true,
  },
  "preview-api-crm": {
    id: "preview-api-crm", name: "CRM API", kind: "api",
    configuration: { serviceUrl: "https://crm.example.com/api", limits: { requestTimeoutMs: 15000 } },
    methods: [{ name: "listCustomers", method: "GET", path: "/customers", description: "List customers", parameters: [{ name: "limit", type: "integer", required: false }] }], methodsComplete: true,
  },
  "preview-npm-browser": {
    id: "preview-npm-browser", name: "@nexum-hub/browser", kind: "npm",
    configuration: { name: "@nexum-hub/browser", installedVersion: "1.1.0", namespace: "browser" },
    methods: [{ name: "browsers.list", description: "List authorized browsers", parameters: [] }], methodsComplete: true,
  },
  "preview-mcp-filesystem": {
    id: "preview-mcp-filesystem", name: "Filesystem", kind: "mcp", configuration: { type: "stdio", command: "[hidden]", args: "[hidden]" },
    methods: [{ name: "list_directory", parameters: [{ name: "path", type: "string", required: true }] }], methodsComplete: true,
  },
  "preview-npm-utils": {
    id: "preview-npm-utils", name: "@acme/data-utils", kind: "npm", configuration: { name: "@acme/data-utils", installedVersion: "2.4.0" },
    methods: [], methodsComplete: false,
  },
};
