// Code-owned JSON Schema fragments for platform methods. These describe the
// actual normalized arguments and successful SDK results, not MCP transport.
export const dialect = "https://json-schema.org/draft/2020-12/schema";
export const string = { type: "string" } as const;
export const boolean = { type: "boolean" } as const;
export const integer = { type: "integer" } as const;
export const nonnegative = { type: "integer", minimum: 0 } as const;
export const nullValue = { type: "null" } as const;
export const jsonValue = {
  anyOf: ["null", "boolean", "number", "string", "array", "object"].map(type => ({ type })),
};
export const jsonObject = { type: "object" } as const;
export const nullable = (schema: object) => ({ anyOf: [schema, nullValue] });
export const array = (items: object) => ({ type: "array", items });
export const enumeration = (...values: string[]) => ({ type: "string", enum: values });
export const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
export const output = (schema: object) => ({ $schema: dialect, ...schema });
