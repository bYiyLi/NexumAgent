import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import {
  mergeChildEnvironment,
  whichExecutable,
  type EnvironmentSnapshot,
} from "../process/environment.js";
import { atomicText, contains, privateDirectory } from "../runtime/paths.js";

const day = 24 * 60 * 60_000;
const maximumOutput = 4 * 1024 * 1024;
const roots = [
  ".gitignore",
  "package.json",
  "package-lock.json",
  "scripts",
  "modules",
  "docs",
];
const running = new Set<string>();
const ignoreBlock = [
  "# Nexum Agent work snapshots",
  "/mcp.json",
  "/api/",
  "/api.json",
  "node_modules/",
  "resources/",
  "tmp/",
  ".env",
  ".env.*",
  ".npmrc",
  "",
].join("\n");
export type WorkGitStatus =
  "committed" | "unchanged" | "skipped" | "unavailable" | "failed" | "not_due";
export interface WorkGitResult {
  readonly status: WorkGitStatus;
  readonly reason: string | null;
  readonly checkedAt: string;
  readonly nextCheckAt: string;
  readonly commit: string | null;
  readonly stateSaved: boolean;
}
export interface WorkGitOptions {
  /** Already-discovered user environment. Never inherit the Agent's process.env directly. */
  readonly environment: EnvironmentSnapshot;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}
interface Attempt {
  readonly root: string;
  readonly work: string;
  readonly gitDir: string;
  readonly state: string;
  readonly empty: string;
  readonly executable: string;
  readonly environment: Record<string, string>;
  readonly timeoutMs: number;
}
interface CommandResult {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly uncertain: boolean;
}
class Skip extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
class GitFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
function missing(cause: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes(
    (cause as NodeJS.ErrnoException)?.code ?? "",
  );
}
async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (cause) {
    if (missing(cause)) return false;
    throw cause;
  }
}
function forbidden(filename: string): boolean {
  const parts = filename.split("/");
  return (
    ["mcp.json", "api", "api.json"].includes(parts[0]!.toLowerCase()) ||
    parts.some(
      (part) =>
        ["node_modules", "resources", "tmp", ".npmrc", ".env", ".git"].includes(
          part.toLowerCase(),
        ) || /^\.env\./i.test(part),
    )
  );
}
function selected(filename: string): boolean {
  return (
    !forbidden(filename) &&
    (roots.includes(filename) ||
      ["scripts/", "modules/", "docs/"].some((prefix) =>
        filename.startsWith(prefix),
      ))
  );
}
function names(bytes: Buffer): string[] {
  if (!bytes.length) return [];
  requireCondition(
    bytes.at(-1) === 0,
    "invalid_git_output",
    "Git returned incomplete path records.",
  );
  return new TextDecoder("utf-8", { fatal: true })
    .decode(bytes.subarray(0, -1))
    .split("\0");
}
function gitEnvironment(snapshot: EnvironmentSnapshot): Record<string, string> {
  const result = mergeChildEnvironment(snapshot);
  for (const name of Object.keys(result)) {
    if (
      /^GIT_/i.test(name) ||
      [
        "NODE_OPTIONS",
        "NODE_PATH",
        "PAGER",
        "EDITOR",
        "VISUAL",
        "SSH_ASKPASS",
      ].includes(name.toUpperCase())
    )
      delete result[name];
  }
  Object.assign(result, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_LITERAL_PATHSPECS: "1",
    LC_ALL: "C",
    LANG: "C",
  });
  return result;
}
function safeOptions(attempt: Attempt): string[] {
  return [
    "--no-pager",
    "--literal-pathspecs",
    "-c",
    `core.hooksPath=${attempt.empty}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.attributesFile=${devNull}`,
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "core.pager=",
    "-c",
    "user.name=Nexum Agent",
    "-c",
    "user.email=nexum@localhost",
  ];
}

