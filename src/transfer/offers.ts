import path from "node:path";
import { inspect, types } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { JsonObject, JsonValue } from "../contracts/types.js";
import type { AccessTarget } from "../extensions/api.js";
import type { ArtifactScope } from "../results/artifacts.js";
import { parseArtifactUri } from "../results/artifacts.js";

export type IssuedTransferSnapshot = JsonObject & {
  transferId: string;
  direction: "upload" | "download";
  status: "pending";
  expiresAt: string;
};
export type TransferReference = JsonObject & {
  transferId: string;
  expiresAt: string;
};
export type TransferRequest = {
  readonly method: "GET" | "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
};
export type TransferOffer = Readonly<
  IssuedTransferSnapshot & { request: TransferRequest }
>;
export interface TransferOfferScope extends Pick<
  ArtifactScope,
  "ownerKey" | "signal" | "assertCurrent"
> {
  /** The current verified Grant, never recovered from a historical snapshot. */
  readonly grantId?: string;
  /** Fresh Core target authority; never retain a settled creator invocation. */
  readonly authorizeTarget?: (target: AccessTarget) => void;
}
export interface TransferBinding {
  readonly ownerKey: string;
  readonly grantId: string;
  readonly agentId: string;
  readonly profileRoot: string;
}
export interface IssuedTransferOffer {
  readonly snapshot: IssuedTransferSnapshot;
  readonly reference: TransferReference;
  readonly binding: TransferBinding;
}
export type TransferDelivery = JsonObject & {
  transferId: string;
  available: boolean;
};
export interface TransferOfferDeliveryOptions {
  readonly agentId: string;
  readonly profileRoot: string;
  readonly maxEntries?: number;
  /** Encoded snapshot/request bytes; entry count independently bounds object overhead. */
  readonly maxBytes?: number;
  readonly now?: () => number;
  /** Trusted current transfer/Grant/target authority, including live unconsumed state. */
  readonly authorize?: (
    scope: TransferOfferScope,
    snapshot: IssuedTransferSnapshot,
  ) => void;
}

