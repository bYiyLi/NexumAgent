import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import {
  loadProfileConfig,
  profileRoot,
  validateServerUrl,
} from "../dist/application/config.js";
const credential = "synthetic-private-agent-token";
function fixture(t) {
  const home = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-profile-")),
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    write(
      profile,
      value = { server_url: "https://server.example/base", token: credential },
    ) {
      const root = profileRoot(profile, home);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const filename = path.join(root, "config.json");
      writeFileSync(
        filename,
        typeof value === "string" || Buffer.isBuffer(value)
          ? value
          : JSON.stringify(value),
        { mode: 0o600 },
      );
      return filename;
    },
  };
}
function invalid(action) {
  assert.throws(action, (error) => {
    assert.equal(error.code, "invalid_configuration");
    assert.equal(String(error).includes(credential), false);
    assert.equal(JSON.stringify(error).includes(credential), false);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("profiles use the target home and isolate server credentials without writable or enumerable token copies", (t) => {
  const f = fixture(t),
    production = f.write("production"),
    development = f.write("development", {
      server_url: "http://127.0.0.1:3000/base",
      token: "development-only",
    });
  assert.equal(profileRoot("production", f.home), path.join(f.home, ".nexum"));
  assert.equal(
    profileRoot("development", f.home),
    path.join(f.home, ".nexum-dev"),
  );
  const before = readFileSync(production),
    config = loadProfileConfig("production", f.home),
    dev = loadProfileConfig("development", f.home);
  assert.equal(config.token, credential);
  assert.equal(config.serverUrl, "https://server.example/base");
  assert.equal(config.root, path.dirname(production));
  assert.equal(dev.token, "development-only");
  assert.equal(dev.root, path.dirname(development));
  assert(Object.isFrozen(config));
  assert.equal(Object.keys(config).includes("token"), false);
  assert.equal(JSON.stringify(config).includes(credential), false);
  assert.equal(inspect(config).includes(credential), false);
  assert.throws(() => {
    config.token = "changed";
  }, TypeError);
  assert.deepEqual(readFileSync(production), before);
});

test("malformed, oversized, non-UTF8, missing and expanded configuration never leaks the source credential", (t) => {
  const f = fixture(t);
  invalid(() => loadProfileConfig("development", f.home));
  for (const value of [
    '{"token":"' + credential + '",',
    " ".repeat(16385) + credential,
    Buffer.from([0xff, 0xfe]),
    {
      server_url: "https://server.example",
      token: credential,
      agentId: "injected",
    },
    { server_url: "https://server.example" },
    { server_url: "https://server.example", token: "" },
    [],
  ]) {
    f.write("development", value);
    invalid(() => loadProfileConfig("development", f.home));
  }
});

test("owner storage and retention settings remain profile-local, immutable and explicit", (t) => {
  const f = fixture(t);
  const retention = {
    work_idle_ms: 3600000,
    run_history_ms: 86400000,
    run_logs_ms: 43200000,
    input_attachments_ms: 3600000,
    artifact_ms: 7200000,
    material_copies_ms: 86400000,
  };
  const filename = f.write("development", {
    server_url: "http://127.0.0.1:3000",
    token: credential,
    storage: { max_managed_bytes: 4 * 1024 ** 3 },
    retention,
  });
  f.write("production");
  const bytes = readFileSync(filename);
  const config = loadProfileConfig("development", f.home);
  assert.deepEqual(config.storage, { max_managed_bytes: 4 * 1024 ** 3 });
  assert.deepEqual(config.retention, retention);
  assert.ok(Object.isFrozen(config.storage));
  assert.ok(Object.isFrozen(config.retention));
  assert.throws(() => {
    config.retention.artifact_ms = 1;
  }, TypeError);
  assert.equal(loadProfileConfig("production", f.home).storage, undefined);
  assert.equal(loadProfileConfig("production", f.home).retention, undefined);
  assert.deepEqual(readFileSync(filename), bytes);
  assert.equal(JSON.stringify(config).includes(credential), false);
});

test("owner settings reject unknown keys, malformed numbers and impossible expiry dates without leaking credentials", (t) => {
  const f = fixture(t);
  const values = [
    { storage: [] },
    { storage: null },
    { storage: { max_managed_bytes: 0 } },
    { storage: { max_managed_bytes: Number.MAX_SAFE_INTEGER + 1 } },
    { storage: { untracked_limit: 1000 } },
    { retention: [] },
    { retention: { artifact_ms: 9_000_000_000_000_000 } },
    { retention: { run_logs_ms: -1 } },
    { retention: { work_idle_ms: 0.5 } },
    { retention: { input_attachments_ms: "1000" } },
    { retention: { material_copies_ms: null } },
    { retention: { delete_now: 1 } },
  ];
  for (const policy of values) {
    f.write("development", {
      server_url: "http://127.0.0.1",
      token: credential,
      ...policy,
    });
    invalid(() => loadProfileConfig("development", f.home));
  }
});

test("production transport requirements and header-safe credentials fail before any connection", (t) => {
  const f = fixture(t);
  for (const server_url of [
    "not a URL",
    "http://server.example",
    "file:///tmp/config",
    `https://user:${credential}@server.example`,
    `https://server.example?token=${credential}`,
    `https://server.example/#${credential}`,
    " https://server.example",
    "https://server.example\n",
  ]) {
    f.write("production", { server_url, token: credential });
    invalid(() => loadProfileConfig("production", f.home));
  }
  for (const token of [
    credential + "\n",
    credential + "\0",
    credential + " ",
    "unicode-密钥",
    "x".repeat(8193),
  ]) {
    f.write("development", { server_url: "http://127.0.0.1", token });
    invalid(() => loadProfileConfig("development", f.home));
  }
  assert.equal(
    validateServerUrl("http://127.0.0.1:3000", "development").protocol,
    "http:",
  );
  invalid(() => profileRoot("unknown", f.home));
  invalid(() => profileRoot("development", "relative-home"));
  invalid(() => profileRoot("development", {}));
});

test("redirected profile directories are rejected across platforms", (t) => {
  const f = fixture(t);
  const production = f.write("production");
  symlinkSync(
    path.dirname(production),
    profileRoot("development", f.home),
    "junction",
  );
  invalid(() => loadProfileConfig("development", f.home));
});

test(
  "a credential file cannot be a symlink or a directory",
  {
    skip:
      process.platform === "win32"
        ? "File symlinks require Windows privileges; profile junction coverage remains active."
        : false,
  },
  (t) => {
    const f = fixture(t);
    const production = f.write("production"),
      root = profileRoot("development", f.home);
    mkdirSync(root);
    const filename = path.join(root, "config.json");
    symlinkSync(production, filename);
    invalid(() => loadProfileConfig("development", f.home));
    rmSync(filename);
    mkdirSync(filename);
    invalid(() => loadProfileConfig("development", f.home));
  },
);

test(
  "POSIX configuration permissions keep credentials private to the Agent user",
  {
    skip:
      process.platform === "win32"
        ? "Windows ACLs are not represented by POSIX mode bits."
        : false,
  },
  (t) => {
    const f = fixture(t),
      filename = f.write("development");
    chmodSync(filename, 0o644);
    invalid(() => loadProfileConfig("development", f.home));
    chmodSync(filename, 0o600);
    assert.equal(loadProfileConfig("development", f.home).token, credential);
  },
);
