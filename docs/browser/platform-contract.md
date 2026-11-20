# Nexum browser 使用的公共平台合同

本文件列出本包使用的公共语义和设计接线，不授权私有接口或修改 Agent 核心。公共扩展协议代码已有实现，独立协议包尚未发布；不能因这里有 TypeScript 设计就声称已安装可用。

## 加载与配置

普通 npm 包主入口为公开客户端，平台注册入口使用标准 exports["./nexum"]。静态 nexum 声明包含 apiVersion、namespace、权限及 instructions/docs/scripts/skills；Agent 显式配置已安装包和启用意图。先核对实际包/版本/路径和静态贡献，再求值工厂，全部方法/资料准备后整体发布。

包安装、扩展启用、实际初始化成功、浏览器插件加载和浏览器在线是独立事实。未启用时不初始化；同一 profile 单实例；模块顶层不创建持续副作用。跨 profile 共享实例或用模块变量保存“当前调用者”不允许。

## 最小工厂和调用接口

```typescript
interface ExtensionHost {
  readonly context: Readonly<Record<string, unknown>>; // 可信 Agent/profile 与公开 paths
  readonly config: Readonly<Record<string, unknown>>; // 本扩展获准配置
  readonly signal: AbortSignal;
  readonly resources: ResourceService;
  log(entry: {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    data?: Record<string, unknown>;
  }): void;
}
interface Invocation {
  readonly context: Readonly<Record<string, unknown>>; // 当前 run/caller/pwd/Project
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly resources: ResourceService;
  readonly output: OutputAPI;
  log(entry: {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    data?: Record<string, unknown>;
  }): void;
  progress(value: Record<string, unknown>): void;
  authorize(target: {
    type: "path" | "url" | "resource" | "connection";
    value: string;
    access: string;
  }): void;
  requestInput(request: {
    message: string;
    inputSchema: unknown;
    timeoutMs?: number;
  }): Promise<unknown>;
}
interface MethodDefinition {
  description: string;
  permissions: readonly string[];
  inputSchema: unknown;
  schemaDialect?: "2020-12" | "draft7";
  outputSchema?: unknown;
  path?: readonly string[];
  normalize?(args: readonly unknown[]): unknown;
  handle(input: unknown, call: Invocation): unknown;
}
interface ExtensionInstance {
  methods: Readonly<Record<string, MethodDefinition>>;
  dispose?(): void | Promise<void>;
}
type ExtensionFactory = (
  host: ExtensionHost,
) => ExtensionInstance | Promise<ExtensionInstance>;
```

这些是 browser 所用的公开合同子集；实际方言标签、权限注册键和服务类型以公共版本化协议定义为准。不能把上述 unknown 换成任意无校验 RPC：每个浏览器方法都要由包提供精确输入/输出类型、Schema 与规范化规则。公开包的实际导出与本文接线需做通用 conformance 验收。

normalize 仅做同步参数归一化，不做 I/O；方法进入 handler 前由核心校验、授权并登记 operation。返回值可为普通业务值/原生 Promise/bytes/公开结果意图；不能返回函数、自定义控制原型、Proxy、host/call、原始资源或底层 handler。浏览器链式对象由普通客户端据业务描述构造。

## 资源合同

```typescript
interface ManagedResource {
  readonly closed: Promise<void>;
  dispose(reason?: unknown): void | Promise<void>;
}
interface ResourceRef<T extends ManagedResource> {
  readonly id: string;
  readonly kind: string;
  readonly signal: AbortSignal;
  readonly value: T; // 只在扩展内部
  report(details: Record<string, unknown>): void;
}
interface ResourceService {
  register<T extends ManagedResource>(input: {
    kind: string;
    value: T;
  }): Promise<ResourceRef<T>>;
  get<T extends ManagedResource>(id: string): Promise<ResourceRef<T>>;
  handoff(id: string): Promise<unknown>;
}
```

先登记冷对象再启动，等待真实 listening/ready，实际关闭后 closed 才完成。host 资源为实例共享，call 资源默认随当前 run 收尾。get 是授权借用，不改归属；handoff 先持久确认再解除旧 run 信号，重试核对原事实。dispose 失败、closed 拒绝或超时需保留未确认项和控制身份；并发清理复用尝试，不能提前删除身份。

