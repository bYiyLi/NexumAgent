import path from "node:path";
import { inspect, types, MIMEType } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type {
  ContributionOrigin,
  JsonObject,
  JsonValue,
} from "../contracts/types.js";
import type { ManagedResource } from "../extensions/resources.js";
import type { AccessTarget } from "../extensions/api.js";

export type McpMethod =
  | "tools/call"
  | "tools/list"
  | "resources/list"
  | "resources/templates/list"
  | "prompts/list"
  | "prompts/get";
export interface McpOutputBinding {
  readonly agentId: string;
  readonly profileRoot: string;
  readonly extensionId: string;
  readonly origin: ContributionOrigin;
}
export interface McpResultOptions {
  readonly connectionResourceId: string;
  readonly connection: string;
  readonly method?: McpMethod;
}
export interface McpSourceIdentity extends McpOutputBinding {
  readonly connectionResourceId: string;
  readonly connection: string;
}
export type McpAccess = "result" | "resources.read" | "resources.list";
export interface McpReadScope {
  readonly ownerKey: string;
  readonly grantId?: string;
  readonly signal?: AbortSignal;
  assertCurrent(): void;
  authorizeConnection(
    connection: string,
    uri?: string,
    access?: McpAccess,
  ): void;
}
export interface McpResultScope {
  readonly ownerKey: string;
  readonly grantId?: string;
  readonly signal?: AbortSignal;
  readonly authorizeTarget?: (target: AccessTarget) => void;
  assertCurrent(): void;
}
/** A registered cold connection implements this; it is never a script result. */
export interface McpResourceReader extends ManagedResource {
  readonly connection: string;
  assertCurrent(): void;
  readResource(uri: string, scope: McpReadScope): Promise<unknown>;
  listResources?(scope: McpReadScope, cursor?: string): Promise<unknown>;
}
export type McpResolvedReader = Pick<
  McpResourceReader,
  "connection" | "assertCurrent" | "readResource" | "listResources"
