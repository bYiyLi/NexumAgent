import { createHash } from "node:crypto";
import { Blob, File } from "node:buffer";
import { constants, lstatSync, realpathSync, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { MIMEType, types } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import { canonicalJson, isPlainRecord, newId } from "../contracts/json.js";
import { contains, privateDirectory } from "../runtime/paths.js";

export interface ArtifactRecord {
  readonly resourceId: string;
  readonly agentId: string;
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly originRunId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}
interface StoredArtifact extends ArtifactRecord {
  readonly schemaVersion: 1;
  readonly ownerKey: string;
}
export interface ArtifactSource {
  readonly path?: string;
  readonly data?: ArrayBuffer | SharedArrayBuffer | ArrayBufferView | Blob;
  readonly name?: string;
  readonly mimeType?: string;
}
export interface ArtifactAccess {
  readonly action: "register" | "read" | "list";
  readonly uri?: string;
  readonly path?: string;
  readonly resource?: ArtifactRecord & { readonly ownerKey: string };
}
export interface ArtifactScope {
  readonly pwd: string;
  readonly ownerKey: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  /** Trusted Core control-source verdict; never parsed from a script result. */
  readonly controlStorage?: boolean;
  assertCurrent(): void;
  authorize(target: ArtifactAccess): void;
}
export interface ArtifactOptions {
  readonly maxFileBytes?: number;
  readonly maxReadBytes?: number;
  readonly retentionMs?: number;
  readonly now?: () => number;
  /** Core retention facts, never a guest callback or a substitute for current read permission. */
  readonly retentionUntil?: (
    resourceId: string,
    originRunId: string | null,
    originalExpiresAt: number,
  ) => number;
  readonly reserve?: (
    bytes: number,
    options?: { readonly control?: boolean },
  ) => Promise<{ release(): void }>;
}
export interface ArtifactPage {
  readonly resources: readonly ArtifactRecord[];
  readonly nextCursor: string | null;
}
export type ArtifactInspector = (fixed: {
  readonly path: string;
  readonly size: number;
  readonly name: string;
  readonly mimeType: string;
}) => Promise<{ readonly mimeType?: string }>;
interface Preparation {
  directory: Stats;
  content: Stats;
  data?: Stats;
  metadata?: Stats;
}
const resourceId = /^res_[0-9a-f]{32}$/;
const denied = new Set([
  "forbidden",
  "permission_denied",
  "access_denied",
  "resource_forbidden",
  "path_not_allowed",
  "unauthorized",
]);
const metadataLimit = 16384;
const chunkSize = 65536;
const NativeBlob = Blob;
const nativeBlob = new NativeBlob([]);
const blobSymbols = Object.getOwnPropertySymbols(nativeBlob);
const blobHandleKey = blobSymbols.find((key) => key.description === "kHandle")!;
const blobLengthKey = blobSymbols.find((key) => key.description === "kLength")!;
const blobTypeKey = blobSymbols.find((key) => key.description === "kType")!;
const nativeHandle = Object.getOwnPropertyDescriptor(
  nativeBlob,
  blobHandleKey,
)!.value;
const nativeHandlePrototype = Object.getPrototypeOf(nativeHandle);
const nativeHandleSlice = Object.getOwnPropertyDescriptor(
  nativeHandlePrototype,
  "slice",
)!.value;
const nativeHandleReader = Object.getOwnPropertyDescriptor(
  nativeHandlePrototype,
  "getReader",
)!.value;
const nativeFile = new File([], "reference", { lastModified: 0 });
const fileStateKey = Object.getOwnPropertySymbols(nativeFile).find(
  (key) => !blobSymbols.includes(key),
)!;
const nativeFileStatePrototype = Object.getPrototypeOf(
  Object.getOwnPropertyDescriptor(nativeFile, fileStateKey)!.value,
);
const arrayBufferSize = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
const sharedSize = Object.getOwnPropertyDescriptor(
  SharedArrayBuffer.prototype,
  "byteLength",
)!.get!;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const viewBuffer = Object.getOwnPropertyDescriptor(
  typedPrototype,
  "buffer",
)!.get!;
const viewOffset = Object.getOwnPropertyDescriptor(
  typedPrototype,
  "byteOffset",
)!.get!;
const viewSize = Object.getOwnPropertyDescriptor(
  typedPrototype,
  "byteLength",
)!.get!;
const dataBuffer = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "buffer",
)!.get!;
const dataOffset = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteOffset",
)!.get!;
const dataSize = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteLength",
)!.get!;

function boundedInteger(value: unknown, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= maximum
  );
}

export interface BlobSnapshot {
  readonly blob: Blob;
  /** Node's declared length; every consumer must also count the actual stream. */
  readonly size: number;
  readonly mimeType: string;
  readonly name?: string;
  readonly lastModified?: number;
}

/**
 * Node's public Blob getters inspect JS Symbol fields; they are not brand probes.
 * This proves execution-safe native identity, not opaque queue byte length.
 * Consumers must use bounded streams rather than size-then-arrayBuffer/text.
 */
