import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  linkSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { WorkGitMaintenance } from "../dist/maintenance/work-git.js";
import { whichExecutable } from "../dist/process/environment.js";

const day = 24 * 60 * 60_000;
function snapshot(root, changes = {}) {
  const variables = Object.create(null);
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "ComSpec",
    "USER",
    "USERNAME",
    "LOGNAME",
  ]) {
    if (
      process.env[name] !== undefined &&
      !Object.keys(variables).some(
        (key) => key.toUpperCase() === name.toUpperCase(),
      )
    )
      variables[name] = process.env[name];
  }
  return {
    platform: process.platform,
    variables: {
      ...variables,
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      ...changes,
    },
    shell: null,
    source: process.platform === "win32" ? "windows-user" : "login-shell",
    discoveredAt: Date.now(),
    cwd: root,
  };
}
async function fixture(t) {
  const base = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-work-git-")),
  );
  const root = path.join(base, "profile"),
    work = path.join(root, "work");
  mkdirSync(work, { recursive: true });
  mkdirSync(path.join(root, "home"));
  const environment = snapshot(root);
  const executable = await whichExecutable(
    process.platform === "win32" ? "git.exe" : "git",
    environment,
    root,
  );
  const gitEnvironment = {
    ...environment.variables,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
  const git = (args, options = {}) =>
    execFileSync(
      executable.launchPath,
      [
        "--no-pager",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@localhost",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      {
        cwd: work,
        env: gitEnvironment,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        ...options,
      },
    );
  const put = (name, content = name) => {
    const filename = path.join(work, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  };
  const repository = () => {
    git(["init", "-b", "main"]);
    put("package.json", '{"name":"fixture"}\n');
    git(["add", "package.json"]);
    git(["commit", "-m", "Fixture initial"]);
  };
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return {
    base,
    root,
    work,
    environment,
    executable,
    git,
    gitEnvironment,
    put,
    repository,
    service: (options) =>
      new WorkGitMaintenance(root, { environment, ...options }),
  };
}
const tracked = (f) =>
  f
    .git(["ls-tree", "-r", "--name-only", "HEAD"])
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .sort();

test("construction is cold and does not initialize files or launch Git", async (t) => {
  const f = await fixture(t),
    missing = path.join(f.base, "not-created");
  new WorkGitMaintenance(missing, { environment: f.environment });
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(path.join(f.work, ".git")), false);
  assert.equal(existsSync(path.join(f.root, "state")), false);
});

test("real Git accepts its portable null path for isolated config and attributes on every platform", async (t) => {
  const f = await fixture(t);
  assert.equal(f.git(["config", "--global", "--list"]), "");
  assert.equal(f.git(["config", "--system", "--list"]), "");
  f.put("docs/README.md", "portable Git snapshot");
  const result = await f.service().initialize();
  assert.equal(result.status, "committed", JSON.stringify(result));
  assert.equal(f.git(["rev-parse", "HEAD"]).trim(), result.commit);
  assert.equal(
    f.git([
      "-c",
      "core.attributesFile=/dev/null",
      "check-attr",
      "--all",
      "--",
      "docs/README.md",
    ]),
    "",
  );
});

test("initialization creates an independent local snapshot of only the fixed allowed files", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "package.json",
    "package-lock.json",
    "scripts/report.js",
    "modules/helper.js",
    "docs/README.md",
  ])
    f.put(name);
  for (const name of [
    "package.evil.json",
    "README.md",
    "mcp.json",
    "api/crm/config.json",
    "api.json",
    ".env",
    ".npmrc",
    "scripts/.env.local",
    "docs/.npmrc",
    "modules/node_modules/lib/index.js",
    "resources/content",
    "tmp/result",
    "node_modules/example/index.js",
  ])
    f.put(name, "synthetic private configuration");
  const result = await f.service().initialize();
  assert.equal(result.status, "committed", JSON.stringify(result));
  assert.equal(result.stateSaved, true);
  assert.deepEqual(tracked(f), [
    ".gitignore",
    "docs/README.md",
    "modules/helper.js",
    "package-lock.json",
    "package.json",
    "scripts/report.js",
  ]);
  assert.equal(f.git(["rev-parse", "--show-toplevel"]).trim(), f.work);
  assert.equal(f.git(["remote"]).trim(), "");
  assert.equal(
    f.git(["show", "-s", "--format=%an <%ae>"]).trim(),
    "Nexum Agent <nexum@localhost>",
  );
  assert.match(
    f.git(["show", "-s", "--format=%s"]),
    /Nexum Agent 自动快照 \d{4}-\d{2}-\d{2}T/,
  );
  assert.equal(existsSync(path.join(f.root, "state/work-git.json")), true);
  assert.equal(
    readFileSync(path.join(f.work, "mcp.json"), "utf8"),
    "synthetic private configuration",
  );
});

