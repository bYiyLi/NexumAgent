import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { types, MIMEType } from "node:util";
import { fileTypeFromBuffer } from "file-type";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson } from "../contracts/json.js";
import type { JsonObject, JsonValue } from "../contracts/types.js";
import type { AccessTarget } from "../extensions/api.js";
import {
  createOutput,
  outputIntent,
  type OutputIntent,
} from "../sdk/output.js";
import {
  ArtifactStore,
  type ArtifactRecord,
  type ArtifactScope,
  type ArtifactSource,
} from "./artifacts.js";
import { contentValue, normalizeData } from "./normalize.js";
import { validateMedia } from "./media.js";
import {
  transferOffer,
  transferReference,
  issuedTransferSnapshot,
  TransferOfferDelivery,
  type TransferReference,
  type IssuedTransferSnapshot,
} from "../transfer/offers.js";
import { parseArtifactUri } from "./artifacts.js";

export interface ResultScope extends ArtifactScope {
  readonly grantId?: string;
  readonly authorizeTarget?: (target: AccessTarget) => void;
}
interface StoredTransfer {
  reference: TransferReference;
  snapshot: IssuedTransferSnapshot;
}

export interface ResultLimits {
  readonly textBytes?: number;
  readonly imageBytes?: number;
  readonly audioBytes?: number;
  readonly inlineBytes?: number;
  readonly responseBytes?: number;
  readonly maxDataBytes?: number;
}
export interface RenderOptions {
  readonly textFallback?: boolean;
  readonly maxResponseBytes?: number;
  readonly supportedImages?: ReadonlySet<string>;
  readonly supportedAudio?: ReadonlySet<string>;
}
export interface StoredResult extends JsonObject {
  content: JsonObject[];
}
const KiB = 1024,
  MiB = KiB * KiB;
const textTypes: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".csv": "text/csv",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};
const textMime = (value: string): boolean => {
  const type = new MIMEType(value).essence;
  return (
    type.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/yaml",
      "application/x-yaml",
    ].includes(type) ||
    /\+(?:json|xml)$/.test(type)
  );
};
const asJson = (value: unknown): JsonObject =>
  JSON.parse(canonicalJson(value, 1024 * 1024)) as JsonObject;
