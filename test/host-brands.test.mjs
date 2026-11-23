import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindGoScope, HostRunner } from "../dist/host/runner.js";
import { decodeHostBrands } from "../dist/host/brands.js";
import { mcpResult, McpResultResources } from "../dist/results/mcp.js";
import { TransferOfferDelivery, transferOffer } from "../dist/transfer/offers.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ArtifactStore } from "../dist/results/artifacts.js";
import { encodeHostResult } from "../dist/host/result.js";
import { HostService } from "../dist/host/service.js";

test("only separately verified Go response brands cross a real script Worker", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nexum-host-brands-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = root;
  await mkdir(path.join(work, "modules"), { recursive: true });
  await writeFile(path.join(work, "package.json"), '{"type":"module"}');
  const loader = await ModuleLoader.create(work, `boot_${randomUUID()}`, {
    builtins: () => [], approvedPackages: () => new Map(),
  });
  const runner = new HostRunner(loader);
  t.after(() => runner.close());
  const signal = new AbortController().signal;
  const source = { agentId: "agent_1", profileRoot: root, extensionId: "ext_1",
    connectionResourceId: `res_${"a".repeat(32)}`, connection: "remote",
    origin: { type: "platform", owner: "nexum", namespace: "mcp", version: "1", revision: "r1" } };
  const offers = new TransferOfferDelivery({ agentId: "agent_1", profileRoot: root,
    authorize() {} });
  const transferScope = { ownerKey: "owner_1", grantId: "grant_1", signal, assertCurrent() {} };
  const services = { offers, transferScope,
    authorizeMcp: (actual, method) => actual.connectionResourceId === source.connectionResourceId && method === "tools/call" };
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const secret = "synthetic-offer-secret";
  const payload = { value: { mcp: null, offer: null }, binaryOutputs: [], brands: [
    { kind: "mcp", path: ["mcp"], source, method: "tools/call",
      data: { content: [{ type: "text", text: "hello", _meta: { private: "mcp-secret" } }] } },
    { kind: "transfer", path: ["offer"], data: { transferId: "transfer_1", direction: "upload",
      status: "pending", path: path.join(work, "upload.bin"), expiresAt },
      request: { method: "PUT", url: `https://example.test/upload?token=${secret}`,
        headers: {}, expiresAt } },
  ] };
  const bound = bindGoScope({ instanceId: "host_1", runId: "run_1",
    methods: [{ methodId: "method_1", path: ["sdk", "get"] }] },
  async () => payload, signal, services);
  const result = await runner.start({ runId: "run_1", context: { runId: "run_1" },
    code: "return await sdk.get();", ...bound, signal });
  assert.equal(mcpResult(result.mcp)?.source.connection, "remote");
  assert.equal(transferOffer(result.offer)?.binding.grantId, "grant_1");
  assert.equal(result.mcp.content[0]._meta.private, "mcp-secret");
  assert.equal(result.offer.request.method, "PUT");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("mcp-secret"), false);

  const artifacts = new ArtifactStore(root, "agent_1");
  const mcp = new McpResultResources({ agentId: "agent_1", profileRoot: root,
    resolveResource: async () => ({ connection: "remote", assertCurrent() {},
      async readResource() { return { contents: [] }; } }) });
  const resultScope = { pwd: work, runId: "run_1", ownerKey: "owner_1", grantId: "grant_1",
    signal, assertCurrent() {}, authorize() {}, authorizeTarget() {} };
  const encoded = await encodeHostResult(result, "run_1", signal,
    { artifacts, offers, mcp, scope: resultScope });
  assert.equal(encoded.storedResult.transferOffers[0].reference.transferId, "transfer_1");
  assert.equal(encoded.storedResult.mcpResults.length, 1);
  assert.equal(JSON.stringify(encoded).includes(secret), false);
  assert.equal(JSON.stringify(encoded).includes("mcp-secret"), true);
  await assert.rejects(encodeHostResult(result, "run_2", signal,
    { artifacts, offers, mcp, scope: resultScope }), { code: "result_scope_mismatch" });

  const service = new HostService("host_1", async (method) => method === "sdk.call" ? payload : null,
    signal, async (runId) => {
      assert.equal(runId, "run_1");
      return { brands: services, result: { artifacts, offers, mcp, scope: resultScope } };
    });
  t.after(() => service.close());
  await service.configure({ instanceId: "host_1", profileRoot: root, profile: "development" });
  const hostEncoded = await service.execute({ instanceId: "host_1", runId: "run_1",
    context: { runId: "run_1" }, methods: [{ methodId: "method_1", path: ["sdk", "get"] }],
    code: "return await sdk.get();" }, signal);
  assert.equal(hostEncoded.storedResult.transferOffers[0].reference.transferId, "transfer_1");
  assert.equal(hostEncoded.storedResult.mcpResults.length, 1);
  assert.equal(JSON.stringify(hostEncoded).includes(secret), false);

  assert.throws(() => decodeHostBrands(null, payload.brands.slice(0, 1)), { code: "sdk_brand_unavailable" });
  assert.throws(() => decodeHostBrands(null, [{ ...payload.brands[0], path: [] }],
    { ...services, authorizeMcp: () => false }), { code: "mcp_source_unavailable" });
  assert.throws(() => decodeHostBrands({ item: "forged" }, [{ ...payload.brands[0], path: ["item"] }], services),
    { code: "invalid_sdk_result" });
  assert.equal(mcpResult({ __nexumMcpEnvelope: "forged" }), null);
  assert.equal(transferOffer({ __nexumOfferEnvelope: "forged" }), null);
});
