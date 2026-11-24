import { requireCondition } from "../contracts/errors.js";
import type { ExtensionFactory, MethodDefinition } from "../extensions/api.js";
import { maintenanceMethods } from "../extensions/maintenance.js";
import { object, output, string, boolean, integer, nullable, array, enumeration, jsonObject } from "./schema.js";

const target = enumeration("package", "extension", "mcp", "api");
const status = enumeration("pending", "approved", "denied", "cancelled", "expired");
const authStatus = enumeration("not_required", "required", "ready", "failed");
const createdFields = { requestId: string, status, expiresAt: string, approvalUrl: string };
const created = object(createdFields, ["requestId", "status", "expiresAt"]);
const summary = object({ title: string, changeKinds: array(string), permissions: array(string),
  version: nullable(string), namespace: nullable(string), restartMayBeRequired: boolean });
const view = object({
  ...createdFields, agentId: string, profile: enumeration("development", "production"),
  target, action: string, name: string, revision: integer, candidateRevision: string,
  objectId: nullable(string), baseRevision: nullable(string), summary, authStatus, createdAt: string,
  agentName: string, source: object({ name: string }, []), decidedAt: string,
  decision: object({ status: enumeration("approved", "denied"), revision: integer, candidateRevision: string,
    decidedAt: string, decisionId: string }),
  execution: object({ operationId: string, startedAt: string, status: string, result: jsonObject,
    error: object({ code: string, message: string }) }, ["operationId", "startedAt"]),
}, ["requestId", "status", "expiresAt", "agentId", "profile", "target", "action", "name",
  "revision", "candidateRevision", "objectId", "baseRevision", "summary", "authStatus", "createdAt"]);
const stringMap = { type: "object", additionalProperties: string };
const mcpServer = { oneOf: [
  object({ type: { const: "stdio" }, command: { type: "string", minLength: 1 },
    args: { type: "array", maxItems: 256, items: string }, cwd: string,
    env: { ...stringMap, maxProperties: 256 }, credentialBindings: { ...stringMap, maxProperties: 256,
      propertyNames: { pattern: "^env\\..+$" } } }, ["command"]),
  object({ type: enumeration("sse", "http", "streamable-http"), url: { type: "string", minLength: 1, maxLength: 1024 },
    headers: { ...stringMap, maxProperties: 64 }, credentialBindings: { ...stringMap, maxProperties: 256,
      propertyNames: { pattern: "^headers\\..+$" } } }, ["url"]),
] };
const apiConfig = object({
  name: string, serviceUrl: string,
  authentication: object({
    operationSelections: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
    credentialBindings: stringMap,
    supplementalSchemes: { type: "object", additionalProperties: jsonObject },
    supplementalSecurity: array({ type: "object", additionalProperties: array(string) }),
  }, []),
  oauth: { type: "object", additionalProperties: object({
    issuer: string, authorizationEndpoint: string, tokenEndpoint: string, deviceAuthorizationEndpoint: string,
    jwksUri: string, clientId: string, clientAuthentication: enumeration("", "none", "client_secret_basic", "client_secret_post"),
    flow: enumeration("", "authorizationCode", "device", "clientCredentials"),
    scopes: array(string), oidc: boolean, allowHttp: boolean,
  }, []) },
  sourceAuthentication: object({ type: enumeration("none", "apiKey", "basic", "bearer"), name: string,
    in: enumeration("header", "query"), credentialRef: string }, ["type"]),
  credentialBindings: stringMap,
  limits: nullable(object(Object.fromEntries(
    ["documentBytes", "totalDocumentBytes", "referenceCount", "operationCount", "requestBytes", "responseBytes", "requestTimeoutMs"]
      .map(key => [key, { type: "integer", minimum: 1, maximum: 2147483647 }]),
  ), [])),
}, []);

