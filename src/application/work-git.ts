import { discoverEnvironment } from "../process/environment.js";
import { WorkGitMaintenance } from "../maintenance/work-git.js";

/** One native timer per configured profile; Git absence never blocks startup. */
export class WorkGitSchedule {
  #timer?: NodeJS.Timeout;
  #active?: Promise<void>;
  #closed = false;
  #controller = new AbortController();
  constructor(
    readonly root: string,
    readonly diagnose: (code: string) => void,
    readonly reserve?: (bytes: number) => Promise<{ release(): void }>,
  ) {}
  start(): void {
    if (this.#closed || this.#active || this.#timer) return;
    this.#active = this.#check().finally(() => {
      this.#active = undefined;
    });
    void this.#active.catch(() => {});
  }
  async #check(): Promise<void> {
    let next = Date.now() + 24 * 60 * 60_000;
    try {
      const environment = await discoverEnvironment({
        cwd: this.root,
        signal: this.#controller.signal,
      });
      if (this.#closed) return;
      const result = await new WorkGitMaintenance(this.root, {
        environment,
        ...(this.reserve ? { reserve: this.reserve } : {}),
      }).checkDue();
      if (result.status === "failed" || result.status === "unavailable")
        this.diagnose(`work_git_${result.status}`);
      const due = Date.parse(result.nextCheckAt);
      if (Number.isFinite(due)) next = due;
    } catch {
      if (!this.#closed) this.diagnose("work_git_unavailable");
    } finally {
      if (!this.#closed) {
        this.#timer = setTimeout(
          () => {
            this.#timer = undefined;
            this.start();
          },
          Math.max(1000, next - Date.now()),
        );
        this.#timer.unref();
      }
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#controller.abort();
    // The real Git attempt has its own bounded native stop/closure proof.
    await this.#active;
  }
}
