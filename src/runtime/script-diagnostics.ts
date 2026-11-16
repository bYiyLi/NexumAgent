import { types as utilTypes } from "node:util";

/** Safe, script-relative diagnostics. Never expose a raw V8/host stack. */
export interface ScriptDiagnostic {
  exceptionType: string;
  location?: { source: string; line: number; column?: number };
}

export function inspectScriptError(
  cause: unknown,
  nativeStackGetter: (this: Error) => unknown,
  filename: string,
  prototypes: ReadonlyMap<object, string>,
  realmError: typeof Error,
): ScriptDiagnostic | null {
  if (!utilTypes.isNativeError(cause)) return null;
  const exceptionType = prototypes.get(Object.getPrototypeOf(cause)) ?? "Error";
  const diagnostic: ScriptDiagnostic = { exceptionType };

  // V8's formatter may call guest-defined Error.prepareStackTrace, name or
  // message accessors. Refuse location extraction in those cases.
  if (Object.getOwnPropertyDescriptor(realmError, "prepareStackTrace"))
    return diagnostic;
  for (const field of ["name", "message"]) {
    const own = Object.getOwnPropertyDescriptor(cause, field);
    if (own && !("value" in own)) return diagnostic;
  }
  const ownStack = Object.getOwnPropertyDescriptor(cause, "stack");
  let stack: unknown;
  if (ownStack && "get" in ownStack && ownStack.get === nativeStackGetter)
    stack = nativeStackGetter.call(cause);
  // Guest-supplied getters *and* writable stack strings are untrusted.
  // V8's lazy getter is captured in the VM realm and compared by identity.
  if (typeof stack !== "string") return diagnostic;

  const marker = filename + ":";
  for (const raw of stack.slice(0, 16384).split("\n").slice(0, 32)) {
    const line = raw.trim();
    if (!line.startsWith("at ") && !line.startsWith(marker)) continue;
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const coordinate = /^(\d+)(?::(\d+))?(?:\)|$)/.exec(line.slice(index + marker.length));
    if (!coordinate) continue;
    const wrappedLine = Number(coordinate[1]);
    const column = coordinate[2] ? Number(coordinate[2]) : undefined;
    if (!Number.isSafeInteger(wrappedLine) || (column !== undefined && !Number.isSafeInteger(column))) continue;
    return {
      exceptionType,
      location: {
        source: filename,
        line: Math.max(1, wrappedLine - 1),
        ...(column === undefined ? {} : { column }),
      },
    };
  }
  return diagnostic;
}