// This weak map proves issued identity only; it does not retain a request or
// keep a global channel/cache alive. Short-lived credentials belong to one
// explicitly bounded Agent/profile delivery instance below.
const issued = new WeakMap<object, IssuedTransferOffer>();
const snapshotFields = new Set([
  "transferId",
  "direction",
  "status",
  "runId",
  "contextId",
  "projectId",
  "path",
  "resource",
  "progress",
  "createdAt",
  "expiresAt",
  "startedAt",
  "deadlineAt",
  "finishedAt",
  "file",
  "error",
  "maxBytes",
]);
const terminalReasons = new Set([
  "consumed",
  "expired",
  "terminal",
  "unavailable",
]);
const maximumViewBytes = 16384;
function bounded(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximum &&
    !/[\0\r\n]/.test(value)
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function jsonRecord(value: unknown, fields?: ReadonlySet<string>): JsonObject {
  requireCondition(
    isPlainRecord(value),
    "invalid_transfer_offer",
    "A transfer offer requires bounded ordinary data.",
  );
  if (fields)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      requireCondition(
        typeof key === "string" &&
          fields.has(key) &&
          descriptor.enumerable &&
          "value" in descriptor,
        "invalid_transfer_offer",
        "The transfer offer contains an unsupported field.",
      );
    }
  try {
    return JSON.parse(canonicalJson(value, maximumViewBytes)) as JsonObject;
  } catch {
    throw new AgentError(
      "invalid_transfer_offer",
      "The transfer offer data is invalid or exceeds its bounded budget.",
    );
  }
}
export function issuedTransferSnapshot(value: unknown): IssuedTransferSnapshot {
  const data = jsonRecord(value, snapshotFields);
  requireCondition(
    bounded(data.transferId, 128) &&
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(data.transferId) &&
      ["upload", "download"].includes(data.direction as string) &&
      data.status === "pending" &&
      typeof data.expiresAt === "string" &&
      Number.isFinite(Date.parse(data.expiresAt)),
    "invalid_transfer_offer",
    "A transfer snapshot needs its actual identity, direction, state and fixed expiry.",
  );
  data.expiresAt = new Date(data.expiresAt).toISOString();
  requireCondition(
    data.path === undefined ||
      (typeof data.path === "string" && path.isAbsolute(data.path)),
    "invalid_transfer_offer",
    "A transfer target must be its confirmed local path.",
  );
  if (data.resource !== undefined) {
    requireCondition(
      isPlainRecord(data.resource) &&
        typeof data.resource.uri === "string" &&
        Object.keys(data.resource).every((key) =>
          [
            "uri",
            "name",
            "mimeType",
            "size",
            "sha256",
            "resourceId",
            "agentId",
            "createdAt",
            "expiresAt",
            "originRunId",
            "revision",
          ].includes(key),
        ),
      "invalid_transfer_resource",
      "Transfer resources must contain registered resource metadata only.",
    );
    try {
      parseArtifactUri(data.resource.uri);
    } catch {
      throw new AgentError(
        "invalid_transfer_resource",
        "A transfer resource must identify registered Agent content.",
      );
    }
  }
  return freeze(data as IssuedTransferSnapshot);
}
function request(
  value: unknown,
  data: IssuedTransferSnapshot,
): TransferRequest {
  const source = jsonRecord(
    value,
    new Set(["method", "url", "headers", "expiresAt"]),
  );
  requireCondition(
    source.method === (data.direction === "download" ? "GET" : "PUT") &&
      bounded(source.url, 8192) &&
      typeof source.expiresAt === "string" &&
      Date.parse(source.expiresAt) === Date.parse(data.expiresAt) &&
      isPlainRecord(source.headers),
    "invalid_transfer_offer",
    "The request must match its actual transfer direction and original deadline.",
  );
  try {
    const url = new URL(source.url);
    requireCondition(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash,
      "invalid_transfer_offer",
      "The transfer request URL is invalid.",
    );
  } catch {
    throw new AgentError(
      "invalid_transfer_offer",
      "The transfer request URL is invalid.",
    );
  }
  const headers = source.headers as JsonObject;
  requireCondition(
    Object.keys(headers).length <= 16 &&
      Object.entries(headers).every(
        ([key, value]) =>
          /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) &&
          typeof value === "string" &&
          Buffer.byteLength(value) <= 4096 &&
          !/[\0\r\n]/.test(value) &&
          !/^(?:authorization|proxy-authorization|cookie|set-cookie|x-(?:nexum-)?agent-token|x-api-key)$/i.test(
            key,
          ),
      ),
    "invalid_transfer_offer",
    "Transfer request headers must contain only bounded channel information.",
  );
  source.expiresAt = data.expiresAt;
  return freeze(source as unknown as TransferRequest);
}
function owner(
  scope: TransferOfferScope,
  agentId: string,
  profileRoot: string,
): TransferBinding {
  scope.assertCurrent();
  scope.signal?.throwIfAborted();
  requireCondition(
    bounded(scope.ownerKey) && bounded(scope.grantId),
    "transfer_grant_required",
    "A verified current owner and Grant are required for transfer delivery.",
  );
  return Object.freeze({
    ownerKey: scope.ownerKey,
    grantId: scope.grantId,
    agentId,
    profileRoot,
  });
}
function offer(
  data: IssuedTransferSnapshot,
  channel: TransferRequest,
  binding: TransferBinding,
): TransferOffer {
  const value = { ...data, request: channel } as TransferOffer;
  Object.defineProperties(value, {
    toJSON: { value: () => data },
    [inspect.custom]: { value: () => data },
  });
  issued.set(
    value,
    Object.freeze({
      snapshot: data,
      reference: Object.freeze({
        transferId: data.transferId,
        expiresAt: data.expiresAt,
      }),
      binding,
    }),
  );
  return Object.freeze(value);
}
export function transferOffer(value: unknown): IssuedTransferOffer | null {
  return value && typeof value === "object"
    ? (issued.get(value) ?? null)
    : null;
}
/** Core-only, analogous to output's issued-intent rebuild after a native-data copy. */
export function rebuildTransferOffer(
  original: unknown,
  copiedSnapshot: unknown,
): TransferOffer {
  const known = transferOffer(original);
  requireCondition(
    known,
    "invalid_transfer_offer",
    "Only an issued transfer offer can retain its brand.",
  );
  const data = issuedTransferSnapshot(copiedSnapshot);
  requireCondition(
    canonicalJson(data) === canonicalJson(known.snapshot),
    "invalid_transfer_offer",
    "A transfer offer cannot be rebound to different snapshot data.",
  );
  const descriptor = Object.getOwnPropertyDescriptor(original, "request");
  return offer(data, descriptor!.value as TransferRequest, known.binding);
}
export function transferReference(value: unknown): TransferReference {
  const data = jsonRecord(value, new Set(["transferId", "expiresAt"]));
  requireCondition(
    bounded(data.transferId, 128) &&
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(data.transferId) &&
      typeof data.expiresAt === "string" &&
      Number.isFinite(Date.parse(data.expiresAt)),
    "invalid_transfer_reference",
    "The saved transfer reference is invalid.",
  );
  return {
    transferId: data.transferId,
    expiresAt: new Date(data.expiresAt).toISOString(),
  };
}

