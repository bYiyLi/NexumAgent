export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const help =
  [
    "NexumAgent — 本地可编程 TypeScript Agent",
    "",
    "用法：nexum-agent [--help | --version]",
    "      nexum-agent run --profile development|production",
    "",
    "run 使用所选 profile 的 config.json，连接其配置的 Server。",
    "启动 run 时，Node 必须带 --experimental-vm-modules。",
    "development 使用 ~/.nexum-dev，production 使用 ~/.nexum。",
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
    stderr: "无效命令。使用 --help 查看支持的命令。\n",
  };
}
export type * from "./extension-api.js";
