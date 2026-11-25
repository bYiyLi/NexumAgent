import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { types, MIMEType } from "node:util";
import { fileTypeFromBuffer } from "file-type";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
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
  snapshotBlob,
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
import {
  mcpResult,
  mcpSource,
  copyMcpJSON,
  mcpMetaSize,
  McpResultResources,
  type McpSourceIdentity,
  type McpProtocolMeta,
} from "./mcp.js";

export interface ResultScope extends ArtifactScope {
  readonly grantId?: string;
  readonly authorizeTarget?: (target: AccessTarget) => void;
}

function explicitFileLink(value: unknown, pwd: string): OutputIntent | null {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
    return null;
  const tag = Object.getOwnPropertyDescriptor(value, "type");
  if (!tag || !("value" in tag) || tag.value !== "resource_link")
    return null;
  // Do not reinterpret ordinary business objects with unrelated properties.
  const allowed = new Set(["type", "path", "mimeType", "name"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const source: {path: string; mimeType?: string; name?: string} = { path: "" };
  for (const key of ["path", "mimeType", "name"] as const) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field) {
      if (key === "path") return null;
      continue;
    }
    if (!("value" in field) || typeof field.value !== "string") return null;
    source[key] = field.value;
  }
  // A descriptor is a local source declaration, NOT a pre-registered MCP
  // ResourceLink (which must already have a verified URI and name).
  return createOutput(pwd, () => {}).file(source);
}
export type ResultArtifacts = Pick<ArtifactStore,
  "agentId" | "root" | "maxFileBytes" | "maxReadBytes" |
  "register" | "metadata" | "read" | "list">;
interface StoredTransfer {
  reference: TransferReference;
  snapshot: IssuedTransferSnapshot;
}

export interface ResultLimits {
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
export interface ResultDescription {
  /** Normalized content coordinates, without inline media, private source controls or credentials. */
  readonly result: JsonObject;
  /** Host-only protocol data; the application moves a large value over its independent byte channel. */
  readonly hostMeta?: JsonObject;
  /** Fresh short-lived delivery only; never write this back into the stored result. */
  readonly transfers: readonly JsonObject[];
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
    readonly artifacts: ResultArtifacts,
    limits: ResultLimits = {},
    readonly offers?: TransferOfferDelivery,
    readonly mcp?: McpResultResources,
  ) {
    requireCondition(
      !offers ||
        (offers.agentId === artifacts.agentId &&
          offers.profileRoot === artifacts.root),
      "result_profile_mismatch",
      "Transfer delivery must belong to this actual Agent/profile artifact store.",
    );
    requireCondition(
      !mcp ||
        (mcp.agentId === artifacts.agentId &&
          mcp.profileRoot === artifacts.root),
      "result_profile_mismatch",
      "Remote result routing must belong to this actual Agent/profile.",
    );
    this.limits = Object.freeze({
      responseBytes: limits.responseBytes ?? 128 * MiB,
      maxDataBytes: limits.maxDataBytes ?? Math.min(artifacts.maxFileBytes, 128 * MiB),
    });
    requireCondition(
      Object.values(this.limits).every((value) => Number.isSafeInteger(value) && value > 0) &&
        this.limits.responseBytes <= 128 * MiB &&
        this.limits.maxDataBytes <= Math.min(artifacts.maxFileBytes, 128 * MiB),
      "invalid_result_options",
      "Result storage and delivery must fit the platform safety boundary.",
    );
  }

