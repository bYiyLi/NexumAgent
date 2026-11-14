import path from "node:path";
import { types, MIMEType } from "node:util";
import { Blob } from "node:buffer";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import { compileMethodSchema } from "../contracts/validation.js";

// Intents are in-process values, not an authority supplied by an object's keys
// or prototype. Copying a descriptor cannot turn ordinary business data into media.
const intents = new WeakSet<object>();
const sourceFields = new Set(["path", "data", "uri", "mimeType", "name"]);
const optionFields = new Set([
  "name",
  "description",
  "mimeType",
  "annotations",
]);
const resultFields = new Set(["content", "structuredContent", "isError"]);
const errorFields = new Set(["content", "structuredContent"]);
const annotationFields = new Set(["audience", "priority", "lastModified"]);
const contentKinds = new Set([
  "text",
  "image",
  "audio",
  "resource_link",
  "resource",
]);
const collectionLimit = 100000;
const depthLimit = 64;
export interface OutputSource {
  path?: string;
  uri?: string;
  data?: ArrayBufferView | ArrayBuffer | SharedArrayBuffer | Blob;
  mimeType?: string;
  name?: string;
}
export interface OutputOptions {
  name?: string;
  description?: string;
  mimeType?: string;
  annotations?: {
    audience?: ("user" | "assistant")[];
    priority?: number;
    lastModified?: string;
  };
}
export interface OutputIntent {
  readonly kind:
    | "text"
    | "json"
    | "image"
    | "audio"
    | "resource_link"
    | "resource"
    | "collection"
    | "result";
  readonly value: unknown;
  readonly options: Readonly<OutputOptions>;
}
export interface OutputResult {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}
export interface OutputAPI {
  text(value: string, options?: OutputOptions): OutputIntent;
  json(value: unknown): OutputIntent;
  image(source: string | OutputSource, options?: OutputOptions): OutputIntent;
  images(
    sources: readonly (string | OutputSource)[],
    options?: OutputOptions,
  ): OutputIntent;
  audio(source: string | OutputSource, options?: OutputOptions): OutputIntent;
  resourceLink(
    source: string | OutputSource,
    options?: OutputOptions,
  ): OutputIntent;
  file(source: string | OutputSource, options?: OutputOptions): OutputIntent;
  embeddedResource(
    source: string | OutputSource,
    options?: OutputOptions,
  ): OutputIntent;
  resource(
    source: string | OutputSource,
    options?: OutputOptions,
  ): OutputIntent;
  result(value: OutputResult): OutputIntent;
  error(
    message: string,
    options?: { content?: readonly unknown[]; structuredContent?: unknown },
  ): OutputIntent;
}
const validateOptions = compileMethodSchema({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 1024 },
    description: { type: "string", maxLength: 4096 },
    mimeType: { type: "string", minLength: 1, maxLength: 256 },
    annotations: {
      type: "object",
      additionalProperties: false,
      properties: {
        audience: {
          type: "array",
          uniqueItems: true,
          items: { enum: ["user", "assistant"] },
        },
        priority: { type: "number", minimum: 0, maximum: 1 },
        lastModified: { type: "string", format: "date-time" },
      },
    },
  },
});
export function outputIntent(value: unknown): OutputIntent | null {
  return value && typeof value === "object" && intents.has(value)
    ? (value as OutputIntent)
    : null;
}

function record(
  value: unknown,
  fields: ReadonlySet<string> | null,
  code: string,
): Record<string, unknown> {
  requireCondition(
    isPlainRecord(value),
    code,
    "Output arguments must be ordinary data objects.",
  );
  const result = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  requireCondition(
    keys.length <= collectionLimit,
    "data_too_large",
    "Output control data exceeds its property budget.",
  );
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable) {
      requireCondition(
        typeof key !== "string" || !fields?.has(key),
        code,
        "Output fields must be enumerable data properties.",
      );
      continue;
    }
    requireCondition(
      typeof key === "string" &&
        (!fields || fields.has(key)) &&
        "value" in descriptor,
      code,
      "Output fields cannot be unknown properties, symbols or accessors.",
    );
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function arrayItems(
  value: unknown,
  code: string,
  remaining = collectionLimit,
): unknown[] {
  requireCondition(
    !types.isProxy(value) && Array.isArray(value),
    code,
    "Output collections must be ordinary arrays.",
  );
  requireCondition(
    value.length <= remaining,
    "data_too_large",
    "Output collection exceeds its item budget.",
  );
  requireCondition(
    !Object.getOwnPropertySymbols(value).some(
      (key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable,
    ),
    code,
    "Output collections cannot have enumerable symbol fields.",
  );
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    requireCondition(
      item && "value" in item,
      code,
      "Output collections cannot contain holes or accessors.",
    );
    result.push(item.value);
  }
  return result;
}

function mime(value: unknown): string {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\0\r\n]/.test(value),
    "invalid_output_mime_type",
    "An output MIME type must be bounded media-type text.",
  );
  try {
    return new MIMEType(value).toString();
  } catch (cause) {
    throw new AgentError(
      "invalid_output_mime_type",
      "The output MIME type is invalid.",
      undefined,
      { cause },
    );
  }
}

