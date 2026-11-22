import path from "node:path";
import { requireCondition } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";
import { callerKey, type Caller } from "../contracts/caller.js";
import type { ArtifactRecord, ArtifactScope, ArtifactSource } from "../results/artifacts.js";
import type { ResultArtifacts } from "../results/encoder.js";
import { TransferOfferDelivery } from "../transfer/offers.js";
import { createOutput } from "../sdk/output.js";
import { decodeGoResult, encodeGoArguments } from "./blob.js";
import type { HostRunServices } from "./service.js";

type Call = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
const methodId = "host:result";

export function createRunServices(root: string, agentId: string, instanceId: string,
  call: Call, runId: string, signal: AbortSignal, context: unknown): HostRunServices {
  requireCondition(isPlainRecord(context) && context.agentId === agentId && context.runId === runId &&
    typeof context.pwd === "string" && path.isAbsolute(context.pwd) && isPlainRecord(context.caller) &&
    typeof context.caller.principalId === "string" && typeof context.caller.clientId === "string",
  "invalid_run_scope", "Run resources require the Go-established caller and working directory.");
  const ownerKey = callerKey(context.caller as unknown as Caller);
  const grantId = typeof context.caller.grantId === "string" ? context.caller.grantId : undefined;
  const scope = { instanceId, runId };
  const assertCurrent = () => signal.throwIfAborted();
  const rpc = async (method: string, input: object) => {
    assertCurrent();
    return await call(method, { ...scope, ...input }, signal);
  };
  const metadata = async (uri: string) => await rpc("artifacts.metadata", { uri }) as ArtifactRecord;
  const artifacts: ResultArtifacts = {
    root, agentId, maxFileBytes: 256 * 1024 * 1024, maxReadBytes: 64 * 1024 * 1024,
    async register(source: ArtifactSource, _scope: ArtifactScope, inspect, options = {}) {
      let encoded: object;
      if (source.path !== undefined) encoded = { path: path.resolve(context.pwd as string, source.path),
        ...(source.name === undefined ? {} : { name: source.name }), ...(source.mimeType === undefined ? {} : { mimeType: source.mimeType }) };
      else {
        const data = await encodeGoArguments([source.data], { ...scope, methodId }, call, signal);
        requireCondition(data.binaryInputs.length === 1, "invalid_artifact_source", "A resource needs native binary data.");
        encoded = { ref: data.binaryInputs[0]!.ref, ...(source.name === undefined ? {} : { name: source.name }),
          ...(source.mimeType === undefined ? {} : { mimeType: source.mimeType }) };
      }
      let record = await rpc("artifacts.register", { source: encoded, ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) }) as ArtifactRecord;
      if (inspect) {
        const observed = await inspect({ path: path.join(root, "work", "resources", record.resourceId, "content", "data"),
          size: record.size, name: record.name, mimeType: record.mimeType });
        if (observed.mimeType && observed.mimeType !== record.mimeType)
          record = await rpc("artifacts.register", { source: { uri: record.uri, name: record.name, mimeType: observed.mimeType } }) as ArtifactRecord;
      }
      return record;
    },
    metadata: async (uri) => await metadata(uri),
    async read(uri, _scope, options) {
      const encoded = await rpc("artifacts.read", { uri, maxBytes: options.maxBytes });
      return await decodeGoResult(encoded, { ...scope, methodId }, call, signal) as { resource: ArtifactRecord; data: Buffer };
    },
    async list(_scope, options = {}) { return await rpc("artifacts.list", { options }) as Awaited<ReturnType<ResultArtifacts["list"]>>; },
  };
  const transferScope = { ownerKey, grantId, runId, signal, assertCurrent };
  const offers = new TransferOfferDelivery({ agentId, profileRoot: root,
    authorize(current) { requireCondition(current.ownerKey === ownerKey && current.grantId === grantId && current.signal === signal && !signal.aborted,
      "transfer_not_authorized", "The transfer result belongs to another Run."); } });
  const output = createOutput(context.pwd, assertCurrent);
  return { bindings: { output },
    brands: { offers, transferScope, authorizeMcp: (source) => source.agentId === agentId && source.profileRoot === root && !signal.aborted },
    result: { artifacts, offers, scope: { ...transferScope, pwd: context.pwd,
      authorize() { assertCurrent(); } } } };
}
