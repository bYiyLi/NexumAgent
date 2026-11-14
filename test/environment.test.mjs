import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const moduleURL =
  process.env.NEXUM_ENVIRONMENT_TEST_MODULE ??
  new URL("../dist/process/environment.js", import.meta.url).href;
const { discoverEnvironment, mergeChildEnvironment, whichExecutable } =
  await import(moduleURL);
const windows = process.platform === "win32";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
function setup(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum environment ")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function snapshot(variables, platform = process.platform) {
  return Object.freeze({
    platform,
    variables: Object.freeze(variables),
    shell: windows ? "powershell.exe" : "/bin/sh",
    source: windows ? "windows-user" : "login-shell",
    discoveredAt: Date.now(),
    cwd: process.cwd(),
  });
}
function isolated(shell, code, options = {}) {
  const source = `import {createRequire,syncBuiltinESMExports} from 'node:module';
const require=createRequire(import.meta.url),os=require('node:os'),original=os.userInfo;
os.userInfo=(...args)=>({...original(...args),shell:${JSON.stringify(shell)}});syncBuiltinESMExports();
const {discoverEnvironment}=await import(${JSON.stringify(moduleURL)});
${code}`;
  return spawnSync(process.execPath, ["--input-type=module"], {
    input: source,
    encoding: "utf8",
    timeout: 15000,
    ...options,
  });
}

test("real user environment discovery fixes cwd and a frozen fresh snapshot without changing Agent globals", async (t) => {
  const root = setup(t);
  const beforeCwd = process.cwd(),
    before = { ...process.env };
  const value = await discoverEnvironment({
    signal: new AbortController().signal,
    cwd: root,
    timeoutMs: 10000,
  });
  assert.equal(value.platform, process.platform);
  assert.equal(value.cwd, root);
  assert.equal(value.source, windows ? "windows-user" : "login-shell");
  assert.equal(path.isAbsolute(value.shell), true);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.variables), true);
  assert.equal(
    Object.keys(value.variables).some((key) => /^_?NEXUM(?:_|$)/i.test(key)),
    false,
  );
  assert.equal(process.cwd(), beforeCwd);
  assert.deepEqual({ ...process.env }, before);
  const executable = await whichExecutable(process.execPath, value, root);
  assert.equal(executable.path, realpathSync.native(process.execPath));
  assert.equal(executable.kind, "native");
});

test(
  "each discovery invokes the configured supported shell again and preserves framed newline values",
  { skip: windows },
  (t) => {
    const root = setup(t),
      state = path.join(root, "state"),
      shell = path.join(root, "zsh");
    writeFileSync(state, "first");
    writeFileSync(
      shell,
      `#!/bin/sh\nexport TEST_DISCOVER_VALUE="$(/bin/cat ${quote(state)})"\nexport TEST_DISCOVER_NEWLINE='first\nsecond=value'\nexport NODE_OPTIONS='--max-old-space-size=512'\nexport NODE_PATH='/user/declared/libraries'\nexport NEXUM_AGENT_TOKEN='synthetic-control-token'\nexec /bin/sh "$@"\n`,
      { mode: 0o700 },
    );
    const result = isolated(
      shell,
      `
import {writeFileSync} from 'node:fs';
const options={signal:new AbortController().signal,cwd:${JSON.stringify(root)}};
const first=await discoverEnvironment(options);writeFileSync(${JSON.stringify(state)},'second');
const second=await discoverEnvironment(options);
console.log(JSON.stringify({first:first.variables.TEST_DISCOVER_VALUE,second:second.variables.TEST_DISCOVER_VALUE,newline:second.variables.TEST_DISCOVER_NEWLINE,nodeOptions:second.variables.NODE_OPTIONS,nodePath:second.variables.NODE_PATH,privateKeys:Object.keys(second.variables).filter(k=>/^_?NEXUM(?:_|$)/i.test(k))}));`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      first: "first",
      second: "second",
      newline: "first\nsecond=value",
      nodeOptions: "--max-old-space-size=512",
      nodePath: "/user/declared/libraries",
      privateKeys: [],
    });
  },
);

