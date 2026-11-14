import { createRequire } from "node:module";
import { types } from "node:util";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { snapshotBlob, type BlobSnapshot } from "../results/artifacts.js";

const require = createRequire(import.meta.url);
const swagger = require("swagger-client") as {
  buildRequest(options: Record<string, unknown>): Record<string, any>;
};
// Pinned swagger-client serializer: unlike its OAS3 body adapter, this does not
// JSON.parse arbitrary string form fields before serializing them.
const { serializeRequest } =
  require("swagger-client/lib/http/serializers/request/index.js") as {
    serializeRequest(request: Record<string, any>): Record<string, any>;
  };

export interface OpenApiRequestOptions {
  document: Record<string, any>;
  operationId: string;
  method: string;
  path: string;
  serviceUrl: string;
  parameters: readonly Record<string, any>[];
  input: {
    path?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    cookies?: Record<string, unknown>;
    body?: unknown;
    contentType?: string;
    accept?: string;
  };
  maxRequestBytes: number;
}

export interface OpenApiRequest {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
}

export function normalizeOpenApiInput(
  value: unknown,
  maxRequestBytes: number,
): OpenApiRequestOptions["input"] {
  requireCondition(
    Number.isSafeInteger(maxRequestBytes) && maxRequestBytes > 0,
    "api_invalid_budget",
    "The request byte budget must be a positive safe integer.",
  );
  requireCondition(
    value !== null &&
      typeof value === "object" &&
      !types.isProxy(value) &&
      !Array.isArray(value),
    "api_invalid_arguments",
    "API input must be a plain object.",
  );
  const input = snapshot(
    value,
    new Budget(maxRequestBytes),
  ) as OpenApiRequestOptions["input"];
  requireCondition(
    record(input),
    "api_invalid_arguments",
    "API input must be a plain object.",
  );
  for (const key of Object.keys(input))
    requireCondition(
      [
        "path",
        "query",
        "headers",
        "cookies",
        "body",
        "contentType",
        "accept",
      ].includes(key),
      "api_unknown_parameter",
      "An unknown API input group was supplied.",
    );
  return input;
}

class Budget {
  used = 0;
  constructor(readonly limit: number) {}
  add(bytes: number): void {
    requireCondition(
      Number.isSafeInteger(bytes) &&
        bytes >= 0 &&
        bytes <= this.limit - this.used,
      "api_request_too_large",
      "The API request exceeds its byte budget.",
    );
    this.used += bytes;
  }
}

const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, "size")!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteOffset",
)!.get!;
const dataViewLength = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteLength",
)!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "buffer",
)!.get!;
const dataViewOffset = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteOffset",
)!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;

function safeBlob(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): BlobSnapshot | null {
  try {
    return snapshotBlob(value, maximum);
  } catch (cause) {
    throw new AgentError(
      isAgentError(cause) && cause.code === "resource_too_large"
        ? "api_request_too_large"
        : "api_invalid_arguments",
      "The API binary input is not a safe bounded native Blob.",
      undefined,
      { cause },
    );
  }
}

function binarySize(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (!value || typeof value !== "object" || types.isProxy(value)) return;
  if (types.isAnyArrayBuffer(value)) {
    requireCondition(
      !types.isSharedArrayBuffer(value),
      "api_invalid_body",
      "Shared binary buffers are not supported.",
    );
    return bufferLength.call(value) as number;
  }
  if (ArrayBuffer.isView(value)) {
    const view = types.isDataView(value);
    requireCondition(
      !types.isSharedArrayBuffer(
        (view ? dataViewBuffer : typedArrayBuffer).call(value),
      ),
      "api_invalid_body",
      "Shared binary buffers are not supported.",
    );
    return (view ? dataViewLength : typedArrayLength).call(value) as number;
  }
  return safeBlob(value, maximum)?.size;
}

/** Exact JSON string size, without first creating an escaped copy. */
function jsonStringBytes(value: string): number {
  let bytes = Buffer.byteLength(value) + 2;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (
      c === 34 ||
      c === 92 ||
      c === 8 ||
      c === 9 ||
      c === 10 ||
      c === 12 ||
      c === 13
    )
      bytes++;
    else if (c < 32) bytes += 5;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else bytes += 3;
    } else if (c >= 0xdc00 && c <= 0xdfff) bytes += 3;
  }
  return bytes;
}

