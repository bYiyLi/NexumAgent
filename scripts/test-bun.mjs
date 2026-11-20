import { spawn } from "node:child_process";

// This is a Bun integration gate, not a replacement for the Node test suite.
// A managed Nexum Core sets NEXUM_CLOUD_BOOTSTRAP=1; that production-only
// guard must not leak into the standalone package-approval test fixtures.
const env = { ...process.env };
delete env.NEXUM_CLOUD_BOOTSTRAP;

const suites = [
  "test/application-runtime.test.mjs",
  "test/modules.test.mjs",
  "test/work.test.mjs",
  "test/artifacts.test.mjs",
  "test/openapi-request.test.mjs",
  "test/openapi-schema.test.mjs",
  "test/openapi.test.mjs",
  "test/extension-worker-boundary.test.mjs",
  "test/worker-package-gate.test.mjs",
  "test/extensions-service.test.mjs",
];
const executable = process.env.NEXUM_BUN_EXECUTABLE || "bun";
const worker = spawn(executable, ["test", "--timeout=20000", ...suites], {
  stdio: "inherit",
  env,
  shell: false,
});
const code = await new Promise((resolve) => {
  worker.once("error", (error) => {
    console.error("Bun integration tests could not start:", error.message);
    resolve(1);
  });
  worker.once("exit", (status, signal) => {
    if (signal) console.error("Bun integration tests stopped:", signal);
    resolve(status ?? 1);
  });
});
process.exitCode = code;
