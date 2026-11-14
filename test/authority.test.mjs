import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentAuthority } from "../dist/application/authority.js";

function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-authority-")),
  );
  const work = path.join(root, "work"),
    approved = path.join(root, "approved"),
    outside = path.join(root, "outside");
  for (const dir of [work, approved, outside]) mkdirSync(dir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now();
  const connection = {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "isolated",
    bootId: "boot_" + "a".repeat(32),
    connectionId: "connection-one",
  };
  const authority = new AgentAuthority(connection, work, () => now);
  authority.connect(connection);
  const caller = {
    principalId: "owner",
    clientId: "host-one",
    grantId: "grant-one",
  };
  const context = () => ({
    caller: { ...caller },
    connection: { ...connection },
    authorization: {
      agentId: "agent",
      allowedRoots: [approved],
      budgets: { textBytes: 65536 },
      revision: "one",
      expiresAt: new Date(now + 20000).toISOString(),
    },
  });
  return {
    root,
    work,
    approved,
    outside,
    authority,
    connection,
    caller,
    context,
    advance(ms) {
      now += ms;
    },
  };
}

test("current Agent authority is scoped to an exact verified Grant and captured independently of input mutation", (t) => {
  const f = fixture(t),
    context = f.context();
  f.authority.observe(context);
  context.authorization.allowedRoots.push(f.outside);
  f.authority.authorize(f.caller, {
    type: "path",
    value: path.join(f.approved, "new", "file"),
    access: "write",
  });
  assert.throws(
    () =>
      f.authority.authorize(f.caller, {
        type: "path",
        value: path.join(f.outside, "file"),
        access: "read",
      }),
    { code: "path_not_allowed" },
  );
  assert.throws(
    () => f.authority.current({ ...f.caller, grantId: "another-grant" }),
    { code: "forbidden" },
  );
  assert.throws(
    () => f.authority.current({ principalId: "owner", clientId: "host-one" }),
    { code: "unauthorized" },
  );
});

test("a delayed refresh cannot erase a revocation or a newer authenticated observation", (t) => {
  const f = fixture(t);
  f.authority.observe(f.context());
  const captured = f.authority.capture(f.caller);
  f.authority.revoke(f.caller);
  assert.equal(f.authority.refresh(captured, f.context().authorization), false);
  assert.throws(() => f.authority.current(f.caller), { code: "forbidden" });
  f.authority.observe(f.context());
  const earlier = f.authority.capture(f.caller),
    newer = f.context();
  newer.authorization.revision = "newer";
  f.authority.observe(newer);
  assert.equal(f.authority.refresh(earlier, f.context().authorization), false);
  assert.equal(f.authority.current(f.caller).revision, "newer");
});

test("concurrent Agent and Project policy scopes retain their own roots, metadata and refresh CAS", (t) => {
  const f = fixture(t);
  const agent = f.context();
  f.authority.observe(agent);
  const projectA = f.context();
  Object.assign(projectA.authorization, {
    projectId: "project-a",
    projectRoot: f.approved,
    projectName: "A",
  });
  f.authority.observe(projectA);
  const first = f.authority.capture(f.caller, "project-a");
  const projectB = f.context();
  Object.assign(projectB.authorization, {
    projectId: "project-b",
    projectRoot: f.outside,
    projectName: "B",
    allowedRoots: [f.outside],
  });
  f.authority.observe(projectB);
  assert.equal(f.authority.current(f.caller).projectId, undefined);
  assert.equal(f.authority.current(f.caller, "project-a").projectName, "A");
  assert.equal(f.authority.current(f.caller, "project-b").projectName, "B");
  assert.equal(
    f.authority.refresh(first, {
      ...projectA.authorization,
      revision: "a-refreshed",
    }),
    true,
  );
  assert.equal(f.authority.current(f.caller, "project-b").revision, "one");
  assert.throws(
    () =>
      f.authority.authorize(
        f.caller,
        { type: "path", value: f.outside, access: "read" },
        "project-a",
      ),
    { code: "path_not_allowed" },
  );
  f.authority.authorize(
    f.caller,
    { type: "path", value: f.outside, access: "read" },
    "project-b",
  );
  const current = f.authority.capture(f.caller, "project-a");
  assert.throws(() => f.authority.refresh(current, projectB.authorization), {
    code: "authorization_scope_mismatch",
  });
  f.authority.revoke(f.caller);
  for (const id of [null, "project-a", "project-b"])
    assert.throws(() => f.authority.current(f.caller, id), {
      code: "forbidden",
    });
  assert.equal(f.authority.refresh(current, projectA.authorization), false);
});

