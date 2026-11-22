import { randomUUID } from "node:crypto";
import path from "node:path";
import { Peer } from "../../dist/host/peer.js";
import { bindGoScope, HostRunner } from "../../dist/host/runner.js";
import { TransferOfferDelivery, transferOffer } from "../../dist/transfer/offers.js";
import { mcpResult } from "../../dist/results/mcp.js";
import { ModuleLoader } from "../../dist/runtime/modules.js";

const root = process.argv[2];
const work = path.join(root, "work");
const peer = new Peer(process.stdin, process.stdout, () => { throw new Error("unexpected request"); });
peer.start();
const controller = new AbortController();
const offers = new TransferOfferDelivery({ agentId: "agent_1", profileRoot: root, authorize() {} });
const services = { offers,
  transferScope: { ownerKey: "owner_1", grantId: "grant_1", signal: controller.signal, assertCurrent() {} },
  authorizeMcp: (source, method) => source.agentId === "agent_1" && source.profileRoot === root &&
    source.connection === "approved" && method === "tools/call" };
const loader = await ModuleLoader.create(work, `boot_${randomUUID()}`, {
  builtins: () => [], approvedPackages: () => new Map(),
});
const runner = new HostRunner(loader);
const scope = bindGoScope({ instanceId: "host_1", runId: "run_1", methods: [
  { methodId: "method_1", path: ["sdk", "get"] },
] }, (method, params, signal) => peer.call(method, params, signal), controller.signal, services);
try {
  const result = await runner.start({ runId: "run_1", context: { runId: "run_1" },
    code: "return await sdk.get();", ...scope, signal: controller.signal });
  const valid = mcpResult(result.mcp)?.source.connection === "approved" &&
    transferOffer(result.offer)?.binding.grantId === "grant_1" &&
    result.offer.request.method === "PUT" &&
    !JSON.stringify(result).includes("synthetic-offer-secret") &&
    !JSON.stringify(result).includes("mcp-secret");
  await peer.call("test.done", { valid });
} finally {
  await runner.close();
  peer.close();
}