test("daily checks save real additions/modifications/deletions once and do not create empty or catch-up commits", async (t) => {
  const f = await fixture(t);
  let now = Date.now();
  const service = f.service({ now: () => now });
  f.put("scripts/old.js", "original");
  const first = await service.initialize();
  assert.equal(first.status, "committed");
  const stateFile = path.join(f.root, "state/work-git.json"),
    initialRecord = readFileSync(stateFile);
  f.put("scripts/new.js", "new");
  rmSync(path.join(f.work, "scripts/old.js"));
  assert.equal((await service.checkDue()).status, "not_due");
  assert.deepEqual(readFileSync(stateFile), initialRecord);
  now += 5 * day;
  const second = await service.checkDue();
  assert.equal(second.status, "committed");
  assert.notEqual(second.commit, first.commit);
  assert.equal(f.git(["rev-list", "--count", "HEAD"]).trim(), "2");
  assert.equal(tracked(f).includes("scripts/old.js"), false);
  assert.equal(tracked(f).includes("scripts/new.js"), true);
  assert.equal(Date.parse(second.nextCheckAt) - now, day);
  now += day;
  assert.equal((await service.checkDue()).status, "unchanged");
  assert.equal(f.git(["rev-list", "--count", "HEAD"]).trim(), "2");
});

test("existing staging is skipped without changing the user's index, ignore file, or history", async (t) => {
  const f = await fixture(t);
  f.repository();
  f.put("scripts/user-staged.js", "user staging");
  f.git(["add", "scripts/user-staged.js"]);
  const index = readFileSync(path.join(f.work, ".git/index")),
    head = f.git(["rev-parse", "HEAD"]);
  const result = await f.service().initialize();
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "existing_staged");
  assert.deepEqual(readFileSync(path.join(f.work, ".git/index")), index);
  assert.equal(f.git(["rev-parse", "HEAD"]), head);
  assert.equal(existsSync(path.join(f.work, ".gitignore")), false);
});

test("already tracked credentials or excluded directories are reported, retained, and never silently untracked", async (t) => {
  for (const name of [
    ".env",
    "resources/old.txt",
    "scripts/.npmrc",
    "MCP.JSON",
    "API/crm.json",
  ]) {
    await t.test(name, async (child) => {
      const f = await fixture(child);
      f.repository();
      f.put(name, "synthetic secret");
      f.git(["add", name]);
      f.git(["commit", "-m", "Existing user content"]);
      const head = f.git(["rev-parse", "HEAD"]),
        index = readFileSync(path.join(f.work, ".git/index"));
      const result = await f.service().initialize();
      assert.equal(result.status, "skipped");
      assert.equal(result.reason, "forbidden_tracked");
      assert.equal(f.git(["rev-parse", "HEAD"]), head);
      assert.deepEqual(readFileSync(path.join(f.work, ".git/index")), index);
      assert.equal(tracked(f).includes(name), true);
      assert.equal(existsSync(path.join(f.work, ".gitignore")), false);
    });
  }
});

test("real merge/rebase/conflict metadata and locks leave the index and history untouched", async (t) => {
  for (const kind of [
    "merge",
    "rebase",
    "conflict",
    "index.lock",
    "branch.lock",
  ]) {
    await t.test(kind, async (child) => {
      const f = await fixture(child);
      f.repository();
      const head = f.git(["rev-parse", "HEAD"]).trim();
      let marker;
      if (kind === "merge") {
        marker = path.join(f.work, ".git/MERGE_HEAD");
        writeFileSync(marker, head + "\n");
      }
      if (kind === "rebase") {
        marker = path.join(f.work, ".git/rebase-merge");
        mkdirSync(marker);
      }
      if (kind === "index.lock" || kind === "branch.lock") {
        marker = path.join(
          f.work,
          ".git",
          kind === "index.lock" ? "index.lock" : "refs/heads/main.lock",
        );
        writeFileSync(marker, "existing owner lock");
      }
      if (kind === "conflict") {
        const blob = f
          .git(["hash-object", "-w", "--stdin"], { input: "conflict bytes" })
          .trim();
        f.git(["update-index", "--index-info"], {
          input: `0 ${"0".repeat(40)}\tpackage.json\n100644 ${blob} 1\tpackage.json\n100644 ${blob} 2\tpackage.json\n`,
        });
      }
      const index = readFileSync(path.join(f.work, ".git/index"));
      const result = await f.service().initialize();
      assert.equal(result.status, "skipped");
      assert.equal(
        result.reason,
        kind === "conflict"
          ? "unresolved_conflicts"
          : kind.endsWith("lock")
            ? "git_busy"
            : "repository_operation",
      );
      assert.deepEqual(readFileSync(path.join(f.work, ".git/index")), index);
      assert.equal(f.git(["rev-parse", "HEAD"]).trim(), head);
      if (marker) assert.equal(existsSync(marker), true);
      assert.equal(existsSync(path.join(f.work, ".gitignore")), false);
    });
  }
});

