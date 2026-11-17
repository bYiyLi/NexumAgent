import { requireCondition } from "../contracts/errors.js";
import type { ExtensionFactory, MethodDefinition } from "../extensions/api.js";

export const transferSdkUsage = `## JavaScript 传输示例

已有文件需要提供跨端下载时创建一次性下载 Offer：

~~~javascript
const path = await import("node:path");
const file = path.resolve(context.pwd, "report.pdf");
return await transfer.createDownload({ path: file, name: "report.pdf" });
~~~

接收外部上传用 transfer.createUpload({ path: targetPath })，已知大小时另传 expectedSize；用 transfer.get(transferId, { waitMs: 10000 }) 或 transfer.list() 查实际传输状态，传输未完成不等于文件已送达。transferId 必须来自真实结果；Offer 的 URL 不是本机文件路径。
`;

const boundedText = { type: "string", minLength: 1, maxLength: 4096 };
const upload = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: boundedText,
    expectedSize: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    expectedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    mimeType: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["path"],
};
const download = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: boundedText,
    uri: boundedText,
    name: { type: "string", minLength: 1, maxLength: 512 },
    mimeType: { type: "string", minLength: 1, maxLength: 256 },
  },
  oneOf: [
    { properties: { path: boundedText }, required: ["path"] },
    { properties: { uri: boundedText }, required: ["uri"] },
  ],
};
const query = {
  type: "object",
  additionalProperties: false,
  properties: {
    direction: { enum: ["upload", "download"] },
    status: {
      enum: [
        "preparing",
        "pending",
        "transferring",
        "cancelling",
        "succeeded",
        "failed",
        "cancelled",
        "expired",
        "interrupted",
      ],
    },
    runId: boundedText,
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: boundedText,
  },
};

/** Uses exactly the same call-bound service available to an external extension. */
export const transferExtension: ExtensionFactory = () => {
  const methods: Record<string, MethodDefinition> = {};
  for (const action of [
    "createUpload",
    "createDownload",
    "get",
    "list",
    "cancel",
  ] as const) {
    methods[action] = {
      description: {
        createUpload: "创建外部到 Agent 的一次性原始 bytes 上传通道。",
        createDownload: "固定本地文件或复用资源，创建一次性下载通道。",
        get: "查询传输事实，可短暂等待变化；不重签或续期。",
        list: "筛选当前 caller 的传输历史，不返回通道凭据。",
        cancel: "请求停止独立传输；收尾确认后才进入终态。",
      }[action],
      permissions: [`transfer.${action}`],
      normalize(args) {
        requireCondition(
          action === "list"
            ? args.length <= 1
            : action === "get"
              ? args.length >= 1 && args.length <= 2
              : args.length === 1,
          "invalid_arguments",
          "Use the transfer method's declared arguments.",
        );
        if (action === "createUpload" || action === "createDownload")
          return typeof args[0] === "string" ? { path: args[0] } : args[0];
        if (action === "list") return args[0] ?? {};
        return {
          transferId: args[0],
          ...(action === "get" ? { options: args[1] ?? {} } : {}),
        };
      },
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...(action === "createUpload"
          ? upload
          : action === "createDownload"
            ? download
            : action === "list"
              ? query
              : {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    transferId: {
                      type: "string",
                      pattern: "^tr_[0-9a-f]{32}$",
                    },
                    ...(action === "get"
                      ? {
                          options: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                              waitMs: {
                                type: "integer",
                                minimum: 0,
                                maximum: 30000,
                              },
                            },
                          },
                        }
                      : {}),
                  },
                  required:
                    action === "get"
                      ? ["transferId", "options"]
                      : ["transferId"],
                }),
      },
      handle(input, call) {
        if (action === "createUpload") return call.transfer.createUpload(input);
        if (action === "createDownload")
          return call.transfer.createDownload(input);
        if (action === "get")
          return call.transfer.get(input.transferId, input.options);
        if (action === "list") return call.transfer.list(input);
        return call.transfer.cancel(input.transferId);
      },
    };
  }
  return { methods };
};
