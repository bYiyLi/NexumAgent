import type { Caller } from "../contracts/caller.js";
import type { JsonObject, JsonValue } from "../contracts/types.js";
import type { RunView } from "../runtime/engine.js";
import { RuntimeTasks } from "../runtime/tasks.js";

/** Trusted application composition only; adapters still use the one RunEngine. */
export function taskHandlers<T>(
  tasks: RuntimeTasks,
  options: {
    readonly caller: Caller;
    readonly signal: AbortSignal;
    readonly project: (view: RunView) => T | Promise<T>;
    readonly beforeInput?: (runId: string) => void | Promise<void>;
  },
) {
  return {
    "agent.tasks.create": (input: { runId: string; ttlMs?: number }) =>
      tasks.create(options.caller, input, options.signal),
    "agent.tasks.get": async (input: { taskId: string }) => {
      const result = await tasks.get(
        options.caller,
        input.taskId,
        options.signal,
      );
      return { task: result.task, view: await options.project(result.view) };
    },
    "agent.tasks.update": async (input: {
      taskId: string;
      waitId: string;
      input: JsonValue;
      attachments?: JsonObject[];
    }) => {
      const result = await tasks.update(
        options.caller,
        input,
        options.signal,
        options.beforeInput,
      );
      return { task: result.task, view: await options.project(result.view) };
    },
    "agent.tasks.cancel": async (input: { taskId: string }) => {
      const result = await tasks.cancel(
        options.caller,
        input.taskId,
        options.signal,
      );
      return {
        task: result.task,
        view: await options.project(result.view),
        accepted: result.accepted,
      };
    },
  };
}