test("a parent repository is never reused and retains its actual index and HEAD", async (t) => {
  const f = await fixture(t);
  const parentGit = (args) => f.git(args, { cwd: f.base });
  parentGit(["init", "-b", "main"]);
  writeFileSync(path.join(f.base, "parent.txt"), "parent");
  parentGit(["add", "parent.txt"]);
  parentGit(["commit", "-m", "Parent"]);
  const head = parentGit(["rev-parse", "HEAD"]),
    index = readFileSync(path.join(f.base, ".git/index"));
  f.put("scripts/local.js", "local");
  const result = await f.service().initialize();
  assert.equal(result.status, "committed", JSON.stringify(result));
  assert.equal(f.git(["rev-parse", "--show-toplevel"]).trim(), f.work);
  assert.equal(parentGit(["rev-parse", "HEAD"]), head);
  assert.deepEqual(readFileSync(path.join(f.base, ".git/index")), index);
});

test("redirected work/Git directories and nested repositories are refused", async (t) => {
  for (const kind of [
    "work-junction",
    "git-file",
    "git-link",
    "nested-repository",
  ]) {
    await t.test(kind, async (child) => {
      const f = await fixture(child),
        outside = path.join(f.base, "outside");
      mkdirSync(outside);
      writeFileSync(path.join(outside, "keep.txt"), "untouched");
      if (kind === "work-junction") {
        rmSync(f.work, { recursive: true });
        symlinkSync(outside, f.work, "junction");
      }
      if (kind === "git-file")
        writeFileSync(path.join(f.work, ".git"), `gitdir: ${outside}\n`);
      if (kind === "git-link")
        symlinkSync(outside, path.join(f.work, ".git"), "junction");
      if (kind === "nested-repository") {
        mkdirSync(path.join(f.work, "docs/nested"), { recursive: true });
        f.git(["init", path.join(f.work, "docs/nested")]);
        writeFileSync(path.join(f.work, "docs/nested/secret.txt"), "nested");
      }
      const result = await f.service().initialize();
      assert.equal(result.status, "skipped", JSON.stringify(result));
      assert.equal(
        readFileSync(path.join(outside, "keep.txt"), "utf8"),
        "untouched",
      );
      assert.equal(existsSync(path.join(outside, ".git")), false);
    });
  }
});

test("executable local hooks, includes, and clean filters are skipped before index mutation", async (t) => {
  for (const key of [
    "hook.capture.command",
    "include.path",
    "filter.capture.clean",
  ]) {
    await t.test(key, async (child) => {
      const f = await fixture(child);
      f.repository();
      f.put("scripts/new.js");
      const value =
        key === "include.path"
          ? path.join(f.base, "credentials-config")
          : "printf unexpected > ../executed";
      if (key === "include.path")
        writeFileSync(
          value,
          '[remote "credential"]\nurl = https://synthetic:private@example.invalid/\n',
        );
      f.git(["config", "--local", key, value]);
      const index = readFileSync(path.join(f.work, ".git/index")),
        head = f.git(["rev-parse", "HEAD"]);
      const result = await f.service().initialize();
      assert.equal(result.status, "skipped");
      assert.equal(result.reason, "unsafe_git_config");
      assert.deepEqual(readFileSync(path.join(f.work, ".git/index")), index);
      assert.equal(f.git(["rev-parse", "HEAD"]), head);
      assert.equal(existsSync(path.join(f.root, "executed")), false);
      assert.equal(
        readFileSync(path.join(f.root, "state/work-git.json"), "utf8").includes(
          "private@example",
        ),
        false,
      );
    });
  }
});

