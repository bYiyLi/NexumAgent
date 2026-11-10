import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function invoke(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("CLI exposes its initialization-only status", () => {
  const result = invoke("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /工程初始化阶段/);
  assert.match(result.stdout, /尚未实现/);
  assert.equal(result.stderr, "");
});

test("CLI version matches package.json", () => {
  const result = invoke("--version");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), version);
  assert.equal(result.stderr, "");
});

test("CLI refuses unsupported Agent execution", () => {
  const result = invoke("connect");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /尚未实现执行能力/);
});
