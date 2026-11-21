import { readdirSync, readFileSync } from "node:fs";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";
import { AgentError, requireCondition } from "./errors.js";
import { canonicalJson } from "./json.js";
import { validateWireSemantics } from "./wire-validation.js";
import {
  MAX_JSON_BODY_BYTES_V2,
  MAX_RESOURCES_READ_BODY_BYTES_V2,
} from "./wire.js";

const base = new URL("../../contracts/v2/", import.meta.url);
const prefix = "https://schemas.nexum.local/agent/v2/";
const options = {
  strict: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
} as const;
const addFormats = formatsModule.default;
const ajv = new Ajv2020(options);
addFormats(ajv);

ajv.addSchema(
  JSON.parse(
    readFileSync(new URL("common.schema.json", base), "utf8"),
  ) as AnySchema,
);
for (const directory of ["model", "wire"]) {
  for (const name of readdirSync(new URL(directory + "/", base)).sort()) {
    if (name.endsWith(".schema.json"))
      ajv.addSchema(
        JSON.parse(
          readFileSync(new URL(directory + "/" + name, base), "utf8"),
        ) as AnySchema,
      );
  }
}

export function validateContract(contract: string, value: unknown): void {
  canonicalJson(
    value,
    contract === "wire.body:ResourcesRead"
      ? MAX_RESOURCES_READ_BODY_BYTES_V2
      : contract.startsWith("wire.body:")
        ? MAX_JSON_BODY_BYTES_V2
        : 1024 * 1024,
  );
  const id =
    contract === "wire"
      ? prefix + "wire/envelope.schema.json"
      : contract === "wire.stream"
        ? prefix + "wire/stream.schema.json"
        : contract.startsWith("wire.input:")
          ? prefix +
            "wire/operations.schema.json#/$defs/" +
            contract.slice(11) +
            ".input"
          : contract.startsWith("wire.output:")
            ? prefix +
              "wire/operations.schema.json#/$defs/" +
              contract.slice(12) +
              ".output"
            : contract.startsWith("wire.body:")
              ? prefix +
                (contract.startsWith("wire.body:Maintenance")
                  ? "wire/maintenance.schema.json#/$defs/"
                  : "wire/bodies.schema.json#/$defs/") +
                contract.slice(10)
              : contract.startsWith("wire.type:")
                ? prefix + "wire/types.schema.json#/$defs/" + contract.slice(10)
                : contract.endsWith(".output")
                  ? prefix + `model/${contract}.schema.json`
                  : prefix + `model/${contract}.input.schema.json`;
  const validate = ajv.getSchema(id);
  requireCondition(
    validate,
    "unknown_contract",
    "The requested contract is not registered.",
  );
  assertValid(validate, value);
  validateWireSemantics(contract, value);
}

export function compileInputSchema(schema: unknown): (value: unknown) => void {
  canonicalJson(schema);
  requireCondition(
    typeof schema === "boolean" ||
      (schema !== null && typeof schema === "object" && !Array.isArray(schema)),
    "invalid_input_schema",
    "The script input schema must be a Draft 7 schema.",
  );
  let validate: ValidateFunction;
  try {
    // An author's $id never becomes another script or extension's global schema.
    const draft7 = new Ajv(options);
    addFormats(draft7);
    requireCondition(
      draft7.validateSchema(schema),
      "invalid_input_schema",
      "The script input schema is invalid.",
    );
    validate = draft7.compile(schema as AnySchema);
  } catch (error) {
    throw new AgentError(
      "invalid_input_schema",
      "The script schema is invalid or refers to an unavailable schema.",
      undefined,
      { cause: error },
    );
  }
  return (value: unknown) => {
    canonicalJson(value);
    assertValid(validate, value);
  };
}

const safeFieldName = (name: unknown): string | null =>
  typeof name === "string" &&
  /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name) &&
  !/(token|secret|password|credential|bearer)/i.test(name)
    ? name
    : null;