test("redirected Git reflogs or commit-message metadata cannot write into another profile", async (t) => {
  for (const kind of ["logs-junction", "message-hardlink"]) {
    await t.test(kind, async (child) => {
      const f = await fixture(child);
      f.repository();
      f.put("scripts/new.js");
      const outside = path.join(f.base, "other-profile");
      mkdirSync(outside);
      const target = path.join(outside, "keep.txt");
      writeFileSync(target, "untouched outside profile");
      if (kind === "logs-junction") {
        rmSync(path.join(f.work, ".git/logs"), { recursive: true });
        symlinkSync(outside, path.join(f.work, ".git/logs"), "junction");
      } else {
        rmSync(path.join(f.work, ".git/COMMIT_EDITMSG"));
        linkSync(target, path.join(f.work, ".git/COMMIT_EDITMSG"));
      }
      const before = readFileSync(path.join(f.work, ".git/HEAD")),
        index = readFileSync(path.join(f.work, ".git/index"));
      const result = await f.service().initialize();
      assert.equal(result.status, "skipped");
      assert.equal(result.reason, "repository_mismatch");
      assert.equal(readFileSync(target, "utf8"), "untouched outside profile");
      assert.equal(existsSync(path.join(outside, "HEAD")), false);
      assert.deepEqual(readFileSync(path.join(f.work, ".git/HEAD")), before);
      assert.deepEqual(readFileSync(path.join(f.work, ".git/index")), index);
    });
  }
});

test("a hard-linked ignore file is refused without appending to its other pathname", async (t) => {
  const f = await fixture(t);
  f.repository();
  const outside = path.join(f.base, "other-configuration");
  writeFileSync(outside, "keep\n");
  linkSync(outside, path.join(f.work, ".gitignore"));
  const head = f.git(["rev-parse", "HEAD"]);
  const result = await f.service().initialize();
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "unsafe_snapshot_path");
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
  assert.equal(f.git(["rev-parse", "HEAD"]), head);
});

test("Git resolution refuses a work-owned launch path even when it redirects to the installed executable", async (t) => {
  const f = await fixture(t),
    tools = path.join(f.work, "tools");
  symlinkSync(path.dirname(f.executable.path), tools, "junction");
  const environment = snapshot(f.root, {
    PATH: tools + path.delimiter + f.environment.variables.PATH,
  });
  for (const key of Object.keys(environment.variables))
    if (key !== "PATH" && key.toUpperCase() === "PATH")
      delete environment.variables[key];
  const result = await new WorkGitMaintenance(f.root, {
    environment,
  }).initialize();
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "unsafe_git_executable");
  assert.equal(existsSync(path.join(f.work, ".git")), false);
});

test("maintenance disables global configuration, filesystem hooks, signing, fsmonitor and inherited Git routing", async (t) => {
  const f = await fixture(t);
  f.repository();
  f.put("scripts/new.js");
  const hooks = path.join(f.work, ".git/hooks");
  mkdirSync(hooks, { recursive: true });
  const hook = path.join(hooks, "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nprintf unexpected > ../hook-executed\n");
  chmodSync(hook, 0o755);
  for (const [key, value] of [
    ["core.fsmonitor", "printf unexpected > ../fsmonitor-executed"],
    ["commit.gpgSign", "true"],
    ["gpg.program", "not-a-real-signing-program"],
    ["core.pager", "printf unexpected > ../pager-executed"],
  ])
    f.git(["config", "--local", key, value]);
  writeFileSync(
    path.join(f.root, "home/.gitconfig"),
    '[hook "global"]\ncommand = printf unexpected > ../global-executed\nevent = pre-commit\n',
  );
  const config = readFileSync(path.join(f.work, ".git/config"));
  const foreign = path.join(f.base, "foreign");
  mkdirSync(foreign);
  const environment = snapshot(f.root, {
    GIT_DIR: foreign,
    GIT_WORK_TREE: foreign,
    GIT_INDEX_FILE: path.join(foreign, "index"),
    GIT_TRACE: path.join(foreign, "trace"),
    GIT_AUTHOR_NAME: "Wrong identity",
    GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
    NEXUM_AGENT_TOKEN: "synthetic-never-inherit",
  });
  const result = await new WorkGitMaintenance(f.root, {
    environment,
  }).initialize();
  assert.equal(result.status, "committed", JSON.stringify(result));
  assert.deepEqual(readFileSync(path.join(f.work, ".git/config")), config);
  assert.equal(existsSync(path.join(foreign, "index")), false);
  assert.equal(existsSync(path.join(foreign, "trace")), false);
  for (const name of [
    "hook-executed",
    "fsmonitor-executed",
    "pager-executed",
    "global-executed",
  ])
    assert.equal(existsSync(path.join(f.root, name)), false);
  assert.equal(
    f.git(["show", "-s", "--format=%an <%ae>"]).trim(),
    "Nexum Agent <nexum@localhost>",
  );
});

