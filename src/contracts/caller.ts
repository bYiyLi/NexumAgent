import { types } from "node:util";
import { canonicalJson, digest, isPlainRecord } from "./json.js";
import { AgentError } from "./errors.js";
import type { JsonObject } from "./types.js";

export const MAX_HOST_FEATURE_BYTES_V2 = 16 * 1024;
export type HostFeatures = JsonObject & {
  readonly sampling?: Readonly<
    JsonObject & {
      context?: JsonObject;
      tools?: JsonObject;
    }
  >;
  readonly elicitation?: Readonly<
    JsonObject & {
      form?: JsonObject & { applyDefaults?: boolean };
      url?: JsonObject;
    }
  >;
  readonly roots?: Readonly<JsonObject & { listChanged?: boolean }>;
};

function snapshotHostFeatures(value: HostFeatures): HostFeatures {
  const copy = JSON.parse(canonicalJson(value, MAX_HOST_FEATURE_BYTES_V2));
  const object = (value: unknown, keys?: readonly string[]) =>
    isPlainRecord(value) &&
    (!keys || Object.keys(value).every((key) => keys.includes(key)));
  const valid =
    object(copy, ["sampling", "elicitation", "roots"]) &&
    (copy.sampling === undefined ||
      (object(copy.sampling, ["context", "tools"]) &&
        [copy.sampling.context, copy.sampling.tools].every(
          (item) => item === undefined || object(item),
        ))) &&
    (copy.elicitation === undefined ||
      (object(copy.elicitation, ["form", "url"]) &&
        (copy.elicitation.form === undefined ||
          (object(copy.elicitation.form) &&
            (copy.elicitation.form.applyDefaults === undefined ||
              typeof copy.elicitation.form.applyDefaults === "boolean"))) &&
        (copy.elicitation.url === undefined ||
          object(copy.elicitation.url)))) &&
    (copy.roots === undefined ||
      (object(copy.roots, ["listChanged"]) &&
        (copy.roots.listChanged === undefined ||
          typeof copy.roots.listChanged === "boolean")));
  if (!valid)
    throw new AgentError(
      "invalid_host_features",
      "Host features must use the negotiated standard capability objects.",
    );
  const freeze = (item: any): void => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy as HostFeatures;
}

export interface McpCaller {
  readonly principalId: string;
  readonly clientId: string;
  readonly source?: "mcp";
  readonly sessionRef?: never;
  /** Verified Cloud Grant binding; never populated from script inputs. */
  readonly grantId?: string;
  /** Cloud-minted association and actual negotiated MCP Host capabilities. */
  readonly hostRef?: string;
  readonly hostCapabilities?: Readonly<{
    sampling: boolean;
    elicitation: boolean;
    roots: boolean;
  }>;
  readonly hostFeatures?: HostFeatures;
  readonly host?: string;
  readonly model?: string;
}
export interface OwnerSessionCaller {
  readonly principalId: string;
  readonly clientId: string;
  readonly source: "owner_session";
  readonly sessionRef: string;
  readonly grantId?: never;
  readonly host?: never;
  readonly model?: never;
  readonly hostRef?: never;
  readonly hostCapabilities?: never;
  readonly hostFeatures?: never;
}
export type Caller = JsonObject & (McpCaller | OwnerSessionCaller);
export const callerKey = (caller: Caller): string =>
  digest({ principalId: caller.principalId, clientId: caller.clientId });
export function fixedCaller(caller: Caller): Caller {
  if (caller.source === "owner_session") {
    if (
      typeof caller.sessionRef !== "string" ||
      !/^[0-9a-f]{64}$/.test(caller.sessionRef) ||
      caller.clientId !== `nexum-console:${caller.sessionRef}` ||
      [
        caller.grantId,
        caller.host,
        caller.model,
        caller.hostRef,
        caller.hostCapabilities,
        caller.hostFeatures,
      ].some((item) => item !== undefined)
    )
      throw new AgentError(
        "invalid_caller",
        "An owner session must retain its distinct verified identity.",
      );
    return Object.freeze({
      principalId: caller.principalId,
      clientId: caller.clientId,
      source: "owner_session",
      sessionRef: caller.sessionRef,
    });
  }
  if (
    (caller.source !== undefined && caller.source !== "mcp") ||
    caller.sessionRef !== undefined
  )
    throw new AgentError("invalid_caller", "The Caller identity is invalid.");
  const features =
    caller.hostFeatures === undefined
      ? undefined
      : snapshotHostFeatures(caller.hostFeatures);
  return Object.freeze({
    principalId: caller.principalId,
    clientId: caller.clientId,
    ...(caller.source === undefined ? {} : { source: caller.source }),
    ...(caller.grantId === undefined ? {} : { grantId: caller.grantId }),
    ...(caller.hostRef === undefined ? {} : { hostRef: caller.hostRef }),
    ...(caller.hostCapabilities === undefined
      ? {}
      : {
          hostCapabilities: Object.freeze({
            sampling: caller.hostCapabilities.sampling,
            elicitation: caller.hostCapabilities.elicitation,
            roots: caller.hostCapabilities.roots,
          }),
        }),
    ...(features === undefined ? {} : { hostFeatures: features }),
    ...(caller.host === undefined ? {} : { host: caller.host }),
    ...(caller.model === undefined ? {} : { model: caller.model }),
  });
}
// Authorization uses the already-verified invocation/current local policy. An
// accidentally async or boolean callback must never be treated as permission.
export function authorizeCall(check: () => unknown): void {
  const result = check();
  if (result === undefined) return;
  if (types.isPromise(result))
    void Promise.prototype.then.call(result, undefined, () => {});
  throw new AgentError(
    "authorization_configuration",
    "The authorization callback must finish synchronously by returning undefined or throwing.",
  );
}
