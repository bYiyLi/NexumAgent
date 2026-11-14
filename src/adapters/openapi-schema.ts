import SwaggerParser from "@apidevtools/swagger-parser";
import Draft4Module from "ajv-draft-04";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { parseDocument } from "yaml";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { types } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { ApprovedOpenApi } from "./openapi-types.js";
import { snapshotBlob } from "../results/artifacts.js";

export interface OpenApiLimits {
  documentBytes: number;
  totalDocumentBytes: number;
  referenceCount: number;
  operationCount: number;
  requestBytes: number;
  responseBytes: number;
  requestTimeoutMs: number;
}
export const openApiLimits = (
  input: ApprovedOpenApi["limits"],
): OpenApiLimits => {
  const defaults = {
    documentBytes: 8 * 1024 * 1024,
    totalDocumentBytes: 32 * 1024 * 1024,
    referenceCount: 128,
    operationCount: 1000,
    requestBytes: 64 * 1024 * 1024,
    responseBytes: 64 * 1024 * 1024,
    requestTimeoutMs: 30000,
  };
  const result = { ...defaults, ...input };
  requireCondition(
    Object.keys(result).every((key) => Object.hasOwn(defaults, key)) &&
      Object.values(result).every(
        (value) =>
          Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647,
      ),
    "api_invalid_limits",
    "OpenAPI limits must be bounded positive integers.",
  );
  return result;
};
type RecordValue = Record<string, any>;
const object = (value: unknown): value is RecordValue => isPlainRecord(value);
const clone = <T>(value: T, limit = 32 * 1024 * 1024): T =>
  JSON.parse(canonicalJson(value, limit)) as T;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const emptySchema = (value: unknown) =>
  value === undefined ||
  value === true ||
  (object(value) && Object.keys(value).length === 0);
const schemaKeywords = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
];
const singleKeywords = [
  "items",
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
];
const arrayKeywords = ["allOf", "anyOf", "oneOf", "prefixItems"];
const baseDialect = "https://spec.openapis.org/oas/3.1/dialect/base";
const jsonDialect = "https://json-schema.org/draft/2020-12/schema";
const typedSize = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
const dataViewSize = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteLength",
)!.get!;
const bufferSize = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
const binaryKeyword = "nexumNativeBinary";
function nativeSize(value: unknown, limit: number): number | null {
  const blob = snapshotBlob(value, limit);
  if (blob) return blob.size;
  if (types.isSharedArrayBuffer(value)) return null;
  if (types.isAnyArrayBuffer(value) || types.isArrayBufferView(value))
    return Reflect.apply(
      types.isDataView(value)
        ? dataViewSize
        : types.isArrayBufferView(value)
          ? typedSize
          : bufferSize,
      value,
      [],
    ) as number;
  return null;
}

function location(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AgentError(
      "api_invalid_document",
      "Each fixed OpenAPI document needs an absolute source URI.",
    );
  }
  requireCondition(
    ["https:", "http:", "file:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash,
    "api_invalid_document",
    "Document bases must be credential-free HTTP(S) or file URIs without fragments.",
  );
  return url.href;
}
function parse(bytes: Buffer, limit: number): RecordValue {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = parseDocument(source, {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
      strict: true,
    });
    requireCondition(
      !parsed.errors.length && !parsed.warnings.length,
      "api_invalid_document",
      "The API source is not valid JSON or supported YAML.",
    );
    const value = parsed.toJS({ maxAliasCount: 100 });
    requireCondition(
      object(value),
      "api_invalid_document",
      "An API description must be an object.",
    );
    return clone(value, limit);
  } catch (cause) {
    throw new AgentError(
      "api_invalid_document",
      "The API source could not be parsed as bounded JSON/YAML.",
      undefined,
      { cause },
    );
  }
}

