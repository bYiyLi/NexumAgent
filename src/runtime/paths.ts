import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { newId } from "../contracts/json.js";
import { requireCondition } from "../contracts/errors.js";

export function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

// Internal persistence helpers, not a public filesystem SDK.
export function privateDirectory(root: string, ...parts: string[]): string {
  const boundary = realpathSync(root);
  requireCondition(
    boundary === root,
    "storage_path_escape",
    "The established internal root must not redirect to another location.",
  );
  let current = boundary;
  for (const part of parts) {
    requireCondition(
      part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/.test(part),
      "invalid_path",
      "Invalid internal directory component.",
    );
    const next = path.join(current, part);
    const existing = lstatSync(next, { throwIfNoEntry: false });
    requireCondition(
      !existing || existing.isDirectory(),
      "storage_path_escape",
      "An internal directory must be a directory and must not redirect to another location.",
    );
    if (!existing) mkdirSync(next, { recursive: false, mode: 0o700 });
    current = realpathSync(next);
    requireCondition(
      contains(boundary, current),
      "storage_path_escape",
      "An internal directory escapes its profile.",
    );
  }
  return current;
}

export function atomicText(filename: string, text: string): void {
  const temporary = path.join(path.dirname(filename), "." + newId("write"));
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
}
