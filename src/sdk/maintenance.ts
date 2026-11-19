import { requireCondition } from "../contracts/errors.js";
import type { ExtensionFactory, MethodDefinition } from "../extensions/api.js";
import { maintenanceMethods } from "../maintenance/requests.js";

export const maintenanceSdkUsage = `## JavaScript 维护申请示例

先检查当前状态，再根据实际需要提出安装、更新或配置申请；创建申请不代表批准或安装成功。

~~~javascript
return await maintenance.list({ target: "package", limit: 20 });
~~~

例如实际安装 npm 包时使用 maintenance.packages.install({ name, version }) 提交申请；返回的 requestId 用 maintenance.get(requestId) 回读审批与执行结果。MCP/API 配置、扩展启停均按下方实际方法表构造参数，不推测配置字段或绕过用户批准。

MCP 配置新增、修改或移除时，申请返回 status 为 pending，只表示等待用户确认。将返回的 approvalUrl 链接交给用户并说明需要在授权页确认；编辑 work/mcp.json、reload 或重启 Agent 都不能代替授权。

用户确认后 Nexum 会自动执行该修订，并切换对应 MCP 连接；不要重复调用 maintenance.mcp.update、手动重启 Agent 或尝试再次执行这份申请。使用 maintenance.get(requestId) 回读：status 为 approved 只说明用户同意；只有 execution.status 为 succeeded 且 execution.result.connection.state 为 ready，才确认 MCP 连接已就绪。连接移除成功时 state 为 removed。等待、失败或无执行结果时，向用户说明 requestId、实际状态和可用的错误代码，不要假报已生效或盲目重试。
`;

/** Public call-bound facade, identical for built-in and external extensions. */
export const maintenanceExtension: ExtensionFactory = () => {
  const methods: Record<string, MethodDefinition> = {};
  const text = { type: "string", minLength: 1, maxLength: 8192 };
  for (const name of [
    ...maintenanceMethods,
    "get",
    "list",
    "cancel",
  ] as const) {
    const parts = name.split("."),
      group = parts.length === 2 ? parts[0] : null,
      action = parts.at(-1)!;
    const properties: Record<string, unknown> = group
      ? { name: { type: "string", minLength: 1, maxLength: 214 } }
      : name === "list"
        ? {
            target: { enum: ["package", "extension", "mcp", "api"] },
            name: text,
            status: {
              enum: ["pending", "approved", "denied", "cancelled", "expired"],
            },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: text,
          }
        : { requestId: text };
    const required: string[] = group
      ? ["name"]
      : name === "list"
        ? []
        : ["requestId"];
    if (group === "packages" && action !== "remove")
      properties.version = { type: "string", minLength: 1, maxLength: 256 };
    if (group === "mcp" && action !== "remove") {
      properties.config = { type: "object" };
      required.push("config");
    }
    if (group === "api" && action !== "remove")
      Object.assign(properties, {
        url: text,
        path: text,
        config: { type: "object" },
      });
    methods[name] = {
      description: group
        ? group === "mcp"
          ? `申请 ${name}；返回 approvalUrl 供用户确认，批准后自动更新 MCP 连接。用 maintenance.get(requestId) 核对执行结果，无需重启 Agent。`
          : `申请 ${name}；用户确认最终修订后才实际执行。`
        : `${name === "get" ? "读取" : name === "list" ? "筛选" : "撤销尚未执行的"}维护申请；不批准或重签。`,
      permissions: [`maintenance.${name}`],
      path: parts,
      normalize(args) {
        requireCondition(
          name === "list" ? args.length <= 1 : args.length === 1,
          "invalid_arguments",
          "Use this maintenance method's declared arguments.",
        );
        return group
          ? args[0]
          : name === "list"
            ? (args[0] ?? {})
            : { requestId: args[0] };
      },
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties,
        required,
      },
      handle(input, call) {
        if (group) {
          const service = call.maintenance[
            group as "packages" | "extensions" | "mcp" | "api"
          ] as unknown as Record<string, (input: unknown) => unknown>;
          return service[action]!(input);
        }
        if (name === "get") return call.maintenance.get(input.requestId);
        if (name === "cancel") return call.maintenance.cancel(input.requestId);
        return call.maintenance.list(input);
      },
    };
  }
  return { methods };
};
