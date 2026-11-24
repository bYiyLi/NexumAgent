import { requireCondition } from "../contracts/errors.js";
import type { ExtensionHandle } from "../extensions/registry.js";
import { methodSkill } from "../work/method-skills.js";
import { shSdkUsage, shSdkCalling, shSdkErrors } from "./sh.js";

export type PlatformNamespace = "sh";

/** Only the process SDK is implemented by a Node platform Worker. */
export function platformSkill(namespace: PlatformNamespace, handle: ExtensionHandle) {
  requireCondition(namespace === "sh" && handle.origin.type === "platform" && handle.origin.namespace === namespace,
    "invalid_platform_source", "The shell Skill must use its actual Registry source.");
  requireCondition(handle.methods.every(method => Object.hasOwn(method, "outputSchema")),
    "invalid_platform_contract", "Every registered shell method must declare its successful result contract.");
  const name = "managed-processes";
  const description = "需要启动或执行受管命令、PTY，按真实 processId 观察、读写或停止进程，或查询可执行文件与进程环境时使用；普通文件处理使用 Node/npm。";
  return { name, generated: methodSkill({ name, description, usage: shSdkUsage, calling: shSdkCalling, errors: shSdkErrors,
    origin: handle.origin, bindingPath: [namespace], methods: handle.methods }) };
}