// Copy only inert public data. No getters, custom toJSON/coercion, Proxy traps,
// or stream reads may run inside a supposedly pure request builder.
function snapshot(
  value: unknown,
  budget: Budget,
  seen = new Set<object>(),
  depth = 0,
): any {
  requireCondition(
    depth <= 64,
    "api_invalid_arguments",
    "The request input is too deeply nested.",
  );
  if (value === null) {
    budget.add(4);
    return null;
  }
  if (typeof value === "string") {
    budget.add(jsonStringBytes(value));
    return value;
  }
  if (typeof value === "boolean") {
    budget.add(value ? 4 : 5);
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    budget.add(String(value).length);
    return value;
  }
  requireCondition(
    value && typeof value === "object" && !types.isProxy(value),
    "api_invalid_arguments",
    "API input must contain inert data or native binary values.",
  );
  const size = binarySize(value, budget.limit - budget.used);
  if (size !== undefined) {
    budget.add(size);
    return value;
  }
  requireCondition(
    !seen.has(value),
    "api_invalid_arguments",
    "Cyclic API input is not supported.",
  );
  const proto = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  requireCondition(
    array ||
      proto === null ||
      (!types.isProxy(proto) && Object.getPrototypeOf(proto) === null),
    "api_invalid_arguments",
    "Streams and custom input objects are not supported.",
  );
  seen.add(value);
  budget.add(2);
  const result: any = array ? [] : Object.create(null);
  if (array) budget.add(value.length);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    requireCondition(
      typeof key === "string",
      "api_invalid_arguments",
      "Symbol input properties are not supported.",
    );
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireCondition(
      "value" in descriptor && descriptor.enumerable && key !== "__proto__",
      "api_invalid_arguments",
      "Input accessors and hidden properties are not supported.",
    );
    if (array)
      requireCondition(
        /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length,
        "api_invalid_arguments",
        "Array input properties are not supported.",
      );
    else budget.add(jsonStringBytes(key) + 2);
    result[key] = snapshot(descriptor.value, budget, seen, depth + 1);
  }
  if (array)
    requireCondition(
      Object.keys(result).length === value.length,
      "api_invalid_arguments",
      "Sparse API arrays are not supported.",
    );
  seen.delete(value);
  return result;
}

function jsonBytes(value: any): number {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringBytes(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return String(value).length;
  requireCondition(
    binarySize(value) === undefined,
    "api_invalid_body",
    "Binary values cannot be encoded as JSON.",
  );
  if (Array.isArray(value))
    return 2 + value.reduce((n, item) => n + jsonBytes(item) + 1, 0);
  return (
    2 +
    Object.entries(value).reduce(
      (n, [key, item]) => n + jsonStringBytes(key) + jsonBytes(item) + 2,
      0,
    )
  );
}

const forbiddenHeaders = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "authorization",
  "proxy-authorization",
  "content-type",
  "accept",
]);
function checkHeader(name: string): void {
  requireCondition(
    !forbiddenHeaders.has(name.toLowerCase()) &&
      !name.toLowerCase().startsWith("proxy-") &&
      !name.startsWith(":"),
    "api_invalid_header",
    "A parameter cannot set a reserved request header.",
  );
}
function media(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}
function isJson(value: string): boolean {
  return (
    value === "application/json" || /^application\/[^/]+\+json$/.test(value)
  );
}
function record(value: any): value is Record<string, any> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    binarySize(value) === undefined
  );
}

