import { createHash } from "node:crypto";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MIMEType } from "node:util";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { JsonValue } from "../contracts/types.js";
import type {
  WireConnectionV2,
  WireStreamDirectionV2,
  WireStreamRefV2,
} from "../contracts/wire.js";
import { validateAgentToken, validateServerUrl } from "./config.js";

export interface DataPlaneClaim {
  readonly transferId: string;
  readonly reservationId: string;
}
export interface DataPlaneRead {
  readonly readable: Readable;
  /** Settles after the local HTTP request, response, socket and consumer close. */
  readonly closed: Promise<void>;
}
export interface DataPlaneWrite {
  readonly writable: Writable;
  /** Includes the actual Cloud consumer acknowledgement, beyond Writable.finish. */
  readonly closed: Promise<void>;
}
export interface AgentDataPlaneOptions {
  readonly serverUrl: string;
  readonly token: string;
  readonly binding: WireConnectionV2;
  readonly maxBytes?: number;
  readonly maxJsonBytes?: number;
  assertCurrent(): void;
}

const identity = /^[A-Za-z0-9_-]{1,256}$/;
const headerIdentity = /^[\x21-\x7e]{1,256}$/;
const directions: Readonly<Record<string, readonly WireStreamDirectionV2[]>> = {
  resource: ["agent-to-cloud"],
  attachment: ["cloud-to-agent"],
  transfer: ["agent-to-cloud", "cloud-to-agent"],
  "host-request": ["agent-to-cloud"],
  "host-response": ["cloud-to-agent"],
  "result-meta": ["agent-to-cloud"],
  maintenance: ["agent-to-cloud", "cloud-to-agent"],
};
const refKeys = new Set([
  "streamId",
  "purpose",
  "direction",
  "expiresAt",
  "maxBytes",
  "mimeType",
  "size",
  "sha256",
]);
function plainData(value: unknown, allowed: ReadonlySet<string>): boolean {
  return (
    isPlainRecord(value) &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === "string" &&
        allowed.has(key) &&
        "value" in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
}
function error(code: string): AgentError {
  // Native socket/parser messages, response bodies and credentials never escape.
  return new AgentError(
    code,
    "The authenticated Agent data stream could not complete.",
  );
}
function safeFailure(cause: unknown): AgentError {
  return isAgentError(cause) ? cause : error("stream_closed");
}

/** HTTP adaptation only. Core owns reservations, stream slots and transfer state. */
export class AgentDataPlane {
  #server: URL;
  #token: string;
  #binding: Readonly<WireConnectionV2>;
  #assertCurrent: () => void;
  #maxBytes: number;
  #maxJsonBytes: number;
  constructor(options: AgentDataPlaneOptions) {
    this.#server = validateServerUrl(
      options.serverUrl,
      options.binding.profile,
    );
    this.#token = validateAgentToken(options.token);
    const binding = options.binding;
    requireCondition(
      [
        binding.agentId,
        binding.bootId,
        binding.connectionId,
        binding.cloudEnvironment,
      ].every(
        (value) => typeof value === "string" && headerIdentity.test(value),
      ) &&
        binding.cloudEnvironment === binding.profile &&
        typeof options.assertCurrent === "function",
      "invalid_connection_binding",
      "The authenticated Agent connection binding is invalid.",
    );
    this.#binding = Object.freeze({ ...binding });
    this.#assertCurrent = options.assertCurrent;
    this.#maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.#maxJsonBytes = options.maxJsonBytes ?? 1024 * 1024;
    requireCondition(
      Number.isSafeInteger(this.#maxBytes) &&
        this.#maxBytes > 0 &&
        Number.isSafeInteger(this.#maxJsonBytes) &&
        this.#maxJsonBytes > 0 &&
        this.#maxJsonBytes <= this.#maxBytes,
      "invalid_configuration",
      "The data stream budgets are invalid.",
    );
  }
  #current(signal: AbortSignal, deadline: number): void {
    if (signal.aborted) throw error("stream_cancelled");
    if (Date.now() >= deadline) throw error("stream_timeout");
    try {
      authorizeCall(this.#assertCurrent);
    } catch {
      throw error("invalid_connection_binding");
    }
  }
  #reference(
    ref: WireStreamRefV2,
    direction: WireStreamDirectionV2,
    signal: AbortSignal,
    claim?: DataPlaneClaim,
  ): Readonly<WireStreamRefV2> {
    requireCondition(
      plainData(ref, refKeys) &&
        typeof ref.streamId === "string" &&
        identity.test(ref.streamId) &&
        typeof ref.purpose === "string" &&
        Object.hasOwn(directions, ref.purpose) &&
        directions[ref.purpose]!.includes(ref.direction) &&
        typeof ref.expiresAt === "string" &&
        /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](?:\.[0-9]+)?Z$/.test(
          ref.expiresAt,
        ) &&
        Number.isFinite(Date.parse(ref.expiresAt)) &&
        Number.isSafeInteger(ref.maxBytes) &&
        ref.maxBytes > 0 &&
        ref.maxBytes <= this.#maxBytes &&
        (ref.size === undefined ||
          (Number.isSafeInteger(ref.size) &&
            ref.size >= 0 &&
            ref.size <= ref.maxBytes)) &&
        (ref.sha256 === undefined ||
          (typeof ref.sha256 === "string" &&
            /^[0-9a-f]{64}$/.test(ref.sha256))) &&
        (ref.mimeType === undefined ||
          (typeof ref.mimeType === "string" &&
            ref.mimeType.length <= 256 &&
            !/[\x00-\x1f\x7f]/.test(ref.mimeType))),
      "invalid_stream_reference",
      "The authenticated stream reference is invalid.",
    );
    requireCondition(
      ref.direction === direction,
      "stream_direction_mismatch",
      "The stream direction does not match this endpoint.",
    );
    if (ref.mimeType !== undefined) {
      try {
        new MIMEType(ref.mimeType);
      } catch {
        throw error("invalid_stream_reference");
      }
    }
    requireCondition(
      ref.purpose === "transfer"
        ? plainData(claim, new Set(["transferId", "reservationId"])) &&
            claim !== undefined &&
            Object.keys(claim).length === 2 &&
            typeof claim.transferId === "string" &&
            typeof claim.reservationId === "string" &&
            identity.test(claim.transferId) &&
            identity.test(claim.reservationId)
        : claim === undefined,
      "invalid_stream_reference",
      "The actual transfer reservation must match the stream purpose.",
    );
    const deadline = Date.parse(ref.expiresAt);
    requireCondition(
      deadline - Date.now() <= 2_147_483_647,
      "invalid_stream_reference",
      "The stream deadline is invalid.",
    );
    this.#current(signal, deadline);
    return Object.freeze({ ...ref });
  }
  async openRead(
    ref: WireStreamRefV2,
    signal: AbortSignal,
    claim?: DataPlaneClaim,
  ): Promise<DataPlaneRead> {
    const stream = this.#reference(ref, "cloud-to-agent", signal, claim);
    const exchange = this.#open(stream, signal, claim);
    try {
      await exchange.opened;
    } catch (cause) {
      await exchange.closed.catch(() => {});
      throw cause;
    }
    return { readable: exchange.body, closed: exchange.closed };
  }
  openWrite(
    ref: WireStreamRefV2,
    signal: AbortSignal,
    claim?: DataPlaneClaim,
  ): DataPlaneWrite {
    const stream = this.#reference(ref, "agent-to-cloud", signal, claim);
    const exchange = this.#open(stream, signal, claim);
    return { writable: exchange.body, closed: exchange.closed };
  }
  #open(
    ref: Readonly<WireStreamRefV2>,
    signal: AbortSignal,
    claim?: DataPlaneClaim,
  ) {
    const reading = ref.direction === "cloud-to-agent";
    const deadline = Date.parse(ref.expiresAt);
    const url = new URL(this.#server);
    url.pathname =
      url.pathname.replace(/\/+$/, "") + "/agent/file-stream/" + ref.streamId;
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${this.#token}`,
      Connection: "close",
      "X-Nexum-Connection-Id": this.#binding.connectionId,
      "X-Nexum-Agent-Profile": this.#binding.profile,
      "X-Nexum-Agent-Boot-Id": this.#binding.bootId,
      "X-Nexum-Stream-Purpose": ref.purpose,
      "X-Nexum-Stream-Direction": ref.direction,
      ...(claim
        ? {
            "X-Nexum-Transfer-Id": claim.transferId,
            "X-Nexum-Reservation-Id": claim.reservationId,
          }
        : {}),
      ...(!reading && ref.mimeType ? { "Content-Type": ref.mimeType } : {}),
      // A transfer consumer may acknowledge fixed bytes before Core has verified
      // source closure. Chunked framing carries the producer's real final EOF.
      ...(!reading && ref.purpose !== "transfer" && ref.size !== undefined
        ? { "Content-Length": ref.size }
        : {}),
    };
    const completion = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<void>();
    // Callers may await HTTP admission/body production before observing closure.
    void completion.promise.catch(() => {});
    void opening.promise.catch(() => {});
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let failure: AgentError | undefined;
    let requestClosed = false,
      responseClosed = false,
      socketClosed = false,
      bodyClosed = false;
    let socketAssigned = false,
      pipeStarted = false,
      pipeDone = false,
      acknowledged = false;
    let settled = false,
      count = 0;
    const hash = createHash("sha256");
    const current = () => this.#current(signal, deadline);
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (
        settled ||
        !requestClosed ||
        !responseClosed ||
        !socketClosed ||
        !bodyClosed ||
        !pipeDone
      )
        return;
      if (!failure) {
        try {
          current();
        } catch (cause) {
          failure = safeFailure(cause);
        }
      }
      if (!failure && !acknowledged) failure = error("stream_closed");
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) completion.reject(failure);
      else completion.resolve();
    };
    const fail = (cause: unknown) => {
      failure ??= safeFailure(cause);
      opening.reject(failure);
      body.destroy(failure);
      response?.destroy(failure);
      request?.destroy(failure);
      if (!pipeStarted) pipeDone = true;
      finish();
    };
    const body = new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk: Buffer, _encoding, callback) {
        try {
          current();
          requireCondition(
            Buffer.isBuffer(chunk),
            "invalid_stream_body",
            "Only raw byte stream data is accepted.",
          );
          requireCondition(
            chunk.length <= ref.maxBytes - count,
            "resource_exhausted",
            "The actual stream exceeds its byte budget.",
          );
          count += chunk.length;
          requireCondition(
            ref.size === undefined || count <= ref.size,
            "stream_size_mismatch",
            "The actual stream size does not match its fixed reference.",
          );
          hash.update(chunk);
          callback(null, chunk);
        } catch (cause) {
          callback(safeFailure(cause));
        }
      },
      flush(callback) {
        try {
          current();
          requireCondition(
            ref.size === undefined || count === ref.size,
            "stream_size_mismatch",
            "The actual stream size does not match its fixed reference.",
          );
          const actual = hash.digest("hex");
          requireCondition(
            ref.sha256 === undefined || actual === ref.sha256,
            "checksum_mismatch",
            "The actual stream checksum does not match its fixed reference.",
          );
          callback();
        } catch (cause) {
          callback(safeFailure(cause));
        }
      },
    });
    body.on("error", fail);
    body.once("close", () => {
      bodyClosed = true;
      if (!failure && (!body.readableEnded || !body.writableFinished))
        fail(error("stream_closed"));
      finish();
    });
    const abort = () => fail(error("stream_cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => fail(error("stream_timeout")),
      Math.max(1, deadline - Date.now()),
    );
    try {
      request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: reading ? "GET" : "PUT",
        headers,
        agent: false,
        maxHeaderSize: 16 * 1024,
      });
      request.once("socket", (socket) => {
        socketAssigned = true;
        socket.once("close", () => {
          socketClosed = true;
          finish();
        });
      });
      request.on("error", () => fail(error("stream_closed")));
      request.once("upgrade", (incoming, socket) => {
        response = incoming;
        incoming.on("error", () => {});
        incoming.once("close", () => {
          responseClosed = true;
          finish();
        });
        fail(error("stream_http_error"));
        socket.destroy();
      });
      request.once("close", () => {
        requestClosed = true;
        if (!socketAssigned) socketClosed = true;
        if (!response) responseClosed = true;
        if (!failure && (!response || !response.complete))
          fail(error("stream_closed"));
        finish();
      });
      request.once("response", (incoming) => {
        response = incoming;
        incoming.on("error", () => fail(error("stream_closed")));
        incoming.once("aborted", () => fail(error("stream_closed")));
        incoming.once("close", () => {
          responseClosed = true;
          if (!incoming.complete) fail(error("stream_closed"));
          finish();
        });
        try {
          current();
          requireCondition(
            (incoming.statusCode ?? 0) >= 200 && incoming.statusCode! < 300,
            "stream_http_error",
            "The data stream endpoint did not accept the request.",
          );
          if (reading) {
            const length = incoming.headers["content-length"];
            if (length !== undefined) {
              requireCondition(
                typeof length === "string" &&
                  /^(0|[1-9][0-9]*)$/.test(length) &&
                  Number.isSafeInteger(Number(length)),
                "invalid_stream_reference",
                "The data stream length is invalid.",
              );
              requireCondition(
                Number(length) <= ref.maxBytes,
                "resource_exhausted",
                "The data stream exceeds its byte budget.",
              );
              requireCondition(
                ref.size === undefined || Number(length) === ref.size,
                "stream_size_mismatch",
                "The data stream length does not match its fixed reference.",
              );
            }
            pipeStarted = true;
            void pipeline(incoming, body).then(
              () => {
                pipeDone = true;
                acknowledged = true;
                finish();
              },
              (cause) => {
                pipeDone = true;
                fail(cause);
              },
            );
            opening.resolve();
          } else {
            // Cloud sends success only after the actual consumer's EOF. Drain a
            // bounded response without parsing or exposing an arbitrary body.
            let responseBytes = 0;
            incoming.on("data", (chunk: Buffer) => {
              responseBytes += chunk.length;
              if (responseBytes > 64 * 1024) fail(error("resource_exhausted"));
            });
            incoming.once("end", () => {
              try {
                current();
                acknowledged = true;
                finish();
              } catch (cause) {
                fail(cause);
              }
            });
            incoming.resume();
          }
        } catch (cause) {
          fail(cause);
        }
      });
      if (reading) request.end();
      else {
        pipeStarted = true;
        void pipeline(body, request).then(
          () => {
            pipeDone = true;
            finish();
          },
          (cause) => {
            pipeDone = true;
            fail(cause);
          },
        );
        // A real Go relay must see the handshake before it starts the consumer.
        request.flushHeaders();
        opening.resolve();
      }
      if (signal.aborted) abort();
    } catch (cause) {
      if (!request) {
        requestClosed = responseClosed = socketClosed = true;
      }
      fail(cause);
    }
    return { body, opened: opening.promise, closed: completion.promise };
  }
  async sendFixedBody(
    ref: WireStreamRefV2,
    source: Readable | Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    requireCondition(
      ref.size !== undefined && ref.sha256 !== undefined,
      "invalid_stream_reference",
      "A fixed size and checksum are required.",
    );
    let readable: Readable;
    if (source instanceof Uint8Array) {
      const bytes = Buffer.from(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      );
      requireCondition(
        bytes.length === ref.size,
        "stream_size_mismatch",
        "The fixed body size does not match its reference.",
      );
      requireCondition(
        createHash("sha256").update(bytes).digest("hex") === ref.sha256,
        "checksum_mismatch",
        "The fixed body checksum does not match its reference.",
      );
      readable = Readable.from([bytes]);
    } else {
      requireCondition(
        source instanceof Readable,
        "invalid_stream_body",
        "A native byte stream or Uint8Array is required.",
      );
      readable = source;
    }
    const { writable, closed } = this.openWrite(ref, signal);
    try {
      await pipeline(readable, writable);
      await closed;
    } catch (cause) {
      writable.destroy(safeFailure(cause));
      await closed.catch(() => {});
      throw safeFailure(cause);
    }
  }
  async readJson(
    ref: WireStreamRefV2,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    requireCondition(
      ref.size !== undefined && ref.sha256 !== undefined,
      "invalid_stream_reference",
      "A fixed JSON size and checksum are required.",
    );
    requireCondition(
      ref.size <= this.#maxJsonBytes,
      "resource_exhausted",
      "The JSON body exceeds its byte budget.",
    );
    const { readable, closed } = await this.openRead(ref, signal);
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of readable) chunks.push(chunk as Buffer);
      await closed;
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, ref.size),
        ),
      );
      canonicalJson(value, this.#maxJsonBytes);
      return value as JsonValue;
    } catch (cause) {
      readable.destroy(safeFailure(cause));
      await closed.catch(() => {});
      if (isAgentError(cause)) throw cause;
      throw error("invalid_stream_json");
    }
  }
  async writeJson(
    ref: WireStreamRefV2,
    value: JsonValue,
    signal: AbortSignal,
  ): Promise<void> {
    const bytes = Buffer.from(canonicalJson(value, this.#maxJsonBytes));
    await this.sendFixedBody(ref, bytes, signal);
  }
}
