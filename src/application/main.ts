import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { realpath, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { AgentError, isAgentError } from "../contracts/errors.js";
import { newId } from "../contracts/json.js";
import type { Profile } from "../contracts/types.js";
import { loadProfileConfig, profileRoot } from "./config.js";
import {
  reconnectControl,
  type ConnectionDiagnosticDetails,
} from "./connection.js";
import { AgentRuntime, type AgentRuntimeOptions } from "./runtime.js";
import { maintenanceRuntimeOptions } from "./maintenance.js";
import { WorkGitSchedule } from "./work-git.js";
import { appendDiagnostic, startupFailureDetails } from "./diagnostics.js";

export interface AgentProgramOptions {
  readonly version: string;
  /** Managed Launcher correlation ID; optional for embedded/runtime tests. */
  readonly attemptId?: string;
  readonly signal?: AbortSignal;
  /** Trusted embedding/test home; the installed CLI uses the actual OS home. */
  readonly home?: string;
  readonly runtime?: AgentRuntimeOptions;
  diagnose?(
    code: string,
    retry: boolean,
    details?: ConnectionDiagnosticDetails,
  ): void;
}

/** Native process entry: one boot/Core survives reconnects; only observations are replaced. */
export async function runAgent(
  profile: Profile,
  options: AgentProgramOptions,
): Promise<number> {
  let runtime: AgentRuntime | undefined;
  let git: WorkGitSchedule | undefined;
  let initializing: Promise<AgentRuntime> | undefined;
  let stopping = false;
  let shutdownTask: Promise<void> | undefined;
  let reserve: ((bytes: number) => Promise<{ release(): void }>) | undefined;
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  let failure: unknown;
  let restartRequested = false;
  let diagnosticRoot: string | undefined;
  const attemptId = options.attemptId ?? randomUUID();
  let startupPhase = "profile_load";
  let rejectedCode = "connection_rejected";
  const diagnose = (
    code: string,
    retry: boolean,
    details?: ConnectionDiagnosticDetails,
  ) => {
    if (!retry && [
      "invalid_configuration", "invalid_agent_credential", "agent_already_connected",
      "unsupported_protocol", "invalid_agent_metadata",
      "unsupported_agent_environment",
    ].includes(code))
      rejectedCode = code;
    // Never serialize native/plugin errors, request data, configuration or credentials.
    if (diagnosticRoot) {
      try {
        appendDiagnostic(diagnosticRoot, profile, code, retry, details);
      } catch {
        process.stderr.write("agent_log_unavailable\n");
      }
    }
    options.diagnose?.(code, retry, details);
    const failureSummary = code === "agent_startup_failed" ? [
      details?.phase ? `phase=${details.phase}` : "",
      details?.failureCode ? `failure=${details.failureCode}` : "",
      details?.sourceCode ? `source=${details.sourceCode}` : "",
      details?.sourceModule ? `module=${details.sourceModule}` : "",
    ].filter(Boolean).join(" ") : "";
    process.stderr.write(`${code}${retry ? ": retrying" : ""}${failureSummary ? " " + failureSummary : ""}\n`);
  };
  const shutdown = (): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    stopping = true;
    shutdownTask = (async () => {
      try {
        // Keep the authenticated cleanup channel open until Core/native I/O
        // has joined. An OS stop is not an observation disconnect.
        await initializing?.catch(() => {});
        const closed = await Promise.allSettled([
          git?.close(),
          runtime?.close(),
        ]);
        const failed = closed.find((entry) => entry.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } finally {
        lifetime.abort(
          new AgentError("runtime_closed", "The Agent process is stopping."),
        );
      }
    })();
    void shutdownTask.catch(() => {});
    return shutdownTask;
  };
  const stop = () => {
    void shutdown();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (options.signal?.aborted) return 0;
    // An existing profile can retain a fixed launch/configuration error without
    // parsing credentials or creating a new profile as a side effect.
    try {
      const candidate = profileRoot(
        profile,
        realpathSync.native(options.home ?? homedir()),
      );
      const directory = lstatSync(candidate, { throwIfNoEntry: false });
      if (
        directory?.isDirectory() &&
        realpathSync.native(candidate) === candidate
      )
        diagnosticRoot = candidate;
    } catch {
      /* A missing home/profile cannot provide a private diagnostic location. */
    }
    diagnose("agent_boot_stage", false, {
      component: "core", phase: startupPhase, attemptId,
    });
    if (typeof vm.SourceTextModule !== "function") {
      diagnose("vm_modules_required", false, {
        component: "core", phase: "runtime_preflight",
        attemptId, recoveryCode: "verify_core",
      });
      diagnose("agent_startup_failed", false, {
        component: "core", phase: "runtime_preflight", attemptId,
        failureCode: "vm_modules_required", recoveryCode: "verify_core",
      });
      return 78; // Permanent local fault: Launcher reports blocked without retry.
    }
    const config = loadProfileConfig(profile, options.home);
    diagnosticRoot = config.root;
    startupPhase = "control_connect";
    diagnose("agent_boot_stage", false, {
      component: "core", phase: startupPhase, attemptId,
    });
    const bootId = newId("boot");
    const defaults = maintenanceRuntimeOptions(config);
    const configure =
      options.runtime?.configureMaintenance ?? defaults.configureMaintenance!;
    const reconnectResult = await reconnectControl(
      {
        serverUrl: config.serverUrl,
        token: config.token,
        profile,
        bootId,
        version: options.version,
        signal,
        async upgrade(version) {
          const program = path.join(config.root, "program");
          if ((await realpath(program)) !== program)
            throw new AgentError(
              "agent_update_failed",
              "The managed Agent program directory is invalid.",
            );
          const temporary = path.join(
            program,
            ".update-" + randomUUID() + ".new",
          );
          try {
            await writeFile(temporary, JSON.stringify({ version }) + "\n", {
              flag: "wx",
              mode: 0o600,
            });
            await rename(temporary, path.join(program, "update.json"));
          } finally {
            await rm(temporary, { force: true });
          }
          diagnose("agent_upgrade_required", false);
        },
        async ready(connection) {
          try {
            if (stopping)
              throw new AgentError("runtime_closed", "The Agent is stopping.");
            if (runtime) {
              startupPhase = "connection_attach";
              runtime.attachConnection(connection);
            }
            else {
              startupPhase = "core_initialize";
              diagnose("agent_boot_stage", false, {
                component: "core", phase: startupPhase, attemptId,
              });
              initializing = AgentRuntime.create(config, connection, bootId, {
                version: options.version,
                home: options.home,
                ...defaults,
                ...options.runtime,
                async configureMaintenance(components) {
                  reserve = components.reserve;
                  return await configure(components);
                },
                async requestRestart(restartId, reason) {
                  if (stopping || restartRequested) return;
                  restartRequested = true;
                  diagnose("agent_restart_requested", false, {
                    phase: "restart",
                    component: "core",
                    failureCode: "restart_scheduled",
                  });
                  void shutdown().catch(() => {});
                },
              });
              try {
                runtime = await initializing;
              } finally {
                initializing = undefined;
              }
              if (!stopping) {
                git = new WorkGitSchedule(
                  config.root,
                  (code) => diagnose(code, false),
                  reserve,
                );
                git.start();
              }
            }
            if (stopping) return;
            startupPhase = "online";
            diagnose("agent_connected", false, {
              component: "core", phase: startupPhase, attemptId,
            });
            // Return the ready handshake first. Optional packages may fail,
            // block or require user authority without losing Core presence.
            setImmediate(() => {
              if (!stopping) runtime?.startOptionalComponents();
            });
          } catch (cause) {
            if (!stopping) failure = cause;
            void shutdown();
            throw cause;
          }
        },
        invoke(message, observer) {
          if (!runtime || stopping)
            throw new AgentError(
              "runtime_unavailable",
              "The Agent has not initialized.",
            );
          return runtime.dispatch(message, observer);
        },
        async event(message, observer) {
          if (!runtime || stopping)
            throw new AgentError(
              "runtime_unavailable",
              "The Agent has not initialized.",
            );
          await runtime.event(message, observer);
        },
      },
      diagnose,
    );
    if (failure) throw failure;
    if (reconnectResult === "permanent") {
      diagnose("agent_startup_failed", false, {
        component: "core", phase: "control_connect", attemptId,
        failureCode: rejectedCode, recoveryCode: "check_configuration",
      });
      return 78;
    }
    return restartRequested ? 76 : reconnectResult === "upgrade" ? 75 : 0;
  } catch (cause) {
    const code = isAgentError(cause) ? cause.code : "agent_failed";
    diagnose("agent_startup_failed", false, startupFailureDetails(
      cause, startupPhase, attemptId,
    ));
    return code === "invalid_configuration" ? 78 : 1;
  } finally {
    options.signal?.removeEventListener("abort", stop);
    try {
      await shutdown();
    } catch (cause) {
      diagnose("agent_shutdown_unconfirmed", false, startupFailureDetails(
        cause, "shutdown", attemptId,
      ));
      // This overrides a normal return; do not report successful cleanup.
      throw new AgentError(
        "agent_shutdown_unconfirmed",
        "The Agent's native resources have not confirmed closure.",
      );
    }
  }
}
