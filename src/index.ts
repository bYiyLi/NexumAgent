export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const help =
  [
    "NexumAgent — 本地 TypeScript Agent（工程初始化阶段）",
    "",
    "用法：nexum-agent [--help | --version]",
    "",
    "目前仅提供 CLI 工程骨架。Cloud 连接、受控 JavaScript Runtime",
    "和 SDK 扩展尚未实现，请勿将其用于实际 Agent 执行。",
  ].join("\n") + "\n";

export function runCli(args: readonly string[], version: string): CliResult {
  if (
    args.length === 0 ||
    (args.length === 1 && ["--help", "-h"].includes(args[0] ?? ""))
  ) {
    return { exitCode: 0, stdout: help, stderr: "" };
  }
  if (args.length === 1 && ["--version", "-v"].includes(args[0] ?? "")) {
    return { exitCode: 0, stdout: version + "\n", stderr: "" };
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: "NexumAgent 尚未实现执行能力；仅支持 --help 和 --version。\n",
  };
}
export type * from "./extension-api.js";
