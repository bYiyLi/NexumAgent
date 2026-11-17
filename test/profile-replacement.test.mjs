import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { acceptInstalledAgentIdentity } from "../dist/application/profile-replacement.js";

const token = "private-selected-token";
const serverUrl = "https://nexum-dev.example.test/";

async function fixture(t, oldAgentId = "agent_old") {
  const root = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "nexum-replacement-")),
  );
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await mkdir(path.join(root, "program"));
  await mkdir(path.join(root, "work"));
  await mkdir(path.join(root, "logs"));
  await writeFile(path.join(root, "work", "old-script.txt"), "old Agent work");
  await writeFile(path.join(root, "logs", "old.log"), "old Agent logs");
  const store = new SqliteStore(root, {
    agentId: oldAgentId,
    profile: "development",
    cloudEnvironment: "development",
  });
  store.close();
  const archiveId = randomUUID();
  const marker = path.join(root, "program", "identity-replacement.json");
  const intent = {
    profile: "development",
    serverUrl,
    tokenDigest: createHash("sha256").update(token).digest("hex"),
    archiveId,
  };
  const config = { profile: "development", root, token, serverUrl };
  const prepare = () => writeFile(marker, JSON.stringify(intent));
  return { root, marker, archiveId, intent, config, prepare };
}

test("explicit reinstall retires old Agent data only after binding to a new authenticated identity", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await acceptInstalledAgentIdentity(f.config, "agent_new"),
    false,
  );
  await f.prepare();
  assert.equal(await acceptInstalledAgentIdentity(f.config, "agent_new"), true);
  const archive = path.join(f.root, "previous-agents", f.archiveId);
  assert.equal(
    await readFile(path.join(archive, "work", "old-script.txt"), "utf8"),
    "old Agent work",
  );
  assert.equal(
    await readFile(path.join(archive, "logs", "old.log"), "utf8"),
    "old Agent logs",
  );
  const db = new DatabaseSync(path.join(archive, "state", "runtime.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    db.prepare("SELECT agent_id FROM runtime_meta WHERE singleton=1").get()
      .agent_id,
    "agent_old",
  );
  db.close();
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  const replacement = new SqliteStore(f.root, {
    agentId: "agent_new",
    profile: "development",
    cloudEnvironment: "development",
  });
  replacement.close();
  await assert.rejects(readdir(path.join(f.root, "work")), { code: "ENOENT" });
  assert.equal(
    await acceptInstalledAgentIdentity(f.config, "agent_new"),
    false,
  );
});

test("reinstall with the same Agent ID keeps work, logs and run history", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  assert.equal(
    await acceptInstalledAgentIdentity(f.config, "agent_old"),
    false,
  );
  assert.equal(
    await readFile(path.join(f.root, "work", "old-script.txt"), "utf8"),
    "old Agent work",
  );
  assert.equal(
    await readFile(path.join(f.root, "logs", "old.log"), "utf8"),
    "old Agent logs",
  );
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  await assert.rejects(readdir(path.join(f.root, "previous-agents")), {
    code: "ENOENT",
  });
});

test("mismatched install intent cannot replace a local Agent", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  await assert.rejects(
    acceptInstalledAgentIdentity(
      { ...f.config, token: "different-token" },
      "agent_new",
    ),
    { code: "agent_identity_replacement_failed" },
  );
  await assert.rejects(
    acceptInstalledAgentIdentity(
      { ...f.config, profile: "production" },
      "agent_new",
    ),
    { code: "agent_identity_replacement_failed" },
  );
  assert.equal(
    await readFile(path.join(f.root, "work", "old-script.txt"), "utf8"),
    "old Agent work",
  );
  assert.ok(await readFile(f.marker));
});

test("partial archive resumes with its fixed identity and never overwrites saved data", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const archive = path.join(f.root, "previous-agents", f.archiveId);
  await mkdir(archive, { recursive: true });
  await rename(path.join(f.root, "work"), path.join(archive, "work"));
  assert.equal(await acceptInstalledAgentIdentity(f.config, "agent_new"), true);
  assert.equal(
    await readFile(path.join(archive, "work", "old-script.txt"), "utf8"),
    "old Agent work",
  );
  assert.equal(
    await readFile(path.join(archive, "logs", "old.log"), "utf8"),
    "old Agent logs",
  );
});

test("redirected profile data never authorizes or receives an identity archive", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const outside = path.join(f.root, "external-work");
  await mkdir(outside);
  await writeFile(path.join(outside, "private.txt"), "do not touch");
  await rm(path.join(f.root, "work"), { recursive: true });
  await symlink(
    outside,
    path.join(f.root, "work"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(acceptInstalledAgentIdentity(f.config, "agent_new"), {
    code: "agent_identity_replacement_failed",
  });
  assert.equal(
    await readFile(path.join(outside, "private.txt"), "utf8"),
    "do not touch",
  );
  assert.ok(await readFile(path.join(f.root, "state", "runtime.sqlite")));
});
