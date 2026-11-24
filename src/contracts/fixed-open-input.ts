import { AgentError } from "./errors.js";
import { canonicalJson } from "./json.js";

function invalidOpenInput(keyword: string, expected: string, key?: string, declared = true): never {
  const path = key && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(key) &&
    (declared || !/(token|secret|password|credential|bearer)/i.test(key))
    ? "$." + key : "$";
  throw new AgentError(
    "invalid_arguments",
    "Invalid arguments: " + path + " violates " + keyword + "; expected " + expected + ".",
    { errors: [{ path, keyword, expected }] },
  );
}

// Node only receives Open parameters during Work preparation. Cloud/Wire
// contracts are owned by Go; this boundary still checks actual JSON values.
export function validateOpenInputV2(value: unknown): void {
  canonicalJson(value);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalidOpenInput("type", "object");
  const fields = value as Record<string, unknown>;
  if (!Object.hasOwn(fields, "agentId"))
    invalidOpenInput("required", "provide this field", "agentId");
  for (const key of Object.keys(fields)) {
    let maximum: number;
    switch (key) {
      case "agentId":
      case "projectId":
      case "contextId":
        maximum = 256;
        break;
      case "path":
        maximum = 8192;
        break;
      default:
        invalidOpenInput("additionalProperties", "remove the undeclared field", key, false);
    }
    const field = fields[key];
    if (typeof field !== "string") invalidOpenInput("type", "string", key);
    if (!field.length) invalidOpenInput("minLength", "minLength 1", key);
    if (field.length > maximum) {
      let count = 0;
      for (const _ of field) {
        if (++count > maximum) invalidOpenInput("maxLength", "maxLength " + maximum, key);
      }
    }
  }
  if (Object.hasOwn(fields, "projectId") && Object.hasOwn(fields, "path"))
    invalidOpenInput("not", "do not provide these fields together");
}
