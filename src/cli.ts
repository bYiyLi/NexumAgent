#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runCli } from "./index.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const args = process.argv.slice(2);
if (args[0] === "install") {
  if (
    args.length !== 3 ||
    args[1] !== "--profile" ||
    !["development", "production"].includes(args[2]!)
  ) {
    process.stderr.write(
      "install requires --profile production|development.\n",
    );
    process.exitCode = 2;
  } else {
    const server_url = process.env.NEXUM_BOOTSTRAP_SERVER;
    const token = process.env.NEXUM_BOOTSTRAP_TOKEN;
    delete process.env.NEXUM_BOOTSTRAP_SERVER;
    delete process.env.NEXUM_BOOTSTRAP_TOKEN;
    try {
      const { installNpmAgent } = await import("../scripts/npm-install.mjs");
      const result = await installNpmAgent({
        profile: args[2] as "development" | "production",
        version,
        config: { server_url, token },
      });
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch {
      process.stderr.write(
        "agent_install_failed: inspect current service and installed version before retrying.\n",
      );
      process.exitCode = 1;
    }
  }
} else if (args[0] === "run") {
  if (
    args.length !== 3 ||
    args[1] !== "--profile" ||
    !["development", "production"].includes(args[2]!)
  ) {
    process.stderr.write(
      "run 必须明确选择 --profile development 或 production。\n",
    );
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const { runAgent } = await import("./application/main.js");
      process.exitCode = await runAgent(
        args[2] as "development" | "production",
        { version, signal: controller.signal },
      );
    } catch {
      process.stderr.write("agent_failed\n");
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
} else {
  const result = runCli(args, version);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
