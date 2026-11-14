import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  linkSync,
  chmodSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  CredentialVault,
  privateMaintenanceRead,
  privateMaintenanceWrite,
} from "../dist/maintenance/credentials.js";

const binding = {
  owner: "owner",
  agentId: "agent",
  profile: "development",
  target: "api",
  name: "crm",
  scheme: "key",
  service: "https://crm.example",
  authRevision: "fixed",
};
async function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-credentials-")),
  );
  mkdirSync(path.join(root, "work"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, vault: await CredentialVault.open(root) };
}

test("profile-private credentials persist across reopen, expose opaque refs and never enter work", async (t) => {
  const { root, vault } = await fixture(t),
    secret = "private-secret-for-vault",
    ref = await vault.create(binding, { value: secret });
  assert.match(ref, /^cred_[a-f0-9]{48}$/);
  assert.equal(ref.includes(secret), false);
  assert.deepEqual(await vault.read(ref, binding), { value: secret });
  const reopened = await CredentialVault.open(root);
  assert.deepEqual(await reopened.read(ref, binding), { value: secret });
  assert.deepEqual(readdirSync(path.join(root, "work")), []);
  const file = path.join(
    root,
    "state",
    "maintenance",
    "credentials",
    `${ref}.json`,
  );
  if (process.platform !== "win32")
    assert.equal(statSync(file).mode & 0o777, 0o600);
  const returned = await reopened.read(ref, binding);
  returned.value = "guest-mutation";
  assert.deepEqual(await vault.read(ref, binding), { value: secret });
});
test("credential references reject another owner/profile/target/service or malformed identity", async (t) => {
  const { vault } = await fixture(t),
    ref = await vault.create(binding, { token: "protected" });
  for (const [key, value] of Object.entries({
    owner: "other",
    agentId: "other",
    profile: "production",
    name: "other",
    service: "https://other.example",
    authRevision: "other",
  }))
    await assert.rejects(vault.read(ref, { ...binding, [key]: value }), {
      code: "credential_binding_mismatch",
    });
  await assert.rejects(vault.read("../../secret", binding), {
    code: "credential_reference_invalid",
  });
  await assert.rejects(vault.read(`cred_${"a".repeat(48)}`, binding), {
    code: "credential_binding_mismatch",
  });
});
test("trusted token updates preserve binding and atomically persist only at the existing reference", async (t) => {
  const { root, vault } = await fixture(t),
    ref = await vault.create(binding, {
      tokens: { access_token: "before" },
      clientSecret: "secret",
    });
  await Promise.all([
    vault.update(ref, binding, {
      tokens: { access_token: "first" },
      clientSecret: "secret",
    }),
    vault.update(ref, binding, {
      tokens: { access_token: "second" },
      clientSecret: "secret",
    }),
  ]);
  assert.equal((await vault.read(ref, binding)).tokens.access_token, "second");
  await assert.rejects(
    vault.update(
      ref,
      { ...binding, owner: "other" },
      { tokens: { access_token: "wrong" } },
    ),
    { code: "credential_binding_mismatch" },
  );
  assert.equal((await vault.read(ref, binding)).tokens.access_token, "second");
  assert.equal(
    readdirSync(path.join(root, "state", "maintenance", "credentials")).length,
    1,
  );
});
test("private maintenance data reject symlink/hardlink inputs and leave existing safe data intact", async (t) => {
  const { root } = await fixture(t),
    outside = path.join(root, "outside.json");
  writeFileSync(outside, '{"secret":"outside"}', { mode: 0o600 });
  const target = path.join(root, "state", "maintenance", "linked.json");
  symlinkSync(outside, target);
  await assert.rejects(privateMaintenanceRead(root, ["linked.json"]), {
    code: "credential_file_invalid",
  });
  await assert.rejects(
    privateMaintenanceWrite(root, ["linked.json"], { changed: true }),
    { code: "credential_file_invalid" },
  );
  rmSync(target);
  linkSync(outside, target);
  await assert.rejects(privateMaintenanceRead(root, ["linked.json"]), {
    code: "credential_file_invalid",
  });
  await assert.rejects(
    privateMaintenanceWrite(root, ["linked.json"], { changed: true }),
    { code: "credential_file_invalid" },
  );
  assert.equal(readFileSync(outside, "utf8"), '{"secret":"outside"}');
  const directory = path.join(root, "state", "maintenance", "redirect");
  symlinkSync(
    path.join(root, "work"),
    directory,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    privateMaintenanceWrite(root, ["redirect", "data.json"], {
      secret: "must-not-write",
    }),
    { code: "storage_path_escape" },
  );
  assert.deepEqual(readdirSync(path.join(root, "work")), []);
});
test("private store bounds reads, rejects permissive files, fixes exclusive identities and cleans temporary writes", async (t) => {
  const { root } = await fixture(t);
  await privateMaintenanceWrite(
    root,
    ["bounded.json"],
    { value: "fixed" },
    true,
  );
  await assert.rejects(
    privateMaintenanceWrite(
      root,
      ["bounded.json"],
      { value: "overwrite" },
      true,
    ),
    { code: "credential_file_exists" },
  );
  assert.deepEqual(await privateMaintenanceRead(root, ["bounded.json"]), {
    value: "fixed",
  });
  await assert.rejects(privateMaintenanceRead(root, ["bounded.json"], 4), {
    code: "credential_file_invalid",
  });
  if (process.platform !== "win32") {
    chmodSync(path.join(root, "state", "maintenance", "bounded.json"), 0o644);
    await assert.rejects(privateMaintenanceRead(root, ["bounded.json"]), {
      code: "credential_file_invalid",
    });
    chmodSync(path.join(root, "state", "maintenance", "bounded.json"), 0o600);
  }
  await assert.rejects(
    privateMaintenanceWrite(root, ["..", "data.json"], { invalid: true }),
    { code: "credential_path_invalid" },
  );
  assert.equal(
    readdirSync(path.join(root, "state", "maintenance")).some((value) =>
      value.startsWith(".private-"),
    ),
    false,
  );
});
