import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { requireCondition } from "../contracts/errors.js";

/** Private control files stay bounded even if an external writer changes them. */
export async function maintenanceText(
  filename: string,
  maximum: number,
  optional = false,
): Promise<string | null> {
  let file;
  try {
    file = await open(
      filename,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (cause) {
    if (optional && (cause as NodeJS.ErrnoException).code === "ENOENT")
      return null;
    throw cause;
  }
  try {
    const before = await file.stat();
    requireCondition(
      before.isFile() && before.size <= maximum,
      "maintenance_file_invalid",
      "The maintenance input must be a bounded regular file.",
    );
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maximum - length + 1)),
        read = await file.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
      requireCondition(
        length <= maximum,
        "maintenance_file_invalid",
        "The maintenance file grew beyond its fixed limit.",
      );
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const after = await file.stat();
    requireCondition(
      before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs,
      "maintenance_file_changed",
      "The maintenance input changed while being read.",
    );
    return Buffer.concat(chunks, length).toString("utf8");
  } finally {
    await file.close();
  }
}
