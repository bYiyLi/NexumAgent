import { hostname } from "node:os";
import type { IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { canonicalJson, isPlainRecord, newId } from "../contracts/json.js";
import { validateServerUrl, validateAgentToken } from "./config.js";
import { safeErrorData } from "../contracts/error-data.js";
import { validateContract } from "../contracts/validation.js";
import type {
  WireConnectionV2,
  WireEnvelopeV2,
  WireEventV2,
  WireInvokeV2,
  WireInvocationContextV2,
  WireOperationV2,
  WireInputsV2,
  WireOutputsV2,
} from "../contracts/wire.js";
import type { Profile } from "../contracts/types.js";

const maximum = 1024 * 1024;
const reverseOperations: ReadonlySet<WireOperationV2> = new Set([
  "transfer.prepare",
  "transfer.revoke",
  "authorization.refresh",
  "host.request",
  "attachment.open",
  "stream.prepare",
  "stream.revoke",
  "maintenance.request.create",
  "maintenance.request.get",
  "maintenance.request.list",
  "maintenance.request.cancel",
  "maintenance.request.decision",
  "maintenance.request.beginExecution",
  "state.user.get",
  "state.user.set",
  "state.user.delete",
]);
const cloudEvents = new Set([
  "agent.catalog.sync",
  "agent.authorization.changed",
]);
const permanent = new Map([
  ["invalid_agent_credential", 401],
  ["agent_already_connected", 409],
  ["unsupported_protocol", 400],
  ["invalid_agent_metadata", 400],
  ["unsupported_agent_environment", 400],
]);
export interface ControlConnectionOptions {
  readonly serverUrl: string;
  readonly token: string;
  readonly profile: Profile;
  readonly bootId: string;
  readonly version: string;
  readonly signal: AbortSignal;
  /** Application initialization completes before an incoming invocation is admitted. */
  ready(connection: ControlConnection): Promise<void>;
  invoke(message: WireInvokeV2, signal: AbortSignal): Promise<unknown>;
  event(message: WireEventV2, signal: AbortSignal): Promise<void>;
}
export class ConnectionRejection extends AgentError {
  constructor(
    readonly status: number,
    readonly rejectionCode: string | null,
  ) {
    super("connection_rejected", "The Agent connection was rejected.");
  }
  get stopNoRestart(): boolean {
    return (
      this.rejectionCode !== null &&
      permanent.get(this.rejectionCode) === this.status
    );
  }
}
interface Pending {
  readonly operation: WireOperationV2;
  readonly resolve: (value: any) => void;
  readonly reject: (reason: unknown) => void;
  readonly cleanup: () => void;
}
function header(response: IncomingMessage, name: string): string {
  const value = response.headers[name];
  const occurrences = response.rawHeaders.filter(
    (_value, index) => index % 2 === 0 && _value.toLowerCase() === name,
  ).length;
  requireCondition(
    occurrences === 1 &&
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      value.trim() === value &&
      !/[\0\r\n]/.test(value),
    "invalid_connection_binding",
    "The authenticated Upgrade response is missing a unique bounded connection identity.",
  );
  return value;
}
function remoteError(error: unknown): {
  code: string;
  message: string;
  details?: { runId: string; status: string };
} {
  const safe = safeErrorData(error, {
    code: "agent_error",
    message: "The Agent operation failed.",
  });
  // Codes locate the failure; transport errors never echo native/plugin messages or secrets.
  const result: {
    code: string;
    message: string;
    details?: { runId: string; status: string };
  } = {
    code:
      typeof safe.code === "string" && /^[a-z0-9_]{1,128}$/.test(safe.code)
        ? safe.code
        : "agent_error",
    message: "The Agent operation failed.",
  };
  // A response projection failure must not hide the already accepted Run's
  // identity. Only these two public facts are safe; plugin/native details stay local.
  const details = safe.details;
  if (
    result.code === "run_context_too_large" &&
    isPlainRecord(details) &&
    typeof details.runId === "string" &&
    /^run_[0-9a-f]{32}$/.test(details.runId) &&
    typeof details.status === "string" &&
    [
      "accepted",
      "preparing_inputs",
      "running",
      "waiting_input",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(details.status)
  ) {
    result.details = { runId: details.runId, status: details.status };
  }
  return result;
}

/** One actual socket and its observation RPCs; accepted Run lifetime belongs to RunEngine. */
export class ControlConnection {
  readonly binding: Readonly<WireConnectionV2>;
  readonly closed: Promise<void>;
  readonly signal: AbortSignal;
  #socket: WebSocket;
  #options: ControlConnectionOptions;
  #controller = new AbortController();
  #closure = Promise.withResolvers<void>();
  #pending = new Map<string, Pending>();
  #incoming = new Map<string, AbortController>();
  #queuedBytes = 0;
  #stopped = false;
  #ready = false;
  #initial: { message: WireEnvelopeV2; bytes: number }[] = [];
  #initialBytes = 0;
  #events: Promise<void> = Promise.resolve();
  #eventCount = 0;
  #abort: () => void;
  private constructor(
    socket: WebSocket,
    binding: WireConnectionV2,
    options: ControlConnectionOptions,
  ) {
    this.#socket = socket;
    this.binding = Object.freeze(binding);
    this.#options = options;
    this.signal = this.#controller.signal;
    this.closed = this.#closure.promise;
    this.#abort = () => this.close();
    options.signal.addEventListener("abort", this.#abort, { once: true });
    socket.on("message", (data, binary) => this.#receive(data, binary));
    socket.on("close", () => this.#closed());
    // A WebSocket error is followed by close. Do not report an early fake closure.
    socket.on("error", () => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    });
    if (options.signal.aborted) this.close();
  }
  static async connect(
    options: ControlConnectionOptions,
  ): Promise<ControlConnection> {
    options.signal.throwIfAborted();
    const url = validateServerUrl(options.serverUrl, options.profile);
    validateAgentToken(options.token);
    requireCondition(
      /^boot_[0-9a-f]{32}$/.test(options.bootId) &&
        /^[\x21-\x7e]{1,128}$/.test(options.version),
      "invalid_configuration",
      "The selected Agent runtime metadata is invalid.",
    );
    url.pathname = url.pathname.replace(/\/+$/, "") + "/agent/connect";
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${options.token}`,
        "X-Nexum-Protocol-Version": "2",
        "X-Nexum-Agent-Version": options.version,
        "X-Nexum-Platform":
          process.platform === "win32" ? "windows" : process.platform,
        "X-Nexum-Arch": process.arch === "x64" ? "amd64" : process.arch,
        ...(/^[\x21-\x7e]{1,255}$/.test(hostname())
          ? { "X-Nexum-Hostname": hostname() }
          : {}),
        "X-Nexum-Profile": options.profile,
        "X-Nexum-Boot-Id": options.bootId,
      },
      maxPayload: maximum,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 10000,
    });
    const opening = Promise.withResolvers<ControlConnection>();
    let connection: ControlConnection | undefined;
    let failure: unknown;
    const abort = () => {
      failure = options.signal.reason;
      socket.terminate();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    socket.on("upgrade", (response) => {
      try {
        connection = new ControlConnection(
          socket,
          {
            agentId: header(response, "x-nexum-agent-id"),
            cloudEnvironment: header(response, "x-nexum-cloud-environment"),
            connectionId: header(response, "x-nexum-connection-id"),
            profile: options.profile,
            bootId: options.bootId,
          },
          options,
        );
        requireCondition(
          connection.binding.cloudEnvironment === options.profile,
          "invalid_connection_binding",
          "The Cloud environment does not match the selected profile.",
        );
      } catch (cause) {
        failure = cause;
        socket.terminate();
      }
    });
    socket.once("unexpected-response", (_request, response) => {
      const code = response.headers["x-nexum-error-code"];
      failure = new ConnectionRejection(
        response.statusCode ?? 0,
        typeof code === "string" && permanent.has(code) ? code : null,
      );
      response.destroy();
      socket.terminate();
    });
    socket.once("error", () => {
      failure ??= new AgentError(
        "connection_failed",
        "The Agent connection could not be established.",
      );
    });
    socket.once("close", () => {
      options.signal.removeEventListener("abort", abort);
      opening.reject(
        failure ??
          new AgentError(
            "connection_closed",
            "The Agent connection closed before admission.",
          ),
      );
    });
    socket.once("open", () => {
      void (async () => {
        try {
          requireCondition(
            connection,
            "invalid_connection_binding",
            "No authenticated connection identity was received.",
          );
          await options.ready(connection);
          connection.signal.throwIfAborted();
          connection.#ready = true;
          const messages = connection.#initial;
          connection.#initial = [];
          connection.#initialBytes = 0;
          for (const item of messages) connection.#message(item.message);
          opening.resolve(connection);
        } catch (cause) {
          failure = cause;
          socket.terminate();
        }
      })();
    });
    try {
      return await opening.promise;
    } finally {
      options.signal.removeEventListener("abort", abort);
    }
  }
  #current(): void {
    this.signal.throwIfAborted();
    requireCondition(
      !this.#stopped && this.#socket.readyState === WebSocket.OPEN,
      "connection_closed",
      "The observation connection is no longer open.",
    );
  }
  async send(message: WireEnvelopeV2): Promise<void> {
    this.#current();
    validateContract("wire", message);
    const text = canonicalJson(message, maximum),
      bytes = Buffer.byteLength(text);
    requireCondition(
      this.#queuedBytes + bytes <= 4 * maximum,
      "control_busy",
      "The control connection's output budget is occupied.",
    );
    this.#queuedBytes += bytes;
    try {
      await new Promise<void>((resolve, reject) => {
        this.#socket.send(text, { binary: false, compress: false }, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    } finally {
      this.#queuedBytes -= bytes;
    }
  }
  request<O extends WireOperationV2>(
    operation: O,
    context: WireInvocationContextV2,
    input: WireInputsV2[O],
    signal: AbortSignal,
    timeoutMs = 30000,
  ): Promise<WireOutputsV2[O]> {
    this.#current();
    signal.throwIfAborted();
    requireCondition(
      this.#pending.size < 512 &&
        Number.isSafeInteger(timeoutMs) &&
        timeoutMs > 0 &&
        timeoutMs <= 300000,
      "control_busy",
      "The control request budget or deadline is invalid.",
    );
    requireCondition(
      reverseOperations.has(operation),
      "invalid_control_direction",
      "The Agent cannot request a Cloud-to-Agent operation.",
    );
    this.#checkBinding(context.connection);
    const id = newId("rpc_agent"),
      completion = Promise.withResolvers<WireOutputsV2[O]>();
    const stop = () => {
      if (!this.#pending.delete(id)) return;
      cleanup();
      // Cancel ends this observation. It never claims that a remote side effect stopped.
      void this.send({ type: "cancel", id }).catch(() => {});
      completion.reject(
        signal.aborted
          ? signal.reason
          : new AgentError(
              "observation_timeout",
              "The control observation deadline expired.",
            ),
      );
    };
    const timer = setTimeout(stop, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    this.#pending.set(id, {
      operation,
      resolve: completion.resolve,
      reject: completion.reject,
      cleanup,
    });
    signal.addEventListener("abort", stop, { once: true });
    void this.send({
      type: "invoke",
      id,
      operation,
      context,
      input,
    } as WireEnvelopeV2).catch((cause) => {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        pending.cleanup();
        pending.reject(cause);
      }
    });
    return completion.promise;
  }
  #checkBinding(value: WireConnectionV2): void {
    requireCondition(
      Object.keys(this.binding).every(
        (key) =>
          value[key as keyof WireConnectionV2] ===
          this.binding[key as keyof WireConnectionV2],
      ),
      "connection_binding_mismatch",
      "The message targets a different authenticated connection.",
    );
  }
  #receive(data: RawData, binary: boolean): void {
    try {
      this.#current();
      requireCondition(
        !binary,
        "invalid_control_message",
        "Binary payloads do not belong on the control connection.",
      );
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
      requireCondition(
        bytes.length <= maximum,
        "data_too_large",
        "The control message exceeds its budget.",
      );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const message = JSON.parse(text) as WireEnvelopeV2;
      validateContract("wire", message);
      if (
        !this.#ready &&
        (message.type === "invoke" || message.type === "event")
      ) {
        if (message.type === "invoke")
          requireCondition(
            !this.#initial.some(
              (item) =>
                item.message.type === "invoke" &&
                item.message.id === message.id,
            ),
            "invalid_control_message",
            "An initialization request was duplicated.",
          );
        requireCondition(
          this.#initial.length < 64 &&
            this.#initialBytes + bytes.length <= 4 * maximum,
          "control_busy",
          "Too much control input arrived during initialization.",
        );
        this.#initial.push({ message, bytes: bytes.length });
        this.#initialBytes += bytes.length;
      } else this.#message(message);
    } catch {
      this.close();
    }
  }

  #message(message: WireEnvelopeV2): void {
    try {
      this.#current();
      if (message.type === "result" || message.type === "error") {
        const pending = this.#pending.get(message.id);
        // Late replies after a local observation cancel are discarded, never replayed.
        if (!pending) return;
        if (message.type === "result")
          requireCondition(
            message.operation === pending.operation,
            "invalid_control_message",
            "A control reply used a different operation identity.",
          );
        this.#pending.delete(message.id);
        pending.cleanup();
        if (message.type === "result") pending.resolve(message.output);
        else
          pending.reject(
            new AgentError(
              message.error.code,
              message.error.message,
              message.error.details,
            ),
          );
      } else if (message.type === "cancel") {
        const queued = this.#initial.findIndex(
          (item) =>
            item.message.type === "invoke" && item.message.id === message.id,
        );
        if (queued !== -1) {
          this.#initialBytes -= this.#initial[queued]!.bytes;
          this.#initial.splice(queued, 1);
        }
        this.#incoming
          .get(message.id)
          ?.abort(
            new AgentError(
              "observation_cancelled",
              "The remote observer stopped waiting.",
            ),
          );
      } else if (message.type === "invoke") {
        this.#checkBinding(message.context.connection);
        requireCondition(
          !reverseOperations.has(message.operation),
          "invalid_control_direction",
          "The Cloud cannot invoke an Agent-to-Cloud operation.",
        );
        requireCondition(
          !this.#incoming.has(message.id) && this.#incoming.size < 512,
          "control_busy",
          "The incoming control request is duplicated or the observation budget is occupied.",
        );
        const controller = new AbortController();
        this.#incoming.set(message.id, controller);
        const signal = AbortSignal.any([controller.signal, this.signal]);
        void Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            return this.#options.invoke(message, signal);
          })
          .then(
            (output) =>
              this.send({
                type: "result",
                id: message.id,
                operation: message.operation,
                output,
              } as WireEnvelopeV2),
            (cause) =>
              this.send({
                type: "error",
                id: message.id,
                error: remoteError(cause),
              }),
          )
          .catch(() => {
            this.close();
          })
          .finally(() => {
            this.#incoming.delete(message.id);
          });
      } else {
        this.#checkBinding(message.connection);
        requireCondition(
          cloudEvents.has(message.name),
          "invalid_control_direction",
          "The Cloud event direction is invalid.",
        );
        requireCondition(
          this.#eventCount < 64,
          "control_busy",
          "Too many control events are pending.",
        );
        this.#eventCount++;
        this.#events = this.#events
          .then(() => {
            this.signal.throwIfAborted();
            return this.#options.event(message, this.signal);
          })
          .catch(() => {
            this.close();
          })
          .finally(() => {
            this.#eventCount--;
          });
      }
    } catch {
      this.close();
    }
  }
  close(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#controller.abort(
      new AgentError(
        "connection_closed",
        "The observation connection is closing.",
      ),
    );
    this.#socket.terminate();
  }
  #closed(): void {
    this.#stopped = true;
    this.#controller.abort(
      new AgentError("connection_closed", "The observation connection closed."),
    );
    this.#options.signal.removeEventListener("abort", this.#abort);
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(
        new AgentError(
          "connection_closed",
          "The control observation ended without a confirmed reply.",
        ),
      );
    }
    this.#pending.clear();
    this.#incoming.clear();
    this.#initial = [];
    this.#initialBytes = 0;
    this.#closure.resolve();
  }
}

/** Reconnection only; the callback never replays previously accepted application requests. */
export async function reconnectControl(
  options: ControlConnectionOptions,
  diagnose: (code: string, retry: boolean) => void,
): Promise<"stopped" | "permanent"> {
  let failures = 0;
  while (!options.signal.aborted) {
    try {
      const connection = await ControlConnection.connect(options);
      failures = 0;
      await connection.closed;
    } catch (cause) {
      if (options.signal.aborted) break;
      const local =
        isAgentError(cause) &&
        Object.getOwnPropertyDescriptor(cause, "code")?.value ===
          "invalid_configuration";
      const stop =
        local || (cause instanceof ConnectionRejection && cause.stopNoRestart);
      diagnose(
        local
          ? "invalid_configuration"
          : cause instanceof ConnectionRejection
            ? (cause.rejectionCode ?? "connection_rejected")
            : "connection_failed",
        !stop,
      );
      if (stop) return "permanent";
    }
    if (options.signal.aborted) break;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
    try {
      await delay(wait + Math.floor(Math.random() * 250), undefined, {
        signal: options.signal,
      });
    } catch {
      if (!options.signal.aborted)
        throw new AgentError(
          "connection_failed",
          "The reconnect timer failed.",
        );
    }
  }
  return "stopped";
}
