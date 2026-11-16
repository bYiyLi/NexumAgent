import { requireCondition } from "../contracts/errors.js";
import type { ExtensionFactory, MethodDefinition } from "../extensions/api.js";

const key = { type: "string", minLength: 1, maxLength: 256 };
const positiveVersion = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};

// Keep callable examples beside the positional normalizer that owns them.
// inputSchema below describes the *normalized* object, not JS arguments.
export const stateSdkUsage = `## JavaScript 调用签名（位置参数）

以下是脚本实际调用形式，不要把下方的内部 inputSchema 对象直接传给方法。

` + ["agent", "user"].flatMap((scope) => [
  `- \`state.${scope}.get(key: string)\`：读取，返回现有值及其 version；不存在时按 SDK 实际空值处理。`,
  `- \`state.${scope}.set(key: string, value: JSON, options: { expectedVersion: number | null })\`：条件写入。`,
  `- \`state.${scope}.delete(key: string, options: { expectedVersion: number })\`：条件删除。`,
]).join("\n") + `

~~~javascript
const current = await state.agent.get("example");
const saved = await state.agent.set("example", { count: 1 }, { expectedVersion: current?.version ?? null });
await state.agent.delete("example", { expectedVersion: saved.version });
// user 作用域使用相同的调用签名，如 state.user.get("example")。
~~~

首次创建时 expectedVersion 为 null；更新或删除必须使用读取到的实际版本，不要猜测版本号。脚本异常时先核对是否已发生写入，不要盲目重试。
`;
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
