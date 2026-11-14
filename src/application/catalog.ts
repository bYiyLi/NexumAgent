import path from "node:path";
import { realpathSync, watch, type FSWatcher } from "node:fs";
import { requireCondition } from "../contracts/errors.js";
import { canonicalJson } from "../contracts/json.js";
import type {
  WireCatalogProjectV2,
  WireCatalogSummaryV2,
  WireEventDataV2,
} from "../contracts/wire.js";
import { contains } from "../runtime/paths.js";
import { readProjectSummary } from "../work/discovery.js";

/** Cloud owns the project catalog; this is its bounded live README projection. */
export class AgentCatalog {
  #projects = new Map<string, WireCatalogProjectV2>();
  #watchers: FSWatcher[] = [];
  #generation: string | undefined;
  #nextPage = 0;
  #pending: WireCatalogProjectV2[] = [];
  #roots: readonly string[] = [];
  #sequence = 0;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  #timer?: NodeJS.Timeout;
  constructor(
    readonly publish: (
      data: WireEventDataV2["agent.catalog.changed"],
    ) => Promise<void>,
  ) {}
  project(id: string): WireCatalogProjectV2 | undefined {
    return this.#projects.get(id);
  }
  async sync(
    data: WireEventDataV2["agent.catalog.sync"],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    requireCondition(
      !this.#closed,
      "runtime_closed",
      "The Agent catalog has closed.",
    );
    if (data.page === 0) {
      this.#generation = data.generation;
      this.#nextPage = 0;
      this.#pending = [];
    }
    requireCondition(
      this.#generation === data.generation &&
        data.page === this.#nextPage &&
        this.#pending.length + data.projects.length <= 10000,
      "catalog_page_mismatch",
      "The catalog pages are stale, out of order or too large.",
    );
    this.#pending.push(
      ...(JSON.parse(canonicalJson(data.projects)) as WireCatalogProjectV2[]),
    );
    this.#nextPage++;
    if (!data.complete) return;
    const projects = new Map<string, WireCatalogProjectV2>();
    for (const item of this.#pending) {
      requireCondition(
        !projects.has(item.projectId),
        "catalog_page_mismatch",
        "A project was repeated in one catalog generation.",
      );
      projects.set(item.projectId, item);
    }
    this.#roots = [...data.allowedRoots];
    this.#projects = projects;
    this.#pending = [];
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
    for (const project of projects.values()) {
      try {
        this.#path(project.root);
        const watcher = watch(project.root, (_event, filename) => {
          if (
            filename === null ||
            /^readme(?:\..*)?$/i.test(filename.toString())
          )
            this.#schedule();
        });
        watcher.on("error", () => this.#schedule());
        this.#watchers.push(watcher);
      } catch {
        /* The published summary below records unavailable roots. */
      }
    }
    await this.refresh(signal);
  }
  #path(root: string): void {
    requireCondition(
      path.isAbsolute(root) &&
        realpathSync.native(root) === root &&
        this.#roots.some((allowed) => {
          try {
            return (
              path.isAbsolute(allowed) &&
              realpathSync.native(allowed) === allowed &&
              contains(allowed, root)
            );
          } catch {
            return false;
          }
        }),
      "path_not_allowed",
      "The catalog root is outside its current approved roots.",
    );
  }
  #schedule(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.refresh().catch(() => {});
    }, 100);
    this.#timer.unref();
  }
  refresh(signal = new AbortController().signal): Promise<void> {
    const task = this.#tail.then(async () => {
      if (this.#closed) return;
      const projects = [...this.#projects.values()],
        generation = this.#generation;
      const summaries: WireCatalogSummaryV2[] = [];
      for (const project of projects) {
        signal.throwIfAborted();
        try {
          this.#path(project.root);
          const summary = await readProjectSummary(project.root, signal);
          summaries.push(
            summary.status === "updated" &&
              summary.description !== null &&
              summary.revision !== null
              ? {
                  projectId: project.projectId,
                  root: project.root,
                  status: "ok",
                  description: summary.description,
                  revision: summary.revision,
                }
              : summary.status === "missing"
                ? {
                    projectId: project.projectId,
                    root: project.root,
                    status: "missing",
                  }
                : {
                    projectId: project.projectId,
                    root: project.root,
                    status: "unavailable",
                    error: {
                      code: "readme_unavailable",
                      message: "The current project summary is unavailable.",
                    },
                  },
          );
        } catch {
          signal.throwIfAborted();
          summaries.push({
            projectId: project.projectId,
            root: project.root,
            status: "unavailable",
            error: {
              code: "readme_unavailable",
              message: "The current project summary is unavailable.",
            },
          });
        }
      }
      if (this.#closed || generation !== this.#generation) return;
      // Keep each ordinary control event below its one-MiB envelope limit.
      let page: WireCatalogSummaryV2[] = [];
      for (const item of summaries) {
        if (
          page.length &&
          Buffer.byteLength(canonicalJson([...page, item])) > 512 * 1024
        ) {
          await this.publish({
            sequence: ++this.#sequence,
            observedAt: new Date().toISOString(),
            projects: page,
          });
          page = [];
        }
        page.push(item);
      }
      if (page.length)
        await this.publish({
          sequence: ++this.#sequence,
          observedAt: new Date().toISOString(),
          projects: page,
        });
    });
    this.#tail = task.catch(() => {});
    return task;
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
    await this.#tail;
  }
}
