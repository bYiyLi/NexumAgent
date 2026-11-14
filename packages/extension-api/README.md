# Nexum 扩展协议类型

此包由 Agent 的 `src/extension-api.ts` 自动生成，包含扩展工厂、调用上下文、资源及公开 SDK 的 TypeScript 类型。类型协议没有运行初始化逻辑，不启动 Agent、不读取配置或凭据，也不提供私有 Core manager。

```ts
import type { ExtensionFactory } from "@nexum/extension-api";

export const createExtension: ExtensionFactory = (host) => ({
  methods: {
    hello: {
      description: "返回问候",
      permissions: [],
      inputSchema: { type: "object", additionalProperties: false },
      schemaDialect: "2020-12",
      handle: () => "hello",
    },
  },
});
```

在 Agent 仓库运行 `node scripts/build-extension-api.mjs` 生成本地 `dist`。本包当前为本地可审阅候选，尚未发布到 npm；生成和打包成功不表示已在外部用户环境完成安装验收。