>;
export type McpResourceResolver = (
  source: McpSourceIdentity,
  scope: McpReadScope,
) => McpResolvedReader | Promise<McpResolvedReader>;
export interface McpProtocolMeta extends JsonObject {
  target: "result" | "content" | "resource" | "entry" | "message";
  meta: JsonObject;
}
export interface McpResultInfo {
  readonly kind: "tool" | "resources";
  readonly method: McpMethod | "resources/read";
  readonly source: McpSourceIdentity;
  readonly model: JsonObject;
  readonly meta: readonly McpProtocolMeta[];
}
const issued = new WeakMap<object, McpResultInfo>();
const methods = new Set<McpMethod>([
  "tools/call",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "prompts/get",
]);
const contentTypes = new Set([
  "text",
  "image",
  "audio",
  "resource_link",
  "resource",
]);
const maximumProtocolBytes = 128 * 1024 * 1024;
function text(value: unknown, maximum = 1024): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximum &&
    !/[\0\r\n]/.test(value)
  );
}
function record(value: unknown): Record<string, unknown> {
  requireCondition(
    isPlainRecord(value),
    "invalid_mcp_result",
    "MCP protocol data must be an ordinary data object.",
  );
  const result = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  requireCondition(
    keys.length <= 100000,
    "mcp_result_too_large",
    "MCP protocol data exceeds its field budget.",
  );
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (!field.enumerable) continue;
    requireCondition(
      typeof key === "string" && "value" in field,
      "invalid_mcp_result",
      "MCP protocol fields cannot contain accessors or enumerable Symbols.",
    );
    result[key] = field.value;
  }
  return result;
}
function items(value: unknown): unknown[] {
  requireCondition(
    !types.isProxy(value) && Array.isArray(value) && value.length <= 100000,
    "invalid_mcp_result",
    "MCP protocol collections require bounded ordinary arrays.",
  );
  const result: unknown[] = [];
  for (const key of Object.getOwnPropertySymbols(value))
    requireCondition(
      !Object.getOwnPropertyDescriptor(value, key)?.enumerable,
      "invalid_mcp_result",
      "MCP arrays cannot contain enumerable Symbols.",
    );
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    requireCondition(
      field && "value" in field,
      "invalid_mcp_result",
      "MCP arrays cannot contain holes or accessors.",
    );
    result.push(field.value);
  }
  return result;
}
/** JSON-only copy with encoded-size accounting before escaping or serialization. */
export function copyMcpJSON(
  value: unknown,
  maxBytes = maximumProtocolBytes,
): JsonValue {
  requireCondition(
    Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      maxBytes <= 512 * 1024 * 1024,
    "invalid_mcp_budget",
    "MCP JSON requires a bounded byte budget.",
  );
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  const charge = (amount: number) => {
    bytes += amount;
    requireCondition(
      bytes <= maxBytes,
      "mcp_result_too_large",
      "MCP JSON exceeds its encoded byte budget.",
    );
  };
  const string = (value: string) => {
    charge(2);
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 34 || code === 92) charge(2);
      else if (code < 32) charge([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code < 128) charge(1);
      else if (code < 2048) charge(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          charge(4);
          index++;
        } else charge(6);
      } else charge(code >= 0xdc00 && code <= 0xdfff ? 6 : 3);
    }
    return value;
  };
  function visit(input: unknown, depth: number): JsonValue {
    requireCondition(
      ++nodes <= 100000 && depth <= 64,
      "mcp_result_too_large",
      "MCP JSON exceeds its node or depth budget.",
    );
    if (input === null) {
      charge(4);
      return null;
    }
    if (typeof input === "string") return string(input);
    if (typeof input === "boolean") {
      charge(input ? 4 : 5);
      return input;
    }
    if (typeof input === "number" && Number.isFinite(input)) {
      charge(String(input).length);
      return input;
    }
    requireCondition(
      input &&
        typeof input === "object" &&
        !types.isProxy(input) &&
        !ancestors.has(input),
      "invalid_mcp_result",
      "MCP protocol values must be acyclic JSON data.",
    );
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        requireCondition(
          input.length <= 100000 - nodes,
          "mcp_result_too_large",
          "MCP JSON exceeds its remaining item budget.",
        );
        charge(2 + Math.max(0, input.length - 1));
        return items(input).map((item) => visit(item, depth + 1));
      }
      const source = record(input),
        keys = Object.keys(source),
        result = Object.create(null) as JsonObject;
      requireCondition(
        keys.length <= 100000 - nodes,
        "mcp_result_too_large",
        "MCP JSON exceeds its remaining field budget.",
      );
      charge(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        string(key);
        charge(1);
        result[key] = visit(source[key], depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(input);
    }
  }
  return visit(value, 0);
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function absoluteUri(value: unknown): string {
  requireCondition(
    text(value, 65536),
    "invalid_mcp_uri",
    "An MCP resource must have a bounded absolute URI.",
  );
  try {
    new URL(value);
  } catch {
    throw new AgentError("invalid_mcp_uri", "An MCP resource URI is invalid.");
  }
  return value;
}
export function mcpSource(value: unknown): McpSourceIdentity {
  const data = copyMcpJSON(value, 16384) as JsonObject;
  requireCondition(
    isPlainRecord(data) &&
      Object.keys(data).every((key) =>
        [
          "agentId",
          "profileRoot",
          "extensionId",
          "origin",
          "connectionResourceId",
          "connection",
        ].includes(key),
      ) &&
      text(data.agentId, 256) &&
      typeof data.profileRoot === "string" &&
      path.isAbsolute(data.profileRoot) &&
      path.resolve(data.profileRoot) === data.profileRoot &&
      text(data.extensionId, 256) &&
      text(data.connection, 256) &&
      text(data.connectionResourceId, 128) &&
      /^res_[0-9a-f]{32}$/.test(data.connectionResourceId) &&
      isPlainRecord(data.origin),
    "invalid_mcp_source",
    "MCP results require the actual registered extension and connection identity.",
  );
  const origin = data.origin as JsonObject;
  requireCondition(
    ["platform", "extension"].includes(origin.type as string) &&
      text(origin.owner, 1024) &&
      text(origin.namespace, 256) &&
      text(origin.version, 256) &&
      text(origin.revision, 1024),
    "invalid_mcp_source",
    "MCP source revision and namespace must come from the registered extension.",
  );
  return frozen(data as unknown as McpSourceIdentity);
}
export function bindMcpSource(
  binding: McpOutputBinding | undefined,
  options: unknown,
): McpSourceIdentity {
  requireCondition(
    binding,
    "mcp_source_unavailable",
    "Only a registered invocation can bind an MCP result source.",
  );
  const fields = record(options);
  requireCondition(
    Object.keys(fields).every((key) =>
      ["connectionResourceId", "connection", "method"].includes(key),
    ),
    "invalid_mcp_source",
    "MCP result options contain unsupported fields.",
  );
  return mcpSource({
    ...binding,
    connection: fields.connection,
    connectionResourceId: fields.connectionResourceId,
  });
}