export const maintenanceSdkUsage = `## JavaScript 维护申请示例

先检查当前状态，再根据实际需要提出安装、更新或配置申请；创建申请不代表批准或安装成功。

~~~javascript
return await maintenance.list({ target: "package", limit: 20 });
~~~

例如实际安装 npm 包时使用 maintenance.packages.install({ name, version }) 提交申请；返回的 requestId 用 maintenance.get(requestId) 回读审批与执行结果。MCP/API 配置、扩展启停均按下方实际方法表构造参数，不推测配置字段或绕过用户批准。

MCP 配置新增、修改或移除时，申请返回 status 为 pending，只表示等待用户确认。将返回的 approvalUrl 链接交给用户并说明需要在授权页确认；编辑 work/mcp.json、reload 或重启 Agent 都不能代替授权。

用户确认后 Nexum 会自动执行该修订，并切换对应 MCP 连接；不要重复调用 maintenance.mcp.update、手动重启 Agent 或尝试再次执行这份申请。使用 maintenance.get(requestId) 回读：status 为 approved 只说明用户同意；只有 execution.status 为 succeeded 且 execution.result.connection.state 为 ready，才确认 MCP 连接已就绪。连接移除成功时 state 为 removed。等待、失败或无执行结果时，向用户说明 requestId、实际状态和可用的错误代码，不要假报已生效或盲目重试。

## JavaScript 参数与返回

- packages.install/update({name, version?})、packages.remove({name})；extensions.enable/disable({name})。
- mcp.add/update({连接名: {command, args?, env?} 或 {url, headers?}})，一次提交一个 mcpServers 条目；mcp.remove({name})。
- api.import({name, url 或 path, config?})、api.update({name, url? 或 path?, config?})、api.remove({name})；import 必须且只能选择 url/path 之一，update 可仅调整已有配置。config 只提供实际支持的公开配置字段，授权页负责凭据，不在脚本或示例中填写密钥。
- 上述变更返回 {requestId, status, expiresAt, approvalUrl?}。
- get(requestId: string)、cancel(requestId: string) 返回申请视图，包含 requestId、target/action/name、status、revision/candidateRevision、summary、authStatus、createdAt/expiresAt，以及实际存在的 approvalUrl、decision、execution 等状态证据。
- list(options?: {target?, name?, status?, limit?, cursor?}) 返回 {requests: 申请视图[], nextCursor: string | null}。

get/cancel 是位置参数，不能传 {requestId} 代替字符串；其余方法按上方对象调用，完整字段类型/枚举由选中方法 Schema 提供。maintenance_unavailable 表示服务不可用；配置/认证/权限及候选修订错误以实际 code/message 为准，保留原 requestId，不能通过改文件或重启绕过批准。
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
            target,
            name: text,
            status,
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: { type: "string", minLength: 1, maxLength: 2048 },
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
      delete properties.name;
      required.length = 0;
    }
    if (group === "api" && action !== "remove")
      Object.assign(properties, {
        url: text,
        path: text,
        config: apiConfig,
      });
    methods[name] = {
      description: group
        ? group === "mcp" && action !== "remove"
          ? `申请 ${name}；配置申请直接传入一个命名 mcpServers 条目（如 filesystem: {command, args} 或 remote: {type: "sse" | "http", url, headers}），不包裹 name/config。返回 approvalUrl 供用户确认，批准后自动更新 MCP 连接。用 maintenance.get(requestId) 核对执行结果，无需重启 Agent。`
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
      inputSchema: group === "mcp" && action !== "remove"
        ? {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            minProperties: 1,
            maxProperties: 1,
            propertyNames: { pattern: "^[A-Za-z_$][A-Za-z0-9_.$-]{0,63}$" },
            additionalProperties: mcpServer,
          }
        : {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            properties,
            required,
            ...(group === "api" && action !== "remove" ? {
              ...(action === "import" ? { oneOf: [
                { properties: { url: text }, required: ["url"] },
                { properties: { path: text }, required: ["path"] },
              ] } : { not: { properties: { url: text, path: text }, required: ["url", "path"] } }),
            } : {}),
          },
      outputSchema: output(group ? created : name === "list" ?
        object({ requests: array(view), nextCursor: nullable(string) }) : view),
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
