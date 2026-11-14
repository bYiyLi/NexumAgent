import { requireCondition } from "../contracts/errors.js";
import type { ExtensionFactory, MethodDefinition } from "../extensions/api.js";

const key = { type: "string", minLength: 1, maxLength: 256 };
const positiveVersion = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
export const stateExtension: ExtensionFactory = () => {
  const methods: Record<string, MethodDefinition> = {};
  for (const scope of ["agent", "user"] as const) {
    for (const action of ["get", "set", "delete"] as const) {
      methods[`${scope}.${action}`] = {
        description: `${scope === "agent" ? "当前 Agent/profile 本地" : "Cloud 当前用户权威"}共享值${action === "get" ? "读取" : action === "set" ? "条件写入" : "条件删除"}。`,
        permissions: [`state.${scope}.${action === "get" ? "read" : "write"}`],
        path: [scope, action],
        normalize(args) {
          requireCondition(
            args.length ===
              (action === "set" ? 3 : action === "delete" ? 2 : 1),
            "invalid_arguments",
            "The shared operation requires its declared positional arguments.",
          );
          return {
            key: args[0],
            ...(action === "set"
              ? { value: args[1], options: args[2] }
              : action === "delete"
                ? { options: args[1] }
                : {}),
          };
        },
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          properties: {
            key,
            ...(action === "set" ? { value: {} } : {}),
            ...(action === "get"
              ? {}
              : {
                  options: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      expectedVersion:
                        action === "set"
                          ? { anyOf: [positiveVersion, { type: "null" }] }
                          : positiveVersion,
                    },
                    required: ["expectedVersion"],
                  },
                }),
          },
          required:
            action === "set"
              ? ["key", "value", "options"]
              : action === "delete"
                ? ["key", "options"]
                : ["key"],
        },
        handle(input, call) {
          const data = call.state[scope];
          if (action === "get") return data.get(input.key);
          if (action === "set")
            return data.set(input.key, input.value, input.options);
          return data.delete(input.key, input.options);
        },
      };
    }
  }
  return { methods };
};
