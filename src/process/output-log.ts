import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { types } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { privateDirectory } from "../runtime/paths.js";

export type ProcessOutputStream = "stdout" | "stderr" | "terminal";
export interface ProcessOutputOptions {
  /** Total file bytes, including the fixed header and framing. */
  readonly maxBytes?: number;
  readonly maxPendingBytes?: number;
}
export interface ProcessOutputReadOptions {
  readonly cursor?: string;
  readonly maxBytes?: number;
  readonly encoding?: BufferEncoding | null;
  readonly signal?: AbortSignal;
}
export interface ProcessOutputPage {
  readonly output: { stream: ProcessOutputStream; data: string | Buffer }[];
  readonly nextCursor: string;
  readonly hasMoreOutput: boolean;
  readonly truncated: boolean;
  readonly outputComplete: boolean;
}

const headerBytes = 256;
const completionBytes = 64;
const frameBytes = 8;
const maximumFileBytes = 256 * 1024 * 1024;
const streams = ["stdout", "stderr", "terminal"] as const;
const magic = Buffer.from("NXOUT001");
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const viewBuffer = Object.getOwnPropertyDescriptor(
  typedPrototype,
  "buffer",
)!.get!;
const viewOffset = Object.getOwnPropertyDescriptor(
  typedPrototype,
  "byteOffset",
)!.get!;
const viewLength = Object.getOwnPropertyDescriptor(
  typedPrototype,
  "byteLength",
)!.get!;
// These are Node's native decoder continuation accessors. The bounded bytes
// reconstruct an independent decoder for every read; no decoder object crosses
// the public boundary or survives by relying on a reader's in-memory session.
const decoderNeed = Object.getOwnPropertyDescriptor(
  StringDecoder.prototype,
  "lastNeed",
)!.get!;
const decoderTotal = Object.getOwnPropertyDescriptor(
  StringDecoder.prototype,
  "lastTotal",
)!.get!;
const decoderChar = Object.getOwnPropertyDescriptor(
  StringDecoder.prototype,
  "lastChar",
)!.get!;
type Encoding =
  "utf8" | "utf16le" | "latin1" | "ascii" | "base64" | "base64url" | "hex";
interface Position {
  frame: number;
  offset: number;
  encoding: Encoding | null;
  carry: string[];
}

