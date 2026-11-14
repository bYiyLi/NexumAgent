import { requireCondition } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";

const record = (value: unknown): value is Record<string, any> =>
  isPlainRecord(value);
export interface OpenApiTypeModel {
  name: string;
  parameters: readonly Record<string, any>[];
  requestBody: { required: boolean; content: Record<string, any> } | null;
  responses: Record<string, any>;
}
/** Source schemas describe the generated public types; runtime assertions remain in their original validators. */
export function generateOpenApiTypes(
  models: readonly OpenApiTypeModel[],
  resolve: (value: unknown) => any,
  schemaFor: (parameter: Record<string, any>) => unknown,
  limit: number,
): string {
  const declarations: string[] = [];
  const queue: {
    name: string;
    schema: unknown;
    direction: "request" | "response";
  }[] = [];
  const identities = {
    request: new Map<unknown, string>(),
    response: new Map<unknown, string>(),
  };
  let bytes = 0,
    next = 0;
  const emit = (text: string) => {
    bytes += Buffer.byteLength(text);
    requireCondition(
      bytes <= limit,
      "api_catalog_too_large",
      "Generated API types exceed their byte budget.",
    );
    declarations.push(text);
  };
  const type = (schema: unknown, direction: "request" | "response"): string => {
    if (schema === false) return "never";
    if (!record(schema) || !Object.keys(schema).length) return "unknown";
    const existing = identities[direction].get(schema);
    if (existing) return existing;
    const name = `Schema_${next++}`;
    identities[direction].set(schema, name);
    queue.push({ name, schema, direction });
    return name;
  };
  const primitive = (
    name: string,
    schema: Record<string, any>,
    direction: "request" | "response",
  ): string => {
    if (name === "string")
      return schema.format === "binary"
        ? direction === "request"
          ? "Blob | ArrayBuffer | ArrayBufferView | string"
          : "Blob | string"
        : "string";
    if (name === "file")
      return direction === "request"
        ? "Blob | ArrayBuffer | ArrayBufferView"
        : "Blob";
    if (name === "number" || name === "integer") return "number";
    if (name === "boolean" || name === "null") return name;
    if (name === "array") {
      if (Array.isArray(schema.prefixItems)) {
        const prefix = schema.prefixItems.slice(
          0,
          Number.isInteger(schema.maxItems) ? schema.maxItems : undefined,
        );
        if (schema.items === false && schema.minItems > prefix.length)
          return "never";
        const members = prefix.map(
          (item: unknown, index: number) =>
            `item${index}${index < (schema.minItems ?? 0) ? "" : "?"}:${type(item, direction)}`,
        );
        if (schema.items !== false)
          members.push(`...items:(${type(schema.items ?? {}, direction)})[]`);
        return `[${members.join(",")}]`;
      }
      return `Array<${type(schema.items ?? {}, direction)}>`;
    }
    if (name === "object") {
      const propertyTypes = new Set<string>();
      const members = Object.entries(schema.properties ?? {})
        .map(([key, child]) => {
          const property = resolve(child);
          const excludedRequired =
            record(property) &&
            property[direction === "request" ? "readOnly" : "writeOnly"] ===
              true;
          const optional =
            !Array.isArray(schema.required) ||
            !schema.required.includes(key) ||
            excludedRequired;
          const childType = type(child, direction);
          propertyTypes.add(childType);
          if (optional) propertyTypes.add("undefined");
          return `${JSON.stringify(key)}${optional ? "?" : ""}:${childType};`;
        })
        .join("");
      // A TS string index also covers declared keys. Its value must include those
      // types; the source validator still enforces the narrower additional keys.
      propertyTypes.add(
        type(
          record(schema.additionalProperties)
            ? schema.additionalProperties
            : {},
          direction,
        ),
      );
      return `{${members}}${schema.additionalProperties === false ? "" : ` & Record<string,${[...propertyTypes].join(" | ")}>`}`;
    }
    return "unknown";
  };
  emit(
    "export interface ApiResponse<T=unknown>{readonly ok:boolean;readonly status:number;readonly headers:Readonly<Record<string,string>>;readonly data:T;readonly redacted?:boolean}\n",
  );
  const methods: string[] = [];
  for (let index = 0; index < models.length; index++) {
    const model = models[index]!;
    const groups: string[] = [];
    let requiredInput = !!model.requestBody?.required;
    for (const [position, group] of Object.entries({
      path: "path",
      query: "query",
      header: "headers",
      cookie: "cookies",
    })) {
      const parameters = model.parameters.filter(
        (parameter) => parameter.in === position,
      );
      if (!parameters.length) continue;
      const required = parameters.some(
        (parameter) => parameter.required === true,
      );
      requiredInput ||= required;
      groups.push(
        `${group}${required ? "" : "?"}:{${parameters.map((parameter) => `${JSON.stringify(parameter.name)}${parameter.required ? "" : "?"}:${type(schemaFor(parameter), "request")};`).join("")}};`,
      );
    }
    let body = "";
    if (model.requestBody) {
      const representations = Object.entries(model.requestBody.content);
      body =
        " & (" +
        [
          ...(model.requestBody.required
            ? []
            : ["{body?:never;contentType?:never}"]),
          ...representations.map(
            ([mime, media]) =>
              `{body:${type(media.schema ?? {}, "request")};contentType${representations.length === 1 && !mime.includes("*") ? "?" : ""}:${mime.includes("*") ? "string" : JSON.stringify(mime)}}`,
          ),
        ].join(" | ") +
        ")";
    }
    emit(
      `export type Arguments_${index}={${groups.join("")}accept?:string}${body};\n`,
    );
    const responseTypes = new Set<string>();
    for (const [status, raw] of Object.entries(model.responses)) {
      if (!/^2/.test(status) && status !== "default") continue;
      const response = resolve(raw);
      for (const [mime, media] of Object.entries(response?.content ?? {})) {
        responseTypes.add(
          mime.includes("json")
            ? type((media as any).schema ?? {}, "response")
            : mime.startsWith("text/") || /(?:xml|yaml|javascript)/.test(mime)
              ? "string"
              : "Blob",
        );
      }
      if (response?.schema)
        responseTypes.add(type(response.schema, "response"));
    }
    methods.push(
      `[${JSON.stringify(model.name)}](input${requiredInput ? "" : "?"}:Arguments_${index}):Promise<ApiResponse<${[...responseTypes].join(" | ") || "unknown"}>>;`,
    );
  }
  emit(`export interface ApiClient{${methods.join("\n")}}\n`);
  for (let at = 0; at < queue.length; at++) {
    requireCondition(
      queue.length <= 100000,
      "api_catalog_too_large",
      "Generated API types exceed their schema count.",
    );
    const { name, schema, direction } = queue[at]!;
    const value = resolve(schema);
    let expression: string;
    if (record(schema) && typeof schema.$ref === "string") {
      const target = resolve({ $ref: schema.$ref });
      const { $ref: _ref, ...siblings } = schema;
      expression =
        type(target, direction) +
        (Object.keys(siblings).length ? ` & ${type(siblings, direction)}` : "");
    } else if (!record(value))
      expression = value === false ? "never" : "unknown";
    else {
      let typed = Array.isArray(value.type)
        ? value.type
            .map((kind: string) => primitive(kind, value, direction))
            .join(" | ")
        : primitive(
            value.type ??
              (value.properties || value.additionalProperties !== undefined
                ? "object"
                : value.items
                  ? "array"
                  : "unknown"),
            value,
            direction,
          );
      if (value.nullable === true && typed !== "unknown")
        typed = `(${typed}) | null`;
      const compositions = [typed === "unknown" ? "" : `(${typed})`];
      if (Object.hasOwn(value, "const"))
        compositions.push(`(${JSON.stringify(value.const)})`);
      if (Array.isArray(value.enum))
        compositions.push(
          `(${value.enum.map((item: unknown) => JSON.stringify(item)).join(" | ") || "never"})`,
        );
      for (const [keyword, separator] of [
        ["allOf", " & "],
        ["oneOf", " | "],
        ["anyOf", " | "],
      ] as const)
        if (Array.isArray(value[keyword]))
          compositions.push(
            "(" +
              value[keyword]
                .map((item: unknown) => type(item, direction))
                .join(separator) +
              ")",
          );
      expression = compositions.filter(Boolean).join(" & ") || "unknown";
    }
    emit(`export type ${name}=${expression};\n`);
  }
  return declarations.join("");
}
