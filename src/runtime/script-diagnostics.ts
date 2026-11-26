import { types as utilTypes } from "node:util";
import { AssertionError } from "node:assert";

// Native modules execute outside the guest VM. Match their actual prototypes,
// never an arbitrary error.name or constructor supplied by a guest.
const hostPrototypes = new Map<object, string>([
  [Error.prototype, "Error"], [SyntaxError.prototype, "SyntaxError"],
  [TypeError.prototype, "TypeError"], [ReferenceError.prototype, "ReferenceError"],
  [RangeError.prototype, "RangeError"], [URIError.prototype, "URIError"],
  [EvalError.prototype, "EvalError"], [AggregateError.prototype, "AggregateError"],
  [AssertionError.prototype, "AssertionError"],
]);
const hostStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const hostPrepare = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");

// null means the lookup could not be completed without touching an untrusted
// prototype. Do not let lazy V8 stack formatting perform that lookup instead.
function descriptorInChain(value: object, key: string): PropertyDescriptor | undefined | null {
  let owner: object | null = value;
  for (let depth = 0; owner && depth < 8; depth++) {
    if (utilTypes.isProxy(owner)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return descriptor;
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return owner ? null : undefined;
}

/** Safe, script-relative diagnostics. Never expose a raw V8/host stack. */
export interface ScriptDiagnostic {
  exceptionType: string;
  exceptionCode?: "ERR_ASSERTION";
  location?: { source: string; line: number; column?: number };
}

export function inspectScriptError(
  cause: unknown,
  nativeStackGetter: (this: Error) => unknown,
  filename: string,
  prototypes: ReadonlyMap<object, string>,
  realmError: typeof Error,
  retainStack?: (stack: string) => void,
): ScriptDiagnostic | null {
  if (utilTypes.isProxy(cause) || !utilTypes.isNativeError(cause)) return null;
  const prototype = Object.getPrototypeOf(cause) as object;
  const hostType = hostPrototypes.get(prototype);
  const realmType = prototypes.get(prototype);
  const exceptionType = realmType ?? hostType ?? "Error";
  const diagnostic: ScriptDiagnostic = { exceptionType };
  const code = Object.getOwnPropertyDescriptor(cause, "code");
  if (hostType === "AssertionError" && code && "value" in code && code.value === "ERR_ASSERTION")
    diagnostic.exceptionCode = "ERR_ASSERTION";

  // V8's formatter may call guest-defined Error.prepareStackTrace, name or
  // message accessors. Refuse location extraction in those cases.
  if ((!realmType && !hostType) || descriptorInChain(realmError, "prepareStackTrace") !== undefined)
    return diagnostic;
  const prepare = descriptorInChain(Error, "prepareStackTrace");
  if (prepare === null || prepare?.get || prepare?.set || prepare?.value !== hostPrepare?.value) return diagnostic;
  let multilineMessage: string | undefined;
  for (const field of ["name", "message"]) {
    // A changed prototype can contain an accessor, too. Do not ask V8 to
    // format an error with a guest-controlled name/message getter.
    const descriptor = descriptorInChain(cause, field);
    if (descriptor === null || (descriptor && (!("value" in descriptor) ||
        typeof descriptor.value !== "string" || descriptor.value.length > (field === "name" ? 128 : 8192))))
      return diagnostic;
    if (descriptor && /[\r\n]/.test(descriptor.value)) {
      // Node's generated assertion messages are multiline and may contain
      // private compared values. Strip the exact header, never parse it as frames.
      if (field !== "message" || diagnostic.exceptionCode !== "ERR_ASSERTION" || descriptor.value.length > 8192)
        return diagnostic;
      multilineMessage = descriptor.value;
    }
  }
  const ownStack = Object.getOwnPropertyDescriptor(cause, "stack");
  let stack: unknown;
  const getter = hostType ? hostStackGetter : nativeStackGetter;
  if (getter && ownStack && "get" in ownStack && ownStack.get === getter) {
    try {
      stack = getter.call(cause);
    } catch {
      // Diagnostics must not replace the original script failure.
      return diagnostic;
    }
  }
  // Guest-supplied getters *and* writable stack strings are untrusted.
  // V8's lazy getter is captured in the VM realm and compared by identity.
  if (typeof stack !== "string") return diagnostic;
  retainStack?.(stack);
  let frames = stack;
  if (multilineMessage !== undefined) {
    const header = "AssertionError [ERR_ASSERTION]: " + multilineMessage + "\n";
    if (!frames.startsWith(header)) return diagnostic;
    frames = frames.slice(header.length);
  }

  const marker = filename + ":";
  for (const raw of frames.slice(0, 16384).split("\n").slice(0, 32)) {
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
      ...diagnostic,
      location: {
        source: filename,
        line: Math.max(1, wrappedLine - 1),
        ...(column === undefined ? {} : { column }),
      },
    };
  }
  return diagnostic;
}
