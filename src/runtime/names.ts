import { requireCondition } from "../contracts/errors.js";
import vm from "node:vm";
import { executionGlobals } from "./globals.js";

// Names are registration keys, never paths. Keep the same identity on all OSes.
export function scriptFilename(value: unknown): asserts value is string {
  requireCondition(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.js$/.test(value) &&
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value),
    "invalid_script_name",
    "A script name must be one portable .js filename, without a directory.",
  );
}

const reserved = new Set(
  (
    `await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield eval arguments ` +
    `transfer sh output runtime state mcp api maintenance context console require nexum scripts`
  ).split(/\s+/),
);
for (const name of [
  ...(vm.runInNewContext("Object.getOwnPropertyNames(globalThis)") as string[]),
  ...Object.keys(executionGlobals()),
])
  reserved.add(name);
const portableReserved = new Set(
  [...reserved].map((name) => name.toLowerCase()),
);

export function extensionNamespace(value: string): void {
  requireCondition(
    /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(value) &&
      !portableReserved.has(value.toLowerCase()),
    "invalid_namespace",
    "The extension namespace conflicts with JavaScript, a global, or a platform binding.",
  );
}
