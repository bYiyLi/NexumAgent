import { requireCondition } from "../contracts/errors.js";
import { digest } from "../contracts/json.js";
import type { ExtensionFactory, Invocation } from "../extensions/api.js";
import type { ExtensionHandle } from "../extensions/registry.js";
import { methodSkill } from "../work/method-skills.js";
import { createRuntimeExtension, runtimeSdkUsage } from "./runtime.js";
import { stateExtension, stateSdkUsage } from "./state.js";
import { shExtension, shSdkUsage } from "./sh.js";
import { transferExtension, transferSdkUsage } from "./transfer.js";
import { maintenanceExtension, maintenanceSdkUsage } from "./maintenance.js";

export const platformNamespaces = ["runtime", "state", "sh", "transfer", "maintenance"] as const;
export type PlatformNamespace = (typeof platformNamespaces)[number];

/** These are the factories used by the existing application, including their normalizers. */
export function platformFactories(restart: (reason: string, call: Invocation) => unknown): Record<PlatformNamespace, ExtensionFactory> {
  return {
    runtime: createRuntimeExtension(restart),
    state: stateExtension,
    sh: shExtension,
    transfer: transferExtension,
    maintenance: maintenanceExtension,
  };
}

const selections: Record<PlatformNamespace, readonly [string, string, string]> = {
  runtime: ["runtime-control", "需要可取消等待、向用户收集本次 Run 的业务输入，或请求已获授权的 Agent 安全重启时使用。", runtimeSdkUsage],
  state: ["shared-state", "需要读取、按实际版本条件写入或删除当前 Agent/profile 或 Cloud 用户的跨 Run 共享值时使用。", stateSdkUsage],
  sh: ["managed-processes", "需要启动或执行受管命令、PTY，按真实 processId 观察、读写或停止进程，或查询可执行文件与进程环境时使用；普通文件处理使用 Node/npm。", shSdkUsage],
  transfer: ["file-transfer", "需要创建 Agent 与外部之间的一次性上传或下载通道，查询实际传输状态或请求取消传输时使用。", transferSdkUsage],
  maintenance: ["environment-maintenance", "需要申请安装、更新或移除 npm 包，启停 SDK 扩展，配置 MCP/API 接入，或查询和撤销维护申请时使用；申请回执不代表已经批准或执行。", maintenanceSdkUsage],
};

/** Render documentation only from an actual prepared platform Registry handle. */
export function platformSkill(namespace: PlatformNamespace, handle: ExtensionHandle) {
  requireCondition(handle.origin.type === "platform" && handle.origin.namespace === namespace,
    "invalid_platform_source", "The platform Skill must use its actual Registry source.");
  const [name, description, usage] = selections[namespace];
  return { name, generated: methodSkill({ name, description, usage,
    origin: handle.origin, bindingPath: [namespace], methods: handle.methods }) };
}

/** Projection for Go's authority to compare against the published Registry handle. */
export function platformMethodProjection(namespace: PlatformNamespace, handle: ExtensionHandle) {
  requireCondition(handle.origin.type === "platform" && handle.origin.namespace === namespace &&
    typeof handle.origin.revision === "string" && handle.origin.revision.length > 0,
  "invalid_platform_source", "The platform method table must use its actual source revision.");
  const objectId = `platform:${namespace}`;
  return handle.methods.map((method) => {
    requireCondition(typeof method.name === "string" && Array.isArray(method.path) &&
      method.path.every((part) => typeof part === "string"),
    "invalid_method", "A platform method requires its actual Registry name and path.");
    const methodPath = [namespace, ...method.path];
    return {
      id: `platform_${digest([objectId, handle.origin.revision!, methodPath])}`,
      operation: method.name,
      metadata: method,
    };
  });
}