function encoding(value: unknown): Encoding | null {
  if (value === null) return null;
  requireCondition(
    typeof value === "string",
    "unsupported_output_encoding",
    "Output encoding must be a supported Node encoding or null.",
  );
  const aliases: Readonly<Record<string, Encoding>> = {
    utf8: "utf8",
    "utf-8": "utf8",
    utf16le: "utf16le",
    "utf-16le": "utf16le",
    ucs2: "utf16le",
    "ucs-2": "utf16le",
    latin1: "latin1",
    binary: "latin1",
    ascii: "ascii",
    base64: "base64",
    base64url: "base64url",
    hex: "hex",
  };
  const key = value.toLowerCase();
  const result = Object.hasOwn(aliases, key) ? aliases[key] : undefined;
  requireCondition(
    result,
    "unsupported_output_encoding",
    "This encoding cannot be incrementally decoded by the current Node runtime.",
  );
  return result;
}
function integer(value: unknown, min: number, max: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}
function unavailable(cause: unknown): AgentError {
  return new AgentError(
    "output_unavailable",
    "The retained process output is missing, invalid or unavailable.",
    undefined,
    { cause },
  );
}
function check(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** A cold, one-writer, bounded disk ring. History is an independent read-only view. */
export class ProcessOutputLog extends EventEmitter {
  readonly root: string;
  readonly processId: string;
  readonly path: string;
  readonly maxPendingBytes: number;
  #maxBytes: number;
  #handle: FileHandle | null = null;
  #readOnly = false;
  #opened = false;
  #closed = false;
  #finishing = false;
  #complete = false;
  #truncated = false;
  #start = 0;
  #end = 0;
  #identity = Buffer.alloc(0);
  #key = Buffer.alloc(0);
  #tail: Promise<void> = Promise.resolve();
  #pendingBytes = 0;
  #pending = 0;
  #openPromise?: Promise<void>;
  #finishPromise?: Promise<void>;
  #closePromise?: Promise<void>;

  constructor(
    agentRoot: string,
    processId: string,
    options: ProcessOutputOptions = {},
  ) {
    super();
    requireCondition(
      typeof agentRoot === "string" &&
        path.isAbsolute(agentRoot) &&
        typeof processId === "string" &&
        /^res_[0-9a-f]{32}$/.test(processId),
      "invalid_output_options",
      "Process output needs an absolute profile root and a managed process identity.",
    );
    this.#maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.maxPendingBytes = options.maxPendingBytes ?? 4 * 1024 * 1024;
    requireCondition(
      integer(this.#maxBytes, 512, maximumFileBytes) &&
        integer(this.maxPendingBytes, 1, 16 * 1024 * 1024),
      "invalid_output_options",
      "Process output retention and pending bytes must fit their bounded policies.",
    );
    this.root = path.resolve(agentRoot);
    this.processId = processId;
    this.path = path.join(
      this.root,
      "logs",
      "processes",
      `${processId}.output`,
    );
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }
  get outputComplete(): boolean {
    return this.#complete;
  }

  #enqueue<T>(
    weight: number,
    action: () => Promise<T>,
    control = false,
  ): Promise<T> {
    if (
      this.#pending >= (control ? 34 : 32) ||
      this.#pendingBytes + weight > this.maxPendingBytes
    )
      return Promise.reject(
        new AgentError(
          "output_busy",
          "Process output has reached its pending I/O budget; await the accepted append before retrying.",
        ),
      );
    this.#pending++;
    this.#pendingBytes += weight;
    const result = this.#tail.then(action);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    void result.then(
      () => {
        this.#pending--;
        this.#pendingBytes -= weight;
      },
      () => {
        this.#pending--;
        this.#pendingBytes -= weight;
      },
    );
    return result;
  }

  #assertOpen(): void {
    requireCondition(
      this.#opened && !this.#closed,
      "output_closed",
      "The output log is not open.",
    );
  }

  async #safePath(): Promise<void> {
    requireCondition(
      (await realpath(this.root)) === this.root,
      "output_unavailable",
      "The Agent profile root was redirected.",
    );
    for (const filename of [
      path.join(this.root, "logs"),
      path.join(this.root, "logs", "processes"),
    ])
      requireCondition(
        (await lstat(filename)).isDirectory() &&
          (await realpath(filename)) === filename,
        "output_unavailable",
        "A process output directory was redirected or is unavailable.",
      );
    const actual = await lstat(this.path);
    requireCondition(
      actual.isFile(),
      "output_unavailable",
      "Process output must remain a regular file.",
    );
    if (this.#handle) {
      const retained = await this.#handle.stat();
      requireCondition(
        actual.dev === retained.dev && actual.ino === retained.ino,
        "output_unavailable",
        "The retained output file was replaced.",
      );
    }
  }

  async open(
    options: {
      readonly readOnly?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    requireCondition(
      !this.#closed && !this.#closePromise,
      "output_closed",
      "A closed output view cannot be reopened.",
    );
    if (this.#openPromise) return this.#openPromise;
    this.#readOnly = options.readOnly ?? false;
    this.#openPromise = this.#enqueue(0, async () => {
      check(options.signal);
      try {
        if (this.#readOnly) await this.#safePath();
        else privateDirectory(this.root, "logs", "processes");
        this.#handle = await open(
          this.path,
          this.#readOnly
            ? constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
            : constants.O_RDWR |
                constants.O_CREAT |
                constants.O_EXCL |
                (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        if (this.#readOnly) await this.#loadHeader(this.#handle);
        else {
          this.#identity = randomBytes(16);
          this.#key = randomBytes(32);
          await this.#saveHeader();
        }
        check(options.signal);
        this.#opened = true;
      } catch (cause) {
        await this.#handle?.close();
        this.#handle = null;
        if (options.signal?.aborted) throw cause;
        throw unavailable(cause);
      }
    });
    return this.#openPromise;
  }

  async #writeAll(
    file: FileHandle,
    bytes: Buffer,
    position: number,
  ): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.write(
        bytes,
        offset,
        bytes.length - offset,
        position + offset,
      );
      requireCondition(
        result.bytesWritten > 0,
        "output_unavailable",
        "The output write made no progress.",
      );
      offset += result.bytesWritten;
    }
  }
  async #readAll(
    file: FileHandle,
    size: number,
    position: number,
  ): Promise<Buffer> {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await file.read(
        bytes,
        offset,
        size - offset,
        position + offset,
      );
      requireCondition(
        result.bytesRead > 0,
        "output_unavailable",
        "Retained output ended before its saved boundary.",
      );
      offset += result.bytesRead;
    }
    return bytes;
  }
  async #saveHeader(): Promise<void> {
    const bytes = Buffer.alloc(headerBytes);
    magic.copy(bytes);
    this.#identity.copy(bytes, 8);
    this.#key.copy(bytes, 24);
    createHash("sha256").update(this.processId).digest().copy(bytes, 56);
    bytes.writeUInt32LE(this.#maxBytes, 88);
    bytes.writeBigUInt64LE(BigInt(this.#start), 92);
    bytes.writeBigUInt64LE(BigInt(this.#end), 100);
    // Completion is published only after the data writer has actually closed.
    bytes[108] = 0;
    bytes[109] = Number(this.#truncated);
    await this.#writeAll(this.#handle!, bytes, 0);
  }
  async #loadHeader(file: FileHandle): Promise<void> {
    const bytes = await this.#readAll(file, headerBytes, 0);
    const start = Number(bytes.readBigUInt64LE(92)),
      end = Number(bytes.readBigUInt64LE(100));
    const maximum = bytes.readUInt32LE(88);
    requireCondition(
      bytes.subarray(0, 8).equals(magic) &&
        bytes
          .subarray(56, 88)
          .equals(createHash("sha256").update(this.processId).digest()) &&
        integer(maximum, 512, maximumFileBytes) &&
        integer(start, 0, Number.MAX_SAFE_INTEGER) &&
        integer(end, start, Number.MAX_SAFE_INTEGER) &&
        end - start <= maximum - headerBytes - completionBytes &&
        bytes[108] === 0 &&
        bytes[109]! <= 1 &&
        (await file.stat()).size <= maximum - completionBytes,
      "output_unavailable",
      "The output log header does not match its process or retention policy.",
    );
    const identity = bytes.subarray(8, 24);
    requireCondition(
      !this.#identity.length || this.#identity.equals(identity),
      "output_unavailable",
      "The output log identity was replaced.",
    );
    this.#identity = Buffer.from(identity);
    this.#key = Buffer.from(bytes.subarray(24, 56));
    this.#maxBytes = maximum;
    this.#start = start;
    this.#end = end;
    this.#complete = await this.#completion();
    this.#truncated = bytes[109] === 1;
  }
  async #completion(): Promise<boolean> {
    const filename = `${this.path}.complete`;
    let file: FileHandle | undefined;
    try {
      const stats = await lstat(filename);
      requireCondition(
        stats.isFile() && stats.size === 48,
        "output_unavailable",
        "The output completion marker is invalid.",
      );
      file = await open(
        filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const marker = await this.#readAll(file, 48, 0);
      requireCondition(
        marker.subarray(0, 16).equals(this.#identity) &&
          timingSafeEqual(
            marker.subarray(16),
            createHmac("sha256", this.#key).update(this.#identity).digest(),
          ),
        "output_unavailable",
        "The completion marker belongs to another output log.",
      );
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    } finally {
      await file?.close();
    }
  }
  async #ringRead(
    file: FileHandle,
    position: number,
    size: number,
  ): Promise<Buffer> {
    const capacity = this.#maxBytes - headerBytes - completionBytes,
      offset = position % capacity;
    const first = Math.min(size, capacity - offset);
    const left = await this.#readAll(file, first, headerBytes + offset);
    return first === size
      ? left
      : Buffer.concat(
          [left, await this.#readAll(file, size - first, headerBytes)],
          size,
        );
  }
  async #ringWrite(position: number, bytes: Buffer): Promise<void> {
    const capacity = this.#maxBytes - headerBytes - completionBytes,
      offset = position % capacity;
    const first = Math.min(bytes.length, capacity - offset);
    await this.#writeAll(
      this.#handle!,
      bytes.subarray(0, first),
      headerBytes + offset,
    );
    if (first < bytes.length)
      await this.#writeAll(this.#handle!, bytes.subarray(first), headerBytes);
  }
  async #frame(
    file: FileHandle,
    position: number,
  ): Promise<{ size: number; stream: number }> {
    const bytes = await this.#ringRead(file, position, frameBytes),
      size = bytes.readUInt32LE();
    requireCondition(
      size > 0 &&
        size <=
          Math.min(
            65536,
            this.#maxBytes - headerBytes - completionBytes - frameBytes,
          ) &&
        bytes[4]! < streams.length &&
        position + frameBytes + size <= this.#end,
      "output_unavailable",
      "A retained output frame is invalid.",
    );
    return { size, stream: bytes[4]! };
  }

  append(
    stream: ProcessOutputStream,
    bytes: Uint8Array,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    this.#assertOpen();
    requireCondition(
      !this.#readOnly,
      "output_read_only",
      "A historical output view cannot capture new bytes.",
    );
    requireCondition(
      !this.#finishing && !this.#complete,
      "output_complete",
      "The process output is already finishing or complete.",
    );
    const streamIndex = streams.indexOf(stream);
    requireCondition(
      streamIndex >= 0 && !types.isProxy(bytes) && types.isUint8Array(bytes),
      "invalid_output_data",
      "Output capture needs a known stream and native bytes.",
    );
    check(options.signal);
    const size = viewLength.call(bytes) as number;
    if (this.#pending >= 32 || this.#pendingBytes + size > this.maxPendingBytes)
      return Promise.reject(
        new AgentError(
          "output_busy",
          "The pending capture budget is full; no bytes were accepted.",
        ),
      );
    let captured: Buffer;
    try {
      captured = Buffer.from(
        new Uint8Array(viewBuffer.call(bytes), viewOffset.call(bytes), size),
      );
    } catch (cause) {
      throw new AgentError(
        "invalid_output_data",
        "The native output byte view is invalid or detached.",
        undefined,
        { cause },
      );
    }
    return this.#enqueue(size, async () => {
      this.#assertOpen();
      check(options.signal);
      await this.#safePath();
      const capacity = this.#maxBytes - headerBytes - completionBytes;
      let offset = Math.max(0, captured.length - (capacity - frameBytes));
      if (offset) this.#truncated = true;
      try {
        while (offset < captured.length) {
          const count = Math.min(
            65536,
            capacity - frameBytes,
            captured.length - offset,
          );
          requireCondition(
            this.#end <= Number.MAX_SAFE_INTEGER - frameBytes - count,
            "output_position_exhausted",
            "The process output position is exhausted.",
          );
          while (this.#end - this.#start + frameBytes + count > capacity) {
            const old = await this.#frame(this.#handle!, this.#start);
            this.#start += frameBytes + old.size;
            this.#truncated = true;
          }
          const header = Buffer.alloc(frameBytes);
          header.writeUInt32LE(count);
          header[4] = streamIndex;
          await this.#ringWrite(this.#end, header);
          await this.#ringWrite(
            this.#end + frameBytes,
            captured.subarray(offset, offset + count),
          );
          this.#end += frameBytes + count;
          offset += count;
          // Cancellation waits for the actual frame write and its new boundary.
          await this.#saveHeader();
          check(options.signal);
        }
      } finally {
        if (offset) this.emit("change");
      }
    }).catch((cause: unknown) => {
      if (cause instanceof AgentError || options.signal?.aborted) throw cause;
      throw unavailable(cause);
    });
  }

  #cursor(position: Position): string {
    const value = Buffer.from(
      JSON.stringify({
        ...position,
        id: this.#identity.toString("hex"),
        processId: this.processId,
      }),
    ).toString("base64url");
    return `${value}.${createHmac("sha256", this.#key).update(value).digest("base64url")}`;
  }
  #position(cursor: string | undefined, selected: Encoding | null): Position {
    if (cursor === undefined)
      return {
        frame: this.#start,
        offset: 0,
        encoding: selected,
        carry: ["", "", ""],
      };
    try {
      requireCondition(
        typeof cursor === "string" &&
          cursor.length <= 4096 &&
          /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor),
        "invalid_output_cursor",
        "The output cursor is invalid.",
      );
      const [value, signed] = cursor.split(".") as [string, string];
      const signature = Buffer.from(signed, "base64url"),
        expected = createHmac("sha256", this.#key).update(value).digest();
      requireCondition(
        signature.length === expected.length &&
          signature.toString("base64url") === signed &&
          timingSafeEqual(signature, expected),
        "invalid_output_cursor",
        "The output cursor does not belong to this log.",
      );
      const data = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
      ) as Position & { id: string; processId: string };
      requireCondition(
        data.id === this.#identity.toString("hex") &&
          data.processId === this.processId &&
          data.encoding === selected &&
          integer(data.frame, 0, this.#end) &&
          integer(data.offset, 0, 65536) &&
          Array.isArray(data.carry) &&
          data.carry.length === 3 &&
          data.carry.every(
            (item) =>
              typeof item === "string" &&
              item.length <= 8 &&
              /^[A-Za-z0-9+/]*={0,2}$/.test(item),
          ),
        "invalid_output_cursor",
        "The output cursor does not match this process, position or encoding.",
      );
      return data.frame < this.#start
        ? {
            frame: this.#start,
            offset: 0,
            encoding: selected,
            carry: ["", "", ""],
          }
        : data;
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw new AgentError(
        "invalid_output_cursor",
        "The output cursor is invalid.",
        undefined,
        { cause },
      );
    }
  }

  read(options: ProcessOutputReadOptions = {}): Promise<ProcessOutputPage> {
    this.#assertOpen();
    const maximum = options.maxBytes ?? 65536,
      selected = encoding(
        options.encoding === undefined ? "utf8" : options.encoding,
      );
    requireCondition(
      integer(maximum, 1, 1024 * 1024),
      "invalid_output_options",
      "Output reads need a byte budget from 1 through 1048576.",
    );
    return this.#enqueue(0, async () => {
      this.#assertOpen();
      check(options.signal);
      let file = this.#handle,
        owned = false;
      try {
        await this.#safePath();
        if (!file) {
          file = await open(
            this.path,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          );
          owned = true;
        }
        await this.#loadHeader(file);
        const position = this.#position(options.cursor, selected);
        const output: ProcessOutputPage["output"] = [];
        const decoders =
          selected === null
            ? null
            : streams.map((_, index) => {
                const decoder = new StringDecoder(selected);
                if (position.carry[index])
                  decoder.write(Buffer.from(position.carry[index]!, "base64"));
                return decoder;
              });
        const emit = (stream: ProcessOutputStream, data: string | Buffer) => {
          if (data.length) output.push({ stream, data });
        };
        let remaining = maximum,
          framesRead = 0;
        while (
          position.frame < this.#end &&
          remaining > 0 &&
          framesRead++ < 4096
        ) {
          check(options.signal);
          const frame = await this.#frame(file, position.frame);
          requireCondition(
            position.offset < frame.size,
            "invalid_output_cursor",
            "The output cursor is outside its retained frame.",
          );
          const count = Math.min(frame.size - position.offset, remaining);
          const bytes = await this.#ringRead(
            file,
            position.frame + frameBytes + position.offset,
            count,
          );
          emit(
            streams[frame.stream]!,
            decoders ? decoders[frame.stream]!.write(bytes) : bytes,
          );
          position.offset += count;
          remaining -= count;
          if (position.offset === frame.size) {
            position.frame += frameBytes + frame.size;
            position.offset = 0;
          }
        }
        requireCondition(
          position.frame < this.#end || position.offset === 0,
          "invalid_output_cursor",
          "The end cursor must not have a frame offset.",
        );
        if (decoders)
          for (let index = 0; index < streams.length; index++) {
            const decoder = decoders[index]!;
            if (this.#complete && position.frame === this.#end)
              emit(streams[index]!, decoder.end());
            const need = decoderNeed.call(decoder) as number,
              total = decoderTotal.call(decoder) as number;
            position.carry[index] = need
              ? (decoderChar.call(decoder) as Buffer)
                  .subarray(0, total - need)
                  .toString("base64")
              : "";
          }
        check(options.signal);
        return {
          output,
          nextCursor: this.#cursor(position),
          hasMoreOutput: position.frame < this.#end,
          truncated: this.#truncated,
          outputComplete: this.#complete,
        };
      } catch (cause) {
        if (cause instanceof AgentError || options.signal?.aborted) throw cause;
        throw unavailable(cause);
      } finally {
        if (owned) await file?.close();
      }
    });
  }

  finish(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    this.#assertOpen();
    requireCondition(
      !this.#readOnly,
      "output_read_only",
      "Closing a historical view does not finish the writer's output.",
    );
    if (this.#finishPromise) return this.#finishPromise;
    this.#finishing = true;
    const result = this.#enqueue(
      0,
      async () => {
        try {
          check(options.signal);
        } catch (cause) {
          this.#finishing = false;
          this.#finishPromise = undefined;
          throw cause;
        }
        try {
          await this.#safePath();
          await this.#saveHeader();
          await this.#handle!.sync();
          await this.#handle!.close();
          this.#handle = null;
          const temporary = `${this.path}.complete.pending`;
          const marker = Buffer.concat([
            this.#identity,
            createHmac("sha256", this.#key).update(this.#identity).digest(),
          ]);
          let file: FileHandle | undefined;
          try {
            file = await open(
              temporary,
              constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                (constants.O_NOFOLLOW ?? 0),
              0o600,
            );
            await this.#writeAll(file, marker, 0);
            await file.sync();
            await file.close();
            file = undefined;
            await rename(temporary, `${this.path}.complete`);
          } finally {
            await file?.close();
            await rm(temporary, { force: true });
          }
          this.#complete = true;
        } catch (cause) {
          this.#complete = false;
          throw unavailable(cause);
        }
        this.emit("change");
        check(options.signal);
      },
      true,
    );
    this.#finishPromise = result;
    return result;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return this.#tail;
    this.#closePromise = this.#enqueue(
      0,
      async () => {
        await this.#handle?.close();
        this.#handle = null;
        this.#closed = true;
      },
      true,
    );
    return this.#closePromise;
  }
}