test("an owner session has its own bounded policy identity and cannot borrow or mint an MCP Grant", (t) => {
  const f = fixture(t);
  const sessionRef = "c".repeat(64);
  const caller = {
    principalId: "owner",
    clientId: `nexum-console:${sessionRef}`,
    source: "owner_session",
    sessionRef,
  };
  f.authority.observe({ ...f.context(), caller });
  assert.equal(f.authority.current(caller).agentId, "agent");
  assert.throws(
    () =>
      f.authority.authorize(caller, {
        type: "path",
        value: f.work,
        access: "write",
      }),
    { code: "forbidden" },
  );
  assert.throws(
    () =>
      f.authority.authorize(caller, {
        type: "path",
        value: process.execPath,
        access: "execute",
      }),
    { code: "forbidden" },
  );
  f.authority.authorize(caller, {
    type: "resource",
    value: "res_" + "a".repeat(32),
    access: "stop",
  });
  assert.throws(
    () =>
      f.authority.current({
        principalId: "owner",
        clientId: caller.clientId,
        grantId: sessionRef,
      }),
    { code: "forbidden" },
  );
  assert.throws(
    () => f.authority.current({ ...caller, clientId: "nexum-console:other" }),
    { code: "unauthorized" },
  );
  assert.throws(() =>
    f.authority.observe({
      ...f.context(),
      caller: { ...caller, grantId: "forged" },
    }),
  );
  f.authority.revoke(caller);
  assert.throws(() => f.authority.current(caller), { code: "forbidden" });
});

test("declared process execution can resolve a system executable while data reads stay within approved roots", (t) => {
  const f = fixture(t);
  f.authority.observe(f.context());
  f.authority.authorize(f.caller, {
    type: "path",
    value: process.execPath,
    access: "execute",
  });
  assert.throws(
    () =>
      f.authority.authorize(f.caller, {
        type: "path",
        value: process.execPath,
        access: "read",
      }),
    { code: "path_not_allowed" },
  );
});

test("expired authority stops new managed access without changing a Run or borrowing another Grant", (t) => {
  const f = fixture(t);
  f.authority.observe(f.context());
  f.advance(21000);
  assert.throws(() => f.authority.current(f.caller), {
    code: "authorization_expired",
  });
  f.authority.observe({
    ...f.context(),
    caller: { ...f.caller, grantId: "fresh-other-grant" },
  });
  assert.throws(() => f.authority.current(f.caller), {
    code: "authorization_expired",
  });
});

test("same-boot reconnection retains policy but every new observation uses the current exact connection", (t) => {
  const f = fixture(t),
    old = f.context();
  f.authority.observe(old);
  const current = { ...f.connection, connectionId: "connection-two" };
  f.authority.connect(current);
  assert.equal(f.authority.current(f.caller).revision, "one");
  assert.throws(() => f.authority.observe(old), {
    code: "connection_mismatch",
  });
  f.authority.observe({ ...f.context(), connection: current });
  for (const key of ["agentId", "bootId", "cloudEnvironment", "profile"])
    assert.throws(
      () =>
        f.authority.connect({
          ...current,
          [key]: key === "profile" ? "production" : "changed",
        }),
      { code: "runtime_binding_mismatch" },
    );
});

test("pure cleanup keeps original identity after revocation and cannot obtain a new access permit", (t) => {
  const f = fixture(t),
    old = f.context();
  f.authority.observe(old);
  f.authority.revoke(f.caller);
  const current = { ...f.connection, connectionId: "connection-two" };
  f.authority.connect(current);
  assert.equal(
    f.authority.cleanupContext(f.caller, old).connection.connectionId,
    "connection-two",
  );
  assert.throws(() => f.authority.current(f.caller), { code: "forbidden" });
  assert.throws(
    () => f.authority.cleanupContext({ ...f.caller, grantId: "other" }, old),
    { code: "forbidden" },
  );
  assert.throws(
    () =>
      f.authority.cleanupContext(f.caller, {
        ...old,
        connection: { ...old.connection, bootId: "boot_" + "b".repeat(32) },
      }),
    { code: "connection_mismatch" },
  );
});

test("managed path checks reject escaping and replaced approved symlinks, including new output paths", (t) => {
  const f = fixture(t);
  f.authority.observe(f.context());
  symlinkSync(f.outside, path.join(f.approved, "escape"), "junction");
  assert.throws(
    () =>
      f.authority.authorize(f.caller, {
        type: "path",
        value: path.join(f.approved, "escape", "new-file"),
        access: "write",
      }),
    { code: "path_not_allowed" },
  );
  renameSync(f.approved, path.join(f.root, "old-approved"));
  symlinkSync(f.outside, f.approved, "junction");
  assert.throws(
    () =>
      f.authority.authorize(f.caller, {
        type: "path",
        value: path.join(f.approved, "new-file"),
        access: "write",
      }),
    { code: "path_not_allowed" },
  );
  f.authority.authorize(f.caller, {
    type: "path",
    value: path.join(f.work, "file"),
    access: "write",
  });
});

test("Agent public logs are readable without exposing private profile state or granting log writes", (t) => {
  const f = fixture(t),
    logs = path.join(f.root, "logs");
  mkdirSync(logs);
  f.authority.observe(f.context());
  f.authority.authorize(f.caller, {
    type: "path",
    value: path.join(logs, "processes", "output"),
    access: "read",
  });
  for (const [value, access] of [
    [path.join(logs, "output"), "write"],
    [path.join(f.root, "state", "runtime.sqlite"), "read"],
    [path.join(f.root, "config.json"), "read"],
  ])
    assert.throws(
      () => f.authority.authorize(f.caller, { type: "path", value, access }),
      { code: "path_not_allowed" },
    );
});
