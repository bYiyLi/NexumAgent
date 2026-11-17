import { requireCondition } from "../contracts/errors.js";
import type { ExtensionFactory, MethodDefinition } from "../extensions/api.js";
import type { OutputAPI } from "./output.js";

export const outputSdkUsage = `## JavaScript 返回示例

普通文本或 JSON 可直接 return 原值。需要图片、音频、文件和资源时显式使用 output；返回本地路径不会自动交付文件。

~~~javascript
const { readFile } = await import("node:fs/promises");
const path = await import("node:path");
const bytes = await readFile(path.resolve(context.pwd, "screenshot.png"));
return output.image({ data: bytes, mimeType: "image/png" });
~~~

~~~javascript
return output.file("report.pdf", { name: "report.pdf" });
~~~

文件须真实存在且可在当前权限下读取；资源引用不等于模型已读取内容。需要混合内容与结构化数据时使用 output.result，具体形状查下方方法说明。
`;

type ScriptOutputMethod = Exclude<
  keyof OutputAPI,
  "mcpResult" | "mcpResourceResult"
>;
const descriptions: Record<ScriptOutputMethod, string> = {
  text: "返回文本内容。",
  json: "明确返回结构化业务数据，不将同形对象转换为媒体。",
  image: "预览一张真实图片。",
  images: "按顺序预览多张真实图片。",
  audio: "返回音频内容。",
  resourceLink: "固定本地文件并返回可通过 MCP Resources 获取的资源引用。",
  file: "返回文件资源引用，是 resourceLink 的简写。",
  embeddedResource: "在结果中嵌入受限大小的资源正文。",
  resource: "嵌入资源正文，是 embeddedResource 的简写。",
  result: "组合内容块、结构化业务数据和业务错误标记。",
  error: "返回业务错误，不设置运行终态。",
};

/** The script facade is registered by the same factory protocol as any npm extension. */
export const outputExtension: ExtensionFactory = () => {
  const methods: Record<string, MethodDefinition> = {};
  for (const name of Object.keys(descriptions) as ScriptOutputMethod[]) {
    const one = name === "json" || name === "result";
    methods[name] = {
      description: descriptions[name],
      permissions: ["output"],
      normalize(args) {
        requireCondition(
          args.length >= 1 && args.length <= (one ? 1 : 2),
          "invalid_arguments",
          "The output helper requires its declared value and optional metadata.",
        );
        return {
          value: args[0],
          ...(args.length === 2 ? { options: args[1] } : {}),
        };
      },
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: { value: {}, ...(one ? {} : { options: {} }) },
        required: ["value"],
      },
      handle(input, call) {
        return Reflect.apply(
          call.output[name],
          undefined,
          one ? [input.value] : [input.value, input.options],
        );
      },
    };
  }
  return { methods };
};
