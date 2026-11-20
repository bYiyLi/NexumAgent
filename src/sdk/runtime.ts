import { setTimeout as delay } from "node:timers/promises";
import { requireCondition } from "../contracts/errors.js";
import type { ExtensionFactory, Invocation } from "../extensions/api.js";

export const runtimeSdkUsage = `## JavaScript 调用示例

- \`await runtime.requestInput({ message, inputSchema, timeoutMs? })\`：等待用户输入，原 Run 续接。
- \`await runtime.sleep(milliseconds)\`：可取消的等待，单位毫秒，范围 1–3600000。取消原 Run 会立即打断此等待。
- \`await runtime.restart({reason:"apply-approved-updates"})\`：在当前 Run 完成后请求安全退出，让 systemd/launchd/Windows 启动器拉起新版 Core；执行前核实其他活跃任务，不自动重放脚本。

sleep 成功返回 null。requestInput 接受 {message: string, inputSchema: object | boolean, timeoutMs?: number}，返回原 Run 收到的 JSON 对象；只使用原 waitId 续接。restart 的 reason 只接受 apply-approved-updates 或 recover-agent，返回实际重启申请回执，不能据此声称新进程已上线；restart_unavailable 表示当前启动器不支持该操作。参数范围读取对应方法的真实 Schema；取消后不重放原脚本。

脚本需要等待时，直接使用 \`await runtime.sleep(ms)\`，不要写 \`await new Promise(resolve => setTimeout(resolve, ms))\`。后者及不支持取消的第三方 Promise 不会因 Run 收到取消请求而自动结束，Run 会如实保持 \`cancelling\` 直至主体和受管资源完成收尾。独立后台进程仍需按其资源 ID 管理。
`;

/** Uses exactly the same invocation service as external extension methods. */
export function createRuntimeExtension(
  restart?: (reason: string, call: Invocation) => unknown,
): ExtensionFactory {
  return () => ({
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
    ...(restart ? { restart: {
      description:
        "请求 Core 在本次 Run 成功保存后退出，由 OS 管理器重新拉起；不自动重放旧运行。",
      permissions: ["maintenance.execute"],
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          reason: {
            type: "string",
            enum: ["apply-approved-updates", "recover-agent"],
          },
        },
        required: ["reason"],
        additionalProperties: false,
      },
      handle(input, call) {
        call.authorize({ type: "maintenance", value: "agent", access: "execute" });
        requireCondition(restart, "restart_unavailable",
          "The Agent is not supervised by a restart-capable launcher.");
        return restart(input.reason, call);
      },
    }} : {}),
  },
  });
}
export const runtimeExtension: ExtensionFactory = createRuntimeExtension();