SDK handler 未被脚本 await 也由核心跟踪实际结算；单次 run 取消不调用共享实例 dispose。停用/换版先检查在途调用、固定版本脚本和独立后台业务资源，再关闭准入、触发 host.signal 并清理；空闲连接不能永久阻止停用。浏览器包负责把标准信号接到实际等待/协议/资源，不设置 run 终态。

## 公开结果合同

```typescript
interface OutputSource {
  path?: string;
  uri?: string;
  data?: ArrayBufferView | ArrayBuffer | SharedArrayBuffer | Blob;
  mimeType?: string;
  name?: string;
}
interface OutputOptions {
  name?: string;
  description?: string;
  mimeType?: string;
  annotations?: {
    audience?: ("user" | "assistant")[];
    priority?: number;
    lastModified?: string;
  };
}
interface OutputIntent {
  readonly kind:
    | "text"
    | "json"
    | "image"
    | "audio"
    | "resource_link"
    | "resource"
    | "collection"
    | "result";
  readonly value: unknown;
  readonly options: Readonly<OutputOptions>;
}
interface OutputAPI {
  text(value: string, options?: OutputOptions): OutputIntent;
  json(value: unknown): OutputIntent;
  image(source: string | OutputSource, options?: OutputOptions): OutputIntent;
  images(
    sources: readonly (string | OutputSource)[],
    options?: OutputOptions,
  ): OutputIntent;
  audio(source: string | OutputSource, options?: OutputOptions): OutputIntent;
  file(source: string | OutputSource, options?: OutputOptions): OutputIntent;
  resourceLink(
    source: string | OutputSource,
    options?: OutputOptions,
  ): OutputIntent;
  resource(
    source: string | OutputSource,
    options?: OutputOptions,
  ): OutputIntent;
  result(value: {
    content: readonly unknown[];
    structuredContent?: unknown;
    isError?: boolean;
  }): OutputIntent;
}
```

output 是内容意图包装，注册/固定真实产物、预算、编码和标准 MCP 交付由平台结果层承担。浏览器包可以使用 call.output 或返回公开带类型业务数据，不能获得内部 encoder/ArtifactStore/TransferManager。大文件传输沿公开 transfer 五方法（createUpload/createDownload/get/list/cancel），短期 Offer 不落历史，实际传输和创建运行分别记录。

## 通用接线验收前提

Phase 48 必须实现 npm 静态发现/启用、公开协议包、四类贡献、启动/退出资源协调、结果/数据面、维护与 Console。当前工厂/注册/资源组件已存在不代表这些产品链路已闭合。browser 包可作为真实 conformance 对象验证通用能力，但核心不得因它增加私有 manager 注入、browser 条件分支或自定义终态。

若字段/能力确有通用缺口，明确修改公共契约并同步所有使用者；不在扩展里绕过或向 Agent 主入口硬编码注册。测试必须证明无需 browser 包时，Agent 的其他功能、安装清单和运行不受影响。

## browser 接线的明确限制

- 没有 onRunEnd、终态写入或私有事件钩子。本包以 call.resources 登记 RunScope，使正常结束和取消都调用自己的 dispose/closed；不以 call.signal 仅在取消时触发来推断正常结束。
- handler 只返回纯数据/bytes/公开意图。Selector/Frame/Capability/WebMCP/Download 门面都在 Node 客户端构造；等待器三个方法是 browser 自己的受管贡献，不要求核心理解网页事件。
- call 服务仅在本次调用有效期间使用。RunScope 长期控制用已登记 ref.signal/ref.report 与扩展自有连接，收尾不能复用已结算 call.log/progress/output/authorize；新业务 I/O 必须使用新的真实 call。
- call.output.file 不立即生成 URI；call.resources.register 也不是文件资源登记 API。大快照先返回真实本机 artifact，再经最终 output 物化，不把缺少公开 ArtifactStore 当作导入私有模块的理由。
- 原生 Node 同进程不是安全沙箱；上述协议提供受管工作的一致性、授权和可观察性，不承诺阻止脚本绕过 SDK 使用 Node 原生 I/O。浏览器包无需为开放 Node 模型添加核心例外。
