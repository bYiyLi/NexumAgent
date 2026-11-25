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
}> {
  const assertCurrent = () => signal.throwIfAborted();
  if (services)
    requireCondition(services.scope.runId === runId, "result_scope_mismatch",
      "The result services belong to a different Run.");
  const selected = services
    ? // Reserve room for the authoritative Run identity, wait state and envelope.
      new ResultEncoder(services.artifacts, { textBytes: 48 * 1024 }, services.offers, services.mcp)
    : encoder;
  const storedResult = await selected.encode(value, services ? {
    ...services.scope, signal,
    assertCurrent() { assertCurrent(); services.scope.assertCurrent(); },
  } : { pwd: "/", ownerKey: "unavailable", runId, signal, assertCurrent,
    authorize: unavailable });
  // The private protocol is bounded. Larger results require the Go byte plane.
  return JSON.parse(canonicalJson({ version: 1, storedResult })) as {
    version: 1; storedResult: StoredResult;
  };
}