test("child overrides preserve Node business options, remove explicit values, and cannot reintroduce Agent/IPC controls", () => {
  const source = snapshot({
    PATH: "/original",
    NODE_OPTIONS: "--max-old-space-size=1024",
    NODE_PATH: "/user/libraries",
    KEEP: "yes",
    REMOVE: "value",
    NEXUM_AGENT_TOKEN: "synthetic-control",
    NODE_CHANNEL_FD: "3",
  });
  const merged = mergeChildEnvironment(source, {
    PATH: "/child/path",
    NODE_OPTIONS: "--max-old-space-size=2048",
    REMOVE: null,
  });
  assert.equal(merged.NODE_OPTIONS, "--max-old-space-size=2048");
  assert.equal(merged.NODE_PATH, "/user/libraries");
  assert.equal(merged.PATH, "/child/path");
  assert.equal(merged.KEEP, "yes");
  assert.equal(Object.hasOwn(merged, "REMOVE"), false);
  assert.equal(Object.hasOwn(merged, "NEXUM_AGENT_TOKEN"), false);
  assert.equal(Object.hasOwn(merged, "NODE_CHANNEL_FD"), false);
  assert.equal(source.variables.PATH, "/original");
  for (const key of [
    "NEXUM_AGENT_TOKEN",
    "nexum_private",
    "_NEXUM_CONFIG",
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_CUSTOM",
    "NODE_UNIQUE_ID",
    "ELECTRON_RUN_AS_NODE",
  ])
    assert.throws(() => mergeChildEnvironment(source, { [key]: "synthetic" }), {
      code: "environment_variable_forbidden",
    });
  const withPreload = mergeChildEnvironment(source, {
    NODE_OPTIONS: '--require="/user/explicit preload.js"',
  });
  assert.equal(
    withPreload.NODE_OPTIONS,
    '--require="/user/explicit preload.js"',
  );
});

test("Windows overrides have one case-insensitive identity and data accessors never run", () => {
  const source = snapshot(
    { Path: "C:\\original", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    "win32",
  );
  const result = mergeChildEnvironment(source, {
    PATH: "C:\\child",
    comspec: null,
  });
  assert.deepEqual(Object.keys(result), ["PATH"]);
  assert.equal(result.PATH, "C:\\child");
  assert.throws(
    () => mergeChildEnvironment(source, { Path: "one", PATH: "two" }),
    { code: "invalid_environment" },
  );
  let touched = false;
  const getters = {
    get PATH() {
      touched = true;
      return "invalid";
    },
  };
  assert.throws(() => mergeChildEnvironment(source, getters), {
    code: "invalid_environment",
  });
  assert.equal(touched, false);
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        touched = true;
        return [];
      },
    },
  );
  assert.throws(() => mergeChildEnvironment(source, proxy), {
    code: "invalid_environment",
  });
  assert.equal(touched, false);
  assert.throws(
    () => mergeChildEnvironment(source, { "INVALID=KEY": "value" }),
    { code: "invalid_environment" },
  );
  assert.throws(() => mergeChildEnvironment(source, { KEY: "bad\0value" }), {
    code: "invalid_environment",
  });
});

test("executable lookup uses each call cwd and its fixed PATH rather than Agent cwd or child overrides", async (t) => {
  const root = setup(t),
    first = path.join(root, "first directory"),
    second = path.join(root, "second directory");
  for (const cwd of [first, second]) {
    mkdirSync(path.join(cwd, "bin"), { recursive: true });
    writeFileSync(
      path.join(cwd, "bin", windows ? "example-tool.cmd" : "example-tool"),
      windows ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
      { mode: 0o700 },
    );
  }
  const fixed = snapshot(
    windows ? { Path: "bin", PATHEXT: ".CMD;.EXE" } : { PATH: "bin" },
  );
  const [one, two] = await Promise.all([
    whichExecutable("example-tool", fixed, first),
    whichExecutable("example-tool", fixed, second),
  ]);
  assert.equal(
    one.path,
    realpathSync.native(
      path.join(first, "bin", windows ? "example-tool.cmd" : "example-tool"),
    ),
  );
  assert.equal(
    two.path,
    realpathSync.native(
      path.join(second, "bin", windows ? "example-tool.cmd" : "example-tool"),
    ),
  );
  assert.equal(one.kind, windows ? "batch" : "native");
  const child = mergeChildEnvironment(fixed, {
    PATH: path.join(second, "bin"),
    NODE_OPTIONS: "--max-old-space-size=64",
  });
  assert.equal(
    (await whichExecutable("example-tool", fixed, first)).path,
    one.path,
  );
  assert.equal(child.NODE_OPTIONS, "--max-old-space-size=64");
  assert.equal(process.cwd(), fixed.cwd);
  const native = await whichExecutable(process.execPath, fixed, first);
  const arguments_ = ["space value", "A&B", "$(literal)", 'a"quote', ""];
  const run = spawnSync(
    native.path,
    [
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)));",
      "--",
      ...arguments_,
    ],
    {
      cwd: first,
      env: { ...process.env, NODE_OPTIONS: child.NODE_OPTIONS },
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), arguments_);
});