function options(value: Readonly<Record<string, unknown>>): JsonObject {
  return asJson({
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    ...(value.annotations === undefined
      ? {}
      : { annotations: value.annotations }),
  });
}
async function snapshotBytes(
  filename: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(
    filename,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stats = await file.stat();
    requireCondition(
      stats.isFile() && stats.size <= maxBytes,
      "inline_media_too_large",
      "The fixed resource exceeds this inline content budget.",
    );
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(65536, maxBytes - size + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      requireCondition(
        size <= maxBytes,
        "inline_media_too_large",
        "The fixed resource exceeds this inline content budget.",
      );
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}
function encodedBytes(value: string, maximum: number): Buffer {
  requireCondition(
    value.length <= Math.ceil(maximum / 3) * 4 && value.length % 4 === 0,
    "invalid_media_encoding",
    "Encoded media must use bounded canonical base64.",
  );
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < value.length - padding; i++)
    requireCondition(
      alphabet.includes(value[i]!),
      "invalid_media_encoding",
      "Encoded media contains invalid base64 characters.",
    );
  const last = padding
    ? alphabet.indexOf(value[value.length - padding - 1] ?? "")
    : 0;
  requireCondition(
    (value.length / 4) * 3 - padding <= maximum &&
      (!padding || (last >= 0 && last % (padding === 2 ? 16 : 4) === 0)),
    "invalid_media_encoding",
    "Encoded media is invalid or exceeds its content budget.",
  );
  return Buffer.from(value, "base64");
}
const recordJson = (value: ArtifactRecord): JsonObject => asJson(value);
function record(value: JsonValue | undefined): ArtifactRecord {
  requireCondition(
    value && !Array.isArray(value) && typeof value === "object",
    "invalid_saved_result",
    "Saved content must identify its fixed resource.",
  );
  return value as unknown as ArtifactRecord;
}

/** Stores identities and JSON only. MCP bytes are materialized on the later authorized delivery path. */
export class ResultEncoder {
  readonly limits: Required<ResultLimits>;
  constructor(
    readonly artifacts: ArtifactStore,
    limits: ResultLimits = {},
    readonly offers?: TransferOfferDelivery,
  ) {
    requireCondition(
      !offers ||
        (offers.agentId === artifacts.agentId &&
          offers.profileRoot === artifacts.root),
      "result_profile_mismatch",
      "Transfer delivery must belong to this actual Agent/profile artifact store.",
    );
    this.limits = Object.freeze({
      textBytes: limits.textBytes ?? 64 * KiB,
      imageBytes: limits.imageBytes ?? 10 * MiB,
      audioBytes: limits.audioBytes ?? 32 * MiB,
      inlineBytes: limits.inlineBytes ?? 64 * MiB,
      responseBytes: limits.responseBytes ?? 128 * MiB,
      maxDataBytes:
        limits.maxDataBytes ?? Math.min(artifacts.maxFileBytes, 256 * MiB),
    });
    requireCondition(
      Object.values(this.limits).every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) &&
        this.limits.textBytes <= 16 * MiB &&
        this.limits.imageBytes <= artifacts.maxReadBytes &&
        this.limits.audioBytes <= artifacts.maxReadBytes &&
        this.limits.inlineBytes <= 128 * MiB &&
        this.limits.responseBytes <= 512 * MiB &&
        this.limits.maxDataBytes <= artifacts.maxFileBytes &&
        this.limits.maxDataBytes <= 256 * MiB,
      "invalid_result_options",
      "Result budgets must fit the actual Agent resource and response policy.",
    );
  }

  async encode(value: unknown, scope: ResultScope): Promise<StoredResult> {
    scope.assertCurrent();
    scope.signal?.throwIfAborted();
    const result: StoredResult = { content: [] };
    const transfers = new Map<string, StoredTransfer>(),
      transferLinks = new Set<string>();
    let transferBytes = 2;
    let inlineBytes = 0,
      textBytes = 0;
    const paths = new Map<string, Promise<ArtifactRecord>>(),
      identities = new WeakMap<object, Promise<ArtifactRecord>>();
    const reserve = (size: number) => {
      inlineBytes += size;
      requireCondition(
        inlineBytes <= this.limits.inlineBytes,
        "inline_content_too_large",
        "The result exceeds its aggregate inline byte budget.",
      );
    };
    const fixed = async (
      source: Readonly<Record<string, unknown>>,
      kind: string,
    ): Promise<ArtifactRecord> => {
      const textual =
        kind === "resource" &&
        ((typeof source.mimeType === "string" && textMime(source.mimeType)) ||
          (typeof source.path === "string" &&
            !!textTypes[path.extname(source.path).toLowerCase()]));
      const individual =
        kind === "image"
          ? this.limits.imageBytes
          : kind === "audio"
            ? this.limits.audioBytes
            : kind === "resource"
              ? textual
                ? this.limits.textBytes
                : this.limits.inlineBytes
              : this.artifacts.maxFileBytes;
      const aggregate =
        kind === "image" ||
        kind === "audio" ||
        (kind === "resource" && !textual);
      const cap = Math.min(
        individual,
        aggregate
          ? Math.max(1, this.limits.inlineBytes - inlineBytes)
          : individual,
        this.artifacts.maxFileBytes,
      );
      if (typeof source.uri === "string") {
        const resource = await this.artifacts.metadata(source.uri, scope);
        if (kind === "image" || kind === "audio") {
          const data = await this.artifacts.read(resource.uri, scope, {
            maxBytes: cap,
          });
          await validateMedia(
            data.data,
            kind,
            typeof source.mimeType === "string"
              ? source.mimeType
              : resource.mimeType === "application/octet-stream"
                ? undefined
                : resource.mimeType,
            { signal: scope.signal, maxBytes: cap },
          );
        }
        return resource;
      }
      const proposed: ArtifactSource = {
        ...(typeof source.path === "string"
          ? { path: source.path }
          : {
              data:
                typeof source.data === "string"
                  ? encodedBytes(source.data, cap)
                  : (source.data as ArtifactSource["data"]),
            }),
        ...(typeof source.name === "string" ? { name: source.name } : {}),
        ...(typeof source.mimeType === "string"
          ? { mimeType: source.mimeType }
          : {}),
      };
      const cacheKey = proposed.path;
      const objectKey =
        proposed.data && typeof proposed.data === "object"
          ? proposed.data
          : undefined;
      let pending = cacheKey
        ? paths.get(cacheKey)
        : objectKey
          ? identities.get(objectKey)
          : undefined;
      if (!pending) {
        pending = this.artifacts
          .register(
            proposed,
            scope,
            async (snapshot) => {
              scope.assertCurrent();
              if (kind === "image" || kind === "audio") {
                const bytes = await snapshotBytes(
                  snapshot.path,
                  cap,
                  scope.signal,
                );
                const metadata = await validateMedia(
                  bytes,
                  kind,
                  proposed.mimeType,
                  { signal: scope.signal, maxBytes: cap },
                );
                return { mimeType: metadata.mimeType };
              }
              if (!proposed.mimeType) {
                const file = await open(
                  snapshot.path,
                  constants.O_RDONLY |
                    (constants.O_NOFOLLOW ?? 0) |
                    (constants.O_NONBLOCK ?? 0),
                );
                try {
                  const stats = await file.stat();
                  requireCondition(
                    stats.isFile() && stats.size === snapshot.size,
                    "resource_source_changed",
                    "The fixed resource changed before format inspection.",
                  );
                  const head = Buffer.alloc(Math.min(snapshot.size, 65536));
                  const read = await file.read(head, 0, head.length, 0);
                  let detected;
                  try {
                    detected = await fileTypeFromBuffer(
                      head.subarray(0, read.bytesRead),
                      { signal: scope.signal },
                    );
                  } catch (cause) {
                    scope.signal?.throwIfAborted();
                  }
                  if (detected) return { mimeType: detected.mime };
                  const textType =
                    textTypes[path.extname(snapshot.name).toLowerCase()];
                  if (textType) return { mimeType: textType };
                } finally {
                  await file.close();
                }
              }
              return {};
            },
            { maxBytes: cap },
          )
          .catch((cause: unknown) => {
            if (
              cause instanceof AgentError &&
              cause.code === "resource_too_large" &&
              kind !== "resource_link"
            )
              throw new AgentError(
                aggregate && cap < individual
                  ? "inline_content_too_large"
                  : kind === "image" || kind === "audio"
                    ? "inline_media_too_large"
                    : "resource_read_too_large",
                "The requested inline content exceeds its configured budget; choose a resource link.",
              );
            throw cause;
          });
        if (cacheKey) paths.set(cacheKey, pending);
        else if (objectKey) identities.set(objectKey, pending);
      }
      return await pending;
    };
    const resolveOffer = async (value: unknown): Promise<JsonObject> => {
      const known = transferOffer(value);
      requireCondition(
        known &&
          known.binding.ownerKey === scope.ownerKey &&
          known.binding.grantId === scope.grantId &&
          known.binding.agentId === this.artifacts.agentId &&
          known.binding.profileRoot === this.artifacts.root,
        "transfer_offer_binding_mismatch",
        "The issued Offer does not belong to this current result binding.",
      );
      if (!transfers.has(known.reference.transferId)) {
        const saved = { reference: known.reference, snapshot: known.snapshot };
        transferBytes += Buffer.byteLength(canonicalJson(saved, 32768)) + 1;
        requireCondition(
          transfers.size < 1024 &&
            transferBytes <= Math.min(this.limits.textBytes, 65536),
          "result_transfer_too_large",
          "The result exceeds its safe transfer-reference budget.",
        );
        transfers.set(known.reference.transferId, saved);
        const resource = known.snapshot.resource;
        if (
          known.snapshot.direction === "download" &&
          resource &&
          !Array.isArray(resource) &&
          typeof resource === "object"
        ) {
          const uri = resource.uri;
          requireCondition(
            typeof uri === "string" &&
              parseArtifactUri(uri).agentId === this.artifacts.agentId,
            "invalid_transfer_resource",
            "A download Offer must reference this Agent's registered resource.",
          );
          if (!transferLinks.has(uri)) {
            await append(
              createOutput(scope.pwd, () => scope.assertCurrent()).file({
                uri,
              }),
            );
            transferLinks.add(uri);
          }
        }
      }
      return known.snapshot;
    };
    const append = async (input: unknown): Promise<JsonObject> => {
      scope.assertCurrent();
      scope.signal?.throwIfAborted();
      if (transferOffer(input)) return await resolveOffer(input);
      const intent = outputIntent(input);
      if (intent?.kind === "collection") {
        const refs: JsonValue[] = [];
        for (const item of intent.value as readonly unknown[])
          refs.push(await append(item));
        return { content: refs };
      }
      requireCondition(
        !intent || !["result", "json"].includes(intent.kind),
        "invalid_result_content",
        "Nested full results and JSON wrappers belong in structured data.",
      );
      let kind: string,
        source: Readonly<Record<string, unknown>>,
        meta: JsonObject;
      if (intent) {
        kind = intent.kind;
        meta = options(intent.options as Readonly<Record<string, unknown>>);
        source =
          kind === "text"
            ? { text: intent.value }
            : {
                ...(intent.value as Readonly<Record<string, unknown>>),
                ...(intent.options.name ? { name: intent.options.name } : {}),
                ...(intent.options.mimeType
                  ? { mimeType: intent.options.mimeType }
                  : {}),
              };
      } else {
        const content = contentValue(input, scope.pwd);
        if (content && !outputIntent(content)) {
          source = content as Readonly<Record<string, unknown>>;
          kind = source.type as string;
          meta = options(source);
        } else if (
          types.isArrayBufferView(input) ||
          types.isAnyArrayBuffer(input) ||
          (input && typeof input === "object")
        ) {
          kind = "resource_link";
          source = { data: input };
          meta = {};
        } else
          throw new AgentError(
            "invalid_result_content",
            "A result content item is not a valid content or binary source.",
          );
      }
      const index = result.content.length;
      requireCondition(
        index < 10000,
        "result_content_too_large",
        "The result exceeds its content-item budget.",
      );
      if (kind === "text") {
        requireCondition(
          typeof source.text === "string",
          "invalid_result_content",
          "Text content must have a string body.",
        );
        textBytes += Buffer.byteLength(source.text);
        requireCondition(
          textBytes <= this.limits.maxDataBytes,
          "result_data_too_large",
          "Result text exceeds the bounded full-result storage budget.",
        );
        result.content.push({
          type: "text",
          text: source.text,
          ...(meta.annotations ? { annotations: meta.annotations } : {}),
        });
        return { contentIndex: index };
      }
      let resource: ArtifactRecord,
        encoding: "text" | "blob" = "blob",
        inlineTextBytes = 0;
      if (kind === "resource" && source.resource) {
        const embedded = source.resource as Readonly<Record<string, unknown>>;
        encoding = typeof embedded.text === "string" ? "text" : "blob";
        if (encoding === "text")
          requireCondition(
            Buffer.byteLength(embedded.text as string) <= this.limits.textBytes,
            "resource_read_too_large",
            "Embedded text exceeds its inline context budget; choose a resource link.",
          );
        const bytes =
          encoding === "text"
            ? Buffer.from(embedded.text as string)
            : typeof embedded.blob === "string"
              ? encodedBytes(embedded.blob, this.limits.inlineBytes)
              : embedded.blob;
        resource = await fixed(
          {
            data: bytes,
            ...(embedded.mimeType
              ? { mimeType: embedded.mimeType }
              : encoding === "text"
                ? { mimeType: "text/plain; charset=utf-8" }
                : {}),
          },
          kind,
        );
      } else resource = await fixed(source, kind);
      let mimeType = resource.mimeType;
      if (kind === "image" || kind === "audio") {
        const cap =
          kind === "image" ? this.limits.imageBytes : this.limits.audioBytes;
        requireCondition(
          resource.size <= cap,
          "inline_media_too_large",
          "The media exceeds its individual inline byte budget.",
          { uri: resource.uri },
        );
        const bytes = await this.artifacts.read(resource.uri, scope, {
          maxBytes: cap,
        });
        const hint =
          typeof source.mimeType === "string"
            ? source.mimeType
            : resource.mimeType === "application/octet-stream"
              ? undefined
              : resource.mimeType;
        mimeType = (
          await validateMedia(bytes.data, kind, hint, {
            signal: scope.signal,
            maxBytes: cap,
          })
        ).mimeType;
        // A generic-file cache entry is never evidence that its declared media
        // type is true. Validate both the current request and retained metadata.
        if (
          resource.mimeType !== "application/octet-stream" &&
          resource.mimeType !== hint
        )
          await validateMedia(bytes.data, kind, resource.mimeType, {
            signal: scope.signal,
            maxBytes: cap,
          });
        reserve(resource.size);
      } else if (kind === "resource") {
        if (!source.resource) encoding = textMime(mimeType) ? "text" : "blob";
        if (encoding === "blob") reserve(resource.size);
        else {
          const data = await this.artifacts.read(resource.uri, scope, {
            maxBytes: Math.min(
              this.limits.textBytes,
              this.artifacts.maxReadBytes,
            ),
          });
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(data.data);
          } catch {
            throw new AgentError(
              "invalid_resource_text",
              "The resource is not valid UTF-8 text; choose a binary resource.",
            );
          }
          inlineTextBytes = Buffer.byteLength(JSON.stringify(text)) - 2;
        }
      }
      result.content.push({
        type: kind,
        resource: recordJson(resource),
        mimeType,
        ...meta,
        ...(kind === "resource"
          ? { encoding, ...(encoding === "text" ? { inlineTextBytes } : {}) }
          : {}),
      });
      return {
        contentIndex: index,
        resourceId: resource.resourceId,
        uri: resource.uri,
        name: resource.name,
        mimeType,
        size: resource.size,
      };
    };
    const data = async (input: unknown, pure = false) => {
      const normalized = await normalizeData(input, {
        mode: pure ? "data" : "auto",
        pwd: scope.pwd,
        maxBytes: this.limits.maxDataBytes,
        assertCurrent: () => scope.assertCurrent(),
        resolveContent: (value) => append(value),
        resolveTransferOffer: resolveOffer,
      });
      result.data = normalized.data;
      if (normalized.conversions.length)
        result.conversions = normalized.conversions;
    };
    const intent = outputIntent(value);
    if (intent?.kind === "result") {
      const body = intent.value as {
        content: readonly unknown[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      for (const item of body.content) await append(item);
      if (Object.hasOwn(body, "structuredContent"))
        await data(body.structuredContent, true);
      if (body.isError !== undefined) result.isError = body.isError;
    } else if (intent?.kind === "json") await data(intent.value, true);
    else if (value === undefined) {
    } else if (typeof value === "string")
      await append(
        createOutput(scope.pwd, () => scope.assertCurrent()).text(value),
      );
    else if (intent || contentValue(value, scope.pwd)) await append(value);
    else if (!types.isProxy(value) && Array.isArray(value) && value.length) {
      // Descriptor-based normalization below rejects holes/accessors without executing them.
      requireCondition(
        value.length <= 100000,
        "result_content_too_large",
        "The result array exceeds its item budget.",
      );
      const items: unknown[] = [];
      let all = true;
      for (let i = 0; i < value.length; i++) {
        const item = Object.getOwnPropertyDescriptor(value, String(i));
        if (
          !item ||
          !("value" in item) ||
          !contentValue(item.value, scope.pwd)
        ) {
          all = false;
          break;
        }
        items.push(item.value);
      }
      if (all) for (const item of items) await append(item);
      else await data(value);
    } else await data(value);
    if (transfers.size)
      result.transferOffers = [...transfers.values()] as unknown as JsonValue;
    await this.#fit(result, scope);
    scope.assertCurrent();
    scope.signal?.throwIfAborted();
    return result;
  }

  #projection(
    result: StoredResult,
    run: JsonObject,
    fallback: boolean,
  ): JsonObject {
    const content = result.content.map((item) => {
      if (item.type === "text")
        return {
          type: "text",
          text: item.text!,
          ...(item.annotations ? { annotations: item.annotations } : {}),
        };
      const resource = record(item.resource);
      const meta = {
        ...(item.annotations ? { annotations: item.annotations } : {}),
        ...(item.description ? { description: item.description } : {}),
      };
      if (item.type === "resource_link")
        return {
          type: "resource_link",
          uri: resource.uri,
          name: item.name ?? resource.name,
          mimeType: item.mimeType ?? resource.mimeType,
          ...meta,
        };
      if (item.type === "resource")
        return {
          type: "resource",
          resource: {
            uri: resource.uri,
            mimeType: item.mimeType ?? resource.mimeType,
            ...(item.encoding === "text" ? { text: "" } : { blob: "" }),
          },
          ...meta,
        };
      return {
        type: item.type,
        data: "",
        mimeType: item.mimeType ?? resource.mimeType,
        ...(item.annotations ? { annotations: item.annotations } : {}),
      };
    });
    const transfers = this.#transfers(result);
    const delivery: JsonObject = {
      ...((result.delivery as JsonObject) ?? {}),
      ...(transfers.length
        ? {
            transfers: transfers.map((item) => ({
              transferId: item.reference.transferId,
              available: false,
              reason: "delivery_unavailable",
              snapshot: item.snapshot,
            })),
          }
        : {}),
    };
    const structuredContent: JsonObject = {
      run,
      ...(Object.hasOwn(result, "data") ? { data: result.data! } : {}),
      ...(result.conversions ? { conversions: result.conversions } : {}),
      ...(Object.keys(delivery).length ? { delivery } : {}),
    };
    if (fallback) {
      const text = Object.hasOwn(result, "data")
        ? JSON.stringify(result.data)
        : "";
      content.push({
        type: "text",
        text: `runId: ${String(run.runId ?? "")}\nstatus: ${String(run.status ?? "")}${text ? "\n" + text : ""}`,
      });
    }
    return {
      content: content as JsonValue[],
      structuredContent,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    };
  }
  #transfers(result: StoredResult): StoredTransfer[] {
    if (result.transferOffers === undefined) return [];
    requireCondition(
      Array.isArray(result.transferOffers) &&
        result.transferOffers.length <= 1024,
      "invalid_saved_result",
      "Saved transfer references must be a bounded array.",
    );
    try {
      canonicalJson(
        result.transferOffers,
        Math.min(this.limits.textBytes, 65536),
      );
    } catch {
      throw new AgentError(
        "result_transfer_too_large",
        "Saved transfer references exceed their bounded budget.",
      );
    }
    const seen = new Set<string>();
    return result.transferOffers.map((value) => {
      requireCondition(
        value &&
          !Array.isArray(value) &&
          typeof value === "object" &&
          Object.keys(value).every((key) =>
            ["reference", "snapshot"].includes(key),
          ),
        "invalid_saved_result",
        "A saved transfer entry contains unsupported fields.",
      );
      const reference = transferReference(value.reference),
        snapshot = issuedTransferSnapshot(value.snapshot);
      requireCondition(
        reference.transferId === snapshot.transferId &&
          reference.expiresAt === snapshot.expiresAt &&
          !seen.has(reference.transferId),
        "invalid_saved_result",
        "Saved transfer identity and snapshot must agree without duplicates.",
      );
      seen.add(reference.transferId);
      return { reference, snapshot };
    });
  }
  async #fit(result: StoredResult, scope: ArtifactScope): Promise<void> {
    const dataText = Object.hasOwn(result, "data")
      ? JSON.stringify({
          data: result.data,
          ...(result.conversions ? { conversions: result.conversions } : {}),
        })
      : undefined;
    let obvious =
      dataText !== undefined &&
      Buffer.byteLength(dataText) > this.limits.textBytes;
    let plainBytes = 0;
    for (const item of result.content)
      if (item.type === "text" && typeof item.text === "string")
        plainBytes += Buffer.byteLength(item.text);
    obvious ||= plainBytes > this.limits.textBytes;
    let size = obvious
      ? this.limits.textBytes + 1
      : Buffer.byteLength(
          JSON.stringify(
            this.#projection(
              result,
              { runId: scope.runId ?? "", status: "succeeded" },
              true,
            ),
          ),
        );
    for (const item of result.content)
      if (item.type === "resource" && item.encoding === "text")
        size += Number(item.inlineTextBytes ?? record(item.resource).size);
    if (size <= this.limits.textBytes) return;
    // Keep the whole normalized JSON or text in an actual resource and make the incomplete model view explicit.
    const summary: JsonObject[] = [];
    let changed = false;
    if (Object.hasOwn(result, "data")) {
      const resource = await this.artifacts.register(
        {
          data: Buffer.from(dataText!),
          name: "result.json",
          mimeType: "application/json",
        },
        scope,
      );
      delete result.data;
      delete result.conversions;
      changed = true;
      summary.push({
        type: "resource_link",
        resource: recordJson(resource),
        mimeType: resource.mimeType,
      });
      result.delivery = {
        complete: false,
        reason: "context_budget",
        dataResource: recordJson(resource),
      };
    }
    const afterDataBytes =
      plainBytes > this.limits.textBytes
        ? this.limits.textBytes + 1
        : Buffer.byteLength(
            JSON.stringify(
              this.#projection(
                result,
                { runId: scope.runId ?? "", status: "succeeded" },
                true,
              ),
            ),
          );
    let textResource: ArtifactRecord | undefined;
    if (afterDataBytes > this.limits.textBytes && plainBytes > 0) {
      const texts = result.content
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.type === "text");
      const normalized = await normalizeData(texts, {
        mode: "data",
        maxBytes: this.limits.maxDataBytes,
        assertCurrent: () => scope.assertCurrent(),
      });
      const bytes = Buffer.from(JSON.stringify(normalized.data));
      textResource = await this.artifacts.register(
        {
          data: bytes,
          name: "result-content.json",
          mimeType: "application/json",
        },
        scope,
      );
      changed = true;
      result.delivery = {
        ...((result.delivery as JsonObject) ?? {}),
        complete: false,
        reason: "context_budget",
        textResource: recordJson(textResource),
      };
    }
    let linked = false;
    for (const item of result.content) {
      if (textResource && item.type === "text") {
        if (!linked)
          summary.push({
            type: "resource_link",
            resource: recordJson(textResource),
            mimeType: textResource.mimeType,
          });
        linked = true;
      } else summary.push(item);
    }
    if (changed) {
      result.content = summary;
      result.content.unshift({
        type: "text",
        text: "结果超过模型上下文预算，完整内容已保存为资源；当前返回资源引用。",
      });
    }
    const control = this.#projection(
      result,
      { runId: scope.runId ?? "", status: "succeeded" },
      true,
    );
    let bytes = Buffer.byteLength(JSON.stringify(control));
    for (const item of result.content)
      if (item.type === "resource" && item.encoding === "text")
        bytes += Number(item.inlineTextBytes ?? record(item.resource).size);
    requireCondition(
      bytes <= this.limits.textBytes,
      "result_context_too_large",
      "The result metadata or explicitly embedded text exceeds its context budget; choose resource links.",
    );
  }

  async render(
    result: StoredResult,
    scope: ResultScope,
    run: JsonObject,
    options: RenderOptions = {},
  ): Promise<JsonObject> {
    scope.assertCurrent();
    scope.signal?.throwIfAborted();
    // Only normalized saved JSON is accepted; caller-supplied functions/accessors never reach the protocol boundary.
    result = JSON.parse(
      canonicalJson(result, Math.max(this.limits.textBytes * 4, 1024 * 1024)),
    ) as StoredResult;
    const response = this.#projection(
      result,
      asJson(run),
      options.textFallback ?? true,
    );
    const content = response.content as JsonObject[];
    const maximum = Math.min(
      this.limits.responseBytes,
      options.maxResponseBytes ?? this.limits.responseBytes,
    );
    requireCondition(
      Number.isSafeInteger(maximum) && maximum > 0,
      "invalid_result_options",
      "The actual response budget must be a positive integer.",
    );
    const control = this.#projection(
      result,
      asJson(run),
      options.textFallback ?? true,
    );
    const transfers = this.#transfers(result);
    const applyTransfers = () => {
      if (transfers.length) {
        const current = transfers.map((item) => ({
          ...(this.offers
            ? this.offers.deliver(item.reference, scope)
            : {
                transferId: item.reference.transferId,
                available: false,
                reason: "delivery_unavailable",
              }),
          snapshot: item.snapshot,
        }));
        for (const target of [response, control]) {
          const structured = target.structuredContent as JsonObject;
          structured.delivery = {
            ...((structured.delivery as JsonObject) ?? {}),
            transfers: current,
          };
        }
      }
    };
    applyTransfers();
    let inlineBytes = 0,
      encodedBinaryBytes = 0;
    for (let i = 0; i < result.content.length; i++) {
      const item = result.content[i]!;
      requireCondition(
        ["text", "image", "audio", "resource_link", "resource"].includes(
          item.type as string,
        ),
        "invalid_saved_result",
        "The saved content type is unsupported.",
      );
      if (item.type === "text") continue;
      const source = record(item.resource),
        kind = item.type;
      const actual = await this.artifacts.metadata(source.uri, scope);
      requireCondition(
        actual.sha256 === source.sha256 &&
          actual.size === source.size &&
          actual.mimeType === source.mimeType,
        "saved_resource_changed",
        "The historical content no longer matches its fixed identity.",
        { uri: source.uri },
      );
      if (kind === "resource_link") continue;
      if (kind === "image" || kind === "audio") {
        const mimeType = item.mimeType as string;
        const supported =
          kind === "image" ? options.supportedImages : options.supportedAudio;
        requireCondition(
          !supported || supported.has(new MIMEType(mimeType).essence),
          "host_content_unsupported",
          "This Host does not support the saved media type.",
          { uri: source.uri, mimeType },
        );
      }
      const cap =
        kind === "image"
          ? this.limits.imageBytes
          : kind === "audio"
            ? this.limits.audioBytes
            : item.encoding === "text"
              ? this.limits.textBytes
              : this.limits.inlineBytes;
      if (!(kind === "resource" && item.encoding === "text")) {
        encodedBinaryBytes += Math.ceil(source.size / 3) * 4;
        requireCondition(
          encodedBinaryBytes + Buffer.byteLength(JSON.stringify(control)) <=
            maximum,
          "mcp_response_too_large",
          "Encoded media exceeds the actual transport/Host budget.",
        );
      }
      const bytes = await this.artifacts.read(source.uri, scope, {
        maxBytes: Math.min(cap, this.artifacts.maxReadBytes),
      });
      requireCondition(
        bytes.resource.sha256 === source.sha256 &&
          bytes.resource.size === source.size,
        "saved_resource_changed",
        "The historical content no longer matches its fixed identity.",
        { uri: source.uri },
      );
      if (kind === "resource" && item.encoding === "text") {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.data);
        } catch {
          throw new AgentError(
            "invalid_resource_text",
            "The resource is not valid UTF-8 text; return it as a binary resource.",
            { uri: source.uri },
          );
        }
        (content[i]!.resource as JsonObject).text = text;
        ((control.content as JsonObject[])[i]!.resource as JsonObject).text =
          text;
      } else {
        inlineBytes += bytes.data.length;
        requireCondition(
          inlineBytes <= this.limits.inlineBytes,
          "inline_content_too_large",
          "Saved content exceeds its aggregate inline budget.",
        );
        if (kind === "image" || kind === "audio")
          await validateMedia(bytes.data, kind, item.mimeType as string, {
            signal: scope.signal,
            maxBytes: cap,
          });
        if (kind === "resource")
          (content[i]!.resource as JsonObject).blob =
            bytes.data.toString("base64");
        else content[i]!.data = bytes.data.toString("base64");
      }
    }
    // Resource I/O may yield long enough for a channel to be claimed, expire or
    // lose authority. Re-project current delivery immediately before returning.
    applyTransfers();
    requireCondition(
      Buffer.byteLength(JSON.stringify(control)) <= this.limits.textBytes,
      "result_context_too_large",
      "The final text/structured response exceeds the model context budget.",
    );
    requireCondition(
      Number.isSafeInteger(maximum) &&
        maximum > 0 &&
        Buffer.byteLength(JSON.stringify(response)) <= maximum,
      "mcp_response_too_large",
      "The final MCP response exceeds the actual transport/Host budget.",
    );
    scope.assertCurrent();
    scope.signal?.throwIfAborted();
    return response;
  }

  async listResources(
    scope: ArtifactScope,
    page: { limit?: number; cursor?: string } = {},
  ): Promise<JsonObject> {
    const result = await this.artifacts.list(scope, page);
    const response = {
      resources: result.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        mimeType: resource.mimeType,
        size: resource.size,
      })),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
    requireCondition(
      Buffer.byteLength(JSON.stringify(response)) <=
        Math.min(this.limits.textBytes, this.limits.responseBytes),
      "resource_list_too_large",
      "The resource directory exceeds this response budget; request a smaller page.",
    );
    return response;
  }

  /** Standard resources/read uses text/blob bodies, never image/audio tool blocks. */
  async readResource(uri: string, scope: ArtifactScope): Promise<JsonObject> {
    const resource = await this.artifacts.metadata(uri, scope);
    const text = textMime(resource.mimeType),
      essence = new MIMEType(resource.mimeType).essence;
    const cap = text
      ? this.limits.textBytes
      : essence.startsWith("image/")
        ? this.limits.imageBytes
        : essence.startsWith("audio/")
          ? this.limits.audioBytes
          : this.limits.inlineBytes;
    const empty = {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          ...(text ? { text: "" } : { blob: "" }),
        },
      ],
    };
    requireCondition(
      Buffer.byteLength(JSON.stringify(empty)) +
        (text ? resource.size : Math.ceil(resource.size / 3) * 4) <=
        this.limits.responseBytes,
      "mcp_response_too_large",
      "The encoded resource exceeds its response budget before reading.",
      { uri },
    );
    const fixed = await this.artifacts.read(uri, scope, {
      maxBytes: Math.min(cap, this.artifacts.maxReadBytes),
    });
    const body: JsonObject = { uri: resource.uri, mimeType: resource.mimeType };
    if (text) {
      try {
        body.text = new TextDecoder("utf-8", { fatal: true }).decode(
          fixed.data,
        );
      } catch {
        throw new AgentError(
          "invalid_resource_text",
          "The registered resource is not valid UTF-8 text.",
          { uri },
        );
      }
    } else body.blob = fixed.data.toString("base64");
    const response: JsonObject = { contents: [body] };
    if (text)
      requireCondition(
        Buffer.byteLength(JSON.stringify(response)) <= this.limits.textBytes,
        "resource_read_too_large",
        "The encoded text resource exceeds the context budget; use transfer.createDownload({ uri }) for a file stream.",
        { uri },
      );
    requireCondition(
      Buffer.byteLength(JSON.stringify(response)) <= this.limits.responseBytes,
      "mcp_response_too_large",
      "The resource response exceeds its final encoded budget.",
      { uri },
    );
    return response;
  }
}