export function snapshotBlob(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): BlobSnapshot | null {
  requireCondition(
    Number.isSafeInteger(maximum) && maximum >= 0,
    "invalid_resource_budget",
    "A Blob snapshot requires a bounded trusted byte budget.",
  );
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  let prototype = Object.getPrototypeOf(value),
    isBlob = false,
    isFile = false;
  for (let depth = 0; prototype && depth < 64; depth++) {
    requireCondition(
      !types.isProxy(prototype),
      "invalid_artifact_source",
      "A Blob prototype cannot be a Proxy.",
    );
    if (prototype === File.prototype) isFile = true;
    if (prototype === Blob.prototype) {
      isBlob = true;
      break;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  if (!isBlob) return null;
  const data = (key: symbol): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireCondition(
      descriptor && "value" in descriptor,
      "invalid_artifact_source",
      "Blob internal fields must be own data properties.",
    );
    return descriptor.value;
  };
  const handle = data(blobHandleKey),
    size = data(blobLengthKey),
    type = data(blobTypeKey);
  requireCondition(
    boundedInteger(size, maximum),
    "resource_too_large",
    "The Blob exceeds the configured content-size policy.",
  );
  requireCondition(
    typeof type === "string" && type.length <= 256,
    "invalid_artifact_source",
    "Blob MIME metadata must be bounded text.",
  );
  requireCondition(
    handle &&
      typeof handle === "object" &&
      !types.isProxy(handle) &&
      Object.getPrototypeOf(handle) === nativeHandlePrototype &&
      Reflect.ownKeys(handle).length === 0 &&
      Object.getOwnPropertyDescriptor(nativeHandlePrototype, "slice")?.value ===
        nativeHandleSlice &&
      Object.getOwnPropertyDescriptor(nativeHandlePrototype, "getReader")
        ?.value === nativeHandleReader,
    "invalid_artifact_source",
    "The Blob handle must retain its native identity and methods.",
  );
  try {
    // V8's receiver signature rejects Object.create(nativeHandlePrototype)
    // before entering C++; no user method or source Symbol getter is invoked.
    Reflect.apply(nativeHandleSlice, handle, [0, 0]);
  } catch (cause) {
    throw new AgentError(
      "invalid_artifact_source",
      "The Blob handle is not an actual native Blob handle.",
      undefined,
      { cause },
    );
  }
  let name: string | undefined, lastModified: number | undefined;
  const fileState = Object.getOwnPropertyDescriptor(value, fileStateKey);
  if (isFile || fileState) {
    requireCondition(
      fileState &&
        "value" in fileState &&
        fileState.value &&
        typeof fileState.value === "object" &&
        !types.isProxy(fileState.value) &&
        Object.getPrototypeOf(fileState.value) === nativeFileStatePrototype,
      "invalid_artifact_source",
      "File metadata must retain its native data shape.",
    );
    const fields = Object.getOwnPropertyDescriptors(fileState.value);
    requireCondition(
      Reflect.ownKeys(fields).every(
        (key) =>
          (key === "name" || key === "lastModified") && "value" in fields[key]!,
      ) &&
        typeof fields.name?.value === "string" &&
        typeof fields.lastModified?.value === "number",
      "invalid_artifact_source",
      "File name and time metadata cannot use accessors.",
    );
    name = displayName(fields.name.value);
    lastModified = fields.lastModified.value;
  }
  // Only a fresh controlled carrier reaches Node's constructor. Cloning the
  // original object could execute its additional enumerable getters; slice on
  // an unvalidated source would read forged Symbol fields or a custom method.
  const carrier = Object.create(null);
  Object.defineProperties(carrier, {
    [blobHandleKey]: { value: handle },
    size: { value: size },
  });
  const blob = new NativeBlob([carrier], { type });
  return Object.freeze({
    blob,
    size,
    mimeType: Object.getOwnPropertyDescriptor(blob, blobTypeKey)!.value,
    ...(name === undefined ? {} : { name }),
    ...(lastModified === undefined ? {} : { lastModified }),
  });
}
function mime(value: unknown): string {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\0\r\n]/.test(value),
    "invalid_artifact_source",
    "The resource MIME type must be bounded media-type text.",
  );
  try {
    return new MIMEType(value).toString();
  } catch (cause) {
    throw new AgentError(
      "invalid_artifact_source",
      "The resource MIME type is invalid.",
      undefined,
      { cause },
    );
  }
}
function displayName(value: unknown): string {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= 1024 &&
      !/[\0\r\n]/.test(value),
    "invalid_artifact_source",
    "The resource name must be bounded display text.",
  );
  return value;
}
export function artifactUri(agentId: string, id: string): string {
  requireCondition(
    typeof agentId === "string" &&
      agentId.length > 0 &&
      Buffer.byteLength(agentId) <= 256 &&
      !/[\0\r\n]/.test(agentId) &&
      resourceId.test(id),
    "invalid_resource_uri",
    "A resource URI needs a valid Agent and resource identity.",
  );
  return `nexum://agents/${encodeURIComponent(agentId)}/resources/${id}`;
}
export function parseArtifactUri(uri: string): {
  agentId: string;
  resourceId: string;
} {
  const match =
    typeof uri === "string" &&
    /^nexum:\/\/agents\/([^/]+)\/resources\/(res_[0-9a-f]{32})$/.exec(uri);
  requireCondition(
    match && uri.length <= 2048,
    "invalid_resource_uri",
    "The resource URI is invalid.",
  );
  let agentId: string;
  try {
    agentId = decodeURIComponent(match[1]!);
  } catch (cause) {
    throw new AgentError(
      "invalid_resource_uri",
      "The Agent identity is not correctly encoded.",
      undefined,
      { cause },
    );
  }
  requireCondition(
    artifactUri(agentId, match[2]!) === uri,
    "invalid_resource_uri",
    "The resource URI must use its canonical encoding.",
  );
  return { agentId, resourceId: match[2]! };
}
function publicRecord(record: StoredArtifact): ArtifactRecord {
  return Object.freeze({
    resourceId: record.resourceId,
    agentId: record.agentId,
    uri: record.uri,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    sha256: record.sha256,
    originRunId: record.originRunId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });
}
function permissionDenied(cause: unknown): boolean {
  if (!cause || typeof cause !== "object" || types.isProxy(cause)) return false;
  const code = Object.getOwnPropertyDescriptor(cause, "code");
  return !!code && "value" in code && denied.has(code.value);
}
function authority(check: () => unknown): void {
  try {
    authorizeCall(check);
  } catch (cause) {
    if (cause instanceof AgentError || permissionDenied(cause)) throw cause;
    throw new AgentError(
      "authorization_failed",
      "The current resource authority could not be verified.",
      undefined,
      { cause },
    );
  }
}
function unavailable(cause: unknown): AgentError {
  return new AgentError(
    "resource_unavailable",
    "The registered resource or its fixed content is unavailable.",
    undefined,
    { cause },
  );
}
function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
async function openRegular(
  filename: string,
  code: string,
): Promise<FileHandle> {
  // NONBLOCK also covers a regular file replaced by a FIFO between lstat/open.
  // Opening an untrusted FIFO first would wait indefinitely outside AbortSignal.
  requireCondition(
    (await lstat(filename)).isFile(),
    code,
    "The resource source or stored content must be a regular file.",
  );
  const handle = await open(
    filename,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    requireCondition(
      (await handle.stat()).isFile(),
      code,
      "The resource source or stored content must remain a regular file.",
    );
    return handle;
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

/** Fixed content and its directory catalog belong to one Agent/profile. */
export class ArtifactStore {
  readonly root: string;
  readonly agentId: string;
  readonly directory: string;
  readonly maxFileBytes: number;
  readonly maxReadBytes: number;
  readonly retentionMs: number;
  #now: () => number;
  #retentionUntil?: ArtifactOptions["retentionUntil"];
  #reserve?: ArtifactOptions["reserve"];
  #active = new Map<string, number>();
  #pending = new Set<string>();
  constructor(root: string, agentId: string, options: ArtifactOptions = {}) {
    this.root = realpathSync.native(root);
    requireCondition(
      path.resolve(root) === this.root,
      "storage_path_escape",
      "The established profile root cannot redirect elsewhere.",
    );
    artifactUri(agentId, "res_00000000000000000000000000000000");
    this.agentId = agentId;
    this.directory = privateDirectory(this.root, "work", "resources");
    this.maxFileBytes = options.maxFileBytes ?? 256 * 1024 * 1024;
    this.maxReadBytes = options.maxReadBytes ?? 64 * 1024 * 1024;
    this.retentionMs = options.retentionMs ?? 7 * 86400000;
    this.#now = options.now ?? Date.now;
    this.#retentionUntil = options.retentionUntil;
    this.#reserve = options.reserve;
    requireCondition(
      boundedInteger(this.maxFileBytes, 20 * 1024 ** 3) &&
        this.maxFileBytes > 0 &&
        boundedInteger(this.maxReadBytes, 128 * 1024 ** 2) &&
        this.maxReadBytes > 0 &&
        boundedInteger(this.retentionMs, 365 * 86400000) &&
        this.retentionMs > 0,
      "invalid_artifact_options",
      "Resource size, read and retention policies must be positive bounded Agent configuration.",
    );
  }
  activeSnapshot(): {
    readonly resourceIds: ReadonlySet<string>;
    readonly pendingPaths: ReadonlySet<string>;
  } {
    return Object.freeze({
      resourceIds: new Set(this.#active.keys()),
      pendingPaths: new Set(this.#pending),
    });
  }
  #pin(id: string): () => void {
    this.#active.set(id, (this.#active.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.#active.get(id) ?? 1) - 1;
      if (count) this.#active.set(id, count);
      else this.#active.delete(id);
    };
  }
  #assert(scope: ArtifactScope): void {
    scope.signal?.throwIfAborted();
    authority(() => scope.assertCurrent());
    requireCondition(
      typeof scope.ownerKey === "string" &&
        scope.ownerKey.length > 0 &&
        Buffer.byteLength(scope.ownerKey) <= 256 &&
        path.isAbsolute(scope.pwd),
      "invalid_artifact_context",
      "Resources need the trusted owner and absolute working directory.",
    );
  }
  #check(scope: ArtifactScope, target: ArtifactAccess): void {
    this.#assert(scope);
    authority(() => scope.authorize(Object.freeze(target)));
  }
  #root(): void {
    try {
      requireCondition(
        realpathSync.native(this.root) === this.root &&
          lstatSync(path.join(this.root, "work")).isDirectory() &&
          lstatSync(this.directory).isDirectory() &&
          realpathSync.native(this.directory) === this.directory,
        "storage_path_escape",
        "The resource catalog must remain inside the bound profile.",
      );
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw unavailable(cause);
    }
  }
  #path(id: string): string {
    this.#root();
    requireCondition(
      resourceId.test(id),
      "invalid_resource_uri",
      "The resource identity is invalid.",
    );
    return path.join(this.directory, id);
  }
  async #stage(
    directory: string,
    expected?: Preparation,
  ): Promise<Preparation> {
    this.#root();
    requireCondition(
      path.dirname(directory) === this.directory &&
        path.basename(directory).startsWith(".pending-"),
      "storage_path_escape",
      "A resource preparation directory must belong to this catalog.",
    );
    const content = path.join(directory, "content");
    const info = await lstat(directory),
      contentInfo = await lstat(content);
    requireCondition(
      info.isDirectory() &&
        (await realpath(directory)) === directory &&
        contentInfo.isDirectory() &&
        (await realpath(content)) === content,
      "storage_path_escape",
      "A resource preparation directory cannot redirect elsewhere.",
    );
    if (expected) {
      requireCondition(
        info.dev === expected.directory.dev &&
          info.ino === expected.directory.ino &&
          contentInfo.dev === expected.content.dev &&
          contentInfo.ino === expected.content.ino,
        "resource_preparation_changed",
        "The resource preparation directories were replaced.",
      );
      for (const [filename, previous] of [
        [path.join(content, "data"), expected.data],
        [path.join(directory, "resource.json"), expected.metadata],
      ] as const) {
        if (!previous) continue;
        const current = await lstat(filename);
        requireCondition(
          current.isFile() && sameFile(previous, current),
          "resource_preparation_changed",
          "The fixed resource files were replaced or changed before publication.",
        );
      }
    }
    return expected ?? { directory: info, content: contentInfo };
  }
  async #directory(id: string): Promise<string> {
    const directory = this.#path(id);
    try {
      const info = await lstat(directory);
      requireCondition(
        info.isDirectory() &&
          (await realpath(directory)) === directory &&
          contains(this.directory, directory),
        "storage_path_escape",
        "The registered resource directory cannot redirect elsewhere.",
      );
      const content = path.join(directory, "content");
      requireCondition(
        (await lstat(content)).isDirectory() &&
          (await realpath(content)) === content,
        "storage_path_escape",
        "The resource content directory cannot redirect elsewhere.",
      );
      return directory;
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw unavailable(cause);
    }
  }
  #id(uri: string): string {
    const target = parseArtifactUri(uri);
    requireCondition(
      target.agentId === this.agentId,
      "resource_agent_mismatch",
      "The resource belongs to another Agent.",
    );
    return target.resourceId;
  }
  async #stored(uri: string, scope: ArtifactScope): Promise<StoredArtifact> {
    this.#check(scope, { action: "read", uri });
    const id = this.#id(uri),
      directory = await this.#directory(id);
    let handle: FileHandle | undefined;
    try {
      handle = await openRegular(
        path.join(directory, "resource.json"),
        "invalid_resource_metadata",
      );
      const info = await handle.stat();
      requireCondition(
        info.isFile() && info.size > 0 && info.size <= metadataLimit,
        "invalid_resource_metadata",
        "The local resource registration is invalid or oversized.",
      );
      const data = Buffer.alloc(info.size);
      const read = await handle.read(data, 0, data.length, 0);
      requireCondition(
        read.bytesRead === data.length,
        "invalid_resource_metadata",
        "The local resource registration changed during reading.",
      );
      const parsed: unknown = JSON.parse(data.toString("utf8"));
      requireCondition(
        isPlainRecord(parsed),
        "invalid_resource_metadata",
        "The local resource registration is invalid.",
      );
      const record = parsed as unknown as StoredArtifact;
      requireCondition(
        record.schemaVersion === 1 &&
          record.resourceId === id &&
          record.agentId === this.agentId &&
          record.uri === uri &&
          typeof record.ownerKey === "string" &&
          record.ownerKey.length > 0 &&
          Buffer.byteLength(record.ownerKey) <= 256 &&
          boundedInteger(record.size, 20 * 1024 ** 3) &&
          typeof record.sha256 === "string" &&
          /^[0-9a-f]{64}$/.test(record.sha256) &&
          (record.originRunId === null ||
            typeof record.originRunId === "string") &&
          typeof record.createdAt === "string" &&
          typeof record.expiresAt === "string" &&
          Number.isFinite(Date.parse(record.createdAt)) &&
          Number.isFinite(Date.parse(record.expiresAt)) &&
          Date.parse(record.expiresAt) > Date.parse(record.createdAt),
        "invalid_resource_metadata",
        "The local resource registration does not match its identity and content policy.",
      );
      displayName(record.name);
      requireCondition(
        mime(record.mimeType) === record.mimeType,
        "invalid_resource_metadata",
        "The registered resource MIME type is invalid.",
      );
      this.#check(scope, {
        action: "read",
        uri,
        resource: Object.freeze(record),
      });
      const promisedUntil =
        this.#retentionUntil?.(
          record.resourceId,
          record.originRunId,
          Date.parse(record.expiresAt),
        ) ?? 0;
      requireCondition(
        Number.isSafeInteger(promisedUntil) && promisedUntil >= 0,
        "invalid_retention",
        "The trusted artifact retention deadline is invalid.",
      );
      requireCondition(
        this.#now() < Math.max(Date.parse(record.expiresAt), promisedUntil),
        "resource_expired",
        "The registered resource has expired; it cannot be recreated from a source path.",
      );
      return record;
    } catch (cause) {
      if (
        cause instanceof AgentError ||
        permissionDenied(cause) ||
        scope.signal?.aborted
      )
        throw cause;
      throw unavailable(cause);
    } finally {
      await handle?.close();
    }
  }
  async #content(
    record: StoredArtifact,
  ): Promise<{ handle: FileHandle; info: Stats }> {
    const directory = await this.#directory(record.resourceId);
    let handle: FileHandle | undefined;
    try {
      handle = await openRegular(
        path.join(directory, "content", "data"),
        "resource_changed",
      );
      const info = await handle.stat();
      requireCondition(
        info.isFile() && info.size === record.size,
        "resource_changed",
        "The registered content is no longer the fixed resource that was published.",
      );
      return { handle, info };
    } catch (cause) {
      await handle?.close();
      if (cause instanceof AgentError) throw cause;
      throw unavailable(cause);
    }
  }
  async register(
    value: ArtifactSource,
    scope: ArtifactScope,
    inspect?: ArtifactInspector,
    options: { readonly maxBytes?: number } = {},
  ): Promise<ArtifactRecord> {
    this.#assert(scope);
    const effectiveMaximum =
      options.maxBytes === undefined ? this.maxFileBytes : options.maxBytes;
    requireCondition(
      boundedInteger(effectiveMaximum, this.maxFileBytes) &&
        effectiveMaximum > 0,
      "invalid_resource_budget",
      "The trusted registration budget must be positive and cannot exceed the Agent file policy.",
    );
    requireCondition(
      isPlainRecord(value),
      "invalid_artifact_source",
      "A resource source must be ordinary data.",
    );
    const fields = Object.getOwnPropertyDescriptors(value);
    requireCondition(
      Reflect.ownKeys(fields).every(
        (key) =>
          typeof key === "string" &&
          ["path", "data", "name", "mimeType"].includes(key) &&
          "value" in fields[key]!,
      ) &&
        Number(Object.hasOwn(fields, "path")) +
          Number(Object.hasOwn(fields, "data")) ===
          1,
      "invalid_artifact_source",
      "A resource needs exactly one path or native binary source and data fields.",
    );
    const source = Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [key, field.value]),
    ) as ArtifactSource;
    let bytes: Buffer | undefined,
      blob: Blob | undefined,
      sourcePath: string | undefined;
    let size: number,
      name = source.name,
      mimeType = source.mimeType;
    if (Object.hasOwn(fields, "path")) {
      requireCondition(
        typeof source.path === "string" &&
          source.path.length > 0 &&
          Buffer.byteLength(source.path) <= 262144 &&
          !source.path.includes("\0"),
        "invalid_artifact_source",
        "A resource source path must be nonempty bounded text.",
      );
      sourcePath = path.resolve(scope.pwd, source.path);
      name ??= path.basename(sourcePath);
      this.#check(scope, { action: "register", path: sourcePath });
      size = 0;
    } else {
      const data = source.data;
      requireCondition(
        data && typeof data === "object" && !types.isProxy(data),
        "invalid_artifact_source",
        "A resource needs an actual native binary source.",
      );
      try {
        let native: Uint8Array | undefined;
        if (types.isDataView(data)) {
          size = dataSize.call(data);
          native = new Uint8Array(
            dataBuffer.call(data),
            dataOffset.call(data),
            size,
          );
        } else if (types.isArrayBufferView(data)) {
          size = viewSize.call(data);
          native = new Uint8Array(
            viewBuffer.call(data),
            viewOffset.call(data),
            size,
          );
        } else if (
          types.isSharedArrayBuffer(data) ||
          types.isArrayBuffer(data)
        ) {
          size = (
            types.isSharedArrayBuffer(data) ? sharedSize : arrayBufferSize
          ).call(data);
          native = new Uint8Array(data as ArrayBuffer);
        } else {
          const snapshot = snapshotBlob(data, effectiveMaximum);
          requireCondition(
            snapshot,
            "invalid_artifact_source",
            "A resource source must be an actual native Blob or File.",
          );
          size = snapshot.size;
          blob = snapshot.blob;
          mimeType ??= snapshot.mimeType || undefined;
          name ??= snapshot.name;
        }
        requireCondition(
          boundedInteger(size, effectiveMaximum),
          "resource_too_large",
          "The resource exceeds the configured file-size policy.",
        );
        // Fix a mutable native view synchronously, before any asynchronous work.
        if (native) bytes = Buffer.from(native);
      } catch (cause) {
        if (cause instanceof AgentError) throw cause;
        throw new AgentError(
          "invalid_artifact_source",
          "The binary source is invalid or detached.",
          undefined,
          { cause },
        );
      }
      this.#check(scope, { action: "register" });
    }
    name = displayName(name ?? "resource.bin");
    mimeType = mime(mimeType ?? "application/octet-stream");
    const id = newId("res"),
      uri = artifactUri(this.agentId, id);
    this.#root();
    let temporary: string | undefined,
      input: FileHandle | undefined,
      output: FileHandle | undefined;
    let before: Stats | undefined;
    let prepared: Preparation | undefined;
    let reservation: { release(): void } | undefined;
    let pendingPath: string | undefined;
    const release = this.#pin(id);
    try {
      if (sourcePath) {
        const canonical = await realpath(sourcePath);
        this.#check(scope, { action: "register", path: canonical });
        input = await openRegular(canonical, "invalid_artifact_source");
        before = await input.stat();
        requireCondition(
          before.isFile(),
          "invalid_artifact_source",
          "A local resource source must be a readable regular file.",
        );
        requireCondition(
          boundedInteger(before.size, effectiveMaximum),
          "resource_too_large",
          "The resource exceeds the configured file-size policy.",
        );
        size = before.size;
        sourcePath = canonical;
      }
      this.#check(scope, {
        action: "register",
        ...(sourcePath ? { path: sourcePath } : {}),
      });
      this.#root();
      reservation = await this.#reserve?.(size + metadataLimit + 1024, {
        control: scope.controlStorage === true,
      });
      temporary = await mkdtemp(path.join(this.directory, ".pending-"));
      pendingPath = temporary;
      this.#pending.add(temporary);
      await mkdir(path.join(temporary, "content"), { mode: 0o700 });
      prepared = await this.#stage(temporary);
      output = await open(path.join(temporary, "content", "data"), "wx", 0o600);
      const hash = createHash("sha256");
      let copied = 0;
      const write = async (chunk: Uint8Array) => {
        this.#check(scope, {
          action: "register",
          ...(sourcePath ? { path: sourcePath } : {}),
        });
        copied += chunk.byteLength;
        requireCondition(
          copied <= effectiveMaximum && copied <= size,
          "resource_too_large",
          "The resource changed size or exceeds its configured policy.",
        );
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await output!.write(
            chunk,
            offset,
            chunk.byteLength - offset,
            null,
          );
          requireCondition(
            result.bytesWritten > 0,
            "resource_persistence_failed",
            "The fixed resource content could not be written.",
          );
          offset += result.bytesWritten;
        }
      };
      if (input) {
        while (true) {
          this.#check(scope, { action: "register", path: sourcePath! });
          const buffer = Buffer.allocUnsafe(chunkSize);
          const read = await input.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          await write(buffer.subarray(0, read.bytesRead));
        }
        requireCondition(
          sameFile(before!, await input.stat()) &&
            (await realpath(sourcePath!)) === sourcePath &&
            sameFile(before!, await stat(sourcePath!)),
          "resource_source_changed",
          "The source file changed while its content was being fixed.",
        );
        await input.close();
        input = undefined;
      } else if (bytes) {
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize)
          await write(bytes.subarray(offset, offset + chunkSize));
      } else {
        for await (const chunk of Readable.fromWeb(
          Blob.prototype.stream.call(
            blob!,
          ) as import("node:stream/web").ReadableStream<Uint8Array>,
        ))
          await write(chunk as Uint8Array);
      }
      requireCondition(
        copied === size,
        "resource_source_changed",
        "The source ended before its declared content was fixed.",
      );
      await output.sync();
      prepared.data = await output.stat();
      await output.close();
      output = undefined;
      if (inspect) {
        await this.#stage(temporary, prepared);
        this.#check(scope, {
          action: "register",
          ...(sourcePath ? { path: sourcePath } : {}),
        });
        const result = await inspect(
          Object.freeze({
            path: path.join(temporary, "content", "data"),
            size: copied,
            name,
            mimeType,
          }),
        );
        requireCondition(
          isPlainRecord(result),
          "invalid_artifact_inspection",
          "The trusted content inspector must return metadata data.",
        );
        const fields = Object.getOwnPropertyDescriptors(result);
        requireCondition(
          Reflect.ownKeys(fields).every(
            (key) => key === "mimeType" && "value" in fields[key]!,
          ),
          "invalid_artifact_inspection",
          "The trusted content inspector may only refine the MIME type.",
        );
        if (fields.mimeType) mimeType = mime(fields.mimeType.value);
        await this.#stage(temporary, prepared);
        this.#check(scope, {
          action: "register",
          ...(sourcePath ? { path: sourcePath } : {}),
        });
      }
      const now = this.#now();
      requireCondition(
        boundedInteger(now, 253402300799999 - this.retentionMs),
        "invalid_artifact_clock",
        "The resource clock cannot represent its expiry.",
      );
      const record: StoredArtifact = Object.freeze({
        schemaVersion: 1,
        ownerKey: scope.ownerKey,
        resourceId: id,
        agentId: this.agentId,
        uri,
        name,
        mimeType,
        size: copied,
        sha256: hash.digest("hex"),
        originRunId: scope.runId ?? null,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.retentionMs).toISOString(),
      });
      this.#check(scope, {
        action: "register",
        ...(sourcePath ? { path: sourcePath } : {}),
        resource: record,
      });
      await this.#stage(temporary, prepared);
      const metadata = await open(
        path.join(temporary, "resource.json"),
        "wx",
        0o600,
      );
      try {
        await metadata.writeFile(canonicalJson(record, metadataLimit));
        await metadata.sync();
        prepared.metadata = await metadata.stat();
      } finally {
        await metadata.close();
      }
      this.#check(scope, {
        action: "register",
        ...(sourcePath ? { path: sourcePath } : {}),
        resource: record,
      });
      await this.#stage(temporary, prepared);
      this.#check(scope, {
        action: "register",
        ...(sourcePath ? { path: sourcePath } : {}),
        resource: record,
      });
      await rename(temporary, this.#path(id));
      temporary = undefined;
      this.#check(scope, {
        action: "register",
        ...(sourcePath ? { path: sourcePath } : {}),
        resource: record,
      });
      return publicRecord(record);
    } catch (cause) {
      if (
        cause instanceof AgentError ||
        permissionDenied(cause) ||
        scope.signal?.aborted
      )
        throw cause;
      throw new AgentError(
        "resource_registration_failed",
        "The resource could not be fixed and registered; no completed identity was published.",
        undefined,
        { cause },
      );
    } finally {
      try {
        await input?.close();
        await output?.close();
        if (temporary) {
          this.#root();
          await rm(temporary, { recursive: true, force: true });
        }
      } finally {
        if (pendingPath) this.#pending.delete(pendingPath);
        release();
        reservation?.release();
      }
    }
  }
  async metadata(uri: string, scope: ArtifactScope): Promise<ArtifactRecord> {
    const release = this.#pin(this.#id(uri));
    try {
      const record = await this.#stored(uri, scope),
        content = await this.#content(record);
      await content.handle.close();
      this.#check(scope, { action: "read", uri, resource: record });
      return publicRecord(record);
    } finally {
      release();
    }
  }
  async list(
    scope: ArtifactScope,
    options: {
      limit?: number;
      cursor?: string;
      /** Trusted current page budget, counted before advancing its cursor. */
      maxBytes?: number;
    } = {},
  ): Promise<ArtifactPage> {
    this.#check(scope, { action: "list" });
    this.#root();
    const limit = options.limit ?? 20;
    requireCondition(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 100,
      "invalid_limit",
      "A resource list needs a limit from 1 through 100.",
    );
    const requestedMaximum = options.maxBytes;
    requireCondition(
      requestedMaximum === undefined ||
        (Number.isSafeInteger(requestedMaximum) && requestedMaximum > 0),
      "invalid_resource_budget",
      "A resource page requires a positive trusted byte budget.",
    );
    const maximum =
      requestedMaximum === undefined
        ? undefined
        : Math.min(requestedMaximum, 1024 * 1024);
    let after = "";
    if (options.cursor !== undefined) {
      requireCondition(
        typeof options.cursor === "string" &&
          options.cursor.length <= 2048 &&
          /^[A-Za-z0-9_-]+$/.test(options.cursor),
        "invalid_cursor",
        "The resource cursor is invalid.",
      );
      let cursor: unknown;
      try {
        cursor = JSON.parse(
          Buffer.from(options.cursor, "base64url").toString("utf8"),
        );
      } catch {
        throw new AgentError(
          "invalid_cursor",
          "The resource cursor is invalid.",
        );
      }
      requireCondition(
        isPlainRecord(cursor) &&
          cursor.agentId === this.agentId &&
          cursor.ownerKey === scope.ownerKey &&
          typeof cursor.after === "string" &&
          resourceId.test(cursor.after),
        "invalid_cursor",
        "The resource cursor belongs to another caller or catalog.",
      );
      after = cursor.after;
    }
    const resources: ArtifactRecord[] = [];
    let scanned = 0;
    const entries = await opendir(this.directory);
    for await (const entry of entries) {
      this.#check(scope, { action: "list" });
      requireCondition(
        ++scanned <= 100000,
        "resource_catalog_too_large",
        "The local resource catalog exceeds its bounded scan budget.",
      );
      if (
        !entry.isDirectory() ||
        !resourceId.test(entry.name) ||
        entry.name <= after
      )
        continue;
      try {
        const record = await this.metadata(
          artifactUri(this.agentId, entry.name),
          scope,
        );
        resources.push(record);
        resources.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
        if (resources.length > limit + 1) resources.pop();
      } catch (cause) {
        if (
          permissionDenied(cause) ||
          (cause instanceof AgentError &&
            ["resource_expired", "resource_unavailable"].includes(cause.code))
        )
          continue;
        throw cause;
      }
    }
    this.#check(scope, { action: "list" });
    const cursorAt = (count: number): string | null =>
      resources.length > count
        ? Buffer.from(
            canonicalJson({
              agentId: this.agentId,
              ownerKey: scope.ownerKey,
              after: resources[count - 1]!.resourceId,
            }),
          ).toString("base64url")
        : null;
    let count = Math.min(limit, resources.length);
    if (maximum !== undefined) {
      let bytes = 0,
        selected = -1;
      if (count === 0) {
        if (
          Buffer.byteLength(
            JSON.stringify({ resources: [], nextCursor: null }),
          ) <= maximum
        )
          selected = 0;
      } else {
        for (let index = 0; index < count; index++) {
          bytes += Buffer.byteLength(JSON.stringify(resources[index]));
          // The empty array already includes its brackets; add entries and commas.
          const size =
            Buffer.byteLength(
              JSON.stringify({
                resources: [],
                nextCursor: cursorAt(index + 1),
              }),
            ) +
            bytes +
            index;
          if (size <= maximum) selected = index + 1;
          // A final page can lose a long caller-bound cursor. Inspect all prefixes
          // rather than treating an oversized earlier prefix as the final answer.
        }
      }
      requireCondition(
        selected >= 0,
        "resource_list_too_large",
        "The next resource page cannot fit the current metadata budget without skipping an entry.",
      );
      count = selected;
    }
    return Object.freeze({
      resources: Object.freeze(resources.slice(0, count)),
      nextCursor: cursorAt(count),
    });
  }
  async open(
    uri: string,
    scope: ArtifactScope,
  ): Promise<{
    resource: ArtifactRecord;
    stream: Readable;
    closed: Promise<void>;
  }> {
    const release = this.#pin(this.#id(uri));
    try {
      const result = await this.#open(uri, scope);
      void result.closed.then(release, release);
      return result;
    } catch (cause) {
      release();
      throw cause;
    }
  }
  async #open(
    uri: string,
    scope: ArtifactScope,
  ): Promise<{
    resource: ArtifactRecord;
    stream: Readable;
    closed: Promise<void>;
  }> {
    const record = await this.#stored(uri, scope);
    requireCondition(
      record.size <= this.maxFileBytes,
      "resource_too_large",
      "The registered resource exceeds the current file policy.",
    );
    const { handle, info } = await this.#content(record);
    try {
      this.#check(scope, { action: "read", uri, resource: record });
    } catch (cause) {
      await handle.close();
      throw cause;
    }
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= handle.close());
    const closed = Promise.withResolvers<void>();
    // The public completion remains awaitable even when the consumer observes a
    // stream error first. An unobserved internal notification must not crash Node.
    void closed.promise.catch(() => {});
    const check = () =>
      this.#check(scope, { action: "read", uri, resource: record });
    const content = async function* () {
      let count = 0;
      const hash = createHash("sha256");
      try {
        while (true) {
          check();
          const buffer = Buffer.allocUnsafe(chunkSize);
          const read = await handle.read(buffer, 0, buffer.length, null);
          check();
          if (!read.bytesRead) break;
          count += read.bytesRead;
          requireCondition(
            count <= record.size,
            "resource_changed",
            "The registered resource changed during reading.",
          );
          const chunk = buffer.subarray(0, read.bytesRead);
          hash.update(chunk);
          yield chunk;
        }
        requireCondition(
          count === record.size &&
            hash.digest("hex") === record.sha256 &&
            sameFile(info, await handle.stat()),
          "resource_changed",
          "The registered resource no longer matches its fixed content.",
        );
        check();
      } finally {
        await close();
      }
    };
    const stream = Readable.from(content());
    stream.once("close", () => {
      void close().then(closed.resolve, closed.reject);
    });
    if (scope.signal) {
      const aborted = () =>
        stream.destroy(
          new AgentError(
            "resource_read_cancelled",
            "The resource read was cancelled.",
          ),
        );
      scope.signal.addEventListener("abort", aborted, { once: true });
      stream.once("close", () =>
        scope.signal!.removeEventListener("abort", aborted),
      );
      if (scope.signal.aborted) aborted();
    }
    return Object.freeze({
      resource: publicRecord(record),
      stream,
      closed: closed.promise,
    });
  }
  async read(
    uri: string,
    scope: ArtifactScope,
    options: { maxBytes: number },
  ): Promise<{ resource: ArtifactRecord; data: Buffer }> {
    requireCondition(
      boundedInteger(options.maxBytes, this.maxReadBytes),
      "invalid_resource_budget",
      "The trusted resource-read budget cannot exceed its Agent policy.",
    );
    const resource = await this.metadata(uri, scope);
    requireCondition(
      resource.size <= options.maxBytes,
      "resource_read_too_large",
      "The resource exceeds this response budget; use transfer.createDownload({ uri }) for a file stream.",
      { uri, size: resource.size },
    );
    const result = await this.open(uri, scope),
      chunks: Buffer[] = [];
    let count = 0;
    try {
      for await (const chunk of result.stream) {
        count += (chunk as Buffer).byteLength;
        requireCondition(
          count <= options.maxBytes,
          "resource_read_too_large",
          "The resource exceeds this response budget; use a download stream.",
        );
        chunks.push(chunk as Buffer);
      }
    } finally {
      result.stream.destroy();
      await result.closed;
    }
    return Object.freeze({
      resource: result.resource,
      data: Buffer.concat(chunks, count),
    });
  }
}
