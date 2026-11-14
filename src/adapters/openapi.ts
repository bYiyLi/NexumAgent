import { createHash } from "node:crypto";
import { MIMEType } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import { authorizeCall } from "../contracts/caller.js";
import type { JsonObject } from "../contracts/types.js";
import type {
  ExtensionFactory,
  ExtensionHost,
  Invocation,
  MethodDefinition,
} from "../extensions/api.js";
import { parseOpenApi, openApiLimits } from "./openapi-schema.js";
import {
  buildOpenApiRequest,
  normalizeOpenApiInput,
  type OpenApiRequestOptions,
} from "./openapi-request.js";
import { executeOpenApiHttp, OpenApiHttpError } from "./openapi-http.js";
import { generateOpenApiTypes } from "./openapi-typegen.js";
import type {
  ApprovedOpenApi,
  OpenApiCredentialProvider,
  OpenApiOperation,
  OpenApiResponse,
  PreparedOpenApi,
} from "./openapi-types.js";
export type * from "./openapi-types.js";

type RecordValue = Record<string, any>;
const permissions = Object.freeze(["api.use"] as const);
const methods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
const parameterGroups = {
  path: "path",
  query: "query",
  header: "headers",
  cookie: "cookies",
} as const;
const ignoredHeaders = new Set(["authorization", "accept", "content-type"]);
const clone = <T>(value: T, max = 32 * 1024 * 1024): T =>
  JSON.parse(canonicalJson(value, max)) as T;
const object = (value: unknown): value is RecordValue => isPlainRecord(value);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function schemaFor(parameter: RecordValue, swagger: boolean): unknown {
  if (!swagger || parameter.in === "body")
    return (
      parameter.schema ??
      (object(parameter.content)
        ? Object.values(parameter.content)[0]?.schema
        : {}) ??
      {}
    );
  const schema: RecordValue = Object.create(null);
  for (const key of [
    "type",
    "format",
    "items",
    "default",
    "maximum",
    "exclusiveMaximum",
    "minimum",
    "exclusiveMinimum",
    "maxLength",
    "minLength",
    "pattern",
    "maxItems",
    "minItems",
    "uniqueItems",
    "enum",
    "multipleOf",
    "x-nullable",
  ])
    if (Object.hasOwn(parameter, key))
      schema[key === "x-nullable" ? "nullable" : key] = parameter[key];
  return schema;
}
function documentationValue(value: unknown): any {
  if (Array.isArray(value)) return value.map(documentationValue);
  if (!object(value)) return value;
  const result: RecordValue = Object.create(null);
  // Auth examples/defaults and imported server payloads are not a shared manual.
  for (const [key, child] of Object.entries(value))
    if (!["example", "examples", "default"].includes(key))
      result[key] = documentationValue(child);
  return result;
}
function credentialString(
  value: unknown,
  allowEmpty = false,
): asserts value is string {
  requireCondition(
    typeof value === "string" &&
      (allowEmpty || value.length > 0) &&
      Buffer.byteLength(value) <= 65536 &&
      !/[\0\r\n]/.test(value),
    "api_invalid_credential",
    "A configured API credential is unavailable or not a bounded valid value.",
  );
}
function matchedMedia(
  keys: Iterable<string>,
  requested: string | undefined,
): { key: string; actual: string } | null {
  const available = [...keys];
  const chosen =
    requested ??
    (available.length === 1 && !available[0]!.includes("*")
      ? available[0]
      : undefined);
  if (!chosen) return null;
  let actual: MIMEType;
  try {
    actual = new MIMEType(chosen);
  } catch {
    throw new AgentError(
      "api_invalid_media_type",
      "An API media selection is not a valid MIME type.",
    );
  }
  requireCondition(
    !actual.essence.includes("*"),
    "api_request_media_required",
    "A request must choose a concrete media type instead of sending a wildcard.",
  );
  const matches: { key: string; score: number }[] = [];
  for (const key of available) {
    let declared: MIMEType;
    try {
      declared = new MIMEType(key);
    } catch {
      throw new AgentError(
        "api_invalid_media_type",
        "A declared API media type is invalid.",
      );
    }
    const essence = declared.essence.toLowerCase(),
      target = actual.essence.toLowerCase();
    const [type, subtype] = essence.split("/");
    const fits =
      essence === target ||
      essence === "*/*" ||
      (subtype === "*" && target.startsWith(type + "/")) ||
      (subtype?.startsWith("*+") &&
        target.startsWith(type + "/") &&
        target.endsWith(subtype.slice(1)));
    if (!fits) continue;
    const parameters = [...declared.params];
    if (!parameters.every(([name, value]) => actual.params.get(name) === value))
      continue;
    matches.push({
      key,
      score:
        (essence === target
          ? 3
          : subtype?.startsWith("*+")
            ? 2
            : type === "*"
              ? 0
              : 1) +
        parameters.length * 10,
    });
  }
  matches.sort((a, b) => b.score - a.score);
  if (!matches.length) return null;
  requireCondition(
    matches.length === 1 || matches[0]!.score !== matches[1]!.score,
    "api_ambiguous_media_type",
    "The concrete media type matches multiple equally specific source representations.",
  );
  return { key: matches[0]!.key, actual: chosen };
}