interface Projection {
  model: JsonObject;
  meta: McpProtocolMeta[];
}
function project(
  raw: unknown,
  method: McpMethod | "resources/read",
): Projection {
  const source = copyMcpJSON(raw) as JsonObject;
  requireCondition(
    isPlainRecord(source),
    "invalid_mcp_result",
    "An MCP result must be an object.",
  );
  const meta: McpProtocolMeta[] = [];
  const removeMeta = (
    value: JsonObject,
    target: McpProtocolMeta["target"],
    extra: JsonObject = {},
  ) => {
    if (Object.hasOwn(value, "_meta")) {
      requireCondition(
        isPlainRecord(value._meta),
        "invalid_mcp_meta",
        "Protocol _meta must be a JSON object.",
      );
      meta.push({ target, meta: value._meta as JsonObject, ...extra });
      delete value._meta;
    }
  };
  removeMeta(source, "result");
  if (source.resultType !== undefined)
    requireCondition(
      source.resultType === "complete",
      "unsupported_mcp_result_type",
      "This result bridge cannot complete a remote continuation, input request or Task.",
    );
  const content = (value: JsonValue, index: number): JsonObject => {
    requireCondition(
      isPlainRecord(value) &&
        typeof value.type === "string" &&
        contentTypes.has(value.type),
      "invalid_mcp_content",
      "MCP content must use one of the five standard content kinds.",
    );
    const block = value as JsonObject;
    removeMeta(block, "content", { index });
    if (block.annotations !== undefined) {
      requireCondition(
        isPlainRecord(block.annotations),
        "invalid_mcp_content",
        "MCP annotations must be a data object.",
      );
      const annotation = block.annotations as JsonObject;
      requireCondition(
        (annotation.audience === undefined ||
          (Array.isArray(annotation.audience) &&
            annotation.audience.every(
              (role) => role === "user" || role === "assistant",
            ))) &&
          (annotation.priority === undefined ||
            (typeof annotation.priority === "number" &&
              annotation.priority >= 0 &&
              annotation.priority <= 1)) &&
          (annotation.lastModified === undefined ||
            typeof annotation.lastModified === "string"),
        "invalid_mcp_content",
        "MCP content annotations are invalid.",
      );
    }
    if (block.type === "text")
      requireCondition(
        typeof block.text === "string",
        "invalid_mcp_content",
        "MCP text content needs text.",
      );
    else if (block.type === "image" || block.type === "audio") {
      requireCondition(
        typeof block.data === "string" && text(block.mimeType, 256),
        "invalid_mcp_content",
        "MCP media needs encoded bytes and a MIME type.",
      );
      try {
        new MIMEType(block.mimeType);
      } catch {
        throw new AgentError(
          "invalid_mcp_content",
          "The MCP media MIME type is invalid.",
        );
      }
    } else if (block.type === "resource_link") {
      absoluteUri(block.uri);
      if (block.mimeType !== undefined) {
        requireCondition(
          text(block.mimeType, 256),
          "invalid_mcp_content",
          "An MCP resource MIME type must be bounded text.",
        );
        try {
          new MIMEType(block.mimeType);
        } catch {
          throw new AgentError(
            "invalid_mcp_content",
            "An MCP resource MIME type is invalid.",
          );
        }
      }
      requireCondition(
        block.size === undefined ||
          (typeof block.size === "number" &&
            Number.isSafeInteger(block.size) &&
            block.size >= 0),
        "invalid_mcp_content",
        "A resource link size must be a nonnegative byte count.",
      );
      requireCondition(
        text(block.name, 1024),
        "invalid_mcp_content",
        "MCP resource links need a name.",
      );
    } else {
      requireCondition(
        isPlainRecord(block.resource),
        "invalid_mcp_content",
        "An embedded MCP resource needs its contents.",
      );
      resource(block.resource as JsonObject, index);
    }
    return block;
  };
  const resource = (value: JsonObject, index: number) => {
    absoluteUri(value.uri);
    removeMeta(value, "resource", { index });
    if (value.mimeType !== undefined) {
      requireCondition(
        text(value.mimeType, 256),
        "invalid_mcp_resource",
        "An embedded resource MIME type must be bounded text.",
      );
      try {
        new MIMEType(value.mimeType);
      } catch {
        throw new AgentError(
          "invalid_mcp_resource",
          "An embedded resource MIME type is invalid.",
        );
      }
    }
    requireCondition(
      Number(Object.hasOwn(value, "text")) +
        Number(Object.hasOwn(value, "blob")) ===
        1 &&
        (Object.hasOwn(value, "text")
          ? typeof value.text === "string"
          : typeof value.blob === "string"),
      "invalid_mcp_resource",
      "MCP resources must contain exactly one actual text or encoded binary body.",
    );
  };
  if (method === "resources/read") {
    requireCondition(
      Array.isArray(source.contents),
      "invalid_mcp_resource",
      "MCP resources/read must return its actual contents array.",
    );
    source.contents.forEach((value, index) => {
      requireCondition(
        isPlainRecord(value),
        "invalid_mcp_resource",
        "An MCP resource content item is invalid.",
      );
      resource(value as JsonObject, index);
    });
    return { model: source, meta };
  }
  if (method === "tools/call") {
    requireCondition(
      Array.isArray(source.content) &&
        (source.isError === undefined || typeof source.isError === "boolean"),
      "invalid_mcp_result",
      "A tool result must contain standard content and an optional business-error flag.",
    );
    source.content = source.content.map(content);
    return { model: source, meta };
  }
  if (method === "prompts/get") {
    requireCondition(
      Array.isArray(source.messages),
      "invalid_mcp_result",
      "MCP prompts/get must return its messages.",
    );
    const blocks: JsonObject[] = [];
    const messages = source.messages.map((value, index) => {
      requireCondition(
        isPlainRecord(value) &&
          ["user", "assistant"].includes(value.role as string),
        "invalid_mcp_result",
        "Prompt message roles must remain user or assistant.",
      );
      const message = value as JsonObject;
      removeMeta(message, "message", { index });
      blocks.push(content(message.content!, index));
      return { role: message.role!, contentIndex: index };
    });
    const model: JsonObject = {
      content: blocks,
      structuredContent: {
        ...(source.description === undefined
          ? {}
          : { description: source.description }),
        messages,
      },
      ...(source.resultType === undefined
        ? {}
        : { resultType: source.resultType }),
    };
    return { model, meta };
  }
  const collection = (
    {
      "tools/list": "tools",
      "resources/list": "resources",
      "resources/templates/list": "resourceTemplates",
      "prompts/list": "prompts",
    } as const
  )[method];
  requireCondition(
    collection && Array.isArray(source[collection]),
    "invalid_mcp_result",
    "The MCP catalog response does not match its method.",
  );
  (source[collection] as JsonValue[]).forEach((value, index) => {
    requireCondition(
      isPlainRecord(value),
      "invalid_mcp_result",
      "An MCP catalog entry must be an object.",
    );
    removeMeta(value as JsonObject, "entry", { collection, index });
  });
  return { model: { content: [], structuredContent: source }, meta };
}
/** Explicit finite protocol positions only; Schema/business `_meta` fields remain data. */
export function projectMcpProtocolResult(
  raw: unknown,
  method: McpMethod = "tools/call",
): JsonObject {
  requireCondition(
    methods.has(method),
    "invalid_mcp_method",
    "The MCP result projection method is unsupported.",
  );
  return frozen(project(raw, method).model);
}
function view(info: McpResultInfo): JsonObject {
  const value = copyMcpJSON(info.model) as JsonObject;
  for (const slot of info.meta) {
    let target: JsonObject | undefined;
    if (slot.target === "result") target = value;
    else if (slot.target === "content")
      target = (value.content as JsonObject[] | undefined)?.[
        slot.index as number
      ];
    else if (slot.target === "resource") {
      target =
        info.kind === "resources"
          ? (value.contents as JsonObject[])[slot.index as number]
          : ((value.content as JsonObject[])[slot.index as number]
              ?.resource as JsonObject);
    } else if (slot.target === "message")
      target = (
        (value.structuredContent as JsonObject)?.messages as JsonObject[]
      )?.[slot.index as number];
    else
      target = (
        (value.structuredContent as JsonObject)?.[
          slot.collection as string
        ] as JsonObject[]
      )?.[slot.index as number];
    if (target)
      Object.defineProperty(target, "_meta", {
        value: slot.meta,
        enumerable: false,
      });
  }
  Object.defineProperties(value, {
    toJSON: { value: () => mcpLogSnapshot(value) },
    [inspect.custom]: { value: () => mcpLogSnapshot(value) },
  });
  issued.set(value, info);
  return frozen(value);
}
export function wrapMcpResult(
  raw: unknown,
  source: McpSourceIdentity,
  method: McpMethod = "tools/call",
): JsonObject {
  requireCondition(
    methods.has(method),
    "invalid_mcp_method",
    "The MCP result method is unsupported.",
  );
  const known = mcpResult(raw);
  if (known) {
    requireCondition(
      known.kind === "tool" &&
        known.method === method &&
        canonicalJson(known.source, 16384) ===
          canonicalJson(mcpSource(source), 16384),
      "mcp_source_mismatch",
      "A branded protocol result cannot be rebound to a different connection or method.",
    );
    return rebuildMcpResult(raw, known.model);
  }
  const projected = project(raw, method);
  return view(
    Object.freeze({
      kind: "tool",
      method,
      source: mcpSource(source),
      model: frozen(projected.model),
      meta: frozen(projected.meta),
    }),
  );
}
export function wrapMcpResourceResult(
  raw: unknown,
  source: McpSourceIdentity,
): JsonObject {
  const known = mcpResult(raw);
  if (known) {
    requireCondition(
      known.kind === "resources" &&
        canonicalJson(known.source, 16384) ===
          canonicalJson(mcpSource(source), 16384),
      "mcp_source_mismatch",
      "A branded resource result cannot be rebound to a different connection.",
    );
    return rebuildMcpResult(raw, known.model);
  }
  const projected = project(raw, "resources/read");
  return view(
    Object.freeze({
      kind: "resources",
      method: "resources/read",
      source: mcpSource(source),
      model: frozen(projected.model),
      meta: frozen(projected.meta),
    }),
  );
}
export function mcpResult(value: unknown): McpResultInfo | null {
  return value && typeof value === "object"
    ? (issued.get(value) ?? null)
    : null;
}
function same(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const a = Object.keys(left),
    b = Object.keys(right);
  return (
    a.length === b.length &&
    a.every(
      (key) =>
        Object.hasOwn(right, key) &&
        same((left as JsonObject)[key]!, (right as JsonObject)[key]!),
    )
  );
}
export function rebuildMcpResult(
  original: unknown,
  copiedModel: unknown,
): JsonObject {
  const known = mcpResult(original);
  requireCondition(
    known,
    "invalid_mcp_result",
    "Only an issued MCP result can retain its source brand.",
  );
  const model = copyMcpJSON(copiedModel) as JsonObject;
  requireCondition(
    same(known.model, model),
    "invalid_mcp_result",
    "An MCP result cannot be rebound to different protocol data.",
  );
  return view(Object.freeze({ ...known, model: frozen(model) }));
}
export function mcpLogSnapshot(value: unknown): JsonObject | null {
  const known = mcpResult(value);
  if (!known) return null;
  const content =
    known.kind === "tool" ? (known.model.content as JsonObject[]) : [];
  return {
    mcp: {
      connection: known.source.connection,
      method: known.method,
      revision: known.source.origin.revision,
    },
    contentTypes:
      known.kind === "tool"
        ? [...new Set(content.map((item) => item.type!))]
        : ["resource"],
    contentCount:
      known.kind === "tool"
        ? content.length
        : (known.model.contents as JsonValue[]).length,
    ...(known.model.isError === undefined
      ? {}
      : { isError: known.model.isError }),
    hasStructuredContent: Object.hasOwn(known.model, "structuredContent"),
  };
}

