# Desktop Environment Runtime

状态：部分实现，未完成验收（2026-11-27）。

## 范围与边界

依照已确认的 Local/SSH 统一环境访问方案，提供 Go Runtime、连接生命周期、环境身份与持久化、安全主机验证、原生凭据存储，以及实际 UI 接线。与 Desktop Bootstrap、版本更新和原生窗口相互独立。不实现 Agent 检查、安装、生命周期或 Cloud 转发。

设计契约见 [Desktop 设计基线](../desktop/design.md#environment-runtime-统一契约)。

## 实现状态

| 任务 | 状态 |
| --- | --- |
| Local/SSH Runtime、命令结果、目标路径及 SFTP | 源码已实现；真实 loopback SSH/SFTP 专项通过 |
| SSH 密码、加密私钥、本机 SSH Agent、主机身份固定与取消 | 真实协议专项通过（生成测试密钥、隔离监听端口） |
| SQLite Schema 2、环境元数据及主机指纹 | 已实现；专项迁移与隔离测试 |
| macOS Keychain / Windows Credential Manager | 源码已实现；独立真实系统凭据验收待完成 |
| Wails 环境连接服务与前端真实模式组件 | 源码已实现 |
| App.tsx 主应用真实连接接线 | 已接入真实 Local/SSH 状态与生命周期入口；开发预览隔离；真机端到端仍需验收 |
| Windows/Linux 实际远程主机兼容、原生端到端 UI | 待验收 |

## 验收要求

- 本机命令/文件操作，真实 SSH/SFTP 认证、读写、传输、错误与断线；首次信任确认前不发送认证凭据，主机密钥变化必须阻断。
- 新旧 SQLite 迁移、备份、设置保留、Profile 隔离、唯一目标与信任固定；秘密不得进入 SQLite/持久日志。
- 完整 Desktop 检查、竞争检测、跨平台编译；新真实迁移的 macOS 隔离 DMG 升级。
- 主应用真实状态、真实连接/信任/取消/重试/切换/断开/移除及失败状态端到端；开发预览不能伪装真实成功。原生凭据及 Windows/Linux 目标须独立验收。
- 不提交、推送、发布或操作生产 Agent；保留并行修改。当前阶段不能标记完成。
