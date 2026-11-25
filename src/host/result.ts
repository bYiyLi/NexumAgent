import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson } from "../contracts/json.js";
import { ResultEncoder, type ResultArtifacts, type ResultScope, type StoredResult } from "../results/encoder.js";
import type { McpResultResources } from "../results/mcp.js";
import type { TransferOfferDelivery } from "../transfer/offers.js";

/** Services originate in the trusted host and must use Go-owned authorization. */
export interface HostResultServices {
  readonly artifacts: ResultArtifacts;
  readonly offers?: TransferOfferDelivery;
  readonly mcp?: McpResultResources;
  readonly scope: ResultScope;
  readonly stageResult?: (bytes: Buffer) => Promise<{ ticket: string; size: number; sha256: string }>;
}

// Resource operations must be served by Go's current Run authority. Until that
// bridge exists, the old encoder can safely handle non-resource results only.
const unavailable = (): never => {
  throw new AgentError("result_resource_unavailable", "Result resources are not available in this host.");
};
const noResources: ResultArtifacts = {
  root: "/", agentId: "unavailable", maxFileBytes: 256 * 1024 * 1024,
  maxReadBytes: 64 * 1024 * 1024,
  register: unavailable, metadata: unavailable, read: unavailable, list: unavailable,
};
const encoder = new ResultEncoder(noResources);

/** Preserve the old StoredResult semantics; guest data never chooses the envelope. */
export async function encodeHostResult(value: unknown, runId: string, signal: AbortSignal,
  services?: HostResultServices): Promise<{
  version: 1; storedResult: StoredResult;
} | { version: 1; stagedResult: { ticket: string; size: number; sha256: string } }> {
  const assertCurrent = () => signal.throwIfAborted();
  if (services)
    requireCondition(services.scope.runId === runId, "result_scope_mismatch",
      "The result services belong to a different Run.");
  const selected = services
    ? new ResultEncoder(services.artifacts, {}, services.offers, services.mcp)
    : encoder;
  const storedResult = await selected.encode(value, services ? {
    ...services.scope, signal,
    assertCurrent() { assertCurrent(); services.scope.assertCurrent(); },
  } : { pwd: "/", ownerKey: "unavailable", runId, signal, assertCurrent,
    authorize: unavailable });
  // Only the trusted Host can stage results. Large normalized data uses
  // the existing Go-owned temporary byte plane, not a larger IPC frame
  // or a model-facing ResourceLink.
  const bytes = Buffer.from(canonicalJson(storedResult, 128 * 1024 * 1024));
  if (bytes.length > 1024 * 1024) {
    requireCondition(services?.stageResult, "result_storage_unavailable", "Large results require the Agent result byte plane.");
    return { version: 1, stagedResult: await services.stageResult(bytes) };
  }
  return { version: 1, storedResult: JSON.parse(bytes.toString("utf8")) as StoredResult };
}