/** Cold, due-aware local maintenance. Application startup/resume calls these explicitly. */
export class WorkGitMaintenance {
  readonly root: string;
  #options: WorkGitOptions;
  #now: () => number;
  constructor(agentRoot: string, options: WorkGitOptions) {
    requireCondition(
      path.isAbsolute(agentRoot) && !agentRoot.includes("\0"),
      "invalid_work_git_root",
      "Work Git requires the current absolute Agent profile root.",
    );
    requireCondition(
      options.environment.platform === process.platform &&
        Number.isSafeInteger(options.timeoutMs ?? 10_000) &&
        (options.timeoutMs ?? 10_000) > 0 &&
        (options.timeoutMs ?? 10_000) <= 30_000,
      "invalid_work_git_options",
      "Work Git requires a user environment and bounded native command deadline.",
    );
    this.root = path.resolve(agentRoot);
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }
  /** Includes first repository initialization/snapshot, but never forces a second daily attempt. */
  initialize(): Promise<WorkGitResult> {
    return this.#check();
  }
  /** No catch-up loop: a late startup/resume attempts only the current snapshot once. */
  checkDue(): Promise<WorkGitResult> {
    return this.#check();
  }
  #result(
    status: WorkGitStatus,
    reason: string | null,
    now: number,
    commit: string | null = null,
  ): WorkGitResult {
    return {
      status,
      reason,
      checkedAt: new Date(now).toISOString(),
      nextCheckAt: new Date(now + day).toISOString(),
      commit,
      stateSaved: false,
    };
  }
  async #boundary(): Promise<{ root: string; work: string; state: string }> {
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || (await realpath(this.root)) !== this.root)
      throw new Skip("unsafe_profile_root");
    let work: string, state: string;
    try {
      work = privateDirectory(this.root, "work");
    } catch (cause) {
      if (cause instanceof AgentError && cause.code === "storage_path_escape")
        throw new Skip("unsafe_work_root");
      throw cause;
    }
    try {
      state = privateDirectory(this.root, "state");
    } catch (cause) {
      if (cause instanceof AgentError && cause.code === "storage_path_escape")
        throw new Skip("unsafe_maintenance_state");
      throw cause;
    }
    return { root: this.root, work, state };
  }
  async #stored(filename: string): Promise<WorkGitResult | null> {
    try {
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.size > 16384)
        throw new Skip("unsafe_maintenance_state");
      const value: unknown = JSON.parse(await readFile(filename, "utf8"));
      if (
        !isPlainRecord(value) ||
        value.schemaVersion !== 1 ||
        !isPlainRecord(value.result)
      )
        return null;
      const result = value.result;
      if (
        typeof result.checkedAt !== "string" ||
        typeof result.nextCheckAt !== "string" ||
        !Number.isFinite(Date.parse(result.checkedAt)) ||
        Date.parse(result.nextCheckAt) !== Date.parse(result.checkedAt) + day
      )
        return null;
      if (
        ![
          "committed",
          "unchanged",
          "skipped",
          "unavailable",
          "failed",
        ].includes(result.status as string) ||
        !(
          result.reason === null ||
          (typeof result.reason === "string" &&
            /^[a-z][a-z0-9_]{0,95}$/.test(result.reason))
        ) ||
        !(
          result.commit === null ||
          (typeof result.commit === "string" &&
            /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result.commit))
        ) ||
        typeof result.stateSaved !== "boolean"
      )
        return null;
      return result as unknown as WorkGitResult;
    } catch (cause) {
      if (missing(cause) || cause instanceof SyntaxError) return null;
      throw cause;
    }
  }
  async #check(): Promise<WorkGitResult> {
    const key = path.join(this.root, "work"),
      now = this.#now();
    if (running.has(key))
      return this.#result("skipped", "maintenance_busy", now);
    running.add(key);
    try {
      return await this.#attempt(now);
    } finally {
      running.delete(key);
    }
  }
  async #attempt(now: number): Promise<WorkGitResult> {
    let state: string | undefined, empty: string | undefined;
    let result: WorkGitResult;
    try {
      const boundary = await this.#boundary();
      state = path.join(boundary.state, "work-git.json");
      const stored = await this.#stored(state);
      if (stored && now < Date.parse(stored.nextCheckAt))
        return { ...stored, status: "not_due" };
      const environment = gitEnvironment(this.#options.environment);
      const executable = await whichExecutable(
        process.platform === "win32" ? "git.exe" : "git",
        { ...this.#options.environment, variables: environment },
        boundary.root,
      );
      if (
        executable.kind !== "native" ||
        contains(boundary.work, executable.launchPath) ||
        contains(boundary.work, executable.path)
      )
        throw new Skip("unsafe_git_executable");
      empty = await mkdtemp(path.join(boundary.state, "work-git-"));
      const attempt: Attempt = {
        ...boundary,
        gitDir: path.join(boundary.work, ".git"),
        empty,
        executable: executable.path,
        environment,
        timeoutMs: this.#options.timeoutMs ?? 10_000,
      };
      result = await this.#snapshot(attempt, now);
    } catch (cause) {
      const unavailable =
        cause instanceof AgentError &&
        ["command_not_found", "command_access_denied"].includes(cause.code);
      result = this.#result(
        unavailable
          ? "unavailable"
          : cause instanceof Skip
            ? "skipped"
            : "failed",
        unavailable
          ? "git_unavailable"
          : cause instanceof Skip || cause instanceof GitFailure
            ? cause.reason
            : "maintenance_failed",
        now,
      );
    } finally {
      if (empty)
        await rm(empty, { recursive: true, force: true }).catch(() => {});
    }
    if (state) {
      try {
        if ((await exists(state)) && !(await lstat(state)).isFile())
          return { ...result, stateSaved: false };
        const saved = { ...result, stateSaved: true };
        atomicText(
          state,
          canonicalJson({ schemaVersion: 1, result: saved }, 16384) + "\n",
        );
        return saved;
      } catch {
        /* A maintenance record failure cannot invalidate a real commit. */
      }
    }
    return result;
  }
  async #git(
    attempt: Attempt,
    args: string[],
    input?: Buffer,
    repository = true,
  ): Promise<CommandResult> {
    // Recheck the actual current directories before every child; this is not an
    // OS-level dirfd isolation promise against arbitrary hostile concurrent FS writes.
    if (
      (await realpath(attempt.root)) !== attempt.root ||
      (await realpath(attempt.work)) !== attempt.work ||
      !(await lstat(attempt.work)).isDirectory()
    )
      throw new Skip("unsafe_work_root");
    const prefix = [
      ...safeOptions(attempt),
      ...(repository
        ? [`--git-dir=${attempt.gitDir}`, `--work-tree=${attempt.work}`]
        : []),
    ];
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(attempt.executable, [...prefix, ...args], {
        cwd: attempt.work,
        env: attempt.environment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let failure: unknown,
        uncertain = false,
        bytes = 0,
        force: NodeJS.Timeout | undefined;
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      const stop = (reason: string) => {
        if (uncertain) return;
        uncertain = true;
        failure = new GitFailure(reason);
        child.kill("SIGTERM");
        force = setTimeout(() => child.kill("SIGKILL"), 100);
      };
      const timer = setTimeout(
        () => stop("git_command_timeout"),
        attempt.timeoutMs,
      );
      const collect = (chunks: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maximumOutput) stop("git_output_exceeded");
        else chunks.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (cause) => {
        failure = cause;
      });
      child.stdin.on("error", () => {}); // EPIPE is reported by the real child outcome.
      child.once("close", (code) => {
        clearTimeout(timer);
        if (force) clearTimeout(force);
        if (failure && !uncertain) reject(failure);
        else
          resolve({
            code,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            uncertain,
          });
      });
      child.stdin.end(input);
    });
  }
  #ok(result: CommandResult): Buffer {
    if (result.uncertain) throw new GitFailure("git_result_unknown");
    if (result.code !== 0) {
      if (
        /index\.lock|cannot lock ref|another git process/i.test(
          result.stderr.toString("utf8"),
        )
      )
        throw new Skip("git_busy");
      throw new GitFailure("git_command_failed");
    }
    return result.stdout;
  }
  async #repository(attempt: Attempt): Promise<void> {
    const git = await lstat(attempt.gitDir);
    if (
      !git.isDirectory() ||
      (await realpath(attempt.gitDir)) !== attempt.gitDir
    )
      throw new Skip("repository_mismatch");
    for (const part of ["config", "index", "HEAD", "objects", "refs"]) {
      const filename = path.join(attempt.gitDir, part);
      if ((await exists(filename)) && (await lstat(filename)).isSymbolicLink())
        throw new Skip("repository_mismatch");
    }
    for (const part of [
      "commondir",
      "config.worktree",
      "objects/info/alternates",
    ])
      if (await exists(path.join(attempt.gitDir, part)))
        throw new Skip("repository_mismatch");
    let entries = 0;
    const inspect = async (directory: string): Promise<void> => {
      if (!(await exists(directory))) return;
      const children = await opendir(directory);
      for await (const child of children) {
        if (++entries > 100_000) throw new Skip("git_metadata_exceeded");
        if (child.isSymbolicLink()) throw new Skip("repository_mismatch");
        if (child.name.endsWith(".lock")) throw new Skip("git_busy");
        // Git can overwrite COMMIT_EDITMSG or append reflogs in place. A
        // second hard-link name must not make those writes escape the profile.
        if (
          child.isFile() &&
          !contains(
            path.join(attempt.gitDir, "objects"),
            path.join(directory, child.name),
          ) &&
          (await lstat(path.join(directory, child.name))).nlink > 1
        )
          throw new Skip("repository_mismatch");
        if (child.isDirectory())
          await inspect(path.join(directory, child.name));
      }
    };
    await inspect(attempt.gitDir);
    const config = await this.#git(attempt, [
      "config",
      "--no-includes",
      "--local",
      "--name-only",
      "--get-regexp",
      "^(include|includeif|filter|hook)\\.|^core\\.worktree$|^extensions\\.(worktreeconfig|partialclone)$|^remote\\..*\\.promisor$",
    ]);
    if (config.uncertain || ![0, 1].includes(config.code ?? -1))
      throw new GitFailure("git_config_unavailable");
    if (config.stdout.length) throw new Skip("unsafe_git_config");
    const actual = this.#ok(
      await this.#git(attempt, [
        "rev-parse",
        "--show-toplevel",
        "--absolute-git-dir",
        "--git-common-dir",
        "--is-bare-repository",
      ]),
    )
      .toString("utf8")
      .trimEnd()
      .split("\n");
    if (
      actual.length !== 4 ||
      path.resolve(actual[0]!) !== attempt.work ||
      path.resolve(actual[1]!) !== attempt.gitDir ||
      path.resolve(attempt.work, actual[2]!) !== attempt.gitDir ||
      actual[3] !== "false"
    )
      throw new Skip("repository_mismatch");
  }
  async #admission(attempt: Attempt): Promise<string[]> {
    for (const item of [
      "index.lock",
      "HEAD.lock",
      "config.lock",
      "packed-refs.lock",
    ])
      if (await exists(path.join(attempt.gitDir, item)))
        throw new Skip("git_busy");
    for (const item of [
      "MERGE_HEAD",
      "REBASE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-apply",
      "rebase-merge",
      "sequencer",
      "BISECT_LOG",
    ])
      if (await exists(path.join(attempt.gitDir, item)))
        throw new Skip("repository_operation");
    const conflicts = this.#ok(
      await this.#git(attempt, ["ls-files", "--unmerged", "-z"]),
    );
    if (conflicts.length) throw new Skip("unresolved_conflicts");
    const staged = await this.#git(attempt, [
      "diff",
      "--cached",
      "--quiet",
      "--exit-code",
      "--no-ext-diff",
      "--no-textconv",
    ]);
    if (staged.code === 1 && !staged.uncertain)
      throw new Skip("existing_staged");
    this.#ok(staged);
    const tracked = names(
      this.#ok(await this.#git(attempt, ["ls-files", "-z"])),
    );
    if (tracked.some(forbidden)) throw new Skip("forbidden_tracked");
    return tracked;
  }
  async #ignore(attempt: Attempt): Promise<void> {
    const filename = path.join(attempt.work, ".gitignore");
    if ((await exists(filename)) && !(await lstat(filename)).isFile())
      throw new Skip("unsafe_snapshot_path");
    const handle = await open(
      filename,
      constants.O_RDWR |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1 || stat.size > 64 * 1024)
        throw new Skip("unsafe_snapshot_path");
      const content = await handle.readFile("utf8");
      if (!content.includes(ignoreBlock))
        await handle.writeFile(
          (content && !content.endsWith("\n") ? "\n" : "") + ignoreBlock,
        );
    } finally {
      await handle.close();
    }
  }
  async #paths(attempt: Attempt): Promise<string[]> {
    const candidates = names(
      this.#ok(
        await this.#git(attempt, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          ...roots,
        ]),
      ),
    ).filter(selected);
    for (const filename of candidates) {
      const parts = filename.split("/");
      if (
        parts.some(
          (part) => !part || part === "." || part === ".." || part === ".git",
        ) ||
        !contains(attempt.work, path.resolve(attempt.work, ...parts))
      )
        throw new Skip("unsafe_snapshot_path");
      let current = attempt.work;
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]!);
        try {
          const stat = await lstat(current);
          if (
            stat.isSymbolicLink() ||
            (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
          )
            throw new Skip("unsafe_snapshot_path");
        } catch (cause) {
          if (missing(cause)) break;
          throw cause;
        }
      }
    }
    return [...new Set(candidates)];
  }
  async #head(attempt: Attempt): Promise<string | null> {
    const result = await this.#git(attempt, [
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD",
    ]);
    if (result.code === 1 && !result.uncertain) return null;
    const hash = this.#ok(result).toString("utf8").trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash))
      throw new GitFailure("invalid_git_head");
    return hash;
  }
  async #snapshot(attempt: Attempt, now: number): Promise<WorkGitResult> {
    const version = this.#ok(
      await this.#git(attempt, ["--version"], undefined, false),
    )
      .toString("utf8")
      .match(/git version (\d+)\.(\d+)/);
    if (
      !version ||
      Number(version[1]) < 2 ||
      (Number(version[1]) === 2 && Number(version[2]) < 36)
    )
      return this.#result("unavailable", "git_version_unsupported", now);
    if (!(await exists(attempt.gitDir)))
      this.#ok(
        await this.#git(attempt, [
          "init",
          `--template=${attempt.empty}`,
          attempt.work,
        ]),
      );
    await this.#repository(attempt);
    await this.#admission(attempt);
    await this.#ignore(attempt);
    const paths = await this.#paths(attempt);
    if (!paths.length) return this.#result("unchanged", null, now);
    // Recheck immediately before writing the index, then commit only these
    // literal paths. Concurrent unrelated user staging cannot enter this commit.
    await this.#admission(attempt);
    await this.#repository(attempt);
    const before = await this.#head(attempt),
      input = Buffer.from(paths.join("\0") + "\0");
    this.#ok(
      await this.#git(
        attempt,
        ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
        input,
      ),
    );
    const changed = await this.#git(attempt, [
      "diff",
      "--cached",
      "--quiet",
      "--exit-code",
      "--no-ext-diff",
      "--no-textconv",
    ]);
    if (!changed.uncertain && changed.code === 0)
      return this.#result("unchanged", null, now);
    if (changed.uncertain || changed.code !== 1) this.#ok(changed);
    const staged = names(
      this.#ok(
        await this.#git(attempt, [
          "diff",
          "--cached",
          "--name-only",
          "--no-ext-diff",
          "--no-textconv",
          "-z",
        ]),
      ),
    );
    if (
      staged.some((filename) => !paths.includes(filename)) ||
      (await this.#head(attempt)) !== before
    )
      throw new Skip("git_state_changed");
    await this.#repository(attempt);
    const message = `Nexum Agent 自动快照 ${new Date(this.#now()).toISOString()} [${randomUUID()}]`;
    const committed = await this.#git(
      attempt,
      [
        "commit",
        "--only",
        "--no-gpg-sign",
        "--no-verify",
        "--cleanup=verbatim",
        "-m",
        message,
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      input,
    );
    // A timeout/nonzero result can occur after HEAD changed. Inspect the actual
    // commit once; never replay a potentially successful mutation.
    const after = await this.#head(attempt);
    if (after && after !== before) {
      const proof = this.#ok(
        await this.#git(attempt, [
          "show",
          "--no-patch",
          "--format=%P%n%B",
          after,
        ]),
      ).toString("utf8");
      const newline = proof.indexOf("\n");
      if (
        proof.slice(0, newline) === (before ?? "") &&
        proof.slice(newline + 1).trimEnd() === message
      )
        return this.#result(
          "committed",
          committed.uncertain || committed.code !== 0
            ? "commit_confirmed_after_error"
            : null,
          now,
          after,
        );
    }
    if (committed.uncertain || committed.code === 0)
      return this.#result("failed", "commit_outcome_unknown", now);
    this.#ok(committed);
    throw new GitFailure("commit_failed");
  }
}
