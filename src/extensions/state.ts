import type { JsonValue } from "../contracts/types.js";
import { AgentError } from "../contracts/errors.js";

export interface StateValue {
  readonly value: JsonValue;
  readonly version: number;
  readonly updatedAt: number;
}
export interface StateDeletion {
  readonly deleted: true;
  readonly version: number;
  readonly updatedAt: number;
}
export interface StateNamespace {
  get(key: string): Promise<StateValue | null>;
  set(
    key: string,
    value: JsonValue,
    options: { expectedVersion: number | null },
  ): Promise<StateValue>;
  delete(
    key: string,
    options: { expectedVersion: number },
  ): Promise<StateDeletion>;
}
export interface StateService {
  readonly agent: StateNamespace;
  readonly user: StateNamespace;
}

export function unavailableState(current: () => void): StateService {
  const fail = async (): Promise<never> => {
    current();
    throw new AgentError(
      "state_service_unavailable",
      "Shared state services are not connected for this Agent.",
    );
  };
  const namespace = Object.freeze({ get: fail, set: fail, delete: fail });
  return Object.freeze({ agent: namespace, user: namespace });
}
