import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson } from "../contracts/json.js";
import type { JsonValue } from "../contracts/types.js";
import { validateContract } from "../contracts/validation.js";
import { validateConnectionV2 } from "../contracts/wire-validation.js";
import type {
  WireCallerV2,
  WireInvocationContextV2,
} from "../contracts/wire.js";
import type { StateDeletion, StateValue } from "../extensions/state.js";
import type { UserStateBackend, UserStateIdentity } from "../services/state.js";
import type { AgentControlPort } from "./runtime.js";

export interface CloudUserStateOptions {
  /** Obtains the actual current authenticated socket, never a cached old one. */
  readonly control: () => Pick<
    AgentControlPort,
    "binding" | "signal" | "request"
  >;
  /** Captures current policy for this verified caller, never a global caller. */
  readonly context: (caller: WireCallerV2) => WireInvocationContextV2;
}

/** Cloud owns values and CAS. This adapter sends one observation and never replays a mutation. */
export class CloudUserStateBackend implements UserStateBackend {
  constructor(readonly options: CloudUserStateOptions) {}

  #scope(identity: UserStateIdentity, signal: AbortSignal) {
    signal.throwIfAborted();
    requireCondition(
      typeof identity.grantId === "string" && identity.grantId.length > 0,
      "unauthorized",
      "Cloud user state requires a verified Grant.",
    );
    const context = this.options.context({
        principalId: identity.principalId,
        clientId: identity.clientId,
        grantId: identity.grantId,
      }),
      control = this.options.control();
    if (control.signal.aborted)
      throw new AgentError(
        "user_state_unavailable",
        "The Cloud user-state authority is unavailable; no local value was substituted.",
      );
    validateConnectionV2(context.connection, control.binding);
    requireCondition(
      context.caller.principalId === identity.principalId &&
        context.caller.clientId === identity.clientId &&
        context.caller.grantId === identity.grantId &&
        control.binding.agentId === identity.agentId &&
        control.binding.cloudEnvironment === identity.cloudEnvironment &&
        context.authorization.agentId === identity.agentId,
      "runtime_binding_mismatch",
      "Cloud shared values require this exact caller and Agent binding.",
    );
    return { control, context };
  }

  async get(
    identity: UserStateIdentity,
    key: string,
    signal: AbortSignal,
  ): Promise<StateValue | null> {
    const { control, context } = this.#scope(identity, signal),
      input = { namespace: "default" as const, key };
    validateContract("wire.input:state.user.get", input);
    const result = await control.request(
      "state.user.get",
      context,
      input,
      signal,
    );
    validateContract("wire.output:state.user.get", result);
    return JSON.parse(
      canonicalJson(result.state, 64 * 1024 + 1024),
    ) as StateValue | null;
  }

  async set(
    identity: UserStateIdentity,
    key: string,
    value: JsonValue,
    expectedVersion: number | null,
    signal: AbortSignal,
  ): Promise<StateValue> {
    const { control, context } = this.#scope(identity, signal),
      input = { namespace: "default" as const, key, value, expectedVersion };
    validateContract("wire.input:state.user.set", input);
    const result = await control.request(
      "state.user.set",
      context,
      input,
      signal,
    );
    validateContract("wire.output:state.user.set", result);
    return JSON.parse(canonicalJson(result, 64 * 1024 + 1024)) as StateValue;
  }

  async delete(
    identity: UserStateIdentity,
    key: string,
    expectedVersion: number,
    signal: AbortSignal,
  ): Promise<StateDeletion> {
    const { control, context } = this.#scope(identity, signal),
      input = { namespace: "default" as const, key, expectedVersion };
    validateContract("wire.input:state.user.delete", input);
    const result = await control.request(
      "state.user.delete",
      context,
      input,
      signal,
    );
    validateContract("wire.output:state.user.delete", result);
    return JSON.parse(canonicalJson(result, 1024)) as StateDeletion;
  }
}