test("missing, inaccessible and cancelled executable lookups preserve distinct failures", async (t) => {
  const root = setup(t),
    value = snapshot(
      windows ? { Path: root, PATHEXT: ".EXE;.CMD" } : { PATH: root },
    );
  await assert.rejects(
    whichExecutable("missing-program-for-test", value, root),
    { code: "command_not_found" },
  );
  await assert.rejects(
    whichExecutable(process.execPath, value, path.join(root, "missing")),
    { code: "cwd_unavailable" },
  );
  if (!windows) {
    const denied = path.join(root, "no-execute");
    writeFileSync(denied, "#!/bin/sh\n", { mode: 0o600 });
    await assert.rejects(whichExecutable("no-execute", value, root), {
      code: "command_access_denied",
    });
  }
  const controller = new AbortController(),
    reason = new Error("test-cancelled");
  controller.abort(reason);
  await assert.rejects(
    whichExecutable(process.execPath, value, root, {
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
  await assert.rejects(
    discoverEnvironment({ signal: controller.signal, cwd: root }),
    (error) => error === reason,
  );
});

test("unsupported shells fail without a silent fallback and probe output is bounded", async (t) => {
  const root = setup(t);
  if (!windows) {
    const result = isolated(
      path.join(root, "unknown-shell"),
      `try{await discoverEnvironment({signal:new AbortController().signal,cwd:${JSON.stringify(root)}});process.exitCode=1;}catch(error){console.log(error.code);}`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "environment_shell_unsupported");
  }
  await assert.rejects(
    discoverEnvironment({
      signal: new AbortController().signal,
      cwd: root,
      maxBytes: 1,
      timeoutMs: 10000,
    }),
    { code: "environment_too_large" },
  );
});

test(
  "timeout and cancellation stop the actual probe group, including a child holding no output pipes",
  { skip: windows },
  async (t) => {
    const root = setup(t),
      shell = path.join(root, "zsh"),
      slow = path.join(root, "slow.mjs"),
      pids = path.join(root, "pids.json");
    writeFileSync(
      slow,
      `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'],{stdio:'ignore'});
child.on('spawn',()=>writeFileSync(${JSON.stringify(pids)},JSON.stringify({root:process.pid,child:child.pid})));
setInterval(()=>{},1000);`,
    );
    writeFileSync(
      shell,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(slow)}\n`,
      { mode: 0o700 },
    );
    for (const mode of ["timeout", "cancel"]) {
      rmSync(pids, { force: true });
      const code = `import {existsSync} from 'node:fs';
const controller=new AbortController();
let timer;if(${JSON.stringify(mode)}==='cancel')timer=setInterval(()=>{if(existsSync(${JSON.stringify(pids)})){clearInterval(timer);controller.abort(new Error('controlled-cancellation'));}},5);
try{await discoverEnvironment({signal:controller.signal,cwd:${JSON.stringify(root)},timeoutMs:500});process.exitCode=1;}catch(error){console.log(JSON.stringify({code:error.code??null,message:error.message}));}finally{clearInterval(timer);}`;
      const result = isolated(shell, code);
      const processIds = existsSync(pids)
        ? JSON.parse(readFileSync(pids, "utf8"))
        : null;
      try {
        assert.equal(result.status, 0, result.stderr);
        const outcome = JSON.parse(result.stdout);
        if (mode === "timeout")
          assert.equal(outcome.code, "environment_probe_timeout");
        else assert.equal(outcome.message, "controlled-cancellation");
        assert.ok(processIds);
        for (const pid of Object.values(processIds))
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } finally {
        if (processIds) {
          try {
            process.kill(-processIds.root, "SIGKILL");
          } catch {}
          for (const pid of Object.values(processIds)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
      }
    }
  },
);
