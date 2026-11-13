import { types } from "node:util";
import { digest } from "./json.js";
import { AgentError } from "./errors.js";

export interface Caller {
  readonly principalId: string;
  readonly clientId: string;
  readonly host?: string;
  readonly model?: string;
}
export const callerKey = (caller: Caller): string =>
  digest({ principalId: caller.principalId, clientId: caller.clientId });
export function fixedCaller(caller: Caller): Caller {
  return Object.freeze({
    principalId: caller.principalId,
    clientId: caller.clientId,
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
