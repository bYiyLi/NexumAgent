import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

test("the npm Core package contains no native binaries or OS lifecycle installers", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "@nexum-hub/agent");
  assert.ok(!manifest.files.some((x) => x === "native" || x.startsWith("scripts/")),
    "Cloud owns the native supervisor, bootstrap and updater");
  const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: root, encoding: "utf8", timeout: 30000,
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const names = pack.files.map((entry) => entry.path);
  assert.ok(names.includes("dist/cli.js"));
  assert.ok(names.includes("contracts/v2/common.schema.json"));
  for (const name of names) {
    assert.doesNotMatch(name, /^(native\/|native-src\/|scripts\/)/,
      "Core npm must not ship a native binary or installation tool");
    assert.doesNotMatch(name, /\.map$/i, "Core npm should not ship source maps");
  }
});
