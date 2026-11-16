# Nexum browser 包、插件与独立发行

## 身份与安装

产品显示名固定 **Nexum browser**；npm 技术包名设计为 `@nexum/browser`，namespace 为 `browser`。技术包名的 registry 可用性、所有权、发布权限和许可证在正式发行前核实；2026-11-16 只读查询公共 registry 的该名称未找到可公开获取的版本；这不是名称保留或未来可发布保证，本设计不声称名称已取得。本包独立 semver，不以 Agent 版本代替插件/协议版本。

官方内置包是 Agent 仓库内维护的可选第一方包：Agent 默认依赖/安装命令/初始化/首次上线不包含它，未安装或未启用时没有其端口、SDK、文档注入或浏览器扫描。用户经 maintenance.packages.install 安装指定版本，再经 maintenance.extensions.enable 启用。卸载走先检查占用/停用，再 remove；仅 npm 安装成功不表示浏览器插件已经装好或已连接。

本包 `package.json` 的主要公开字段（实际文件为发行依据）：

```json
{
  "name": "@nexum/browser",
  "type": "module",
  "license": "UNLICENSED",
  "files": [
    "dist",
    "browser-extension",
    "instructions",
    "docs",
    "scripts",
    "skills",
    "README.md",
    "implementation.json"
  ],
  "exports": {
    ".": {
      "types": "./dist/client/index.d.ts",
      "import": "./dist/client/index.js"
    },
    "./nexum": {
      "types": "./dist/extension/index.d.ts",
      "import": "./dist/extension/index.js"
    }
  },
  "nexum": {
    "apiVersion": 1,
    "namespace": "browser",
    "permissions": ["connection", "path", "resource", "url"],
    "instructions": "./instructions/README.md",
    "docs": "./docs",
    "scripts": "./scripts",
    "skills": "./skills"
  }
}
```

permissions 表达需要连接、路径和资源能力；具体平台注册键及方法子集须以公共协议包正式导出固化，不以自创字符串授予权限。无 postinstall 自动启用/监听/浏览器安装/系统服务注册。内部使用公开 @nexum/sdk 类型；运行依赖仅为本包真实需要的 Node 库，不拉入 Avru/QuickJS/FRPC/Host 私有运行时。

## 五类贡献

- SDK：完整方法表及类型；普通入口只构造公开客户端，扩展入口负责受管实现。
- instructions：使用时机、先观察后操作再验证、目标/引用、默认全自动与用户停止、未知副作用不重放、结果实际交付、浏览器原生限制。
- docs：完整 SDK/类型、连接/安装、生命周期、文件/媒体、故障、权限、兼容矩阵和复杂示例；本包手册由 Nexum 生成阅读副本。
- scripts：真实 .js 元数据/Schema 的可复用流程，如浏览器发现、页面观察、截图与文件交付、页面操作验证；不自动执行。
- Skills：按任务选择浏览器控制、页面验收、资料提取和下载/附件流程；先元数据，再正文及相对资源。

五类内容的 owner/namespace/版本/修订统一；启停换版整体准备/发布，不混合新手册与旧方法。资料源留包内，生成导航/副本沿通用机制，不覆盖 Agent 根 README、其他扩展或全局资料目录。用户指令及模型权限不由网页内容覆盖。

## 浏览器插件交付

每个 npm 制品携带匹配版本的 production/development 插件构建和 release-info（包/插件/协议版本、稳定 ID、文件 hash/平台范围）。包维护把插件文件准备到 profile 稳定目录；浏览器原生确认由用户完成，更新后需重新加载时明确反馈，不能静默操作浏览器扩展管理页。

生产与开发插件各有稳定公钥/ID、显示名称与独立 storage，固定对应端口和 profile。不得从 npx 缓存、临时构建目录或另一 profile 加载。退出/停用/卸载包会中止连接，浏览器插件显示离线并退避；不删除用户浏览器配置、书签、历史或全部下载。

## 独立 npm 发布资格

1. 检查技术名称/权限、许可证及依赖告知，固定源 revision、锁文件、制品 SHA-256/512；未取得发布权限不声称已发布。
2. 三平台 package build/check、干净环境安装/启用/停用、两 profile 共存、Chrome/Edge 真插件、完整 SDK/文件/Host 验收通过，逐项记录限制。
3. 先用 npm pack --json 生成候选，检查**实际 tarball 的文件、链接目标、字节与 hash**（dry-run 仅作预检）：仅本包运行文件、自己编写的手册/脚本/Skills、配套插件和必要许可；没有源码秘密、数据、缓存、测试临时文件或原始参考。
4. 必须排除 `docs/browser/archive/**`、Avru 原始文档、`26.1103.32239/**`、原始 API/能力文档、OpenAI 运行脚本/二进制、node_modules、Cloud 私有设计及本机状态。发布手册从本包现行 SDK/类型/使用正文生成，不能原样复制含 archive 链接的开发设计目录；tarball 内手册的本地链接也必须全部可用。资料归档不授予对外再分发许可；公开 Git 提交/推送前也需单独核实参考资料可分发边界。
5. 使用本包自己的版本与 dev/latest 标签；Agent 发行不自动发布本包，本包发行不更新 Agent 二进制。发布动作需要实际发行任务授权，不由本次设计写入推定。
6. 发布后只读回查 registry 名称/版本/完整性、下载同一 tarball，验证导入入口和固定插件 hash。结果未知先查状态，不盲目重发版本。npm 可获取、用户已安装、插件已加载、已连接和完整产品验收分别记录。

仓库归档、设计完成、npm 候选、真实发布和用户机器接入各有独立证据。发布前清单检查是本包验收的一部分，不能靠忽略目录名称假定没有打包原始资料。