test("missing Git records an unavailable attempt and does not install or retry before the next daily check", async (t) => {
  const f = await fixture(t),
    environment = snapshot(f.root, {
      PATH: "",
      ...(process.platform === "win32" ? { Path: undefined } : {}),
    });
  if (environment.variables.Path === undefined)
    delete environment.variables.Path;
  const service = new WorkGitMaintenance(f.root, { environment });
  const result = await service.initialize();
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "git_unavailable");
  assert.equal(result.stateSaved, true);
  assert.equal((await service.checkDue()).status, "not_due");
  assert.equal(existsSync(path.join(f.work, ".git")), false);
});

test("two maintenance instances do not overlap or overwrite the completed attempt record", async (t) => {
  const f = await fixture(t);
  f.put("scripts/a.js");
  const first = f.service().initialize(),
    other = f.service().checkDue();
  const busy = await other;
  assert.equal(busy.status, "skipped");
  assert.equal(busy.reason, "maintenance_busy");
  assert.equal(busy.stateSaved, false);
  const complete = await first;
  assert.equal(complete.status, "committed");
  const stored = JSON.parse(
    readFileSync(path.join(f.root, "state/work-git.json"), "utf8"),
  ).result;
  assert.equal(stored.commit, complete.commit);
  assert.equal(stored.stateSaved, true);
  assert.equal(f.git(["rev-list", "--count", "HEAD"]).trim(), "1");
});

test("a lost maintenance record rechecks actual Git state and never duplicates an unchanged snapshot", async (t) => {
  const f = await fixture(t);
  f.put("docs/a.md");
  const first = await f.service().initialize();
  assert.equal(first.status, "committed");
  rmSync(path.join(f.root, "state/work-git.json"));
  const next = await f.service().checkDue();
  assert.equal(next.status, "unchanged");
  assert.equal(f.git(["rev-parse", "HEAD"]).trim(), first.commit);
  assert.equal(f.git(["rev-list", "--count", "HEAD"]).trim(), "1");
});

test(
  "a timed-out commit is inspected and confirmed once; its actual success and sanitized environment are retained",
  {
    skip:
      process.platform === "win32"
        ? "POSIX executable proxy fault injection; real Git behavior is otherwise tested natively."
        : false,
  },
  async (t) => {
    const f = await fixture(t),
      tools = path.join(f.base, "tools"),
      capture = path.join(f.base, "git-child.json");
    mkdirSync(tools);
    const wrapper = path.join(tools, "git");
    writeFileSync(
      wrapper,
      `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';import {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);const result=spawnSync(${JSON.stringify(f.executable.launchPath)},args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);if(args.includes('commit')){writeFileSync(${JSON.stringify(capture)},JSON.stringify({hasAgentToken:Object.hasOwn(process.env,'NEXUM_AGENT_TOKEN')}));setTimeout(()=>process.exit(0),5000);}else process.exit(0);\n`,
    );
    // The fixture proxy delegates every operation to real Git and delays only
    // after its successful commit, producing a genuinely uncertain child result.
    writeFileSync(path.join(f.base, "package.json"), '{"type":"module"}');
    chmodSync(wrapper, 0o755);
    const environment = snapshot(f.root, {
      PATH: tools + path.delimiter + f.environment.variables.PATH,
      NEXUM_AGENT_TOKEN: "synthetic-never-inherit",
    });
    const service = new WorkGitMaintenance(f.root, {
      environment,
      timeoutMs: 2000,
    });
    f.put("scripts/proof.js");
    const result = await service.initialize();
    assert.equal(result.status, "committed", JSON.stringify(result));
    assert.equal(result.reason, "commit_confirmed_after_error");
    assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), {
      hasAgentToken: false,
    });
    assert.equal((await service.checkDue()).status, "not_due");
    assert.equal(f.git(["rev-list", "--count", "HEAD"]).trim(), "1");
  },
);
