import { authorizeCall } from "../contracts/caller.js";
import { requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";

/** Actual capabilities of the original Host session, never the last connected Host. */
export interface HostRequestServices {
  readonly capabilities: Readonly<JsonObject>;
  assertCurrent(): void;
  sampling(
    params: JsonObject,
    options?: HostRequestOptions,
  ): Promise<JsonObject>;
  elicitation(
    params: JsonObject,
    options?: HostRequestOptions,
  ): Promise<JsonObject>;
  roots(options?: HostRequestOptions): Promise<JsonObject>;
}
export interface HostRequestOptions {
  /** Cancellation of this particular Host request, independent of the whole run. */
  readonly signal?: AbortSignal;
}

/** Core binds this service to the same accepted run and verified caller as the method. */
export interface HostRequestBinding {
  readonly context: Readonly<JsonObject>;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  assertCurrent(): void;
}

function snapshot(value: unknown, maximum: number): JsonObject {
  requireCondition(
    isPlainRecord(value),
    "invalid_host_response",
    "Host requests and responses must contain ordinary protocol data.",
  );
  return JSON.parse(canonicalJson(value, maximum)) as JsonObject;
}
function freeze(value: JsonObject): Readonly<JsonObject> {
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      if (Array.isArray(item)) {
        for (const child of item)
          if (child && typeof child === "object") freeze(child as JsonObject);
        Object.freeze(item);
      } else freeze(item);
    }
  }
  return Object.freeze(value);
}

/** This is an invocation-bound public facade, not a new request or cancellation engine. */
export function bindHostRequests(
  source: HostRequestServices,
  binding: HostRequestBinding,
): HostRequestServices {
  const current = () => {
    binding.signal.throwIfAborted();
    authorizeCall(binding.assertCurrent);
    authorizeCall(() => source.assertCurrent());
  };
  current();
  const capabilities = freeze(snapshot(source.capabilities, 16384));
  // Media-bearing sampling/elicitation bodies use a bounded independent data
  // channel at the transport boundary. This limit is not the WSS control budget.
  const maximum = 128 * 1024 * 1024;
  const request = async (
    action: "sampling" | "elicitation" | "roots",
    params?: JsonObject,
    options?: HostRequestOptions,
  ): Promise<JsonObject> => {
    current();
    const signal = options?.signal
      ? AbortSignal.any([binding.signal, options.signal])
      : binding.signal;
    signal.throwIfAborted();
    const input = params === undefined ? undefined : snapshot(params, maximum);
    const pending =
      action === "roots"
        ? source.roots({ signal })
        : source[action](input!, { signal });
    // A provider must use binding.signal for actual I/O. Do not race it against
    // a synthetic timer and claim a remote operation has already settled.
    const result = await pending;
    signal.throwIfAborted();
    current();
    return snapshot(result, maximum);
  };
  return Object.freeze({
    capabilities,
    assertCurrent: current,
    sampling: (params: JsonObject, options?: HostRequestOptions) =>
      request("sampling", params, options),
    elicitation: (params: JsonObject, options?: HostRequestOptions) =>
      request("elicitation", params, options),
    roots: (options?: HostRequestOptions) =>
      request("roots", undefined, options),
  });
}