function parameterBound(value: any, name: string): number {
  const count =
    value && typeof value === "object" ? Object.keys(value).length : 1;
  // An upper bound for percent encoding plus repeated exploded names. The
  // complete bound is checked before swagger-client allocates encoded strings.
  return 3 * jsonBytes(value) + count * (3 * Buffer.byteLength(name) + 8) + 8;
}
function parameterValue(parameter: Record<string, any>, value: any): void {
  requireCondition(
    value !== null && binarySize(value) === undefined,
    "api_parameter_serialization",
    "Null and binary URL/header parameters require an explicit supported representation.",
  );
  requireCondition(
    parameter.in !== "cookie" || parameter.content || typeof value !== "object",
    "api_parameter_serialization",
    "Style-encoded cookie arrays and objects are not supported without a content representation.",
  );
  if (parameter.content) {
    const types = Object.keys(parameter.content);
    requireCondition(
      types.length === 1 &&
        (isJson(media(types[0]!)) || typeof value === "string"),
      "api_unsupported_media",
      "The parameter content type cannot represent this value.",
    );
  } else if (value && typeof value === "object") {
    const children = Array.isArray(value) ? value : Object.values(value);
    requireCondition(
      children.every((child) => child !== null && typeof child !== "object"),
      "api_parameter_serialization",
      "Nested style-encoded parameters are not supported.",
    );
  }
  if (parameter.style !== undefined && !parameter.content) {
    const styles: Record<string, readonly string[]> = {
      path: ["simple", "label", "matrix"],
      query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"],
      header: ["simple"],
      cookie: ["form"],
    };
    requireCondition(
      styles[parameter.in]?.includes(parameter.style),
      "api_parameter_serialization",
      "The parameter style is not supported in this location.",
    );
    if (["spaceDelimited", "pipeDelimited"].includes(parameter.style))
      requireCondition(
        Array.isArray(value),
        "api_parameter_serialization",
        "Delimited parameters require an array.",
      );
    if (parameter.style === "deepObject")
      requireCondition(
        record(value) && parameter.explode !== false,
        "api_parameter_serialization",
        "deepObject requires an object and explode support.",
      );
  }
}

function nativeBinary(value: any, contentType?: string): Blob {
  if (types.isArrayBuffer(value))
    return new Blob([value], { type: contentType });
  const native = safeBlob(value);
  if (native) {
    const type = contentType ?? native.mimeType;
    return native.name === undefined
      ? new Blob([native.blob as unknown as Blob], { type })
      : new File([native.blob as unknown as Blob], native.name, {
          type,
          lastModified: native.lastModified,
        });
  }
  const view = types.isDataView(value);
  const bytes = new Uint8Array(
    (view ? dataViewBuffer : typedArrayBuffer).call(value),
    (view ? dataViewOffset : typedArrayOffset).call(value),
    binarySize(value)!,
  );
  return new Blob([bytes], { type: contentType });
}

export function buildOpenApiRequest(
  options: OpenApiRequestOptions,
): OpenApiRequest {
  try {
    return build(options);
  } catch (cause) {
    if (isAgentError(cause)) throw cause;
    throw new AgentError(
      "api_request_encoding",
      "The API request could not be serialized.",
      undefined,
      { cause },
    );
  }
}