function safeInstancePath(input: string): string {
  if (!input) return "$";
  if (input.length > 256 || !input.startsWith("/")) return "$";
  const parts = input.slice(1).split("/");
  if (parts.length > 12) return "$";
  let path = "$";
  for (const part of parts) {
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (safeFieldName(decoded)) path += "." + decoded;
    else if (/^(0|[1-9][0-9]{0,5})$/.test(decoded)) path += "[" + decoded + "]";
    else return "$";
  }
  return path;
}

function assertValid(validate: ValidateFunction, value: unknown): void {
  if (validate(value)) return;
  const errors = (validate.errors ?? []).slice(0, 8).map((error) => {
    let path = safeInstancePath(error.instancePath);
    const keyword = error.keyword;
    const p = error.params;
    let expected = "match the declared schema";
    if (keyword === "required" || keyword === "additionalProperties") {
      const field = safeFieldName(
        keyword === "required" ? p.missingProperty : p.additionalProperty,
      );
      if (field) path += "." + field;
      expected = keyword === "required"
        ? "provide this field"
        : "remove this undeclared field";
    } else if (keyword === "type") {
      expected = typeof p.type === "string" &&
        /^(string|number|integer|boolean|object|array|null)$/.test(p.type)
        ? p.type
        : "match the declared field type";
    } else if (
      ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
       "minLength", "maxLength", "minItems", "maxItems"].includes(keyword)
    ) {
      expected = typeof p.limit === "number" && Number.isFinite(p.limit)
        ? keyword + " " + p.limit
        : "satisfy the declared bound";
    } else if (keyword === "oneOf") {
      expected = "provide exactly one allowed combination";
    } else if (keyword === "anyOf") {
      expected = "provide an allowed combination";
    } else if (keyword === "not") {
      expected = "omit the forbidden combination";
    } else if (keyword === "enum") {
      expected = "use a value declared in inputSchema";
    }
    return { path, keyword, expected };
  });
  const first = errors[0];
  throw new AgentError(
    "invalid_arguments",
    first
      ? "Invalid arguments: " + first.path + " violates " + first.keyword +
        "; expected " + first.expected + "."
      : "The arguments do not match the declared schema.",
    { errors },
  );
}

export type SchemaDialect = "draft7" | "2020-12";
export function compileMethodSchema(
  schema: unknown,
  dialect?: SchemaDialect,
  references: readonly unknown[] = [],
): (value: unknown) => void {
  canonicalJson({ schema, references });
  const declared =
    schema && typeof schema === "object"
      ? (schema as Record<string, unknown>).$schema
      : undefined;
  const identified =
    declared === undefined
      ? undefined
      : declared === "http://json-schema.org/draft-07/schema#" ||
          declared === "http://json-schema.org/draft-07/schema"
        ? "draft7"
        : declared === "https://json-schema.org/draft/2020-12/schema" ||
            declared === "https://json-schema.org/draft/2020-12/schema#"
          ? "2020-12"
          : null;
  requireCondition(
    identified !== null &&
      (!dialect || dialect === "draft7" || dialect === "2020-12") &&
      (!identified || !dialect || identified === dialect) &&
      (identified || dialect),
    "unsupported_schema_dialect",
    "A method must identify a supported schema dialect without changing its source semantics.",
  );
  let validate: ValidateFunction;
  try {
    const compiler =
      (identified ?? dialect) === "2020-12"
        ? new Ajv2020(options)
        : new Ajv(options);
    addFormats(compiler);
    for (const reference of references)
      compiler.addSchema(reference as AnySchema);
    requireCondition(
      compiler.validateSchema(schema as AnySchema),
      "invalid_sdk_schema",
      "The method schema is invalid.",
    );
    validate = compiler.compile(schema as AnySchema);
  } catch (cause) {
    throw new AgentError(
      "invalid_sdk_schema",
      "The method schema or its declared references cannot be compiled.",
      undefined,
      { cause },
    );
  }
  return (value: unknown) => {
    // Native Buffer/Uint8Array and declared opaque parameters reach the actual
    // validator unchanged. Their type/size checks belong before handler effects.
    try {
      assertValid(validate, value);
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw new AgentError(
        "invalid_arguments",
        "The method arguments could not be checked against their declared schema.",
        undefined,
        { cause },
      );
    }
  };
}
