import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { Profile } from "../contracts/types.js";
import { requireCondition } from "../contracts/errors.js";
import { privateDirectory } from "../runtime/paths.js";

export const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;

/** Private, bounded control diagnostics. Native/plugin errors and payloads never enter this file. */
export function appendDiagnostic(
  root: string,
  profile: Profile,
  code: string,
  retry: boolean,
): void {
  const directory = privateDirectory(root, "logs");
  const filename = path.join(directory, "agent.log");
  const before = lstatSync(filename, { throwIfNoEntry: false });
  requireCondition(
    !before || (before.isFile() && before.nlink === 1),
    "agent_log_unavailable",
    "The diagnostic file is unavailable.",
  );
  const file = openSync(
    filename,
    constants.O_RDWR |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  try {
    const actual = fstatSync(file);
    const current = lstatSync(filename);
    requireCondition(
      actual.isFile() &&
        actual.nlink === 1 &&
        actual.dev === current.dev &&
        actual.ino === current.ino &&
        (!before || (actual.dev === before.dev && actual.ino === before.ino)) &&
        realpathSync.native(root) === root &&
        realpathSync.native(directory) === directory,
      "agent_log_unavailable",
      "The diagnostic file is unavailable.",
    );
    fchmodSync(file, 0o600);
    const entry = Buffer.from(
      JSON.stringify({
        time: new Date().toISOString(),
        profile,
        code: /^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : "agent_failed",
        retry,
      }) + "\n",
    );
    let position = actual.size;
    if (position + entry.length > MAX_DIAGNOSTIC_BYTES) {
      const length = Math.min(actual.size, MAX_DIAGNOSTIC_BYTES / 2);
      const tail = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = readSync(
          file,
          tail,
          read,
          length - read,
          actual.size - length + read,
        );
        if (!count) break;
        read += count;
      }
      // Drop the first partial record, including any partial UTF-8 character.
      const newline = tail.subarray(0, read).indexOf(10);
      const retained =
        newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1, read);
      ftruncateSync(file, 0);
      writeAll(file, retained, 0);
      position = retained.length;
    }
    writeAll(file, entry, position);
  } finally {
    closeSync(file);
  }
}

function writeAll(file: number, bytes: Buffer, position: number): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(
      file,
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    requireCondition(
      count > 0,
      "agent_log_unavailable",
      "The diagnostic write did not complete.",
    );
    offset += count;
  }
}