export interface McpResourceLimits {
  readonly textBytes?: number;
  readonly imageBytes?: number;
  readonly audioBytes?: number;
  readonly inlineBytes?: number;
  readonly responseBytes?: number;
  readonly metaBytes?: number;
}
export class McpResultResources {
  readonly agentId: string;
  readonly profileRoot: string;
  #resolve: McpResourceResolver;
  constructor(options: {
    readonly agentId: string;
    readonly profileRoot: string;
    readonly resolveResource: McpResourceResolver;
  }) {
    requireCondition(
      text(options.agentId, 256) &&
        typeof options.profileRoot === "string" &&
        path.isAbsolute(options.profileRoot) &&
        typeof options.resolveResource === "function",
      "invalid_mcp_source",
      "MCP resource routing requires this actual Agent/profile resolver.",
    );
    this.agentId = options.agentId;
    this.profileRoot = path.resolve(options.profileRoot);
    this.#resolve = options.resolveResource;
  }
  uri(value: McpSourceIdentity, originalUri: string): string {
    const source = this.#source(value);
    absoluteUri(originalUri);
    const { profileRoot: _root, agentId: _agent, ...identity } = source;
    return `nexum://agents/${encodeURIComponent(this.agentId)}/mcp/${Buffer.from(canonicalJson(identity, 16384)).toString("base64url")}/resources/${Buffer.from(originalUri).toString("base64url")}`;
  }
  #source(value: McpSourceIdentity): McpSourceIdentity {
    const source = mcpSource(value);
    requireCondition(
      source.agentId === this.agentId &&
        source.profileRoot === this.profileRoot,
      "mcp_profile_mismatch",
      "The remote source belongs to another Agent/profile.",
    );
    return source;
  }
  #route(uri: string): { source: McpSourceIdentity; uri: string } {
    requireCondition(
      typeof uri === "string" && uri.length <= 131072,
      "invalid_mcp_uri",
      "The MCP proxy resource URI exceeds its budget.",
    );
    const match =
      /^nexum:\/\/agents\/([^/]+)\/mcp\/([A-Za-z0-9_-]+)\/resources\/([A-Za-z0-9_-]+)$/.exec(
        uri,
      );
    requireCondition(
      match,
      "invalid_mcp_uri",
      "The resource URI does not identify an MCP connection resource.",
    );
    try {
      requireCondition(
        decodeURIComponent(match[1]!) === this.agentId &&
          match[2]!.length <= 24000,
        "mcp_profile_mismatch",
        "The MCP resource targets another Agent or invalid source.",
      );
      const payload = Buffer.from(match[2]!, "base64url"),
        raw = Buffer.from(match[3]!, "base64url");
      requireCondition(
        payload.toString("base64url") === match[2] &&
          raw.toString("base64url") === match[3],
        "invalid_mcp_uri",
        "The resource route is not canonically encoded.",
      );
      const source = this.#source({
        ...JSON.parse(payload.toString("utf8")),
        agentId: this.agentId,
        profileRoot: this.profileRoot,
      });
      const originalUri = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      absoluteUri(originalUri);
      return { source, uri: originalUri };
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw new AgentError(
        "invalid_mcp_uri",
        "The MCP resource route is invalid.",
      );
    }
  }
  authority(scope: McpResultScope, source: McpSourceIdentity): McpReadScope {
    source = this.#source(source);
    requireCondition(
      text(scope.ownerKey, 256) &&
        text(scope.grantId, 256) &&
        typeof scope.authorizeTarget === "function",
      "mcp_authorization_unavailable",
      "Current verified Grant and connection authorization are required.",
    );
    return {
      ownerKey: scope.ownerKey,
      grantId: scope.grantId,
      signal: scope.signal,
      assertCurrent: () => {
        authorizeCall(() => scope.assertCurrent());
        scope.signal?.throwIfAborted();
      },
      authorizeConnection: (connection, uri, access = "resources.read") => {
        authorizeCall(() => scope.assertCurrent());
        scope.signal?.throwIfAborted();
        requireCondition(
          connection === source.connection,
          "mcp_source_mismatch",
          "The connection cannot be rebound during resource access.",
        );
        authorizeCall(() =>
          scope.authorizeTarget!({
            type: "connection",
            value: connection,
            access,
          }),
        );
        if (uri !== undefined) {
          absoluteUri(uri);
          authorizeCall(() =>
            scope.authorizeTarget!({
              type: "resource",
              value: uri,
              access: "read",
            }),
          );
        }
      },
    };
  }
  async resolve(
    value: McpSourceIdentity,
    scope: McpResultScope,
    access: McpAccess = "result",
    uri?: string,
  ): Promise<{ reader: McpResolvedReader; authority: McpReadScope }> {
    const source = this.#source(value),
      authority = this.authority(scope, source);
    authority.assertCurrent();
    authority.authorizeConnection(source.connection, uri, access);
    const reader = await this.#resolve(source, authority);
    requireCondition(
      reader &&
        reader.connection === source.connection &&
        typeof reader.assertCurrent === "function" &&
        typeof reader.readResource === "function",
      "mcp_source_unavailable",
      "The original registered MCP resource reader is unavailable.",
    );
    authorizeCall(() => reader.assertCurrent());
    authority.assertCurrent();
    authority.authorizeConnection(source.connection, uri, access);
    return { reader, authority };
  }
  async readResource(
    uri: string,
    scope: McpResultScope,
    limits: McpResourceLimits = {},
  ): Promise<JsonObject> {
    const routed = this.#route(uri),
      { reader, authority } = await this.resolve(
        routed.source,
        scope,
        "resources.read",
        routed.uri,
      );
    const raw = await reader.readResource(routed.uri, authority);
    const wrapped = wrapMcpResourceResult(raw, routed.source),
      info = mcpResult(wrapped)!;
    const maxText = limits.textBytes ?? 65536,
      maxInline = limits.inlineBytes ?? 64 * 1024 * 1024,
      maximum = limits.responseBytes ?? maximumProtocolBytes;
    let textBytes = 0,
      binaryBytes = 0;
    const contents = (info.model.contents as JsonObject[]).map((item) => {
      const value: JsonObject = {
        ...item,
        uri: this.uri(routed.source, item.uri as string),
      };
      if (typeof value.text === "string")
        textBytes += boundedSize(
          value.text,
          maxText,
          "resource_read_too_large",
        );
      else {
        const blob = value.blob as string;
        const length = base64Size(blob);
        const mime =
          typeof value.mimeType === "string"
            ? new MIMEType(value.mimeType).essence
            : "application/octet-stream";
        const cap = mime.startsWith("image/")
          ? (limits.imageBytes ?? 10 * 1024 * 1024)
          : mime.startsWith("audio/")
            ? (limits.audioBytes ?? 32 * 1024 * 1024)
            : maxInline;
        requireCondition(
          length <= cap,
          "resource_read_too_large",
          "Remote resource bytes exceed this response budget; explicitly materialize a download if needed.",
        );
        binaryBytes += length;
      }
      return value;
    });
    requireCondition(
      textBytes <= maxText && binaryBytes <= maxInline,
      "resource_read_too_large",
      "Remote resource contents exceed the aggregate read budget.",
    );
    const response: JsonObject = { ...info.model, contents };
    boundedSize(
      {
        contents: contents.map((item) =>
          typeof item.blob === "string" ? { ...item, blob: "" } : item,
        ),
      },
      maxText,
      "resource_read_too_large",
    );
    // This endpoint returns a complete standard ReadResourceResult to the
    // actual Host. Reattach only the finite resource protocol positions that
    // the model projection separated from ordinary business data.
    for (const slot of info.meta) {
      if (slot.target === "resource" && Number.isSafeInteger(slot.index)) {
        const item = contents[Number(slot.index)];
        if (item)
          item._meta = copyMcpJSON(
            slot.meta,
            limits.metaBytes ?? 16 * 1024 * 1024,
          );
      }
    }
    applyProtocolMeta(
      response,
      info.meta,
      limits.metaBytes ?? 16 * 1024 * 1024,
    );
    requireCondition(
      boundedSize(response, maximum, "mcp_response_too_large") <= maximum,
      "mcp_response_too_large",
      "The remote resource response exceeds its final encoded budget.",
    );
    await this.resolve(routed.source, scope, "resources.read", routed.uri);
    return response;
  }
  async listResources(
    source: McpSourceIdentity,
    scope: McpResultScope,
    cursor?: string,
    limits: McpResourceLimits = {},
  ): Promise<JsonObject> {
    const { reader, authority } = await this.resolve(
      source,
      scope,
      "resources.list",
    );
    requireCondition(
      reader.listResources,
      "mcp_capability_unavailable",
      "This MCP connection does not expose resource discovery.",
    );
    const raw = await reader.listResources(authority, cursor),
      projected = project(raw, "resources/list"),
      data = projected.model.structuredContent as JsonObject;
    const resources = (data.resources as JsonObject[]).map((item) => ({
      ...item,
      uri: this.uri(source, item.uri as string),
    }));
    const result: JsonObject = { ...data, resources };
    requireCondition(
      boundedSize(
        result,
        limits.textBytes ?? 65536,
        "resource_list_too_large",
      ) <= (limits.textBytes ?? 65536),
      "resource_list_too_large",
      "The remote resource directory exceeds its metadata budget.",
    );
    applyProtocolMeta(
      result,
      projected.meta,
      limits.metaBytes ?? 16 * 1024 * 1024,
    );
    boundedSize(
      result,
      limits.responseBytes ?? maximumProtocolBytes,
      "mcp_response_too_large",
    );
    await this.resolve(source, scope, "resources.list");
    return result;
  }
}
export function jsonSize(value: unknown, maximum: number): number {
  const copied = copyMcpJSON(value, maximum);
  // Copy's exact accounting has already bounded this serialization.
  return Buffer.byteLength(JSON.stringify(copied));
}
export function mcpMetaSize(value: unknown, maximum: number): number {
  return boundedSize(value, maximum, "mcp_meta_too_large");
}
function boundedSize(value: unknown, maximum: number, code: string): number {
  try {
    return jsonSize(value, maximum);
  } catch (cause) {
    if (cause instanceof AgentError && cause.code === "mcp_result_too_large")
      throw new AgentError(
        code,
        "The remote resource metadata or body exceeds its encoded budget.",
      );
    throw cause;
  }
}
export function base64Size(value: string): number {
  requireCondition(
    value.length % 4 === 0,
    "invalid_media_encoding",
    "Remote resource binary text must be canonical base64.",
  );
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index++)
    requireCondition(
      alphabet.includes(value[index]!),
      "invalid_media_encoding",
      "Remote resource binary text contains invalid base64.",
    );
  const last = padding
    ? alphabet.indexOf(value[value.length - padding - 1] ?? "")
    : 0;
  requireCondition(
    !padding || (last >= 0 && last % (padding === 2 ? 16 : 4) === 0),
    "invalid_media_encoding",
    "Remote resource base64 has invalid padding bits.",
  );
  return (value.length / 4) * 3 - padding;
}
export function applyProtocolMeta(
  target: JsonObject,
  meta: readonly McpProtocolMeta[],
  maximum: number,
): void {
  if (!meta.length) return;
  mcpMetaSize(meta, maximum);
  const root = meta.find((slot) => slot.target === "result")?.meta;
  const hostMeta: JsonObject = { ...(root ?? {}) };
  let key = "io.nexum/mcp",
    suffix = 0;
  while (Object.hasOwn(hostMeta, key)) key = `io.nexum/mcp/${++suffix}`;
  hostMeta[key] = { protocolMeta: meta as unknown as JsonValue };
  target._meta = hostMeta;
  mcpMetaSize(hostMeta, maximum);
}