/** No source I/O is performed: all references come from the already approved byte bundle. */
export async function parseOpenApi(
  input: ApprovedOpenApi,
  limits: OpenApiLimits,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const documents = [input.document, ...(input.references ?? [])];
  requireCondition(
    documents.length <= limits.referenceCount + 1,
    "api_document_too_large",
    "The fixed API reference bundle exceeds its document count.",
  );
  const sources = new Map<string, RecordValue>();
  let total = 0;
  const hashes: [string, string][] = [];
  for (const document of documents) {
    signal?.throwIfAborted();
    const size =
      typeof document.bytes === "string"
        ? Buffer.byteLength(document.bytes)
        : document.bytes.byteLength;
    requireCondition(
      Number.isSafeInteger(size) &&
        size <= limits.documentBytes &&
        total + size <= limits.totalDocumentBytes,
      "api_document_too_large",
      "An OpenAPI source exceeds its fixed document budget.",
    );
    const bytes =
      typeof document.bytes === "string"
        ? Buffer.from(document.bytes)
        : Buffer.from(document.bytes);
    total += bytes.length;
    const key = location(document.location);
    requireCondition(
      !sources.has(key),
      "api_duplicate_reference",
      "Two fixed API documents cannot share a source URI.",
    );
    sources.set(key, parse(bytes, limits.totalDocumentBytes));
    hashes.push([key, digest(bytes)]);
  }
  const base = location(input.document.location),
    root = sources.get(base)!;
  const sourceVersion = root.swagger ?? root.openapi;
  requireCondition(
    sourceVersion === "2.0" ||
      (typeof sourceVersion === "string" &&
        /^3\.(?:0\.[0-4]|1\.[0-2])$/.test(sourceVersion)),
    "api_unsupported_version",
    "Supported API versions are Swagger 2.0, OpenAPI 3.0.0–3.0.4 and 3.1.0–3.1.2.",
  );
  requireCondition(
    !root.jsonSchemaDialect ||
      [baseDialect, jsonDialect].includes(root.jsonSchemaDialect),
    "api_unsupported_schema_dialect",
    "The API declares an unsupported JSON Schema dialect.",
  );
  const options = {
    resolve: {
      file: false as const,
      http: false as const,
      fixed: {
        order: 1,
        canRead: () => true,
        read: (file: { url: string }) => {
          signal?.throwIfAborted();
          const key = new URL(file.url);
          key.hash = "";
          const value = sources.get(key.href);
          requireCondition(
            value,
            "api_reference_unavailable",
            "An API reference is not in its approved fixed byte bundle.",
          );
          return canonicalJson(value, limits.totalDocumentBytes);
        },
      },
    },
    parse: {
      // Every resolver result is our verified canonical JSON, including .yaml bases.
      json: { canParse: () => true },
      yaml: false as const,
      text: false as const,
      binary: false as const,
    },
    dereference: { circular: "ignore" as const },
  };
  let document: RecordValue;
  try {
    // Validation and bundling use separate copies because the mature resolver may mutate its input.
    await new SwaggerParser().validate(base, clone(root) as any, options);
    signal?.throwIfAborted();
    document = clone(
      await new SwaggerParser().bundle(base, clone(root) as any, options),
      limits.totalDocumentBytes,
    ) as RecordValue;
  } catch (cause) {
    signal?.throwIfAborted();
    throw new AgentError(
      "api_invalid_specification",
      "The API specification or its fixed references failed standard validation.",
      undefined,
      { cause },
    );
  }
  signal?.throwIfAborted();
  const modern = sourceVersion.startsWith("3.1");
  const referenceTarget = (ref: URL): unknown => {
    requireCondition(
      ref.href.startsWith(base + "#/"),
      "api_unsupported_reference",
      "Only fixed bundled JSON Pointer references are supported.",
    );
    let found: unknown = document;
    for (const part of decodeURIComponent(ref.hash.slice(2))
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      requireCondition(
        (object(found) || Array.isArray(found)) && Object.hasOwn(found, part),
        "api_reference_unavailable",
        "An API reference target is unavailable.",
      );
      found = (found as RecordValue)[part];
    }
    return found;
  };
  const resolve = (value: unknown): any => {
    const seen = new Set<string>();
    let current = value;
    while (object(current) && typeof current.$ref === "string") {
      const ref = new URL(current.$ref, base);
      requireCondition(
        ref.href.startsWith(base + "#/") && !seen.has(ref.href),
        "api_unsupported_reference",
        "This reference is not a resolvable local JSON Pointer in the fixed bundle.",
      );
      seen.add(ref.href);
      const found = referenceTarget(ref);
      requireCondition(
        found !== undefined,
        "api_reference_unavailable",
        "An API reference target is unavailable.",
      );
      if (object(found)) {
        const { $ref: _ref, ...siblings } = current;
        current = {
          ...found,
          ...(modern ? siblings : {}),
          ...(current.summary === undefined
            ? {}
            : { summary: current.summary }),
          ...(current.description === undefined
            ? {}
            : { description: current.description }),
        };
      } else current = found;
    }
    return current;
  };
  const validators = new Map<string, (value: unknown) => void>();
  const createBank = (direction: "request" | "response") => {
    const transformed = clone(document, limits.totalDocumentBytes);
    const transform = (value: any, bridge = true): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) transform(item);
        return;
      }
      if (typeof value.$ref === "string")
        value.$ref = new URL(value.$ref, base).href;
      if (
        bridge &&
        (value.type === "file" ||
          (value.format === "binary" &&
            (value.type === undefined ||
              value.type === "string" ||
              (Array.isArray(value.type) && value.type.includes("string")))))
      ) {
        const original = { ...value };
        if (original.type === "file") {
          original.type = "string";
          original.format = "binary";
        }
        transform(original, false);
        for (const key of Object.keys(value)) delete value[key];
        value.anyOf = [
          original,
          {
            [binaryKeyword]: {
              ...(original.minLength === undefined
                ? {}
                : { minimum: original.minLength }),
              ...(original.maxLength === undefined
                ? {}
                : { maximum: original.maxLength }),
            },
          },
        ];
        return;
      }
      if (Array.isArray(value.required) && object(value.properties))
        value.required = value.required.filter((key: string) => {
          const property = resolve(value.properties[key]);
          return (
            !object(property) ||
            property[direction === "request" ? "readOnly" : "writeOnly"] !==
              true
          );
        });
      for (const child of Object.values(value)) transform(child);
    };
    transform(transformed);
    const Draft4 = Draft4Module as unknown as typeof Ajv2020;
    const compiler = modern
      ? new Ajv2020({
          strict: false,
          allErrors: false,
          coerceTypes: false,
          useDefaults: false,
          removeAdditional: false,
          logger: false,
        })
      : new Draft4({
          strict: false,
          allErrors: false,
          coerceTypes: false,
          useDefaults: false,
          removeAdditional: false,
          logger: false,
        });
    formats.default(compiler);
    compiler.addKeyword({
      keyword: binaryKeyword,
      schemaType: "object",
      errors: false,
      validate: (
        constraint: { minimum?: number; maximum?: number },
        value: unknown,
      ) => {
        const size = nativeSize(
          value,
          direction === "request" ? limits.requestBytes : limits.responseBytes,
        );
        return (
          size !== null &&
          (constraint.minimum === undefined || size >= constraint.minimum) &&
          (constraint.maximum === undefined || size <= constraint.maximum)
        );
      },
    });
    for (const format of ["binary", "password"])
      compiler.addFormat(format, true);
    for (const format of ["float", "double"])
      compiler.addFormat(format, { type: "number", validate: Number.isFinite });
    compiler.addFormat("int32", {
      type: "number",
      validate: (value: number) =>
        Number.isInteger(value) && value >= -2147483648 && value <= 2147483647,
    });
    compiler.addFormat("int64", {
      type: "number",
      validate: Number.isSafeInteger,
    });
    compiler.addFormat("byte", {
      type: "string",
      validate: (value: string) =>
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value,
        ),
    });
    if (modern) {
      const meta = createRequire(import.meta.url)(
        "ajv/dist/refs/json-schema-2020-12/schema.json",
      );
      compiler.addMetaSchema({ ...meta, $id: baseDialect });
    }
    compiler.addSchema(transformed, base);
    return { compiler, transform };
  };
  const banks = {
    request: createBank("request"),
    response: createBank("response"),
  };
  const inspectSchema = (
    schema: unknown,
    visited = new Set<unknown>(),
  ): void => {
    if (!object(schema) || visited.has(schema)) return;
    visited.add(schema);
    requireCondition(
      !Object.hasOwn(schema, binaryKeyword),
      "api_unsupported_schema_keyword",
      "The source uses a reserved internal native-bridge keyword.",
    );
    requireCondition(
      !["$id", "$anchor", "$dynamicRef", "$dynamicAnchor"].some((key) =>
        Object.hasOwn(schema, key),
      ),
      "api_unsupported_reference",
      "Schema-local identifiers, anchors and dynamic references are not supported by this adapter matrix.",
    );
    requireCondition(
      schema.$schema === undefined ||
        (modern &&
          [
            jsonDialect,
            baseDialect,
            jsonDialect + "#",
            baseDialect + "#",
          ].includes(schema.$schema)) ||
        (!modern &&
          [
            "http://json-schema.org/draft-04/schema#",
            "http://json-schema.org/draft-04/schema",
          ].includes(schema.$schema)),
      "api_unsupported_schema_dialect",
      "A payload schema declares an unsupported source dialect.",
    );
    requireCondition(
      !modern || schema.nullable === undefined,
      "api_unsupported_schema_keyword",
      "OpenAPI 3.1 nullable must use a JSON Schema null union.",
    );
    if (typeof schema.$ref === "string")
      inspectSchema(resolve(schema), visited);
    for (const key of schemaKeywords)
      if (object(schema[key]))
        for (const child of Object.values(schema[key]))
          inspectSchema(child, visited);
    for (const key of singleKeywords) inspectSchema(schema[key], visited);
    for (const key of arrayKeywords)
      if (Array.isArray(schema[key]))
        for (const child of schema[key]) inspectSchema(child, visited);
  };
  const compile = (schema: unknown, direction: "request" | "response") => {
    inspectSchema(schema);
    const key =
      direction + ":" + canonicalJson(schema ?? {}, limits.totalDocumentBytes);
    const cached = validators.get(key);
    if (cached) return cached;
    let nodes = 0;
    const native = (value: unknown, source: any, depth = 0): unknown => {
      requireCondition(
        ++nodes <= 100000 && depth <= 64,
        "api_arguments_too_large",
        "API payloads exceed their node or nesting budget.",
      );
      const blob = snapshotBlob(
        value,
        direction === "request" ? limits.requestBytes : limits.responseBytes,
      );
      const binary =
        blob || types.isAnyArrayBuffer(value) || types.isArrayBufferView(value);
      if (binary) {
        let cursor = source;
        const visitedReferences = new Set<string>();
        while (object(cursor) && typeof cursor.$ref === "string") {
          requireCondition(
            Object.keys(cursor).every((key) =>
              [
                "$ref",
                "description",
                "summary",
                "title",
                "$comment",
                "$schema",
                "example",
                "examples",
                "default",
                "deprecated",
                "readOnly",
                "writeOnly",
              ].includes(key),
            ),
            "api_unsupported_binary_schema",
            "Native binary references with validation siblings require an explicit supported adapter.",
          );
          const ref = new URL(cursor.$ref, base);
          requireCondition(
            !visitedReferences.has(ref.href),
            "api_unsupported_binary_schema",
            "Native binary reference cycles cannot replace an actual binary schema.",
          );
          visitedReferences.add(ref.href);
          cursor = referenceTarget(ref);
        }
        source = resolve(source);
        requireCondition(
          emptySchema(source) ||
            (object(source) &&
              (source.type === "file" ||
                source.format === "binary" ||
                (source.contentMediaType && emptySchema(source.type)))),
          "api_invalid_binary",
          "Native binary input needs an explicitly declared binary schema.",
        );
        requireCondition(
          ![
            "enum",
            "const",
            "pattern",
            "allOf",
            "oneOf",
            "anyOf",
            "not",
            "if",
          ].some((key) => source[key] !== undefined),
          "api_unsupported_binary_schema",
          "Binary enum, const and pattern constraints cannot be silently converted to text checks.",
        );
        const size = blob
          ? blob.size
          : (Reflect.apply(
              types.isDataView(value)
                ? dataViewSize
                : types.isArrayBufferView(value)
                  ? typedSize
                  : bufferSize,
              value,
              [],
            ) as number);
        requireCondition(
          (source.minLength === undefined || size >= source.minLength) &&
            (source.maxLength === undefined || size <= source.maxLength),
          "api_invalid_arguments",
          "Native binary size does not match its source schema.",
        );
        return value;
      }
      source = resolve(source);
      requireCondition(
        source?.type !== "file",
        "api_invalid_binary",
        "A Swagger file parameter requires native binary input.",
      );
      if (Array.isArray(value)) {
        requireCondition(
          value.length <= 100000 - nodes,
          "api_arguments_too_large",
          "API payload arrays exceed their node budget.",
        );
        return value.map((item) =>
          native(item, source?.items ?? {}, depth + 1),
        );
      }
      if (object(value)) {
        const result: RecordValue = Object.create(null);
        for (const [key, item] of Object.entries(value))
          result[key] = native(
            item,
            source?.properties?.[key] ??
              (object(source?.additionalProperties)
                ? source.additionalProperties
                : {}),
            depth + 1,
          );
        return result;
      }
      return value;
    };
    const model = clone(schema ?? {}, limits.totalDocumentBytes);
    const bank = banks[direction];
    bank.transform(model);
    let validate: ReturnType<Ajv2020["compile"]>;
    try {
      validate = bank.compiler.compile(model);
    } catch (cause) {
      throw new AgentError(
        "api_unsupported_schema",
        "A source payload schema cannot be compiled in its original supported dialect.",
        undefined,
        { cause },
      );
    }
    const check = (value: unknown) => {
      nodes = 0;
      const view = native(value, schema ?? {});
      requireCondition(
        validate(view),
        direction === "request"
          ? "api_invalid_arguments"
          : "api_invalid_response",
        "The API payload does not match its original source schema.",
        {
          errors: (validate.errors ?? []).slice(0, 8).map((error) => ({
            path: error.instancePath,
            keyword: error.keyword,
          })),
        },
      );
    };
    validators.set(key, check);
    return check;
  };
  return {
    document,
    sourceVersion,
    base,
    resolve,
    compile,
    revision:
      "sha256:" +
      digest(
        canonicalJson(
          hashes.sort((a, b) => a[0].localeCompare(b[0])),
          limits.totalDocumentBytes,
        ),
      ),
  };
}