interface OperationModel {
  name: string;
  method: string;
  path: string;
  description: string;
  operation: RecordValue;
  parameters: RecordValue[];
  checks: { parameter: RecordValue; validate(value: unknown): void }[];
  body: {
    required: boolean;
    content: RecordValue;
    checks: Map<string, (value: unknown) => void>;
  } | null;
  responseChecks: Map<string, Map<string, (value: unknown) => void>>;
  selectedSecurity: Record<string, readonly string[]>;
  authenticationTargets: Set<string>;
  inputSchema: JsonObject;
}

/** Approved fixed source -> public SDK factory, without source fetches, approval, or implicit retries. */
export async function prepareOpenApi(
  input: ApprovedOpenApi,
  options: {
    credentials?: OpenApiCredentialProvider;
    signal?: AbortSignal;
  } = {},
): Promise<PreparedOpenApi> {
  const signal = options.signal;
  signal?.throwIfAborted();
  requireCondition(
    object(input) &&
      Object.keys(input).every((key) =>
        [
          "name",
          "revision",
          "document",
          "references",
          "serviceUrl",
          "authentication",
          "limits",
        ].includes(key),
      ) &&
      typeof input.name === "string" &&
      /^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/.test(input.name) &&
      typeof input.revision === "string" &&
      input.revision.length > 0 &&
      input.revision.length <= 1024,
    "api_invalid_config",
    "An API adapter needs its approved name, source revision, fixed documents and service configuration.",
  );
  const name = input.name,
    approvedRevision = input.revision;
  let service: URL;
  try {
    service = new URL(input.serviceUrl);
  } catch {
    throw new AgentError(
      "api_invalid_service",
      "The API service needs an absolute HTTP(S) base URL.",
    );
  }
  requireCondition(
    ["http:", "https:"].includes(service.protocol) &&
      !service.username &&
      !service.password &&
      !service.search &&
      !service.hash,
    "api_invalid_service",
    "API service bases cannot contain credentials, query parameters or fragments.",
  );
  const serviceUrl = service.href.replace(/\/$/, "");
  const limits = openApiLimits(input.limits);
  const auth = clone(input.authentication ?? {}, 1024 * 1024);
  requireCondition(
    Object.keys(auth).every((key) =>
      [
        "credentialBindings",
        "operationSelections",
        "supplementalSchemes",
        "supplementalSecurity",
      ].includes(key),
    ),
    "api_invalid_authentication",
    "Only approved authentication bindings and selections are accepted.",
  );
  const parsed = await parseOpenApi(input, limits, signal);
  const document = parsed.document,
    swagger = parsed.sourceVersion === "2.0";
  const bindings = auth.credentialBindings ?? {},
    selections = auth.operationSelections ?? {};
  requireCondition(
    object(bindings) && object(selections),
    "api_invalid_authentication",
    "Authentication bindings and operation selections must be objects.",
  );
  for (const value of Object.values(bindings)) credentialString(value);
  const definitions: RecordValue = Object.create(null);
  const declared = swagger
    ? document.securityDefinitions
    : document.components?.securitySchemes;
  for (const [key, value] of Object.entries(declared ?? {}))
    definitions[key] = parsed.resolve(value);
  for (const [key, value] of Object.entries(auth.supplementalSchemes ?? {})) {
    requireCondition(
      !Object.hasOwn(definitions, key),
      "api_authentication_conflict",
      "Supplemental authentication cannot silently replace a source scheme.",
    );
    definitions[key] = clone(value);
  }
  for (const [key, definition] of Object.entries(definitions)) {
    requireCondition(
      key.length > 0 && Buffer.byteLength(key) <= 256 && object(definition),
      "api_invalid_authentication",
      "A security scheme needs a bounded original identity and definition.",
    );
    const supported =
      (definition.type === "apiKey" &&
        ["header", "query", "cookie"].includes(definition.in) &&
        typeof definition.name === "string" &&
        definition.name.length > 0 &&
        definition.name.length <= 256 &&
        !/[\0\r\n]/.test(definition.name) &&
        (definition.in === "query" ||
          /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(definition.name))) ||
      definition.type === "basic" ||
      (definition.type === "http" &&
        typeof definition.scheme === "string" &&
        ["basic", "bearer"].includes(definition.scheme?.toLowerCase())) ||
      ["oauth2", "openIdConnect", "mutualTLS"].includes(definition.type);
    requireCondition(
      supported,
      "api_unsupported_authentication",
      "A declared authentication scheme needs a supported protected credential provider.",
      { scheme: key },
    );
    if (definition.type === "apiKey" && definition.in === "header")
      requireCondition(
        ![
          "host",
          "content-length",
          "connection",
          "transfer-encoding",
          "upgrade",
          "te",
          "trailer",
          "keep-alive",
          "proxy-authorization",
        ].includes(definition.name.toLowerCase()) &&
          !definition.name.toLowerCase().startsWith("proxy-"),
        "api_unsupported_authentication",
        "Authentication cannot replace HTTP routing or framing headers.",
        { scheme: key },
      );
  }
  for (const key of Object.keys(bindings))
    requireCondition(
      Object.hasOwn(definitions, key),
      "api_invalid_authentication",
      "A credential binding names an unknown security scheme.",
    );
  const selectSecurity = (operation: RecordValue, name: string) => {
    let security = operation.security ?? document.security ?? [];
    if (!security.length && auth.supplementalSecurity)
      security = auth.supplementalSecurity;
    requireCondition(
      Array.isArray(security) && security.length <= 64,
      "api_invalid_authentication",
      "An operation needs a bounded set of authentication alternatives.",
    );
    const choices = security.length ? security : [{}];
    for (const requirement of choices) {
      requireCondition(
        object(requirement) && Object.keys(requirement).length <= 16,
        "api_invalid_authentication",
        "Authentication AND-groups must be bounded objects.",
      );
      for (const [key, scopes] of Object.entries(requirement))
        requireCondition(
          Object.hasOwn(definitions, key) &&
            Array.isArray(scopes) &&
            scopes.every(
              (scope) => typeof scope === "string" && scope.length <= 1024,
            ) &&
            (["oauth2", "openIdConnect"].includes(definitions[key].type) ||
              scopes.length === 0),
          "api_invalid_authentication",
          "An authentication requirement names an invalid scheme or scope set.",
        );
    }
    const selected = Object.hasOwn(selections, name)
      ? selections[name]
      : choices.findIndex((item: RecordValue) =>
          Object.keys(item).every((key) => Object.hasOwn(bindings, key)),
        );
    requireCondition(
      typeof selected === "number" &&
        Number.isInteger(selected) &&
        selected >= 0 &&
        selected < choices.length &&
        Object.keys(choices[selected]).every((key) =>
          Object.hasOwn(bindings, key),
        ),
      "api_authentication_required",
      "An operation's approved authentication alternative is not fully configured.",
      { operation: name },
    );
    requireCondition(
      !Object.keys(choices[selected]).length || options.credentials,
      "api_authentication_required",
      "Configured API authentication needs the trusted Agent credential provider.",
    );
    const targets = new Set<string>();
    for (const key of Object.keys(choices[selected])) {
      const scheme = definitions[key];
      const target =
        scheme.type === "apiKey"
          ? `${scheme.in}:${scheme.in === "header" ? scheme.name.toLowerCase() : scheme.name}`
          : scheme.type === "mutualTLS"
            ? "tls:client"
            : "header:authorization";
      requireCondition(
        !targets.has(target),
        "api_authentication_conflict",
        "Two authentication schemes cannot overwrite the same request target.",
        { operation: name },
      );
      targets.add(target);
    }
    return {
      security,
      selected: choices[selected] as Record<string, readonly string[]>,
      targets,
    };
  };
  const models: OperationModel[] = [],
    metadata: OpenApiOperation[] = [];
  const names = new Set<string>(),
    routes = new Set<string>();
  for (const [pathname, rawPath] of Object.entries(document.paths ?? {})) {
    if (pathname.startsWith("x-")) continue;
    requireCondition(
      pathname.startsWith("/") &&
        !pathname.startsWith("//") &&
        !/[\\?#\0\r\n]/.test(pathname),
      "api_invalid_path",
      "An API path must remain a path under its approved service base.",
    );
    const pathItem = parsed.resolve(rawPath);
    requireCondition(
      object(pathItem),
      "api_invalid_specification",
      "A path item must resolve to a standard object.",
    );
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;
      requireCondition(
        method !== "trace",
        "api_unsupported_method",
        "Native Node fetch does not support TRACE; use an explicitly supported SDK transport.",
      );
      requireCondition(
        object(rawOperation),
        "api_invalid_specification",
        "Each HTTP operation must be an object.",
      );
      const name =
        rawOperation.operationId ?? `${method.toUpperCase()} ${pathname}`;
      requireCondition(
        typeof name === "string" &&
          name.length > 0 &&
          Buffer.byteLength(name) <= 1024 &&
          !/[\0\r\n]/.test(name) &&
          !names.has(name),
        "api_operation_conflict",
        "Original operation identifiers must be unique bounded names.",
      );
      names.add(name);
      const route = method + ":" + pathname.replace(/\{[^}]+\}/g, "{}");
      requireCondition(
        !routes.has(route),
        "api_operation_conflict",
        "Equivalent path templates cannot define duplicate operations.",
      );
      routes.add(route);
      requireCondition(
        models.length < limits.operationCount,
        "api_catalog_too_large",
        "The API operation catalog exceeds its configured budget.",
      );
      const security = selectSecurity(rawOperation, name);
      const merged = new Map<string, RecordValue>();
      for (const raw of [
        ...(pathItem.parameters ?? []),
        ...(rawOperation.parameters ?? []),
      ]) {
        const parameter = parsed.resolve(raw);
        requireCondition(
          object(parameter) &&
            typeof parameter.name === "string" &&
            typeof parameter.in === "string",
          "api_invalid_specification",
          "An operation parameter must resolve to its original location and name.",
        );
        merged.set(
          parameter.in +
            ":" +
            (parameter.in === "header"
              ? parameter.name.toLowerCase()
              : parameter.name),
          parameter,
        );
      }
      const parameters = [...merged.values()].filter(
        (parameter) =>
          !(
            parameter.in === "header" &&
            ignoredHeaders.has(parameter.name.toLowerCase())
          ),
      );
      const modelParameters = parameters.filter(
        (parameter) =>
          !security.targets.has(
            `${parameter.in}:${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`,
          ),
      );
      const requiredPath = [...pathname.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1]!,
      );
      requireCondition(
        requiredPath.every((key) =>
          parameters.some(
            (parameter) =>
              parameter.in === "path" &&
              parameter.name === key &&
              parameter.required === true,
          ),
        ) &&
          parameters
            .filter((parameter) => parameter.in === "path")
            .every((parameter) => requiredPath.includes(parameter.name)),
        "api_invalid_path",
        "Path placeholders and required declared path parameters must agree.",
      );
      const checks = modelParameters
        .filter((parameter) => parameter.in in parameterGroups)
        .map((parameter) => ({
          parameter,
          validate: parsed.compile(schemaFor(parameter, swagger), "request"),
        }));
      const bodyParameter = modelParameters.find(
        (parameter) => parameter.in === "body",
      );
      const form = modelParameters.filter(
        (parameter) => parameter.in === "formData",
      );
      requireCondition(
        !bodyParameter || form.length === 0,
        "api_invalid_specification",
        "Swagger body and formData cannot describe the same operation body.",
      );
      let bodyDefinition = rawOperation.requestBody
        ? parsed.resolve(rawOperation.requestBody)
        : null;
      if (swagger && bodyParameter)
        bodyDefinition = {
          required: !!bodyParameter.required,
          content: Object.fromEntries(
            (
              rawOperation.consumes ??
              document.consumes ?? ["application/json"]
            ).map((mime: string) => [
              mime,
              { schema: bodyParameter.schema ?? {} },
            ]),
          ),
        };
      if (swagger && form.length)
        bodyDefinition = {
          required: form.some((parameter) => parameter.required),
          content: Object.fromEntries(
            (
              rawOperation.consumes ??
              document.consumes ?? ["application/x-www-form-urlencoded"]
            ).map((mime: string) => [
              mime,
              {
                schema: {
                  type: "object",
                  properties: Object.fromEntries(
                    form.map((parameter) => [
                      parameter.name,
                      schemaFor(parameter, true),
                    ]),
                  ),
                  required: form
                    .filter((parameter) => parameter.required)
                    .map((parameter) => parameter.name),
                  additionalProperties: false,
                },
              },
            ]),
          ),
        };
      const body = bodyDefinition
        ? {
            required: !!bodyDefinition.required,
            content: bodyDefinition.content ?? {},
            checks: new Map<string, (value: unknown) => void>(),
          }
        : null;
      if (body)
        for (const [mime, media] of Object.entries(body.content)) {
          requireCondition(
            typeof mime === "string" && mime.length <= 256 && object(media),
            "api_invalid_media_type",
            "Request media types must have bounded standard definitions.",
          );
          const schema = media.schema ?? {};
          body.checks.set(mime, parsed.compile(schema, "request"));
        }
      const responseChecks = new Map<
        string,
        Map<string, (value: unknown) => void>
      >();
      for (const [status, rawResponse] of Object.entries(
        rawOperation.responses ?? {},
      )) {
        const response = parsed.resolve(rawResponse);
        requireCondition(
          object(response),
          "api_invalid_specification",
          "Each response must resolve to its standard definition.",
        );
        const content = swagger
          ? Object.fromEntries(
              (
                rawOperation.produces ??
                document.produces ?? ["application/json"]
              ).map((mime: string) => [
                mime,
                { schema: response.schema ?? {} },
              ]),
            )
          : (response.content ?? {});
        const validators = new Map<string, (value: unknown) => void>();
        for (const [mime, media] of Object.entries(content)) {
          requireCondition(
            mime.length <= 256 && object(media),
            "api_invalid_media_type",
            "Response media types must have bounded standard definitions.",
          );
          // An unspecified payload schema is intentionally unconstrained, including native binary responses.
          validators.set(
            mime,
            media.schema === undefined ||
              (object(media.schema) && !Object.keys(media.schema).length)
              ? () => {}
              : parsed.compile(media.schema, "response"),
          );
        }
        responseChecks.set(status, validators);
      }
      const inputProperties: RecordValue = Object.create(null),
        inputRequired: string[] = [];
      for (const [position, group] of Object.entries(parameterGroups)) {
        const matching = checks.filter(
          (check) => check.parameter.in === position,
        );
        if (!matching.length) continue;
        const required = matching
          .filter((check) => check.parameter.required)
          .map((check) => check.parameter.name);
        inputProperties[group] = {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            matching.map((check) => [check.parameter.name, {}]),
          ),
          ...(required.length ? { required } : {}),
        };
        if (required.length) inputRequired.push(group);
      }
      if (body) {
        inputProperties.body = {};
        inputProperties.contentType = {
          type: "string",
          minLength: 1,
          maxLength: 256,
        };
        if (body.required) inputRequired.push("body");
      }
      inputProperties.accept = {
        type: "string",
        minLength: 1,
        maxLength: 1024,
      };
      const inputSchema = {
        type: "object",
        properties: inputProperties,
        additionalProperties: false,
        ...(inputRequired.length ? { required: inputRequired } : {}),
      };
      const description =
        rawOperation.description ??
        rawOperation.summary ??
        `${method.toUpperCase()} ${pathname}`;
      requireCondition(
        typeof description === "string" &&
          description.length > 0 &&
          description.length <= 4096,
        "api_catalog_too_large",
        "An operation description exceeds the public method budget.",
      );
      const model: OperationModel = {
        name,
        method,
        path: pathname,
        description,
        operation: {
          ...rawOperation,
          operationId: name,
          parameters: modelParameters,
          ...(!swagger && bodyDefinition
            ? { requestBody: bodyDefinition }
            : {}),
          responses: Object.fromEntries(
            Object.entries(rawOperation.responses ?? {}).map(([key, value]) => [
              key,
              parsed.resolve(value),
            ]),
          ),
        },
        parameters: modelParameters,
        checks,
        body,
        responseChecks,
        selectedSecurity: security.selected,
        authenticationTargets: security.targets,
        inputSchema,
      };
      models.push(model);
      metadata.push(
        documentationValue({
          name,
          method: method.toUpperCase(),
          path: pathname,
          description,
          parameters: modelParameters,
          ...(bodyDefinition ? { requestBody: bodyDefinition } : {}),
          responses: rawOperation.responses,
          security: security.security,
        }),
      );
    }
  }
  requireCondition(
    models.length > 0,
    "api_no_operations",
    "The API description has no callable HTTP path operations.",
  );
  for (const key of Object.keys(selections))
    requireCondition(
      names.has(key),
      "api_invalid_authentication",
      "An authentication selection names an unknown operation.",
    );
  const revision =
    "sha256:" +
    digest(
      canonicalJson(
        {
          approved: approvedRevision,
          source: parsed.revision,
          serviceUrl,
          authentication: auth,
        },
        2 * 1024 * 1024,
      ),
    );
  const publicOperations = frozen(clone(metadata, limits.totalDocumentBytes));
  const markdownParts = [
    `# API ${name}\n\n规范 ${parsed.sourceVersion}；固定修订 ${revision}。\n\n每个调用接受一个对象，按 path/query/headers/cookies/body 保留 HTTP 位置。contentType 在多种请求媒体类型时必须显式选择；返回 status/headers/data，二进制 data 为原生 Blob；图片预览显式 return output.image({data: response.data})，普通文件沿 output.file。\n\n认证只从已批准凭据绑定注入；规范与引用不在调用时重新下载。HTTP 错误有独立错误码及 response，不自动重试、跟随重定向、启动回调服务或把 202 变为后台任务。\n\n公共方法输入是 2020-12 envelope；原始 Swagger 2/OAS 3.0 payload 使用 Draft 4/OAS 约束，OAS 3.1 使用 JSON Schema 2020-12。下方保留原始定义；示例/default不进入共享手册。当前高级 schema-local $id/anchor/dynamicRef 不支持并明确拒绝。原生二进制引用不能附加约束 siblings，组合 binary Schema、复杂 style cookie 和 XML/object 自动编解码不在当前矩阵；相关调用明确失败，不静默丢字段。XML/其他文本在源 Schema 允许时保留原始字符串，不创建隐式编解码。Node fetch 不支持 TRACE 以及 GET/HEAD body。\n`,
  ];
  let docsBytes = Buffer.byteLength(markdownParts[0]!);
  for (const operation of publicOperations) {
    const part = `\n## ${operation.name}\n\n\`api.${name}[${JSON.stringify(operation.name)}](arguments)\`\n\n${operation.description}\n\n\`\`\`json\n${canonicalJson(operation, limits.totalDocumentBytes)}\n\`\`\`\n`;
    docsBytes += Buffer.byteLength(part);
    requireCondition(
      docsBytes <= limits.totalDocumentBytes,
      "api_catalog_too_large",
      "The generated API documentation exceeds its byte budget.",
    );
    markdownParts.push(part);
  }
  let ready = false,
    constructed = false;
  const factory: ExtensionFactory = async (host: ExtensionHost) => {
    requireCondition(
      !constructed,
      "api_adapter_in_use",
      "Create a fresh API adapter for each installed source instance.",
    );
    constructed = true;
    host.signal.throwIfAborted();
    authorizeCall(() =>
      host.authorize({ type: "url", value: serviceUrl, access: "connect" }),
    );
    const lifetime = new AbortController();
    const entries: Record<string, MethodDefinition> = Object.create(null);
    const pending = new Set<Promise<OpenApiResponse>>();
    for (const model of models)
      entries[model.name] = {
        description: model.description,
        permissions,
        schemaDialect: "2020-12",
        inputSchema: model.inputSchema,
        normalize(args) {
          requireCondition(
            args.length <= 1,
            "api_invalid_arguments",
            "API operations accept one argument object.",
          );
          const fixed = normalizeOpenApiInput(
            args[0] ?? {},
            limits.requestBytes,
          );
          if (fixed.headers) {
            const normalized: RecordValue = Object.create(null);
            for (const [key, value] of Object.entries(fixed.headers)) {
              const found = model.parameters.find(
                (parameter) =>
                  parameter.in === "header" &&
                  parameter.name.toLowerCase() === key.toLowerCase(),
              );
              requireCondition(
                found && !Object.hasOwn(normalized, found.name),
                "api_invalid_arguments",
                "A header parameter is unknown or specified more than once.",
              );
              normalized[found.name] = value;
            }
            fixed.headers = normalized;
          }
          if (model.body && Object.hasOwn(fixed, "body")) {
            const selected = matchedMedia(
              model.body.checks.keys(),
              fixed.contentType,
            );
            requireCondition(
              selected,
              "api_request_media_required",
              "Choose a concrete contentType matching a declared request representation.",
            );
            fixed.contentType = selected.actual;
          }
          return fixed;
        },
        async handle(value, call: Invocation) {
          lifetime.signal.throwIfAborted();
          const argument = value as OpenApiRequestOptions["input"];
          for (const { parameter, validate } of model.checks) {
            const group =
              parameterGroups[parameter.in as keyof typeof parameterGroups];
            const found = argument[group]?.[parameter.name];
            requireCondition(
              found !== undefined || !parameter.required,
              "api_invalid_arguments",
              "A required API parameter is missing.",
              { parameter: parameter.name, in: parameter.in },
            );
            if (found !== undefined) validate(found);
          }
          if (model.body) {
            requireCondition(
              Object.hasOwn(argument, "body") || !model.body.required,
              "api_invalid_arguments",
              "The API operation needs a request body.",
            );
            if (Object.hasOwn(argument, "body")) {
              requireCondition(
                !["get", "head"].includes(model.method),
                "api_unsupported_request_body",
                "Native Node fetch cannot send a GET or HEAD request body.",
              );
              const selected = matchedMedia(
                model.body.checks.keys(),
                argument.contentType,
              );
              requireCondition(
                selected,
                "api_request_media_required",
                "Choose a declared contentType when an operation has multiple request representations.",
              );
              const essence = new MIMEType(selected.actual).essence;
              requireCondition(
                essence.includes("json") ||
                  [
                    "multipart/form-data",
                    "application/x-www-form-urlencoded",
                  ].includes(essence) ||
                  (!object(argument.body) && !Array.isArray(argument.body)),
                "api_unsupported_media_schema",
                "Non-JSON object/XML serialization requires an explicit codec; raw text or native binary remains supported.",
              );
              model.body.checks.get(selected.key)!(argument.body);
            }
          }
          const activeOperation = { ...model.operation };
          if (model.body && Object.hasOwn(argument, "body")) {
            const selected = matchedMedia(
              model.body.checks.keys(),
              argument.contentType,
            )!;
            if (swagger) activeOperation.consumes = [selected.actual];
            else
              activeOperation.requestBody = {
                ...model.operation.requestBody,
                content: {
                  [selected.actual]: model.body.content[selected.key],
                },
              };
          }
          const operationView = {
            ...document,
            paths: { [model.path]: { [model.method]: activeOperation } },
          };
          const request = buildOpenApiRequest({
            document: operationView,
            operationId: model.name,
            method: model.method,
            path: model.path,
            serviceUrl,
            parameters: model.parameters,
            input: argument,
            maxRequestBytes: limits.requestBytes,
          });
          const ongoing = executeOpenApiHttp({
            request,
            host,
            call: {
              ...call,
              signal: AbortSignal.any([call.signal, lifetime.signal]),
            },
            operation: model.name,
            limits,
            authenticate: async (scope: AbortSignal) => {
              lifetime.signal.throwIfAborted();
              scope.throwIfAborted();
              const target = new URL(request.url),
                headers = new Headers(request.headers),
                secrets: string[] = [],
                sensitiveHeaders: string[] = ["authorization", "cookie"];
              let dispatcher: unknown;
              for (const [key, scopes] of Object.entries(
                model.selectedSecurity,
              )) {
                const definition = definitions[key];
                const credential = await options.credentials!.get({
                  api: name,
                  revision,
                  scheme: key,
                  definition: frozen(clone(definition)),
                  credentialRef: bindings[key]!,
                  scopes,
                  target: request.url,
                  signal: AbortSignal.any([scope, lifetime.signal]),
                  operationId: call.operationId,
                  context: call.context,
                  hostContext: host.context,
                });
                scope.throwIfAborted();
                lifetime.signal.throwIfAborted();
                if (definition.type === "apiKey") {
                  requireCondition(
                    credential.type === "apiKey",
                    "api_invalid_credential",
                    "The credential type does not match its approved security scheme.",
                  );
                  credentialString(credential.value);
                  secrets.push(credential.value);
                  if (definition.in === "header") {
                    requireCondition(
                      !headers.has(definition.name),
                      "api_authentication_conflict",
                      "An argument cannot replace an Agent-managed authentication header.",
                    );
                    headers.set(definition.name, credential.value);
                    sensitiveHeaders.push(definition.name);
                  } else if (definition.in === "query") {
                    requireCondition(
                      !target.searchParams.has(definition.name),
                      "api_authentication_conflict",
                      "An argument cannot replace an Agent-managed authentication query value.",
                    );
                    target.searchParams.set(definition.name, credential.value);
                    const encoded = new URLSearchParams([
                      [definition.name, credential.value],
                    ]).toString();
                    secrets.push(encoded.slice(encoded.indexOf("=") + 1));
                  } else {
                    const existing = headers.get("cookie") ?? "";
                    requireCondition(
                      !existing
                        .split(";")
                        .some(
                          (part) =>
                            part.trim().split("=", 1)[0] === definition.name,
                        ),
                      "api_authentication_conflict",
                      "An argument cannot replace an Agent-managed authentication cookie.",
                    );
                    headers.set(
                      "cookie",
                      (existing ? existing + "; " : "") +
                        definition.name +
                        "=" +
                        encodeURIComponent(credential.value),
                    );
                  }
                } else if (definition.type === "mutualTLS") {
                  requireCondition(
                    credential.type === "mutualTLS" &&
                      credential.dispatcher &&
                      typeof credential.dispatcher === "object",
                    "api_invalid_credential",
                    "mTLS needs its approved connection-level TLS dispatcher.",
                  );
                  dispatcher = credential.dispatcher;
                } else {
                  const basic =
                    definition.type === "basic" ||
                    (definition.type === "http" &&
                      definition.scheme.toLowerCase() === "basic");
                  requireCondition(
                    basic
                      ? credential.type === "basic"
                      : credential.type === "bearer",
                    "api_invalid_credential",
                    "The credential type does not match its approved security scheme.",
                  );
                  let authorization: string;
                  if (credential.type === "basic") {
                    credentialString(credential.username, true);
                    credentialString(credential.password, true);
                    requireCondition(
                      !credential.username.includes(":"),
                      "api_invalid_credential",
                      "A Basic username cannot contain a colon.",
                    );
                    const pair =
                      credential.username + ":" + credential.password;
                    const encoded = Buffer.from(pair).toString("base64");
                    authorization = "Basic " + encoded;
                    secrets.push(
                      credential.password,
                      pair,
                      encoded,
                      authorization,
                    );
                  } else {
                    requireCondition(
                      credential.type === "bearer",
                      "api_invalid_credential",
                      "A token credential is required.",
                    );
                    credentialString(credential.token);
                    authorization = "Bearer " + credential.token;
                    secrets.push(credential.token, authorization);
                  }
                  requireCondition(
                    !headers.has("authorization"),
                    "api_authentication_conflict",
                    "An argument cannot replace an Agent-managed Authorization header.",
                  );
                  headers.set("authorization", authorization);
                }
              }
              return {
                url: target.href,
                headers,
                ...(dispatcher ? { dispatcher } : {}),
                secrets,
                sensitiveHeaders,
              };
            },
            validateResponse(response: OpenApiResponse, mime: string) {
              const status = String(response.status),
                group =
                  model.responseChecks.get(status) ??
                  model.responseChecks.get(status[0] + "XX") ??
                  model.responseChecks.get("default");
              requireCondition(
                group,
                "api_unexpected_response",
                "The service returned a status not described by this operation.",
                { status: response.status, operation: model.name },
              );
              if (
                !group.size ||
                response.status === 204 ||
                response.status === 304 ||
                model.method === "head"
              )
                return;
              const matched = matchedMedia(
                group.keys(),
                response.headers["content-type"] ?? mime,
              );
              const validate = matched ? group.get(matched.key) : undefined;
              requireCondition(
                validate,
                "api_unexpected_response_media",
                "The service returned a media type not described by this operation.",
                { status: response.status, operation: model.name },
              );
              validate(response.data);
            },
          });
          pending.add(ongoing);
          try {
            return await ongoing;
          } catch (error) {
            if (error instanceof OpenApiHttpError) {
              // The public extension boundary accepts ordinary AgentError data,
              // not an adapter-specific control prototype.
              const result = new AgentError(
                error.code,
                error.message,
                error.details,
              );
              result.name = "OpenApiHttpError";
              Object.defineProperty(result, "response", {
                value: error.response,
                enumerable: true,
              });
              throw result;
            }
            throw error;
          } finally {
            pending.delete(ongoing);
          }
        },
      };
    ready = true;
    return {
      methods: entries,
      async dispose() {
        ready = false;
        lifetime.abort(
          new AgentError(
            "api_adapter_stopping",
            "The API source no longer accepts calls.",
          ),
        );
        await Promise.allSettled([...pending]);
      },
    };
  };
  return Object.freeze({
    factory,
    bindingPath: Object.freeze(["api", name] as const),
    permissions,
    revision,
    documentation: Object.freeze({
      markdown: markdownParts.join(""),
      types: generateOpenApiTypes(
        models.map((model) => ({
          name: model.name,
          parameters: model.parameters,
          requestBody: model.body
            ? { required: model.body.required, content: model.body.content }
            : null,
          responses: model.operation.responses,
        })),
        parsed.resolve,
        (parameter) => schemaFor(parameter, swagger),
        limits.totalDocumentBytes,
      ),
    }),
    catalog: () =>
      Object.freeze({
        name: name,
        sourceVersion: parsed.sourceVersion,
        revision,
        ready,
        operations: publicOperations,
      }),
  });
}
