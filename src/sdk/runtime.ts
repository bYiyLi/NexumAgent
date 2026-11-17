import { setTimeout as delay } from "node:timers/promises";
import { requireCondition } from "../contracts/errors.js";
import type { ExtensionFactory } from "../extensions/api.js";

export const runtimeSdkUsage = `## JavaScript 调用示例

- \`await runtime.requestInput({ message, inputSchema, timeoutMs? })\`：等待用户输入，原 Run 续接。
- \`await runtime.sleep(milliseconds)\`：可取消的等待，单位毫秒，范围 1–3600000。取消原 Run 会立即打断此等待。

脚本需要等待时，直接使用 \`await runtime.sleep(ms)\`，不要写 \`await new Promise(resolve => setTimeout(resolve, ms))\`。后者及不支持取消的第三方 Promise 不会因 Run 收到取消请求而自动结束，Run 会如实保持 \`cancelling\` 直至主体和受管资源完成收尾。独立后台进程仍需按其资源 ID 管理。
`;

/** Uses exactly the same invocation service as external extension methods. */
export const runtimeExtension: ExtensionFactory = () => ({
  methods: {
    sleep: {
      description: "可取消的等待；收到本次 Run 停止信号后立即中断，不重放脚本。",
      permissions: [],
      normalize(args) {
        requireCondition(
          args.length === 1,
          "invalid_arguments",
          "Call runtime.sleep(milliseconds) with one positional argument.",
        );
        return { milliseconds: args[0] };
      },
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { milliseconds: { type: "integer", minimum: 1, maximum: 3600000 } },
        required: ["milliseconds"],
        additionalProperties: false,
      },
      async handle(input, call) {
        await delay(input.milliseconds, undefined, { signal: call.signal });
        return null;
      },
    },
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
