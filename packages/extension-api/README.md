# @nexum-hub/sdk — Nexum 扩展协议类型

此包由 Agent 的 `src/extension-api.ts` 自动生成，包含扩展工厂、调用上下文、资源及公开 SDK 的 TypeScript 类型。类型协议没有运行初始化逻辑，不启动 Agent、不读取配置或凭据，也不提供私有 Core manager。

```ts
import type { ExtensionFactory } from "@nexum-hub/sdk";

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

在 Agent 仓库运行 `node scripts/build-extension-api.mjs` 生成本地 `dist`。这是供 Nexum 扩展开发者使用的类型协议包，**不是**通用 AI Host SDK；以 npm Registry 实际状态判断是否已经发布。
