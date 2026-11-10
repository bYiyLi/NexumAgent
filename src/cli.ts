#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runCli } from "./index.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const result = runCli(process.argv.slice(2), version);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
