import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { privateDirectory } from "./paths.js";

const prefix = "NEXUM_RUN_LOG_V1 ",
  headerBytes = 128,
  maximumBytes = 50 * 1024 * 1024,
  pendingBytes = 64 * 1024 * 1024;
type WriteCallback = (error?: Error | null) => void;
export interface RunLogRange {
  readonly dataOffset: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

/** The first text line records cropping; the remaining bytes are ordinary UTF-8. */
export function readRunLogRange(file: number, bytes: number): RunLogRange {
  const head = Buffer.alloc(Math.min(bytes, headerBytes));
  readSync(file, head, 0, head.length, 0);
  if (!head.subarray(0, prefix.length).equals(Buffer.from(prefix)))
    return { dataOffset: 0, startOffset: 0, endOffset: bytes };
  const value = JSON.parse(head.subarray(prefix.length).toString("utf8"));
  requireCondition(
    head.length === headerBytes &&
      value &&
      Object.keys(value).sort().join(",") === "endOffset,startOffset" &&
      Number.isSafeInteger(value.startOffset) &&
      value.startOffset >= 0 &&
      Number.isSafeInteger(value.endOffset) &&
      value.endOffset >= value.startOffset &&
      value.endOffset - value.startOffset === bytes - headerBytes,
    "run_log_unavailable",
    "The retained log byte range no longer matches its file.",
  );
  return {
    dataOffset: headerBytes,
    startOffset: value.startOffset,
    endOffset: value.endOffset,
  };
}

/** One native file writer, bounded buffering and a plain-text rolling tail. */
export class RunLog extends Writable {
  readonly filename: string;
  failure?: unknown;
  #file?: number;
  #identity?: Stats;
  #start = 0;
  #end = 0;
  #pending = 0;
  #accepting = true;
  #finish?: Promise<void>;
  readonly #reserve?: (bytes: number) => Promise<{ release(): void }>;
  constructor(
    readonly root: string,
    readonly runId: string,
    reserve?: (bytes: number) => Promise<{ release(): void }>,
  ) {
    super({ highWaterMark: 64 * 1024 });
    requireCondition(
      path.isAbsolute(root) && /^run_[0-9a-f]{32}$/.test(runId),
      "run_log_unavailable",
      "A run log requires its actual profile and accepted Run identity.",
    );
    this.filename = path.join(root, "logs", "runs", runId, "console.log");
    this.#reserve = reserve;
  }
  #safe(): void {
    requireCondition(
      realpathSync.native(this.root) === this.root &&
        realpathSync.native(path.dirname(this.filename)) ===
          path.dirname(this.filename),
      "run_log_unavailable",
      "The run log directory was redirected.",
    );
    if (this.#file === undefined) return;
    const actual = fstatSync(this.#file),
      entry = lstatSync(this.filename);
    requireCondition(
      actual.isFile() &&
        actual.nlink === 1 &&
        entry.isFile() &&
        entry.dev === actual.dev &&
        entry.ino === actual.ino &&
        actual.dev === this.#identity?.dev &&
        actual.ino === this.#identity.ino &&
        actual.size === headerBytes + this.#end - this.#start,
      "run_log_unavailable",
      "The retained run log was replaced or changed outside its writer.",
    );
  }
  #write(bytes: Buffer, position: number): void {
    for (let offset = 0; offset < bytes.length;) {
      const count = writeSync(
        this.#file!,
        bytes,
        offset,
        bytes.length - offset,
        position + offset,
      );
      requireCondition(
        count > 0,
        "run_log_failed",
        "The native log write did not advance.",
      );
      offset += count;
    }
  }
  #header(): void {
    const text =
      prefix +
      JSON.stringify({ startOffset: this.#start, endOffset: this.#end });
    requireCondition(
      Buffer.byteLength(text) < headerBytes,
      "run_log_failed",
      "The log range exceeds its fixed header.",
    );
    this.#write(Buffer.from(text.padEnd(headerBytes - 1) + "\n"), 0);
  }
  async open(): Promise<void> {
    privateDirectory(this.root, "logs", "runs", this.runId);
    const reservation = await this.#reserve?.(headerBytes + 1024);
    try {
      this.#safe();
      this.#file = openSync(
        this.filename,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
        0o600,
      );
      this.#identity = fstatSync(this.#file);
      this.#header();
    } finally {
      reservation?.release();
    }
  }
  override write(chunk: unknown, callback?: WriteCallback): boolean;
  override write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback?: WriteCallback,
  ): boolean;
  override write(
    chunk: unknown,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean {
    if (!this.#accepting) return true;
    const bytes =
      typeof chunk === "string"
        ? Buffer.byteLength(
            chunk,
            typeof encoding === "string" ? encoding : "utf8",
          )
        : (chunk as Uint8Array).byteLength;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.#pending + bytes > pendingBytes
    ) {
      this.failure ??= new AgentError(
        "run_log_failed",
        "The bounded pending console log budget is full.",
      );
      throw this.failure;
    }
    this.#pending += bytes;
    return typeof encoding === "function"
      ? super.write(chunk, encoding)
      : encoding
        ? super.write(chunk, encoding, callback)
        : super.write(chunk, callback);
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: WriteCallback,
  ): void {
    this.#capture(chunk, chunk.length, done);
  }
  override _writev(
    chunks: { chunk: Buffer; encoding: BufferEncoding }[],
    done: WriteCallback,
  ): void {
    const size = chunks.reduce((total, item) => total + item.chunk.length, 0);
    this.#capture(
      Buffer.concat(
        chunks.map((item) => item.chunk),
        size,
      ),
      size,
      done,
    );
  }
  #capture(bytes: Buffer, pending: number, done: WriteCallback): void {
    void this.#append(bytes)
      .catch((error) => {
        this.failure ??= error;
      })
      .finally(() => {
        this.#pending -= pending;
        // Failure is observed by Core after the native stream actually drains.
        done();
      });
  }
  async #append(bytes: Buffer): Promise<void> {
    if (this.failure) return;
    const retained = this.#end - this.#start,
      capacity = maximumBytes - headerBytes;
    requireCondition(
      this.#end <= Number.MAX_SAFE_INTEGER - bytes.length,
      "run_log_failed",
      "The log byte position is exhausted.",
    );
    let drop = Math.max(0, retained + bytes.length - capacity);
    const growth = Math.max(
        0,
        Math.min(capacity, retained + bytes.length) - retained,
      ),
      reservation = growth ? await this.#reserve?.(growth) : undefined;
    try {
      this.#safe();
      const probe = Buffer.alloc(1);
      while (drop < retained + bytes.length) {
        let byte: number;
        if (drop < retained) {
          requireCondition(
            readSync(this.#file!, probe, 0, 1, headerBytes + drop) === 1,
            "run_log_unavailable",
            "The retained log ended during cropping.",
          );
          byte = probe[0]!;
        } else byte = bytes[drop - retained]!;
        if ((byte & 0xc0) !== 0x80) break;
        drop++;
      }
      const keep = Math.max(0, retained - drop),
        incoming = bytes.subarray(Math.max(0, drop - retained));
      if (drop && keep) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, keep));
        for (let offset = 0; offset < keep;) {
          const count = readSync(
            this.#file!,
            buffer,
            0,
            Math.min(buffer.length, keep - offset),
            headerBytes + drop + offset,
          );
          requireCondition(
            count > 0,
            "run_log_unavailable",
            "The retained log ended during compaction.",
          );
          this.#write(buffer.subarray(0, count), headerBytes + offset);
          offset += count;
        }
      }
      if (drop) ftruncateSync(this.#file!, headerBytes + keep);
      this.#write(incoming, headerBytes + keep);
      this.#start += drop;
      this.#end += bytes.length;
      this.#header();
      this.#safe();
    } finally {
      reservation?.release();
    }
  }
  finish(): Promise<void> {
    this.#finish ??= new Promise((resolve) => {
      this.#accepting = false;
      super.end(() => {
        try {
          if (this.#file !== undefined) {
            this.#safe();
            fsyncSync(this.#file);
          }
        } catch (error) {
          this.failure ??= error;
        } finally {
          if (this.#file !== undefined) {
            try {
              closeSync(this.#file);
            } catch (error) {
              this.failure ??= error;
            }
            this.#file = undefined;
          }
          resolve();
        }
      });
    });
    return this.#finish;
  }
}