  async encode(value: unknown, scope: ResultScope): Promise<StoredResult> {
    scope.assertCurrent();
    scope.signal?.throwIfAborted();
    const result: StoredResult = { content: [] };
    const resources: JsonObject[] = [];
    const contentAssociations: JsonObject[] = [];
    const remoteResults: JsonObject[] = [],
      remoteSeen = new WeakMap<object, number>();
    let remoteMetaBytes = 2;
    const transfers = new Map<string, StoredTransfer>(),
      transferLinks = new Set<string>();
    let transferBytes = 2;
    let inlineBytes = 0,
      textBytes = 0;
    const paths = new Map<string, Promise<ArtifactRecord>>(),
      identities = new WeakMap<object, Promise<ArtifactRecord>>();
    const reserve = (size: number) => {
      inlineBytes += Math.ceil(size / 3) * 4;
      requireCondition(
        inlineBytes <= this.limits.responseBytes,
        "mcp_response_too_large",
        "The encoded result exceeds the response safety boundary.",
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
      const aggregate = kind === "image" || kind === "audio" || (kind === "resource" && !textual);
      // Base64 expansion is a transport fact, not a media-type quota.
      const individual = kind === "resource_link" ? this.artifacts.maxFileBytes :
        Math.min(this.artifacts.maxReadBytes, this.limits.responseBytes);
      const cap = aggregate ? Math.min(individual,
        Math.max(1, Math.floor((this.limits.responseBytes - inlineBytes) / 4) * 3)) : individual;
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
      try {
        return await pending;
      } catch (error) {
        // A failed media-inline registration must not poison a later bounded
        // resource-link registration for this same native source.
        if (cacheKey) paths.delete(cacheKey);
        else if (objectKey) identities.delete(objectKey);
        throw error;
      }
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
            transferBytes <= 65536,
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
      if (mcpResult(input)) return await resolveMcp(input, true);
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
          // Native bytes can carry the actual image/audio payload without
          // forcing an AI to learn a separate output.* JavaScript namespace.
          // Never infer media from a filename or caller-provided MIME alone.
          let detected: string | undefined;
          if (types.isArrayBufferView(input)) {
            const bytes = new Uint8Array(input.buffer, input.byteOffset, Math.min(input.byteLength, 8192));
            detected = (await fileTypeFromBuffer(bytes))?.mime;
          } else if (types.isArrayBuffer(input)) {
            detected = (await fileTypeFromBuffer(new Uint8Array(input, 0, Math.min(input.byteLength, 8192))))?.mime;
          }
          const blob = input && typeof input === "object"
            ? snapshotBlob(input, this.artifacts.maxFileBytes) : null;
          // Blob/File MIME metadata is only a candidate: fixed() validates
          // the actual bytes before publishing a native MCP media block.
          const mimeType = detected ?? blob?.mimeType;
          kind = mimeType?.startsWith("image/") ? "image"
            : mimeType?.startsWith("audio/") ? "audio" : "resource_link";
          source = {
            data: input,
            ...(blob?.name ? { name: blob.name } : {}),
            ...(mimeType ? { mimeType } : {}),
          };
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
        const textSize =
          encoding === "text" ? Buffer.byteLength(embedded.text as string) : 0;
        requireCondition(
          textSize <= this.artifacts.maxFileBytes,
          "resource_too_large",
          "The embedded text exceeds the authorized file storage budget.",
        );
        const bytes =
          encoding === "text"
            ? Buffer.from(embedded.text as string)
            : typeof embedded.blob === "string"
              ? encodedBytes(embedded.blob, this.artifacts.maxFileBytes)
              : embedded.blob;
        const bodySource = {
          data: bytes,
          ...(embedded.mimeType
            ? { mimeType: embedded.mimeType }
            : encoding === "text"
              ? { mimeType: "text/plain; charset=utf-8" }
              : {}),
        };
        resource = await fixed(bodySource, kind);
      } else resource = await fixed(source, kind);
      let mimeType = resource.mimeType;
      if (kind === "image" || kind === "audio") {
        const cap =
          Math.min(this.artifacts.maxReadBytes, this.limits.responseBytes);
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
              this.limits.responseBytes,
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
    const resolveMcp = async (
      input: unknown,
      explicit = false,
    ): Promise<JsonObject> => {
      const known = mcpResult(input);
      requireCondition(
        known && this.mcp,
        "mcp_source_unavailable",
        "Source-aware remote result routing is not configured.",
      );
      await this.mcp.resolve(known.source, scope);
      const previous = remoteSeen.get(input as object);
      if (previous !== undefined) return { mcpResult: previous };
      const slot = remoteResults.length;
      requireCondition(
        slot < 1000,
        "mcp_result_too_large",
        "The result contains too many remote result components.",
      );
      remoteMetaBytes +=
        mcpMetaSize(
          { source: known.source, meta: known.meta },
          this.limits.responseBytes,
        ) + 1;
      requireCondition(
        remoteMetaBytes <= this.limits.responseBytes,
        "mcp_meta_too_large",
        "Remote Host-only metadata exceeds the response safety boundary.",
      );
      remoteSeen.set(input as object, slot);
      remoteResults.push({
        source: known.source as unknown as JsonValue,
        meta: known.meta as unknown as JsonValue,
        method: known.method,
      });
      const blocks: JsonObject[] =
        known.kind === "resources"
          ? (known.model.contents as JsonObject[]).map((resource) => ({
              type: "resource",
              resource,
            }))
          : (known.model.content as JsonObject[]);
      for (let sourceIndex = 0; sourceIndex < blocks.length; sourceIndex++) {
        const block = blocks[sourceIndex]!,
          start = result.content.length;
        if (block.type === "resource_link") {
          // A remote coordinate is not evidence of a downloaded local artifact.
          requireCondition(
            start < 10000,
            "result_content_too_large",
            "The result exceeds its content-item budget.",
          );
          result.content.push({
            ...(copyMcpJSON(block) as JsonObject),
            remote: {
              source: known.source as unknown as JsonValue,
              uri: block.uri!,
            },
          });
        } else await append(block);
        for (let index = start; index < result.content.length; index++) {
          const stored = result.content[index]!;
          stored.mcp = { slot, index: sourceIndex };
          if (block.type === "resource")
            stored.remote = {
              source: known.source as unknown as JsonValue,
              uri: (block.resource as JsonObject).uri!,
            };
        }
      }
      const association: JsonObject = {
        mcpResult: slot,
        contentIndices: result.content.flatMap((item, index) =>
          (item.mcp as JsonObject | undefined)?.slot === slot ? [index] : [],
        ),
        ...(Object.hasOwn(known.model, "structuredContent")
          ? { structuredContent: known.model.structuredContent! }
          : {}),
        ...(known.model.isError === undefined
          ? {}
          : { isError: known.model.isError }),
        ...(known.model.resultType === undefined
          ? {}
          : { resultType: known.model.resultType }),
      };
      // A nested upstream MCP error is data about that upstream result, not
      // an error in the containing Nexum Run. Only a top-level MCP result or
      // an explicit output.error()/output.result({isError:true}) marks isError.
      result.mcpResults ??= [] as JsonValue[];
      if (explicit) {
        const normalized = await normalizeData(association, {
          mode: "data",
          maxBytes: this.limits.maxDataBytes,
          assertCurrent: () => scope.assertCurrent(),
        });
        (result.mcpResults as JsonValue[]).push(normalized.data);
      } else
        (result.mcpResults as JsonValue[]).push({
          mcpResult: slot,
          contentIndices: association.contentIndices!,
        });
      return association;
    };
    const data = async (input: unknown, pure = false) => {
      const normalized = await normalizeData(input, {
        mode: pure ? "data" : "auto",
        pwd: scope.pwd,
        maxBytes: this.limits.maxDataBytes,
        assertCurrent: () => scope.assertCurrent(),
        resolveContent: async (value, _diagnostic, pointer) => {
          const reference = await append(value);
          if (typeof reference.contentIndex === "number") {
            requireCondition(contentAssociations.length < 1000, "result_content_too_large", "Too many nested content locations.");
            contentAssociations.push({ path: pointer, contentIndex: reference.contentIndex });
          }
          if (typeof reference.uri === "string" && typeof reference.contentIndex === "number") {
            const item = result.content[reference.contentIndex];
            const resource = item?.resource as JsonObject | undefined;
            if (resource && typeof resource.sha256 === "string") {
              requireCondition(resources.length < 1000, "result_content_too_large", "Too many resource locations in one result.");
              resources.push({
                path: pointer,
                uri: reference.uri,
                name: String(resource.name ?? reference.name ?? ""),
                mimeType: String(item?.mimeType ?? resource.mimeType ?? "application/octet-stream"),
                size: Number(resource.size ?? reference.size ?? 0),
                sha256: resource.sha256,
                delivery: item?.type === "resource_link" ? "resource_link" : "inline",
                contentIndex: reference.contentIndex,
              });
            }
          }
          return reference;
        },
        resolveTransferOffer: resolveOffer,
        resolveMcpResult: (value) => resolveMcp(value),
      });
      result.data = normalized.data;
      if (normalized.conversions.length)
        result.conversions = normalized.conversions;
      if (normalized.references?.length)
        result.references = normalized.references;
      if (resources.length)
        result.resources = resources;
      if (contentAssociations.length)
        result.contentAssociations = contentAssociations;
    };
    const intent = outputIntent(value),
      remote = mcpResult(value),
      localFile = explicitFileLink(value, scope.pwd);
    if (remote) {
      await resolveMcp(value);
      if (Object.hasOwn(remote.model, "structuredContent"))
        await data(remote.model.structuredContent, true);
      if (remote.model.isError !== undefined)
        result.isError = remote.model.isError;
      if (remote.model.resultType !== undefined)
        result.resultType = remote.model.resultType;
    } else if (intent?.kind === "result") {
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
    } else if (typeof value === "string") await data(value);
    else if (intent) await append(value);
    // A complete, validated standard content descriptor is an explicit
    // source declaration, not an arbitrary path string. This preserves
    // large-path resource delivery without a model-facing output.* SDK.
    else if (localFile) await append(localFile);
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
        const localItem = explicitFileLink(item?.value, scope.pwd);
        if (
          !item ||
          !("value" in item) ||
          !(mcpResult(item.value) || outputIntent(item.value) ||
            localItem)
        ) {
          all = false;
          break;
        }
        items.push(localItem ?? item.value);
      }
      if (all) for (const item of items) await append(item);
      else await data(value);
    } else await data(value);
    if (transfers.size)
      result.transferOffers = [...transfers.values()] as unknown as JsonValue;
    if (remoteResults.length) result.mcpSources = remoteResults;
    canonicalJson(result, this.limits.maxDataBytes);
    await this.#authorizeMcp(result, scope);
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
      const remote = item.remote as JsonObject | undefined;
      if (item.type === "resource_link" && remote) {
        requireCondition(
          this.mcp,
          "mcp_source_unavailable",
          "Remote resource routing is unavailable.",
        );
        const { remote: _remote, mcp: _mcp, ...link } = item;
        return {
          ...link,
          uri: this.mcp.uri(mcpSource(remote.source), remote.uri as string),
        };
      }
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
            uri: remote ? this.mcpUri(remote) : resource.uri,
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
      ...(result.references ? { references: result.references } : {}),
      ...(result.resources ? { resultResources: result.resources } : {}),
      ...(result.contentAssociations ? { contentAssociations: result.contentAssociations } : {}),
      ...(result.mcpResults
        ? {
            mcpResults: (result.mcpResults as JsonObject[]).map((entry) => ({
              ...entry,
              contentIndices: result.content.flatMap((item, index) =>
                (item.mcp as JsonObject | undefined)?.slot === entry.mcpResult
                  ? [index]
                  : [],
              ),
            })),
          }
        : {}),
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
      ...(result.resultType === undefined
        ? {}
        : { resultType: result.resultType }),
    };
  }
  private mcpUri(remote: JsonObject): string {
    requireCondition(
      this.mcp,
      "mcp_source_unavailable",
      "Remote resource routing is unavailable.",
    );
    return this.mcp.uri(mcpSource(remote.source), remote.uri as string);
  }
  #mcpSources(result: StoredResult): {
    source: McpSourceIdentity;
    meta: readonly McpProtocolMeta[];
    method: string;
  }[] {
    if (result.mcpSources === undefined) return [];
    requireCondition(
      Array.isArray(result.mcpSources) && result.mcpSources.length <= 1000,
      "invalid_saved_result",
      "Saved remote results require bounded provenance.",
    );
    let bytes = 2;
    return result.mcpSources.map((value) => {
      requireCondition(
        value &&
          !Array.isArray(value) &&
          typeof value === "object" &&
          Array.isArray(value.meta) &&
          typeof value.method === "string",
        "invalid_saved_result",
        "Saved remote result provenance is invalid.",
      );
      const source = mcpSource(value.source),
        meta = copyMcpJSON(
          value.meta,
          this.limits.responseBytes,
        ) as unknown as McpProtocolMeta[];
      bytes += mcpMetaSize({ source, meta }, this.limits.responseBytes) + 1;
      requireCondition(
        bytes <= this.limits.responseBytes &&
          meta.every(
            (item) =>
              item &&
              ["result", "content", "resource", "entry", "message"].includes(
                item.target,
              ) &&
              item.meta &&
              !Array.isArray(item.meta) &&
              typeof item.meta === "object",
          ),
        "mcp_meta_too_large",
        "Saved Host-only metadata exceeds its separate budget or is malformed.",
      );
      return { source, meta, method: value.method };
    });
  }
  async #authorizeMcp(result: StoredResult, scope: ResultScope): Promise<void> {
    for (const entry of this.#mcpSources(result)) {
      if (!entry.meta.length) continue;
      requireCondition(
        this.mcp,
        "mcp_source_unavailable",
        "The original remote result source is unavailable.",
      );
      // Received fixed bytes remain historical artifacts after the connection closes.
      // Host-only metadata still needs this caller's current connection authority.
      const authority = this.mcp.authority(scope, entry.source);
      authority.assertCurrent();
      authority.authorizeConnection(
        entry.source.connection,
        undefined,
        "result",
      );
    }
    for (const item of result.content)
      if (item.type === "resource_link" && item.remote) {
        const remote = item.remote as JsonObject;
        requireCondition(
          this.mcp && typeof remote.uri === "string",
          "invalid_saved_result",
          "A saved remote coordinate is invalid.",
        );
        await this.mcp.resolve(
          mcpSource(remote.source),
          scope,
          "resources.read",
          remote.uri,
        );
      }
  }
  #applyMcpMeta(result: StoredResult, response: JsonObject): void {
    const sources = this.#mcpSources(result);
    if (!sources.some((source) => source.meta.length)) return;
    const slots = sources.map((entry, slot) => ({
      slot,
      connection: entry.source.connection,
      extensionId: entry.source.extensionId,
      revision: entry.source.origin.revision,
      method: entry.method,
      contentIndices: result.content.flatMap((item, index) =>
        (item.mcp as JsonObject | undefined)?.slot === slot
          ? [{ index, sourceIndex: (item.mcp as JsonObject).index! }]
          : [],
      ),
      protocolMeta: entry.meta as unknown as JsonValue,
    }));
    const root =
      sources.length === 1
        ? sources[0]!.meta.find((item) => item.target === "result")?.meta
        : undefined;
    const hostMeta: JsonObject = { ...(root ?? {}) };
    let key = "io.nexum/mcp",
      suffix = 0;
    while (Object.hasOwn(hostMeta, key)) key = `io.nexum/mcp/${++suffix}`;
    hostMeta[key] = { results: slots };
    response._meta = hostMeta;
    mcpMetaSize(response._meta, this.limits.responseBytes);
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
        65536,
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
  async describe(
    result: StoredResult,
    scope: ResultScope,
    options: { readonly readOnly?: boolean } = {},
  ): Promise<ResultDescription> {
    authorizeCall(() => scope.assertCurrent());
    scope.signal?.throwIfAborted();
    result = JSON.parse(
      JSON.stringify(
        copyMcpJSON(
          result,
          this.limits.maxDataBytes,
        ),
      ),
    ) as StoredResult;
    if (!options.readOnly) await this.#authorizeMcp(result, scope);
    const projected = this.#projection(result, {}, false);
    const visible = projected.content as JsonObject[];
    const content: JsonObject[] = [];
    const artifact = (value: ArtifactRecord): JsonObject => ({
      uri: value.uri,
      name: value.name,
      mimeType: value.mimeType,
      size: value.size,
      sha256: value.sha256,
      expiresAt: value.expiresAt,
    });
    for (let index = 0; index < result.content.length; index++) {
      const item = result.content[index]!,
        view = visible[index]!;
      if (
        item.type === "text" ||
        (item.type === "resource_link" && item.remote)
      ) {
        content.push(view);
        continue;
      }
      const fixed = await this.artifacts.metadata(
        record(item.resource).uri,
        scope,
      );
      const metadata = {
        ...(view.annotations === undefined
          ? {}
          : { annotations: view.annotations }),
        ...(view.description === undefined
          ? {}
          : { description: view.description }),
      };
      if (item.type === "resource_link") content.push(view);
      else if (item.type === "resource")
        content.push({
          type: "resource",
          resource: artifact(fixed),
          uri: (view.resource as JsonObject).uri!,
          encoding: item.encoding!,
          ...metadata,
        });
      else {
        requireCondition(
          (item.type === "image" || item.type === "audio") &&
            fixed.size <= Math.min(this.artifacts.maxReadBytes, this.limits.responseBytes),
          "inline_media_too_large",
          "The retained media exceeds the current delivery budget.",
        );
        content.push({
          type: item.type!,
          resource: artifact(fixed),
          mimeType: view.mimeType!,
          ...metadata,
        });
      }
    }
    const structured = projected.structuredContent as JsonObject;
    const described: JsonObject = {
      content,
      ...(Object.hasOwn(result, "data") ? { data: result.data! } : {}),
      ...(result.conversions === undefined
        ? {}
        : { conversions: result.conversions }),
      ...(result.references === undefined
        ? {}
        : { references: result.references }),
      ...(result.resources === undefined
        ? {}
        : { resources: result.resources }),
      ...(result.contentAssociations === undefined
        ? {}
        : { contentAssociations: result.contentAssociations }),
      ...(structured.mcpResults === undefined
        ? {}
        : { mcpResults: structured.mcpResults }),
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      ...(result.resultType === undefined
        ? {}
        : { resultType: result.resultType }),
    };
    if (result.delivery) {
      const delivery = result.delivery as JsonObject;
      const fixedDelivery: JsonObject = {
        complete: delivery.complete!,
        reason: delivery.reason!,
      };
      for (const key of ["dataResource", "textResource"])
        if (delivery[key])
          fixedDelivery[key] = artifact(
            await this.artifacts.metadata(record(delivery[key]).uri, scope),
          );
      described.delivery = fixedDelivery;
    }
    const meta: JsonObject = {};
    if (!options.readOnly) this.#applyMcpMeta(result, meta);
    const transfers = this.#transfers(result).map<JsonObject>((entry) => {
      const delivery = (options.readOnly
        ? undefined
        : this.offers?.deliver(entry.reference, scope)) ?? {
        transferId: entry.reference.transferId,
        available: false,
        reason: options.readOnly ? "read_only_view" : "delivery_unavailable",
      };
      const value: JsonObject = {
        transferId: delivery.transferId!,
        available: delivery.available!,
      };
      if (delivery.available) value.request = delivery.request!;
      else value.reason = delivery.reason!;
      return value;
    });
    authorizeCall(() => scope.assertCurrent());
    scope.signal?.throwIfAborted();
    return {
      result: described,
      ...(meta._meta ? { hostMeta: meta._meta as JsonObject } : {}),
      transfers,
    };
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
      JSON.stringify(
        copyMcpJSON(
          result,
          this.limits.maxDataBytes,
        ),
      ),
    ) as StoredResult;
    await this.#authorizeMcp(result, scope);
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
    this.#applyMcpMeta(result, response);
    const hostMetaBytes =
      response._meta === undefined
        ? 0
        : mcpMetaSize(response._meta, this.limits.responseBytes) + 10;
    let encodedBinaryBytes = 0;
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
      if (item.type === "resource_link" && item.remote) continue;
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
      const cap = Math.min(this.artifacts.maxReadBytes, maximum);
      if (!(kind === "resource" && item.encoding === "text")) {
        encodedBinaryBytes += Math.ceil(source.size / 3) * 4;
        requireCondition(
          encodedBinaryBytes +
            Buffer.byteLength(JSON.stringify(control)) +
            hostMetaBytes <=
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
    await this.#authorizeMcp(result, scope);
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
        this.limits.responseBytes,
      "resource_list_too_large",
      "The resource directory exceeds this response budget; request a smaller page.",
    );
    return response;
  }

  /** Standard resources/read uses text/blob bodies, never image/audio tool blocks. */
  async readResource(uri: string, scope: ResultScope): Promise<JsonObject> {
    if (/^nexum:\/\/agents\/[^/]+\/mcp\//.test(uri)) {
      requireCondition(
        this.mcp,
        "mcp_source_unavailable",
        "Remote resource routing is unavailable.",
      );
      return await this.mcp.readResource(uri, scope, this.limits);
    }
    const resource = await this.artifacts.metadata(uri, scope);
    const text = textMime(resource.mimeType);
    const cap = Math.min(this.artifacts.maxReadBytes, this.limits.responseBytes);
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
    requireCondition(
      Buffer.byteLength(JSON.stringify(response)) <= this.limits.responseBytes,
      "mcp_response_too_large",
      "The resource response exceeds its final encoded budget.",
      { uri },
    );
    return response;
  }
}
