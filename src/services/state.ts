import { requireCondition } from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import { canonicalJson } from "../contracts/json.js";
import type { JsonObject, JsonValue } from "../contracts/types.js";
import type { AccessTarget } from "../extensions/api.js";
import type {
  StateDeletion,
  StateNamespace,
  StateService,
  StateValue,
} from "../extensions/state.js";
import { SqliteStore } from "../storage/sqlite.js";

export interface StateScope {
  readonly context: Readonly<JsonObject>;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  authorize(target: AccessTarget): void;
}
export interface UserStateIdentity {
  readonly principalId: string;
  readonly clientId: string;
  /** Preserved from the verified invocation; a real Cloud backend requires it. */
  readonly grantId?: string;
  readonly agentId: string;
  readonly cloudEnvironment: string;
}
/** The Cloud authority performs each version comparison and mutation atomically. */
export interface UserStateBackend {
  get(
    identity: UserStateIdentity,
    key: string,
    signal: AbortSignal,
  ): Promise<StateValue | null>;
  set(
    identity: UserStateIdentity,
    key: string,
    value: JsonValue,
    expectedVersion: number | null,
    signal: AbortSignal,
  ): Promise<StateValue>;
  delete(
    identity: UserStateIdentity,
    key: string,
    expectedVersion: number,
    signal: AbortSignal,
  ): Promise<StateDeletion>;
}

export class StateServices {
  #maxBytes: number;
  #reserve?: (bytes: number) => Promise<{ release(): void }>;
  constructor(
    readonly store: SqliteStore,
    readonly user?: UserStateBackend,
    options: {
      maxBytes?: number;
      /** Trusted Core admission; Cloud user state is not local managed storage. */
      reserve?: (bytes: number) => Promise<{ release(): void }>;
    } = {},
  ) {
    this.#maxBytes = options.maxBytes ?? 64 * 1024;
    this.#reserve = options.reserve;
    requireCondition(
      Number.isSafeInteger(this.#maxBytes) &&
        this.#maxBytes > 0 &&
        this.#maxBytes <= 1024 * 1024,
      "invalid_state_options",
      "Shared value control data needs a positive bounded byte budget.",
    );
  }
  bind(scope: StateScope): StateService {
    const caller = scope.context.caller;
    requireCondition(
      caller &&
        !Array.isArray(caller) &&
        typeof caller === "object" &&
        typeof caller.principalId === "string" &&
        caller.principalId.length > 0 &&
        typeof caller.clientId === "string" &&
        caller.clientId.length > 0 &&
        scope.context.agentId === this.store.binding.agentId,
      "invalid_state_context",
      "Shared services require the verified caller and actual Agent binding.",
    );
    const identity = Object.freeze({
      principalId: caller.principalId,
      clientId: caller.clientId,
      ...(typeof caller.grantId === "string"
        ? { grantId: caller.grantId }
        : {}),
      agentId: this.store.binding.agentId,
      cloudEnvironment: this.store.binding.cloudEnvironment,
    });
    const copy = <T>(value: T, metadataBytes = 0): T =>
      JSON.parse(canonicalJson(value, this.#maxBytes + metadataBytes)) as T;
    const authorize = (
      kind: "agent" | "user",
      key: string,
      access: "read" | "write",
    ) => {
      scope.signal.throwIfAborted();
      authorizeCall(() => scope.assertCurrent());
      requireCondition(
        typeof key === "string" &&
          key.length > 0 &&
          Buffer.byteLength(key) <= 256 &&
          !key.includes("\0"),
        "invalid_state_key",
        "A shared key must be nonempty bounded text.",
      );
      authorizeCall(() =>
        scope.authorize({
          type: kind === "agent" ? "agent-state" : "user-state",
          value: key,
          access,
        }),
      );
    };
    const version = (
      value: unknown,
      allowNull: boolean,
    ): value is number | null =>
      (allowNull && value === null) ||
      (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
    const stateValue = (value: StateValue): StateValue => {
      const data = copy(value, 1024);
      requireCondition(
        data &&
          typeof data === "object" &&
          Object.hasOwn(data, "value") &&
          version(data.version, false) &&
          Number.isSafeInteger(data.updatedAt) &&
          Object.keys(data).every((key) =>
            ["value", "version", "updatedAt"].includes(key),
          ),
        "invalid_state_response",
        "The shared authority returned an invalid value or revision.",
      );
      copy(data.value);
      return data;
    };
    const backend = () => {
      requireCondition(
        this.user,
        "user_state_unavailable",
        "The Cloud user-state authority is unavailable; no local cache was substituted.",
      );
      return this.user;
    };
    const namespace = (kind: "agent" | "user"): StateNamespace =>
      Object.freeze({
        get: async (key: string) => {
          authorize(kind, key, "read");
          const data =
            kind === "agent"
              ? this.store.getState(key)
              : await backend().get(identity, key, scope.signal);
          authorize(kind, key, "read");
          return data === null ? null : stateValue(data);
        },
        set: async (
          key: string,
          value: JsonValue,
          options: { expectedVersion: number | null },
        ) => {
          authorize(kind, key, "write");
          const control = copy(options);
          requireCondition(
            control &&
              Object.keys(control).length === 1 &&
              Object.hasOwn(control, "expectedVersion") &&
              version(control.expectedVersion, true),
            "invalid_state_version",
            "A shared write needs its read revision or null for create-only.",
          );
          const serialized = canonicalJson(value, this.#maxBytes);
          const data = JSON.parse(serialized) as JsonValue;
          // No retry: a disconnected mutation may already have committed at its authority.
          if (kind === "user")
            return stateValue(
              await backend().set(
                identity,
                key,
                data,
                control.expectedVersion,
                scope.signal,
              ),
            );
          // The fixed overhead accounts for the key, revision and local metadata;
          // SQLite settlement/headroom is retained by the Core budget provider.
          const reservation = await this.#reserve?.(
            Buffer.byteLength(serialized) + Buffer.byteLength(key) + 1024,
          );
          try {
            // Admission may wait for a native usage scan. It never freezes authority.
            authorize(kind, key, "write");
            return stateValue(
              this.store.setState(key, data, control.expectedVersion),
            );
          } finally {
            reservation?.release();
          }
        },
        delete: async (key: string, options: { expectedVersion: number }) => {
          authorize(kind, key, "write");
          const control = copy(options);
          requireCondition(
            control &&
              Object.keys(control).length === 1 &&
              Object.hasOwn(control, "expectedVersion") &&
              version(control.expectedVersion, false),
            "invalid_state_version",
            "Deleting a shared value requires its positive read revision.",
          );
          const changed =
            kind === "agent"
              ? this.store.deleteState(key, control.expectedVersion)
              : await backend().delete(
                  identity,
                  key,
                  control.expectedVersion,
                  scope.signal,
                );
          const result = copy(changed);
          requireCondition(
            result &&
              result.deleted === true &&
              version(result.version, false) &&
              Number.isSafeInteger(result.updatedAt),
            "invalid_state_response",
            "The shared authority returned an invalid deletion receipt.",
          );
          return result;
        },
      });
    return Object.freeze({
      agent: namespace("agent"),
      user: namespace("user"),
    });
  }
}
