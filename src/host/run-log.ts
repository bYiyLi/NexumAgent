import { StringDecoder } from "node:string_decoder";
import { Writable } from "node:stream";
import { AgentError } from "../contracts/errors.js";

const pendingBytes = 64 * 1024 * 1024;
const frameBytes = 1024 * 1024;
type WriteCallback = (error?: Error | null) => void;

/** Bounded Run console delivery; Go owns retention and persistent byte budgets. */
export class HostRunLog extends Writable {
  failure?: AgentError;
  #pending = 0;
  readonly #send: (text: string) => Promise<unknown>;

  constructor(send: (text: string) => Promise<unknown>) {
    super({ highWaterMark: 64 * 1024 });
    this.#send = send;
  }

  override write(chunk: unknown, callback?: WriteCallback): boolean;
  override write(chunk: unknown, encoding: BufferEncoding, callback?: WriteCallback): boolean;
  override write(
    chunk: unknown,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean {
    const completed = typeof encoding === "function" ? encoding : callback;
    if (this.writableEnded || this.failure) {
      if (completed) queueMicrotask(() => completed());
      return true;
    }
    const size = typeof chunk === "string"
      ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : "utf8")
      : chunk instanceof Uint8Array ? chunk.byteLength : -1;
    if (!Number.isSafeInteger(size) || size < 0 || this.#pending + size > pendingBytes) {
      this.failure = new AgentError("run_log_failed", "The bounded pending console log budget is full.");
      if (completed) queueMicrotask(() => completed());
      return true;
    }
    this.#pending += size;
    return typeof encoding === "function"
      ? super.write(chunk, encoding)
      : encoding ? super.write(chunk, encoding, callback) : super.write(chunk, callback);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: WriteCallback): void {
    void this.#append(chunk).catch(() => {
      this.failure ??= new AgentError("run_log_failed", "The Run log could not be delivered.");
    }).finally(() => {
      this.#pending -= chunk.byteLength;
      done();
    });
  }

  async #append(chunk: Buffer): Promise<void> {
    if (this.failure) return;
    const decoder = new StringDecoder("utf8");
    for (let offset = 0; offset < chunk.length; offset += frameBytes) {
      const text = decoder.write(chunk.subarray(offset, offset + frameBytes));
      if (text) await this.#send(text);
    }
    const tail = decoder.end();
    if (tail) await this.#send(tail);
  }

}
