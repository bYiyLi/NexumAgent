import { randomUUID } from "node:crypto";
import path from "node:path";
import { Peer } from "../../dist/host/peer.js";
import { bindGoScope, HostRunner } from "../../dist/host/runner.js";
import { TransferOfferDelivery, transferOffer } from "../../dist/transfer/offers.js";
import { ArtifactStore } from "../../dist/results/artifacts.js";
import { encodeHostResult } from "../../dist/host/result.js";
import { ModuleLoader } from "../../dist/runtime/modules.js";

const [root, runId] = process.argv.slice(2);
const work = path.join(root, "work");
const peer = new Peer(process.stdin, process.stdout, () => { throw new Error("unexpected request"); });
peer.start();
const controller = new AbortController();
const offers = new TransferOfferDelivery({ agentId: "agent_123", profileRoot: root, authorize() {} });
const scope = { ownerKey: "caller", grantId: "grant_1", signal: controller.signal, assertCurrent() {} };
const loader = await ModuleLoader.create(work, `boot_${randomUUID()}`, { builtins: () => [], approvedPackages: () => new Map() });
const runner = new HostRunner(loader);
const bound = bindGoScope({ instanceId: "host_1", runId, methods: [
  { methodId: "method_1", path: ["transfer", "createUpload"] },
] }, (method, params, signal) => peer.call(method, params, signal), controller.signal,
{ offers, transferScope: scope });
try {
  const result = await runner.start({ runId, context: { runId },
    code: 'return await transfer.createUpload({path: "target.bin"});', ...bound, signal: controller.signal });
  const branded = transferOffer(result);
  const artifacts = new ArtifactStore(root, "agent_123");
  const encoded = await encodeHostResult(result, runId, controller.signal,
    { artifacts, offers, scope: { ...scope, pwd: work, runId, authorize() {}, authorizeTarget() {} } });
  const valid = !!branded && branded.binding.grantId === "grant_1" && result.request.method === "PUT" &&
    encoded.storedResult.transferOffers?.[0]?.reference.transferId === result.transferId &&
    !JSON.stringify(result).includes("synthetic-offer-secret") &&
    !JSON.stringify(encoded).includes("synthetic-offer-secret");
  await peer.call("test.done", { valid, transferId: result.transferId });
} finally {
  await runner.close();
  peer.close();
}
