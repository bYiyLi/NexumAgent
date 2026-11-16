import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installNpmAgent } from "../scripts/npm-install.mjs";

async function packageSource(home, version) {
  const source = path.join(home, "source-" + version);
  for (const name of ["dist", "contracts", "scripts", "node_modules"]) {
    await mkdir(path.join(source, name), { recursive: true });
  }
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ name: "@nexum-hub/agent", version, type: "module" }),
  );
  await writeFile(
    path.join(source, "dist/cli.js"),
    "console.log(" + JSON.stringify(version) + ");\n",
  );
  await writeFile(path.join(source, "contracts/fixture.schema.json"), "{}");
  for (const name of ["service.mjs", "npm-install.mjs", "service-runner.mjs"]) {
    await writeFile(
      path.join(source, "scripts", name),
      "export const testFixture = true;\n",
    );
  }
  return source;
}

test(
  "npm installer stages a pinned runtime/version, retains credentials and does not register a real service in isolation",
  { timeout: 120000 },
  async (t) => {
    const scratch = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), "nexum-npm-installer-fixture-")),
    );
    t.after(async () =>
      rm(scratch, { recursive: true, force: true, maxRetries: 3 }),
    );
    const home = path.join(scratch, "home");
    await mkdir(home, { mode: 0o700 });
    const firstSource = await packageSource(scratch, "0.0.1");
    const inputs = {
      profile: "development",
      version: "0.0.1",
      source: firstSource,
      home,
      register: false,
      config: {
        server_url: "http://127.0.0.1:8123/",
        token: "private-test-token",
      },
    };
    const first = await installNpmAgent(inputs);
    assert.deepEqual(first, {
      profile: "development",
      version: "0.0.1",
      serviceRegistered: false,
      startRequested: false,
    });
    const root = path.join(home, ".nexum-dev");
    assert.equal(
      JSON.parse(await readFile(path.join(root, "program/active.json"), "utf8"))
        .version,
      "0.0.1",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).token,
      "private-test-token",
    );
    assert.equal((await stat(path.join(root, "config.json"))).mode & 0o077, 0);
    const runtime = path.join(
      root,
      "program/runtime",
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
    assert.ok((await stat(runtime)).isFile());
    assert.equal((await installNpmAgent(inputs)).version, "0.0.1");
    assert.equal(
      (await readFile(path.join(root, "config.json"), "utf8")).includes(
        "private-test-token",
      ),
      true,
    );
    assert.ok(
      (
        await stat(path.join(root, "program/versions/0.0.1/app/dist/cli.js"))
      ).isFile(),
    );
    const secondSource = await packageSource(scratch, "0.0.2");
    const second = await installNpmAgent({
      profile: "development",
      version: "0.0.2",
      source: secondSource,
      home,
      register: false,
    });
    assert.equal(second.version, "0.0.2");
    assert.equal(
      JSON.parse(await readFile(path.join(root, "program/active.json"), "utf8"))
        .version,
      "0.0.2",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).token,
      "private-test-token",
    );
    assert.ok(
      (
        await stat(path.join(root, "program/versions/0.0.1/app/package.json"))
      ).isFile(),
      "old version must remain for recovery",
    );
    await assert.rejects(
      () =>
        installNpmAgent({
          profile: "production",
          version: "0.0.3",
          home,
          register: false,
        }),
      /Server URL and Agent Token/,
    );
  },
);