function uri(value: unknown): string {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= 65536 &&
      !/[\0\r\n]/.test(value),
    "invalid_output_source",
    "A resource reference must have a bounded absolute URI.",
  );
  try {
    new URL(value);
  } catch (cause) {
    throw new AgentError(
      "invalid_output_source",
      "The resource reference is not an absolute URI.",
      undefined,
      { cause },
    );
  }
  return value;
}

function binary(value: unknown): boolean {
  if (types.isProxy(value)) return false;
  if (types.isArrayBufferView(value) || types.isAnyArrayBuffer(value))
    return true;
  // Avoid user-defined instanceof/Symbol.hasInstance and proxy prototype hooks.
  let prototype =
    value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  for (let depth = 0; prototype && depth < depthLimit; depth++) {
    if (types.isProxy(prototype)) return false;
    if (prototype === Blob.prototype) return true;
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

function normalizeOptions(value: unknown): Readonly<OutputOptions> {
  const data = record(value, optionFields, "invalid_output");
  if (Object.hasOwn(data, "annotations")) {
    const annotations = record(
      data.annotations,
      annotationFields,
      "invalid_output",
    );
    if (Object.hasOwn(annotations, "audience"))
      annotations.audience = arrayItems(annotations.audience, "invalid_output");
    data.annotations = annotations;
  }
  const copy = JSON.parse(canonicalJson(data, 16384)) as OutputOptions;
  validateOptions(copy);
  if (Object.hasOwn(copy, "mimeType")) copy.mimeType = mime(copy.mimeType);
  if (copy.annotations?.audience) Object.freeze(copy.annotations.audience);
  if (copy.annotations) Object.freeze(copy.annotations);
  return Object.freeze(copy);
}
export function createOutput(pwd: string, current: () => void): OutputAPI {
  requireCondition(
    typeof pwd === "string" && path.isAbsolute(pwd),
    "invalid_output_context",
    "Output sources need the current run's absolute working directory.",
  );
  function intent(
    kind: OutputIntent["kind"],
    value: unknown,
    options: OutputOptions = {},
  ): OutputIntent {
    current();
    const result = { kind, value, options: normalizeOptions(options) };
    intents.add(result);
    return Object.freeze(result);
  }
  function source(input: string | OutputSource): Readonly<OutputSource> {
    current();
    const data = record(
      typeof input === "string" ? { path: input } : input,
      sourceFields,
      "invalid_output_source",
    );
    requireCondition(
      ["path", "data", "uri"].filter((key) => Object.hasOwn(data, key))
        .length === 1,
      "invalid_output_source",
      "Output needs exactly one local path, binary source, or registered resource URI.",
    );
    const result: OutputSource = {};
    for (const key of Object.keys(data)) {
      Object.defineProperty(result, key, {
        value: data[key],
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    if (Object.hasOwn(result, "path")) {
      requireCondition(
        typeof result.path === "string" &&
          result.path.length > 0 &&
          !result.path.includes("\0") &&
          Buffer.byteLength(result.path) <= 262144,
        "invalid_output_source",
        "A local output path must be a nonempty path.",
      );
      result.path = path.resolve(pwd, result.path);
    }
    if (Object.hasOwn(result, "uri")) result.uri = uri(result.uri);
    if (Object.hasOwn(result, "data"))
      requireCondition(
        binary(result.data),
        "invalid_output_source",
        "Binary output must be an actual byte view, ArrayBuffer or Blob source.",
      );
    if (Object.hasOwn(result, "mimeType"))
      result.mimeType = mime(result.mimeType);
    requireCondition(
      !Object.hasOwn(result, "name") ||
        (typeof result.name === "string" &&
          result.name.length > 0 &&
          result.name.length <= 1024),
      "invalid_output_source",
      "An output resource name must be bounded text.",
    );
    return Object.freeze(result);
  }
  const resourceLink = (
    value: string | OutputSource,
    options?: OutputOptions,
  ) => intent("resource_link", source(value), options);
  const embeddedResource = (
    value: string | OutputSource,
    options?: OutputOptions,
  ) => intent("resource", source(value), options);
  function content(values: unknown): readonly unknown[] {
    requireCondition(
      !types.isProxy(values) && Array.isArray(values),
      "invalid_output",
      "A result content field must be an array.",
    );
    const result: unknown[] = [],
      ancestors = new Set<object>();
    let nodes = 0;
    const append = (value: unknown, depth: number): void => {
      requireCondition(
        ++nodes <= collectionLimit && depth <= depthLimit,
        "data_too_large",
        "Output content exceeds its depth or item budget.",
      );
      const known = outputIntent(value);
      const collection = known?.kind === "collection" ? known.value : value;
      if (!types.isProxy(collection) && Array.isArray(collection)) {
        requireCondition(
          !ancestors.has(collection),
          "invalid_output",
          "Output content collections cannot be circular.",
        );
        ancestors.add(collection);
        for (const item of arrayItems(
          collection,
          "invalid_output",
          collectionLimit - nodes,
        ))
          append(item, depth + 1);
        ancestors.delete(collection);
        return;
      }
      if (known) {
        requireCondition(
          contentKinds.has(known.kind),
          "invalid_output",
          "JSON data and nested results belong outside explicit content blocks.",
        );
        result.push(known);
        return;
      }
      const block = record(value, null, "invalid_output");
      requireCondition(
        typeof block.type === "string" && contentKinds.has(block.type),
        "invalid_output",
        "Explicit content must contain supported text, media or resource blocks.",
      );
      if (block.type === "text")
        requireCondition(
          typeof block.text === "string" &&
            !["path", "data", "uri", "resource"].some((key) =>
              Object.hasOwn(block, key),
            ),
          "invalid_output",
          "Text content needs a text field.",
        );
      else if (block.type === "resource_link") {
        requireCondition(
          !["path", "data", "resource"].some((key) =>
            Object.hasOwn(block, key),
          ),
          "invalid_output_source",
          "A resource link cannot contain competing local sources.",
        );
        block.uri = uri(block.uri);
        requireCondition(
          typeof block.name === "string" && block.name.length > 0,
          "invalid_output",
          "A resource link needs a name.",
        );
      } else if (
        block.type === "resource" &&
        Object.hasOwn(block, "resource")
      ) {
        requireCondition(
          !["path", "data", "uri"].some((key) => Object.hasOwn(block, key)),
          "invalid_output_source",
          "An embedded resource cannot contain competing local sources.",
        );
        const resource = record(block.resource, null, "invalid_output");
        resource.uri = uri(resource.uri);
        requireCondition(
          Number(Object.hasOwn(resource, "text")) +
            Number(Object.hasOwn(resource, "blob")) ===
            1 &&
            (Object.hasOwn(resource, "text")
              ? typeof resource.text === "string"
              : typeof resource.blob === "string" || binary(resource.blob)),
          "invalid_output",
          "An embedded resource needs exactly one text or binary body.",
        );
        if (Object.hasOwn(resource, "mimeType"))
          resource.mimeType = mime(resource.mimeType);
        block.resource = Object.freeze(resource);
      } else {
        const locators = ["path", "data", "uri"].filter((key) =>
          Object.hasOwn(block, key),
        );
        requireCondition(
          locators.length === 1,
          "invalid_output_source",
          "Media content needs exactly one source.",
        );
        if (locators[0] === "data") {
          requireCondition(
            typeof block.data === "string" || binary(block.data),
            "invalid_output_source",
            "Media content needs bytes or an encoded data string.",
          );
          if (typeof block.data === "string")
            requireCondition(
              Object.hasOwn(block, "mimeType"),
              "invalid_output",
              "Encoded media needs its MIME type.",
            );
        } else if (locators[0] === "path") {
          requireCondition(
            typeof block.path === "string" &&
              block.path.length > 0 &&
              !block.path.includes("\0") &&
              Buffer.byteLength(block.path) <= 262144,
            "invalid_output_source",
            "A media path must be nonempty text.",
          );
          block.path = path.resolve(pwd, block.path);
        } else block.uri = uri(block.uri);
      }
      const options: Record<string, unknown> = Object.create(null);
      for (const key of optionFields)
        if (Object.hasOwn(block, key)) options[key] = block[key];
      Object.assign(block, normalizeOptions(options));
      result.push(Object.freeze(block));
    };
    append(values, 0);
    return Object.freeze(result);
  }
  const api: OutputAPI = {
    text(value, options) {
      requireCondition(
        typeof value === "string",
        "invalid_output",
        "Text output needs a string.",
      );
      return intent("text", value, options);
    },
    json(value) {
      return intent("json", value);
    },
    image(value, options) {
      return intent("image", source(value), options);
    },
    images(values, options) {
      current();
      const items = arrayItems(values, "invalid_output");
      return intent(
        "collection",
        Object.freeze(
          items.map((value) =>
            api.image(value as string | OutputSource, options),
          ),
        ),
      );
    },
    audio(value, options) {
      return intent("audio", source(value), options);
    },
    resourceLink,
    file: resourceLink,
    embeddedResource,
    resource: embeddedResource,
    result(value) {
      current();
      const data = record(value, resultFields, "invalid_output");
      requireCondition(
        Object.hasOwn(data, "content") &&
          (!Object.hasOwn(data, "isError") ||
            typeof data.isError === "boolean"),
        "invalid_output",
        "A result needs explicit content and valid result fields.",
      );
      return intent(
        "result",
        Object.freeze({ ...data, content: content(data.content) }),
      );
    },
    error(message, options = {}) {
      current();
      requireCondition(
        typeof message === "string" && message.trim().length > 0,
        "invalid_output",
        "A business error needs readable text feedback.",
      );
      const data = record(options, errorFields, "invalid_output");
      return api.result({
        content: [
          api.text(message),
          ...(Object.hasOwn(data, "content")
            ? arrayItems(data.content, "invalid_output")
            : []),
        ],
        ...(Object.hasOwn(data, "structuredContent")
          ? { structuredContent: data.structuredContent }
          : {}),
        isError: true,
      });
    },
  };
  return Object.freeze(api);
}
