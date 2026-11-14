import type { ExtensionFactory } from "../extensions/api.js";

/** Uses exactly the same invocation service as external extension methods. */
export const runtimeExtension: ExtensionFactory = () => ({
  methods: {
    requestInput: {
      description:
        "等待本次运行的业务输入；通过原 waitId 单次续接，不重放脚本。",
      permissions: ["runtime.input"],
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          message: { type: "string", minLength: 1, maxLength: 16384 },
          inputSchema: { anyOf: [{ type: "object" }, { type: "boolean" }] },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
        required: ["message", "inputSchema"],
        additionalProperties: false,
      },
      handle: (input, call) => call.requestInput(input),
    },
  },
});