interface Entry {
  readonly snapshot: IssuedTransferSnapshot;
  readonly binding: TransferBinding;
  readonly expiresAt: number;
  readonly bytes: number;
  request?: TransferRequest;
  reason?: string;
}
export class TransferOfferDelivery {
  readonly agentId: string;
  readonly profileRoot: string;
  readonly maxEntries: number;
  readonly maxBytes: number;
  #entries = new Map<string, Entry>();
  #bytes = 0;
  #now: () => number;
  #authorize?: TransferOfferDeliveryOptions["authorize"];
  constructor(options: TransferOfferDeliveryOptions) {
    requireCondition(
      bounded(options.agentId) &&
        typeof options.profileRoot === "string" &&
        path.isAbsolute(options.profileRoot),
      "invalid_transfer_delivery",
      "Transfer delivery must bind its actual Agent and profile root.",
    );
    this.agentId = options.agentId;
    this.profileRoot = path.resolve(options.profileRoot);
    this.maxEntries = options.maxEntries ?? 32;
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    requireCondition(
      Number.isSafeInteger(this.maxEntries) &&
        this.maxEntries >= 1 &&
        this.maxEntries <= 1024 &&
        Number.isSafeInteger(this.maxBytes) &&
        this.maxBytes >= 1 &&
        this.maxBytes <= 16 * 1024 * 1024,
      "invalid_transfer_delivery",
      "Short-lived transfer delivery capacity must be bounded.",
    );
    this.#now = options.now ?? Date.now;
    this.#authorize = options.authorize;
  }
  #sweep(): void {
    for (const [key, value] of this.#entries)
      if (value.expiresAt <= this.#now()) {
        this.#entries.delete(key);
        this.#bytes -= value.bytes;
      }
  }
  #check(scope: TransferOfferScope, data: IssuedTransferSnapshot): void {
    requireCondition(
      this.#authorize,
      "transfer_authorization_unavailable",
      "Current transfer authorization is unavailable.",
    );
    try {
      authorizeCall(() => this.#authorize!(scope, data));
    } catch {
      throw new AgentError(
        "transfer_not_authorized",
        "Current transfer authorization was not confirmed.",
      );
    }
    scope.assertCurrent();
    scope.signal?.throwIfAborted();
  }
  /** Caller has already completed registration, channel preparation and handoff. */
  issue(
    value: unknown,
    channel: TransferRequest,
    scope: TransferOfferScope,
  ): TransferOffer {
    const binding = owner(scope, this.agentId, this.profileRoot),
      data = issuedTransferSnapshot(value),
      fixedRequest = request(channel, data);
    if (data.direction === "download") {
      const resource = data.resource as JsonObject | undefined;
      requireCondition(
        resource &&
          data.path === undefined &&
          typeof resource.uri === "string" &&
          parseArtifactUri(resource.uri).agentId === this.agentId,
        "invalid_transfer_resource",
        "A prepared download must use this actual Agent's registered resource.",
      );
    } else {
      requireCondition(
        typeof data.path === "string" && path.isAbsolute(data.path),
        "invalid_transfer_offer",
        "A prepared upload must have its confirmed local target.",
      );
    }
    requireCondition(
      data.status === "pending" && Date.parse(data.expiresAt) > this.#now(),
      "transfer_offer_expired",
      "Only a still-pending, unexpired prepared channel can provide an Offer.",
    );
    this.#check(scope, data);
    this.#sweep();
    const previous = this.#entries.get(data.transferId);
    if (previous) {
      requireCondition(
        previous.request &&
          canonicalJson(previous.binding) === canonicalJson(binding) &&
          canonicalJson(previous.snapshot) === canonicalJson(data) &&
          canonicalJson(previous.request) === canonicalJson(fixedRequest),
        "transfer_offer_conflict",
        "An existing transfer identity cannot be reissued or rebound.",
      );
      return offer(previous.snapshot, previous.request, previous.binding);
    }
    const bytes =
      Buffer.byteLength(canonicalJson(data)) +
      Buffer.byteLength(canonicalJson(fixedRequest));
    for (const [key, entry] of this.#entries)
      if (
        !entry.request &&
        (this.#entries.size >= this.maxEntries ||
          this.#bytes + bytes > this.maxBytes)
      ) {
        this.#entries.delete(key);
        this.#bytes -= entry.bytes;
      }
    requireCondition(
      this.#entries.size < this.maxEntries &&
        this.#bytes + bytes <= this.maxBytes,
      "transfer_delivery_busy",
      "The bounded short-lived Offer delivery capacity is full.",
    );
    this.#entries.set(data.transferId, {
      snapshot: data,
      binding,
      request: fixedRequest,
      expiresAt: Date.parse(data.expiresAt),
      bytes,
    });
    this.#bytes += bytes;
    return offer(data, fixedRequest, binding);
  }
  deliver(
    value: TransferReference,
    scope: TransferOfferScope,
  ): TransferDelivery {
    const ref = transferReference(value);
    const no = (reason: string): TransferDelivery => ({
      transferId: ref.transferId,
      available: false,
      reason,
    });
    scope.assertCurrent();
    scope.signal?.throwIfAborted();
    this.#sweep();
    if (!bounded(scope.grantId)) return no("grant_unavailable");
    if (Date.parse(ref.expiresAt) <= this.#now()) return no("expired");
    const entry = this.#entries.get(ref.transferId);
    if (!entry) return no("delivery_unavailable");
    if (
      entry.binding.ownerKey !== scope.ownerKey ||
      entry.binding.grantId !== scope.grantId
    )
      return no("binding_mismatch");
    if (entry.snapshot.expiresAt !== ref.expiresAt)
      return no("reference_mismatch");
    if (!entry.request) return no(entry.reason ?? "delivery_unavailable");
    try {
      this.#check(scope, entry.snapshot);
    } catch {
      return no("authorization_denied");
    }
    if (this.#entries.get(ref.transferId) !== entry || !entry.request)
      return no(entry.reason ?? "delivery_unavailable");
    if (entry.expiresAt <= this.#now()) {
      this.forget(ref.transferId, "expired");
      return no("expired");
    }
    return {
      transferId: ref.transferId,
      available: true,
      request: entry.request as unknown as JsonObject,
    };
  }
  forget(
    transferId: string,
    reason: "consumed" | "expired" | "terminal" | "unavailable" = "unavailable",
  ): void {
    requireCondition(
      bounded(transferId, 128) && terminalReasons.has(reason),
      "invalid_transfer_reference",
      "A transfer invalidation needs its identity and a safe reason.",
    );
    const entry = this.#entries.get(transferId);
    if (entry) {
      entry.request = undefined;
      entry.reason = reason;
    }
    this.#sweep();
  }
}

/** Only for existing synchronous JSON log/progress branches, not arbitrary URL redaction. */
export function transferSafeJSON(
  value: unknown,
  maxBytes = 16384,
  project?: (value: unknown) => JsonObject | null,
): string {
  requireCondition(
    Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1024 * 1024,
    "invalid_transfer_delivery",
    "Transfer-safe log encoding requires a bounded byte budget.",
  );
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  function visit(input: unknown, depth: number): unknown {
    requireCondition(
      ++nodes <= 10000 && depth <= 64,
      "data_too_large",
      "Transfer-safe log data exceeds its bounded graph budget.",
    );
    const projected = project?.(input);
    if (projected) return visit(projected, depth + 1);
    const branded = transferOffer(input);
    if (branded) return visit(branded.snapshot, depth + 1);
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input);
      requireCondition(
        bytes <= maxBytes,
        "data_too_large",
        "Transfer-safe log text exceeds its byte budget.",
      );
      return input;
    }
    if (!input || typeof input !== "object") return input;
    requireCondition(
      !types.isProxy(input) &&
        !ancestors.has(input) &&
        (Array.isArray(input) || isPlainRecord(input)),
      "invalid_json",
      "Log data must contain ordinary acyclic JSON data.",
    );
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        requireCondition(
          !Object.getOwnPropertySymbols(input).some(
            (key) => Object.getOwnPropertyDescriptor(input, key)?.enumerable,
          ),
          "invalid_json",
          "Log arrays cannot contain enumerable Symbol fields.",
        );
        requireCondition(
          input.length <= 10000 - nodes,
          "data_too_large",
          "Log data exceeds its item budget.",
        );
        const result: unknown[] = [];
        for (let index = 0; index < input.length; index++) {
          const item = Object.getOwnPropertyDescriptor(input, String(index));
          requireCondition(
            item && "value" in item,
            "invalid_json",
            "Log arrays cannot contain holes or accessors.",
          );
          result.push(visit(item.value, depth + 1));
        }
        return result;
      }
      const result = Object.create(null) as Record<string, unknown>;
      const keys = Reflect.ownKeys(input);
      requireCondition(
        keys.length <= 10000 - nodes,
        "data_too_large",
        "Log data exceeds its field budget.",
      );
      for (const key of keys) {
        const item = Object.getOwnPropertyDescriptor(input, key)!;
        if (!item.enumerable) continue;
        requireCondition(
          typeof key === "string" && "value" in item,
          "invalid_json",
          "Log data cannot contain enumerable Symbols or accessors.",
        );
        bytes += Buffer.byteLength(key);
        requireCondition(
          bytes <= maxBytes,
          "data_too_large",
          "Log field names exceed their byte budget.",
        );
        result[key] = visit(item.value, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(input);
    }
  }
  return canonicalJson(visit(value, 0), maxBytes);
}
