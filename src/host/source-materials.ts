import { createHash } from "node:crypto";
import { requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { ContributionOrigin, JsonObject } from "../contracts/types.js";
import { compileMethodSchema, type SchemaDialect } from "../contracts/validation.js";
import { methodSkill } from "../work/method-skills.js";

interface SourceMethod {
  id: string;
  operation: string;
  metadata: JsonObject & { path: string[]; description: string };
}
interface Source {
  kind: "mcp" | "api";
  objectId: string;
  name: string;
  revision: string;
  approvalRevision: string;
  instanceId: string;
  methods: SourceMethod[];
}

const expression = (root: string, parts: readonly string[]) =>
  root + parts.map((part) => `[${JSON.stringify(part)}]`).join("");

/** Renders Go's already-approved method table; no transport, vault or Registry lives here. */
export function prepareSourceMaterials(instanceId: string, value: unknown) {
  requireCondition(isPlainRecord(value) && value.instanceId === instanceId &&
    isPlainRecord(value.source) && typeof value.version === "string" && value.version.length > 0 &&
    value.version.length <= 256 && typeof value.description === "string" && value.description.length <= 4096,
  "invalid_source_materials", "The source preparation must come from the authenticated Go application.");
  const fixed = JSON.parse(canonicalJson(value, 4 * 1024 * 1024)) as typeof value;
  const source = fixed.source as unknown as Source;
  requireCondition((source.kind === "mcp" || source.kind === "api") &&
    /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(source.name) && !["mcp", "api"].includes(source.name) &&
    [source.objectId, source.revision, source.approvalRevision, source.instanceId].every((part) =>
      typeof part === "string" && part.length > 0 && part.length <= 256 && !/[\0\r\n]/.test(part)) &&
    Array.isArray(source.methods) && source.methods.length <= 10000,
  "invalid_source_materials", "The actual source identity and method table are required.");
  const ids = new Set<string>(), paths = new Set<string>();
  const examples: string[] = [];
  for (const method of source.methods) {
    requireCondition(isPlainRecord(method) && typeof method.id === "string" && method.id.length > 0 &&
      !ids.has(method.id) && typeof method.operation === "string" && isPlainRecord(method.metadata),
    "invalid_source_materials", "A source method must have a unique identity and actual metadata.");
    ids.add(method.id);
    const metadata = method.metadata;
    const publicName = method.operation === "resources/templates/list" && source.kind === "mcp"
      ? "resources/listTemplates" : method.operation;
    requireCondition(metadata.name === publicName && Array.isArray(metadata.path) &&
      metadata.path.length > 0 && metadata.path.length <= 3 && metadata.path.every((part) =>
        typeof part === "string" && part.length > 0 && part.length <= 2048 && !/[\0\r\n]/.test(part)) &&
      typeof metadata.description === "string" && Object.hasOwn(metadata, "inputSchema") &&
      !paths.has(JSON.stringify(metadata.path)),
    "invalid_source_materials", "The source must describe the exact public calling path and input.");
    paths.add(JSON.stringify(metadata.path));
    if (source.kind === "mcp" && method.operation.startsWith("tools/"))
      requireCondition(canonicalJson(metadata.path) === canonicalJson([`tool_${method.operation.slice(6)}`]),
        "invalid_source_materials", "MCP tools use only tool_ plus the original upstream name.");
    else if (source.kind === "api")
      requireCondition(metadata.path.length === 1 && metadata.path[0] === method.operation &&
        isPlainRecord(metadata.openapi), "invalid_source_materials", "API methods require their actual operation description.");
    else requireCondition(["resources", "prompts", "tasks"].includes(metadata.path[0]!),
      "invalid_source_materials", "MCP methods must belong to their actual protocol capability.");
    requireCondition(metadata.schemas === undefined || Array.isArray(metadata.schemas),
      "invalid_source_materials", "Declared schema dependencies must remain an array.");
    const schemas = metadata.schemas as readonly unknown[] | undefined;
    const validate = compileMethodSchema(metadata.inputSchema, metadata.schemaDialect as SchemaDialect, schemas);
    if (Object.hasOwn(metadata, "outputSchema"))
      compileMethodSchema(metadata.outputSchema,
        (metadata.outputSchemaDialect ?? (isPlainRecord(metadata.outputSchema) &&
          Object.hasOwn(metadata.outputSchema, "$schema") ? undefined : metadata.schemaDialect)) as SchemaDialect, schemas);
    const call = expression(source.name, metadata.path);
    const declared = isPlainRecord(metadata.inputSchema) && Array.isArray(metadata.inputSchema.examples)
      ? metadata.inputSchema.examples : [];
    if (declared.length) {
      validate(declared[0]);
      examples.push(`### ${call}\n\n\`\`\`javascript\nreturn await ${call}(${canonicalJson(declared[0])});\n\`\`\`\n`);
    } else {
      examples.push(`### ${call}\n\n以下函数接收满足方法 inputSchema 的真实 input，不补造业务参数。\n\n` +
        `\`\`\`javascript\nasync function invoke(input) {\n  return await ${call}(input);\n}\n\`\`\`\n`);
    }
  }
  const owner = `${source.kind}:${source.objectId}`;
  const suffix = createHash("sha256").update(owner).digest("hex").slice(0, 12);
  const name = `${source.kind}-${source.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42).replace(/-$/, "") || "source"}-${suffix}`;
  const origin: ContributionOrigin = { type: "local", owner, namespace: source.name,
    version: fixed.version as string, revision: source.revision };
  const usage = source.kind === "mcp"
    ? "# MCP 调用\n\n每个工具接收一个 arguments 对象；无参数调用按空对象处理。tools/call 使用原始工具名，SDK 只提供 tool_ 前缀方法。\n\n" +
      "工具返回上游真实 content、structuredContent、isError 和元数据；isError 不等于传输失败。工具声明的 outputSchema 校验 structuredContent；未声明时不补造返回字段。Resources、Prompts 与 Tasks 仅在实际方法表公开时按各自的 inputSchema 调用，保留各自结果，不把任务状态当最终工具结果。本地取消或远端取消回执不证明远端已终止。\n\n"
    : "# OpenAPI 调用\n\n每个操作接收一个对象：path、query、headers、cookies 按参数位置分组；body 是请求体，contentType 和 accept 选择已声明媒体。必填、编码规则、媒体、认证方案与响应见方法元数据的 openapi 字段。密钥由 Go 使用已批准绑定注入，脚本和手册不包含凭据。\n\n" +
      "返回 { ok, status, headers, data }，必要时附 redacted；保留实际 HTTP 状态和响应内容。非成功 HTTP 响应抛 api_http_error 并保留可交付的 response；文件内容通过真实 Blob/File 或受管引用交付。openapi.operation.responses 保留来源声明的响应状态、头和正文，openapi.errorsReference 指向实际公开错误；缺少正文 Schema 不代表已知其字段。顶层 inputSchema 只校验参数分组，原生 OpenAPI 字段约束、请求体和响应 Schema 由 Go 按同一获准规范校验，不将它们伪装成另一种 JSON Schema 方言。认证由 Go 注入，不在示例中填写密钥或手工添加认证头。\n\n";
  requireCondition(fixed.references === undefined || (isPlainRecord(fixed.references) &&
    Object.entries(fixed.references).every(([name, content]) => /^source-[1-9][0-9]*\.json$/.test(name) && typeof content === "string")),
  "invalid_source_materials", "Source references must contain the approved document bundle only.");
  for (const content of Object.values(fixed.references ?? {})) {
    let document: unknown;
    try { document = JSON.parse(content as string) as unknown; } catch { /* Rejected below. */ }
    requireCondition(isPlainRecord(document), "invalid_source_materials",
      "A public source reference must contain a JSON object.");
  }
  const generated = methodSkill({ name, description: `${source.name}：${fixed.description || `调用已批准的 ${source.kind} 来源`}`.slice(0, 1024),
    origin, bindingPath: [source.name], methods: source.methods.map((method) => method.metadata),
    usage: usage + examples.join("\n"), references: fixed.references as Record<string, string> | undefined });
  const result = { source, origin, metadata: generated.metadata, revision: generated.revision,
    files: [...generated.files].map(([name, content]) => ({ name, content })) };
  canonicalJson(result, 15 * 1024 * 1024);
  return result;
}
