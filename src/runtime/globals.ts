import { Console as NodeConsole } from "node:console";

export function executionGlobals(
  logger: Console = console,
): Record<string, unknown> {
  // Retain native Console behavior without exposing its private Writable,
  // whose host callbacks and lifecycle belong to the accepted Run.
  const methods: Record<string, unknown> = Object.create(null);
  for (const name of Object.getOwnPropertyNames(NodeConsole.prototype)) {
    if (name === "constructor" || name.startsWith("_")) continue;
    const method = Reflect.get(logger, name);
    if (typeof method === "function") methods[name] = method.bind(logger);
  }
  return {
    console: methods,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    fetch,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  };
}