function build(options: OpenApiRequestOptions): OpenApiRequest {
  requireCondition(
    Number.isSafeInteger(options.maxRequestBytes) &&
      options.maxRequestBytes > 0,
    "api_invalid_budget",
    "The request byte budget must be a positive safe integer.",
  );
  const limit = options.maxRequestBytes;
  const input = normalizeOpenApiInput(options.input, limit);
  requireCondition(
    Buffer.byteLength(options.serviceUrl) + Buffer.byteLength(options.path) <=
      limit,
    "api_request_too_large",
    "The API target exceeds its byte budget.",
  );
  const base = new URL(options.serviceUrl);
  requireCondition(
    ["http:", "https:"].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash,
    "api_invalid_service_url",
    "The approved API service URL is invalid.",
  );
  requireCondition(
    options.path.startsWith("/") && !/[?#]/.test(options.path),
    "api_invalid_operation",
    "The operation path is invalid.",
  );
  const method = options.method.toLowerCase();
  const original = options.document.paths?.[options.path]?.[method];
  requireCondition(
    original &&
      [
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
        "trace",
      ].includes(method),
    "api_invalid_operation",
    "The API operation is not present in the document.",
  );
  const oas3 = typeof options.document.openapi === "string";
  const parameters = options.parameters.map((parameter) => ({ ...parameter }));
  const operation = {
    ...original,
    operationId: options.operationId,
    parameters,
  };
  // A single-operation view fixes operation/path overrides and prevents other
  // operations, server selection, or security state from changing this call.
  const document: Record<string, any> = {
    ...options.document,
    security: [],
    paths: { [options.path]: { [method]: { ...operation, security: [] } } },
  };
  const values: Record<string, any> = Object.create(null);
  const wire = new Budget(limit);
  wire.add(
    Buffer.byteLength(options.serviceUrl) +
      Buffer.byteLength(options.path) +
      16,
  );
  const groups = {
    path: "path",
    query: "query",
    header: "headers",
    cookie: "cookies",
  } as const;
  for (const [location, group] of Object.entries(groups)) {
    const supplied = input[group as keyof typeof input];
    if (supplied === undefined) continue;
    requireCondition(
      record(supplied),
      "api_invalid_arguments",
      "API parameter groups must be objects.",
    );
    for (const [name, value] of Object.entries(supplied)) {
      const parameter = parameters.find(
        (p) =>
          p.in === location &&
          (location === "header"
            ? p.name.toLowerCase() === name.toLowerCase()
            : p.name === name),
      );
      requireCondition(
        parameter && parameter.name !== "__proto__",
        "api_unknown_parameter",
        "An undeclared API parameter was supplied.",
      );
      if (location === "header") checkHeader(name);
      parameterValue(parameter, value);
      const key = `${location}.${parameter.name}`;
      requireCondition(
        !(key in values),
        "api_invalid_arguments",
        "A header parameter was supplied more than once.",
      );
      wire.add(parameterBound(value, parameter.name));
      values[key] =
        parameter.content && isJson(media(Object.keys(parameter.content)[0]!))
          ? JSON.stringify(value)
          : value;
      if (location === "path" && record(value) && !parameter.content) {
        const escaped = Object.create(null);
        for (const [name, item] of Object.entries(value))
          escaped[
            encodeURIComponent(name).replace(
              /[!'()*]/g,
              (character) =>
                `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
            )
          ] = item;
        values[key] = escaped;
      }
      if (value === "" && location === "query")
        parameter.allowEmptyValue = true;
    }
  }
  for (const parameter of parameters) {
    requireCondition(
      typeof parameter.name === "string" && parameter.name !== "__proto__",
      "api_invalid_operation",
      "The parameter name cannot be serialized safely.",
    );
    if (parameter.in === "header") checkHeader(parameter.name);
    if (parameter.in === "cookie" && parameter.required)
      requireCondition(
        Object.hasOwn(values, `cookie.${parameter.name}`),
        "api_invalid_arguments",
        "A required cookie parameter was not supplied.",
      );
    // A schema/default describes omission, it is not permission to add an input
    // the caller did not supply. Ajv likewise does not mutate inputs here.
    delete parameter.default;
  }
  const hasBody = Object.hasOwn(input, "body");
  const bodyParameters = parameters.filter((p) => p.in === "body");
  const formParameters = parameters.filter((p) => p.in === "formData");
  requireCondition(
    !hasBody || !["get", "head"].includes(method),
    "api_invalid_body",
    "GET and HEAD requests cannot have a body.",
  );
  const bodyMedia = oas3
    ? Object.keys(operation.requestBody?.content ?? {})
    : (operation.consumes ??
      document.consumes ??
      (formParameters.length
        ? [
            formParameters.some((p) => p.type === "file")
              ? "multipart/form-data"
              : "application/x-www-form-urlencoded",
          ]
        : bodyParameters.length
          ? ["application/json"]
          : []));
  let contentType: string | undefined;
  if (hasBody || input.contentType !== undefined) {
    requireCondition(
      bodyMedia.length > 0 &&
        (oas3
          ? operation.requestBody
          : bodyParameters.length + formParameters.length),
      "api_invalid_body",
      "The operation has no declared request body.",
    );
    contentType = input.contentType ?? bodyMedia[0];
    requireCondition(
      typeof contentType === "string" &&
        !/[\r\n]/.test(contentType) &&
        bodyMedia.some((type: string) => media(type) === media(contentType!)),
      "api_unsupported_media",
      "The selected request content type is not declared.",
    );
  }
  const selected = contentType ? media(contentType) : undefined;
  const mediaKey = bodyMedia.find((type: string) => media(type) === selected);
  let body: BodyInit | null = null;
  let form: Record<string, any> | undefined;
  let bodyBytes = 0;
  let formBytes = 0;
  if (hasBody) {
    if (
      selected === "multipart/form-data" ||
      selected === "application/x-www-form-urlencoded"
    ) {
      requireCondition(
        record(input.body),
        "api_invalid_body",
        "A form body must be an object.",
      );
      form = Object.create(null);
      const encoding =
        operation.requestBody?.content?.[mediaKey]?.encoding ?? {};
      for (const [name, value] of Object.entries(input.body)) {
        const fieldEncoding = Object.hasOwn(encoding, name)
          ? encoding[name]
          : {};
        const parameter = formParameters.find((p) => p.name === name);
        requireCondition(
          oas3 || parameter,
          "api_unknown_parameter",
          "An undeclared form parameter was supplied.",
        );
        requireCondition(
          !fieldEncoding.headers ||
            Object.keys(fieldEncoding.headers).length === 0,
          "api_unsupported_media",
          "Custom multipart part headers are not supported.",
        );
        if (fieldEncoding.style !== undefined)
          parameterValue({ in: "query", ...fieldEncoding }, value);
        if (fieldEncoding.contentType !== undefined)
          requireCondition(
            typeof fieldEncoding.contentType === "string" &&
              /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:;[^\r\n]*)?$/.test(
                fieldEncoding.contentType,
              ),
            "api_unsupported_media",
            "Multipart encoding requires a concrete supported content type.",
          );
        const files = Array.isArray(value) ? value : [value];
        for (const item of files) {
          const size = binarySize(item);
          if (size !== undefined) {
            requireCondition(
              selected === "multipart/form-data",
              "api_invalid_body",
              "Binary fields require multipart/form-data.",
            );
            const native = safeBlob(item);
            const filename = native?.name ?? "blob";
            let type = native?.mimeType || "application/octet-stream";
            if (fieldEncoding.contentType) type = fieldEncoding.contentType;
            requireCondition(
              !isJson(media(type)),
              "api_invalid_body",
              "Native binary cannot be encoded as a JSON form field.",
            );
            bodyBytes +=
              size +
              512 +
              3 * Buffer.byteLength(name) +
              3 * Buffer.byteLength(filename) +
              Buffer.byteLength(type);
          } else
            bodyBytes +=
              selected === "multipart/form-data"
                ? 512 +
                  3 * Buffer.byteLength(name) +
                  2 * jsonBytes(item) +
                  Buffer.byteLength(fieldEncoding.contentType ?? "")
                : parameterBound(item, name) +
                  Buffer.byteLength(fieldEncoding.contentType ?? "");
        }
        wire.add(bodyBytes);
        formBytes += bodyBytes;
        bodyBytes = 0;
        form![name] = {
          value,
          ...(oas3
            ? { encoding: fieldEncoding }
            : { collectionFormat: parameter!.collectionFormat }),
        };
      }
      wire.add(selected === "multipart/form-data" ? 128 : 0);
      if (selected === "multipart/form-data") formBytes += 128;
    } else if (isJson(selected!)) {
      bodyBytes = jsonBytes(input.body);
      wire.add(bodyBytes);
      body = JSON.stringify(input.body);
    } else if (binarySize(input.body) !== undefined) {
      bodyBytes = binarySize(input.body)!;
      wire.add(bodyBytes);
      body = nativeBinary(input.body);
    } else {
      requireCondition(
        typeof input.body === "string",
        "api_unsupported_media",
        "This content type requires a string or native binary body.",
      );
      bodyBytes = Buffer.byteLength(input.body);
      wire.add(bodyBytes);
      body = input.body;
    }
  }
  if (!oas3) {
    for (const parameter of bodyParameters) {
      requireCondition(
        hasBody || !parameter.required,
        "api_invalid_body",
        "A required body was not supplied.",
      );
      // Its body is encoded above. Exclude it from the library's null skipping.
      parameter.required = false;
    }
    for (const parameter of formParameters) {
      requireCondition(
        (record(input.body) && Object.hasOwn(input.body, parameter.name)) ||
          !parameter.required,
        "api_invalid_body",
        "A required form field was not supplied.",
      );
      parameter.required = false;
    }
  }
  requireCondition(
    !oas3 || hasBody || !operation.requestBody?.required,
    "api_invalid_body",
    "A required request body was not supplied.",
  );
  let accept = input.accept;
  if (accept !== undefined)
    requireCondition(
      typeof accept === "string" && !/[\r\n]/.test(accept),
      "api_invalid_header",
      "Accept must be a header string.",
    );
  const responseTypes: string[] = [];
  if (accept === undefined) {
    if (oas3) {
      for (const [status, response] of Object.entries(
        original.responses ?? {},
      ) as [string, any][]) {
        if (!/^2[0-9][0-9]$/.test(status)) continue;
        for (const type of Object.keys(response.content ?? {})) {
          wire.add(Buffer.byteLength(type) + 2);
          responseTypes.push(type);
        }
      }
    } else
      for (const type of operation.produces ?? document.produces ?? []) {
        wire.add(Buffer.byteLength(type) + 2);
        responseTypes.push(type);
      }
    if (responseTypes.length) accept = responseTypes.join(", ");
  } else wire.add(Buffer.byteLength(accept));
  if (contentType) wire.add(Buffer.byteLength(contentType));
  // Disable automatic response-media concatenation before its allocation. The
  // bounded, explicit Accept above is the only header source for this purpose.
  document.paths[options.path]![method]!.responses = {};
  document.paths[options.path]![method]!.produces = [];
  const buildOptions = {
    spec: document,
    operationId: options.operationId,
    baseURL: options.serviceUrl.replace(/\/$/, ""),
    parameters: values,
    requestContentType: contentType,
    responseContentType: accept,
    attachContentTypeForEmptyPayload: hasBody,
  };
  // Cookie builders overwrite Cookie. Build each cookie on its own operation
  // view and combine their already-encoded pairs in declaration order.
  const cookieHeaders: string[] = [];
  for (const parameter of parameters.filter((p) => p.in === "cookie")) {
    if (!Object.hasOwn(values, `cookie.${parameter.name}`)) continue;
    const single = {
      ...document,
      paths: {
        [options.path]: {
          [method]: { ...operation, parameters: [parameter], security: [] },
        },
      },
    };
    const request = swagger.buildRequest({ ...buildOptions, spec: single });
    if (request.headers.Cookie) cookieHeaders.push(request.headers.Cookie);
  }
  operation.parameters = parameters.filter(
    (p) => !["cookie", "body", "formData"].includes(p.in),
  );
  document.paths[options.path]![method]!.parameters = operation.parameters;
  const request = swagger.buildRequest(buildOptions);
  if (form) {
    // Convert byte views only after all fields and their encoded bounds passed.
    for (const entry of Object.values(form)) {
      const type = entry.encoding?.contentType;
      if (binarySize(entry.value) !== undefined)
        entry.value = nativeBinary(entry.value, type);
      else if (type && isJson(media(type)))
        entry.value = JSON.stringify(entry.value);
      else if (Array.isArray(entry.value))
        entry.value = entry.value.map((item: any) =>
          binarySize(item) === undefined ? item : nativeBinary(item, type),
        );
    }
    if (!oas3) {
      // Swagger2 formData permits empty strings; preserve them explicitly.
      for (const entry of Object.values(form))
        if (entry.value === "") entry.allowEmptyValue = true;
    }
    body = serializeRequest({
      url: request.url,
      headers: { "Content-Type": contentType },
      form,
    }).body;
  }
  const headers = new Headers(request.headers);
  if (cookieHeaders.length)
    headers.set(
      "Cookie",
      [headers.get("Cookie"), ...cookieHeaders].filter(Boolean).join("; "),
    );
  if (contentType) headers.set("Content-Type", contentType);
  if (body instanceof FormData) headers.delete("Content-Type");
  if (input.accept !== undefined) {
    requireCondition(
      typeof input.accept === "string",
      "api_invalid_header",
      "Accept must be a string.",
    );
    headers.set("Accept", input.accept);
  }
  const target = new URL(request.url);
  const basePath = base.pathname.replace(/\/$/, "");
  requireCondition(
    target.origin === base.origin &&
      !target.username &&
      !target.password &&
      !target.hash &&
      (!basePath ||
        target.pathname === basePath ||
        target.pathname.startsWith(`${basePath}/`)),
    "api_invalid_service_url",
    "Request serialization escaped the approved service target.",
  );
  const finalBudget = new Budget(limit);
  finalBudget.add(Buffer.byteLength(target.href) + method.length + 8);
  for (const [name, value] of headers)
    finalBudget.add(Buffer.byteLength(name) + Buffer.byteLength(value) + 4);
  if (!(body instanceof FormData))
    finalBudget.add(
      typeof body === "string"
        ? Buffer.byteLength(body)
        : body instanceof Blob
          ? blobSize.call(body)
          : 0,
    );
  else finalBudget.add(formBytes);
  return { url: target.href, method: method.toUpperCase(), headers, body };
}
