import path from "node:path";
import { realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { Readable } from "node:stream";
import { requireCondition } from "../contracts/errors.js";
import { newId } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";
import type { RunServices } from "../runtime/engine.js";
import { contains } from "../runtime/paths.js";
import {
  prepareUpload,
  receiveUpload,
  type TransferIoScope,
} from "../transfer/io.js";
import { TransferStreamSlots } from "../transfer/stream-slots.js";

export interface AttachmentSource {
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly sha256?: string;
  open(): Promise<{ readable: Readable; closed: Promise<void> }>;
}
export interface AttachmentPreparation {
  readonly work: string;
  readonly slots: TransferStreamSlots;
  readonly reserve?: (bytes: number) => Promise<{ release(): void }>;
  resolve(
    reference: JsonObject,
    services: RunServices,
  ): Promise<AttachmentSource>;
}

/** The existing RunEngine owns this all-or-nothing input barrier and its lifetime. */
export async function prepareRunAttachments(
  options: AttachmentPreparation,
  references: readonly JsonObject[],
  directory: string,
  services: RunServices,
): Promise<JsonObject[]> {
  requireCondition(
    references.length <= 20,
    "attachment_count_exceeded",
    "An input batch accepts at most twenty attachments.",
  );
  const root = path.join(options.work, "tmp", "runs", services.runId);
  requireCondition(
    realpathSync.native(directory) === directory && contains(root, directory),
    "attachment_path_escape",
    "Inputs must stay in this run's own preparation directory.",
  );
  const files: string[] = [],
    result: JsonObject[] = [];
  let total = 0;
  try {
    for (const reference of references) {
      services.assertCurrent();
      services.signal.throwIfAborted();
      const permit = options.slots.tryAcquire();
      requireCondition(
        permit,
        "transfer_busy",
        "All actual file stream slots are occupied.",
      );
      let input: Awaited<ReturnType<AttachmentSource["open"]>> | undefined;
      let storage: { release(): void } | undefined;
      try {
        const source = await options.resolve(reference, services);
        requireCondition(
          typeof source.name === "string" &&
            source.name.length > 0 &&
            Buffer.byteLength(source.name) <= 512 &&
            !/[\0\r\n]/.test(source.name),
          "invalid_attachment",
          "The normalized attachment name is invalid.",
        );
        const remaining = Math.min(
          256 * 1024 * 1024,
          512 * 1024 * 1024 - total,
        );
        requireCondition(
          remaining > 0 &&
            (source.size === undefined || source.size <= remaining),
          "attachment_budget_exceeded",
          "The attachment batch exceeds its actual byte budget.",
        );
        storage = await options.reserve?.((source.size ?? remaining) + 16384);
        const filename = path.join(directory, newId("input") + ".bin");
        const scope: TransferIoScope = {
          pwd: directory,
          signal: services.signal,
          assertCurrent: () => services.assertCurrent(),
          authorize(target) {
            requireCondition(
              target.path !== undefined && contains(directory, target.path),
              "attachment_path_escape",
              "An input write escaped its preparation directory.",
            );
            services.assertCurrent();
          },
        };
        const prepared = await prepareUpload(
          {
            path: filename,
            mimeType: source.mimeType,
            ...(source.size === undefined ? {} : { expectedSize: source.size }),
            ...(source.sha256 === undefined
              ? {}
              : { expectedSha256: source.sha256 }),
          },
          scope,
          { maxBytes: remaining },
        );
        input = await source.open();
        const receipt = await receiveUpload(input.readable, prepared, scope, {
          maxBytes: remaining,
          ...(source.size === undefined ? {} : { contentLength: source.size }),
        });
        files.push(receipt.path);
        await input.closed;
        services.assertCurrent();
        services.signal.throwIfAborted();
        total += receipt.size;
        result.push({
          path: receipt.path,
          name: source.name,
          mimeType: receipt.mimeType,
          size: receipt.size,
          sha256: receipt.sha256,
          revision: receipt.revision,
        });
      } finally {
        input?.readable.destroy();
        if (input) await input.closed.catch(() => {});
        storage?.release();
        permit.release();
      }
    }
    return result;
  } catch (cause) {
    // Only paths actually committed by this barrier are removed; source files
    // and registered resource bytes retain their own existing lifetimes.
    await Promise.allSettled(files.map((filename) => unlink(filename)));
    throw cause;
  }
}
