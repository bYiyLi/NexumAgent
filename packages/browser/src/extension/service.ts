import { EventEmitter, once } from "node:events";
import { createServer, type Server } from "node:http";
import {
  readFile,
  writeFile,
  rename,
  mkdir,
  lstat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  setImmediate as yieldTurn,
  setTimeout as delay,
} from "node:timers/promises";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { BrowserInfo } from "../client/types.js";
import {
  BinaryInbox,
  check,
  control,
  data,
  failure,
  frames,
  identifier,
  limits,
  pack,
  parseControl,
  socketPath,
  unpack,
  type Target,
  type RecordData,
  type StreamBinding,
} from "./protocol.js";

export interface BrowserServiceOptions {
  profile: "production" | "development";
  port: number;
  work: string;
  extensionId: string;
  extensionVersion: string;
  defaultBrowserId?: string;
}
interface Pending {
  actionId: string;
  operationId: string;
  runId: string;
  leaseId: string;
  generation: number;
  resolve(value: unknown): void;
  reject(cause: unknown): void;
  cleanup(): void;
  dispatched: boolean;
}
export interface BrowserPeer {
  readonly id: string;
  readonly generation: number;
  readonly browserSessionId: string;
  readonly clientInstanceId: string;
  readonly attemptSequence: number;
  readonly profileId: string;
  readonly socket: WebSocket;
  readonly connectionId: string;
  readonly inbox: BinaryInbox;
  info: BrowserInfo;
  tabs: Map<string, RecordData>;
  capabilities: RecordData[];
  lastSeen: number;
  sequence: number;
  snapshots: Map<
    string,
    {
      id: string;
      total: number;
      parts: Map<number, unknown[]>;
      bytes: number;
      created: number;
    }
  >;
  tabsReady: boolean;
  capabilitiesReady: boolean;
  pending: Map<string, Pending>;
  completed: Map<string, { operationId: string; at: number }>;
}
export interface LeaseEvidence {
  unconfirmedControls?: boolean;
}
interface LeaseWait {
  peer: BrowserPeer;
  generation: number;
  runId: string;
  operationId: string;
  resolve(): void;
  reject(cause: unknown): void;
  opened: boolean;
  onClosed?: (evidence?: LeaseEvidence) => void;
}
/** Cold, package-owned native listener. Only explicit start performs filesystem/network I/O. */
export class BrowserService extends EventEmitter {
  readonly bootId = randomUUID();
  readonly closed: Promise<void>;
  #closed = Promise.withResolvers<void>();
  #stop = new AbortController();
  #server?: Server;
  #wss?: WebSocketServer;
  #start?: Promise<void>;
  #disposing?: Promise<void>;
  #started = false;
  #stopping = false;
  #timer?: NodeJS.Timeout;
  #port: number;
  #sockets = new Set<WebSocket>();
  #peers = new Map<string, BrowserPeer>();
  #profiles = new Map<string, BrowserPeer>();
  #generations = new Map<string, number>();
  #identities = new Map<string, string>();
  #claims = new Map<string, object>();
  #leases = new Map<string, LeaseWait>();
  #tasks = new Set<Promise<unknown>>();
  #persist = Promise.resolve();
  constructor(readonly options: BrowserServiceOptions) {
    super();
    this.setMaxListeners(0);
    this.closed = this.#closed.promise;
    this.#port = options.port;
    check(
      ["production", "development"].includes(options.profile) &&
        Number.isInteger(options.port) &&
        options.port >= 0 &&
        options.port <= 65535 &&
        path.isAbsolute(options.work) &&
        /^[a-p]{32}$/.test(options.extensionId) &&
        identifier(options.extensionVersion),
      "INVALID_ARGUMENT",
      "Browser service requires one explicit profile, port and matching extension identity.",
    );
  }
  get address(): { host: "127.0.0.1"; port: number; path: string } | null {
    return this.#started && !this.#stopping
      ? { host: "127.0.0.1", port: this.#port, path: socketPath }
      : null;
  }
  #track<T>(task: Promise<T>): Promise<T> {
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task)).catch(() => {});
    return task;
  }
  start(signal: AbortSignal): Promise<void> {
    check(
      !this.#stopping,
      "EXTENSION_OFFLINE",
      "The browser service is stopping.",
    );
    if (this.#start) return this.#start;
    const task = this.#startNative(signal);
    this.#start = task;
    void task.catch(() => {});
    return task;
  }
  async #startNative(signal: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([signal, this.#stop.signal]);
    combined.throwIfAborted();
    const directory = path.join(this.options.work, ".nexum-browser");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    check(
      !(await lstat(directory)).isSymbolicLink(),
      "PERMISSION_DENIED",
      "Browser state cannot use a symbolic-link directory.",
    );
    try {
      const body = await readFile(path.join(directory, "profiles.json"));
      check(
        body.length <= 1024 * 1024,
        "OUTPUT_TOO_LARGE",
        "The browser profile map is too large.",
      );
      const value = JSON.parse(body.toString("utf8")) as unknown;
      check(
        value && typeof value === "object" && !Array.isArray(value),
        "PROTOCOL_MISMATCH",
        "The stored browser profile map is invalid.",
      );
      for (const [key, id] of Object.entries(value)) {
        check(
          identifier(key) && identifier(id) && this.#identities.size < 1000,
          "PROTOCOL_MISMATCH",
          "The stored browser profile map is invalid.",
        );
        this.#identities.set(key, id);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    combined.throwIfAborted();
    const server = createServer(
      { maxHeaderSize: 16384 },
      (_request, response) => {
        response.writeHead(404);
        response.end();
      },
    );
    this.#server = server;
    server.maxHeadersCount = 64;
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: limits.controlBytes,
      maxFragments: 32,
      maxBufferedChunks: 256,
    });
    this.#wss = wss;
    server.on("upgrade", (request, socket, head) => {
      const invalid =
        this.#stopping ||
        !["127.0.0.1", "::ffff:127.0.0.1"].includes(
          (socket as import("node:net").Socket).remoteAddress ?? "",
        ) ||
        request.method !== "GET" ||
        request.url !== socketPath ||
        request.headers.host !== `127.0.0.1:${this.#port}` ||
        request.headers.origin !==
          `chrome-extension://${this.options.extensionId}` ||
        Object.keys(request.headers).some(
          (name) =>
            name === "forwarded" ||
            name.startsWith("x-forwarded-") ||
            name === "x-original-url",
        ) ||
        this.#sockets.size >= 64;
      if (invalid) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => this.#connection(ws));
    });
    server.on("error", () => {});
    try {
      server.listen(this.options.port, "127.0.0.1");
      await once(server, "listening", { signal: combined });
    } catch (cause) {
      throw (cause as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? failure(
            "PORT_IN_USE",
            "The configured browser extension port is already in use.",
          )
        : cause;
    }
    const address = server.address();
    check(
      address && typeof address === "object",
      "EXTENSION_OFFLINE",
      "Browser service did not become ready.",
    );
    this.#port = address.port;
    combined.throwIfAborted();
    this.#started = true;
    this.#timer = setInterval(() => {
      const now = Date.now();
      for (const socket of this.#sockets) {
        const peer = [...this.#peers.values()].find(
          (value) => value.socket === socket,
        );
        if (peer && now - peer.lastSeen > 60000) {
          socket.terminate();
          continue;
        }
        if (socket.readyState === WebSocket.OPEN)
          socket.send(control({ v: 1, type: "ping", at: now }));
      }
    }, 20000);
  }
  #connection(socket: WebSocket): void {
    this.#sockets.add(socket);
    let peer: BrowserPeer | undefined;
    const handshake = setTimeout(() => {
      if (!peer) socket.terminate();
    }, 5000);
    socket.on("error", () => {});
    socket.on("message", (raw: RawData, binary: boolean) => {
      const task = (async () => {
        const body = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw);
        if (binary) {
          check(
            peer && this.#peers.get(peer.id) === peer,
            "PROTOCOL_MISMATCH",
            "Binary data arrived before a current handshake.",
          );
          peer.inbox.push(body);
          return;
        }
        const message = parseControl(body);
        if (!peer) {
          check(
            message.type === "hello",
            "PROTOCOL_MISMATCH",
            "Browser hello must be the first message.",
          );
          peer = await this.#hello(socket, message);
          clearTimeout(handshake);
          return;
        }
        check(
          this.#peers.get(peer.id) === peer &&
            message.generation === peer.generation &&
            message.connectionId === peer.connectionId,
          "PROTOCOL_MISMATCH",
          "Message belongs to a stale browser connection.",
        );
        peer.lastSeen = Date.now();
        this.#message(peer, message);
      })();
      void this.#track(task).catch((cause) => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            control({
              v: 1,
              type: "error",
              code: identifier((cause as { code?: unknown })?.code)
                ? (cause as { code: string }).code
                : "PROTOCOL_MISMATCH",
              message: "The browser connection could not accept this message.",
            }),
            () => socket.close(1008, "Invalid browser protocol"),
          );
        else socket.terminate();
      });
    });
    socket.once("close", () => {
      clearTimeout(handshake);
      this.#sockets.delete(socket);
      if (peer) this.#offline(peer);
    });
  }
  async #hello(
    socket: WebSocket,
    value: Record<string, unknown>,
  ): Promise<BrowserPeer> {
    check(
      value.profile === this.options.profile &&
        value.extensionId === this.options.extensionId &&
        value.extensionVersion === this.options.extensionVersion &&
        value.protocol &&
        typeof value.protocol === "object" &&
        (value.protocol as Record<string, unknown>).min === 1 &&
        (value.protocol as Record<string, unknown>).max === 1 &&
        identifier(value.browserProfileId) &&
        identifier(value.browserSessionId) &&
        identifier(value.clientInstanceId) &&
        Number.isSafeInteger(value.attemptSequence) &&
        Number(value.attemptSequence) > 0,
      "PROFILE_MISMATCH",
      "The browser hello does not match this profile and plugin build.",
    );
    const profileId = value.browserProfileId,
      claim = {};
    let old = this.#profiles.get(profileId);
    if (old && Date.now() - old.lastSeen > 60000) {
      this.#offline(old);
      old.socket.terminate();
      old = undefined;
    }
    check(
      !this.#claims.has(profileId),
      "PROFILE_CONFLICT",
      "Another handshake already owns this browser profile.",
    );
    check(
      !old ||
        (old.clientInstanceId === value.clientInstanceId &&
          Number(value.attemptSequence) > old.attemptSequence),
      "PROFILE_CONFLICT",
      "Another healthy browser worker owns this profile identity.",
    );
    this.#claims.set(profileId, claim);
    try {
      let id = this.#identities.get(profileId);
      if (!id) {
        const candidate = randomUUID(),
          directory = path.join(this.options.work, ".nexum-browser");
        // Build from the last durable map inside the serial write, then publish it.
        // A failed write never installs a nondurable identity in the live map.
        const persist = this.#persist
          .catch(() => {})
          .then(async () => {
            check(
              this.#identities.size < 1000,
              "QUEUE_FULL",
              "The browser profile map is full.",
            );
            const next = new Map(this.#identities);
            next.set(profileId, candidate);
            const temporary = path.join(
              directory,
              `.profiles-${randomUUID()}.tmp`,
            );
            try {
              await writeFile(
                temporary,
                JSON.stringify(Object.fromEntries(next)),
                { flag: "wx", mode: 0o600 },
              );
              await rename(temporary, path.join(directory, "profiles.json"));
              this.#identities = next;
            } finally {
              await unlink(temporary).catch((cause) => {
                if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
                  throw cause;
              });
            }
          });
        this.#persist = persist;
        await persist;
        id = candidate;
      }
      check(
        !this.#stopping &&
          socket.readyState === WebSocket.OPEN &&
          this.#claims.get(profileId) === claim,
        "EXTENSION_OFFLINE",
        "The browser handshake ended before acceptance.",
      );
      if (old) {
        this.#offline(old);
        old.socket.close(1000, "Newer connection attempt");
      }
      const generation = (this.#generations.get(id) ?? 0) + 1;
      this.#generations.set(id, generation);
      const metadata = data(value.metadata ?? {}, 16384) as RecordData;
      const info: BrowserInfo = {
        id,
        name: typeof metadata.name === "string" ? metadata.name : "Chromium",
        type: "extension",
        status: "online",
        generation,
        bootId: this.bootId,
        browserSessionId: value.browserSessionId,
        metadata: {
          extensionVersion: this.options.extensionVersion,
          versionSource: ["clientHints", "userAgent", "unknown"].includes(
            String(metadata.versionSource),
          )
            ? (metadata.versionSource as "unknown")
            : "unknown",
          ...(typeof metadata.browserVersion === "string"
            ? { browserVersion: metadata.browserVersion }
            : {}),
        },
        ...(typeof metadata.profileName === "string"
          ? { profileName: metadata.profileName }
          : {}),
        ...(typeof metadata.family === "string"
          ? { family: metadata.family }
          : {}),
      };
      const peer: BrowserPeer = {
        id,
        generation,
        browserSessionId: value.browserSessionId,
        clientInstanceId: value.clientInstanceId,
        attemptSequence: Number(value.attemptSequence),
        profileId,
        socket,
        connectionId: randomUUID(),
        inbox: new BinaryInbox(),
        info,
        tabs: new Map(),
        capabilities: [],
        lastSeen: Date.now(),
        sequence: 0,
        snapshots: new Map(),
        tabsReady: false,
        capabilitiesReady: false,
        pending: new Map(),
        completed: new Map(),
      };
      this.#peers.set(id, peer);
      this.#profiles.set(profileId, peer);
      for (const [leaseId, lease] of this.#leases)
        if (
          lease.peer.id === id &&
          lease.peer.browserSessionId !== peer.browserSessionId
        ) {
          lease.onClosed?.();
          this.#leases.delete(leaseId);
        }
      await this.#send(peer, {
        v: 1,
        type: "ready",
        profile: this.options.profile,
        bootId: this.bootId,
        connectionId: peer.connectionId,
        browserId: id,
        browserSessionId: peer.browserSessionId,
        generation,
        protocolVersion: 1,
        limits,
      });
      this.emit("online", info);
      return peer;
    } finally {
      if (this.#claims.get(profileId) === claim) this.#claims.delete(profileId);
    }
  }
  #message(peer: BrowserPeer, message: Record<string, unknown>): void {
    if (message.type === "pong" || message.type === "ping") {
      if (message.type === "ping")
        void this.#send(peer, { v: 1, type: "pong", at: Date.now() }).catch(
          () => {},
        );
      return;
    }
    if (message.type === "tabs" || message.type === "capabilities") {
      check(
        identifier(message.snapshotId) &&
          Number.isSafeInteger(message.index) &&
          Number.isSafeInteger(message.total) &&
          Number(message.total) > 0 &&
          Number(message.total) <= 128 &&
          Number(message.index) >= 0 &&
          Number(message.index) < Number(message.total) &&
          Array.isArray(message.items),
        "PROTOCOL_MISMATCH",
        "Invalid browser snapshot partition.",
      );
      let snapshot = peer.snapshots.get(message.type);
      if (!snapshot || snapshot.id !== message.snapshotId) {
        snapshot = {
          id: message.snapshotId,
          total: Number(message.total),
          parts: new Map(),
          bytes: 0,
          created: Date.now(),
        };
        peer.snapshots.set(message.type, snapshot);
      }
      check(
        snapshot.total === message.total &&
          !snapshot.parts.has(Number(message.index)) &&
          Date.now() - snapshot.created <= 30000,
        "PROTOCOL_MISMATCH",
        "Browser snapshot partitions conflict.",
      );
      snapshot.bytes += Buffer.byteLength(JSON.stringify(message.items));
      check(
        snapshot.bytes <= limits.snapshotBytes &&
          [...snapshot.parts.values()].reduce(
            (n, items) => n + items.length,
            0,
          ) +
            message.items.length <=
            limits.snapshotItems,
        "OUTPUT_TOO_LARGE",
        "The browser snapshot exceeds its negotiated budget.",
      );
      snapshot.parts.set(Number(message.index), message.items);
      if (snapshot.parts.size === snapshot.total) {
        const items = [...Array(snapshot.total).keys()].flatMap((index) =>
          snapshot!.parts.get(index)!,
        );
        if (message.type === "tabs") {
          const next = new Map<string, RecordData>();
          for (const item of items) {
            const value = data(item, 16384) as RecordData;
            check(
              identifier(value.id) && !next.has(value.id),
              "PROTOCOL_MISMATCH",
              "Browser tab snapshot has duplicate or invalid IDs.",
            );
            next.set(value.id, value);
          }
          peer.tabs = next;
          peer.tabsReady = true;
        } else {
          peer.capabilities = items.map(
            (item) => data(item, 16384) as RecordData,
          );
          peer.capabilitiesReady = true;
        }
        peer.snapshots.delete(message.type);
        this.emit("snapshot", peer.info, message.type);
      }
      return;
    }
    if (message.type === "binary_start") {
      const late =
        typeof message.actionId === "string" &&
        !peer.pending.has(message.actionId) &&
        peer.completed.get(message.actionId)?.operationId ===
          message.operationId;
      peer.inbox.begin(
        message,
        (binding) => {
          const known =
            peer.pending.get(binding.actionId) ??
            peer.completed.get(binding.actionId);
          return (
            !!known &&
            known.operationId === binding.operationId &&
            binding.generation === peer.generation
          );
        },
        late,
      );
      return;
    }
    if (message.type === "binary_end") {
      peer.inbox.end(message);
      return;
    }
    if (message.type === "action_result") {
      check(
        identifier(message.actionId) && identifier(message.operationId),
        "PROTOCOL_MISMATCH",
        "Browser action result has no correlation.",
      );
      const pending = peer.pending.get(message.actionId);
      if (
        !pending &&
        peer.completed.get(message.actionId)?.operationId ===
          message.operationId
      ) {
        peer.inbox.discard(message.actionId);
        return;
      }
      check(
        pending && pending.operationId === message.operationId,
        "PROTOCOL_MISMATCH",
        "Browser result belongs to an unknown action.",
      );
      try {
        if (message.ok === true)
          pending.resolve(
            unpack(
              message.value,
              message.attachments,
              message.valueStream,
              peer.inbox,
              pending,
            ),
          );
        else
          pending.reject(
            failure(
              identifier(message.code) ? message.code : "UNKNOWN_RESULT",
              typeof message.message === "string"
                ? message.message.slice(0, 1024)
                : "The browser operation failed.",
              {
                dispatched: message.dispatched !== false,
                effect:
                  message.effect === "none"
                    ? "none"
                    : message.effect === "confirmed"
                      ? "confirmed"
                      : "unknown",
                operationId: pending.operationId,
              },
            ),
          );
      } catch (cause) {
        pending.reject(cause);
        throw cause;
      } finally {
        pending.cleanup();
        peer.inbox.discard(pending.actionId);
      }
      return;
    }
    if (message.type === "lease_opened" || message.type === "lease_closed") {
      check(
        identifier(message.leaseId),
        "PROTOCOL_MISMATCH",
        "A browser lease reply has no identity.",
      );
      const lease = this.#leases.get(message.leaseId);
      if (!lease && message.type === "lease_closed") return;
      check(
        lease &&
          peer.id === lease.peer.id &&
          peer.browserSessionId === lease.peer.browserSessionId &&
          message.runId === lease.runId &&
          (message.originalGeneration ?? message.generation) ===
            lease.generation,
        "PROTOCOL_MISMATCH",
        "Browser lease evidence belongs to another run or connection.",
      );
      if (message.type === "lease_opened") {
        check(
          lease.peer === peer,
          "PROTOCOL_MISMATCH",
          "A new connection cannot open an old lease.",
        );
        lease.opened = true;
        lease.resolve();
      } else {
        if (!lease.opened)
          lease.reject(
            failure(
              identifier(message.code) ? message.code : "INVALID_TARGET",
              typeof message.message === "string"
                ? message.message.slice(0, 1024)
                : "The browser closed this lease before control was ready.",
            ),
          );
        lease.onClosed?.({
          unconfirmedControls: message.unconfirmedControls === true,
        });
        this.#leases.delete(message.leaseId);
      }
      return;
    }
    if (message.type === "event") {
      check(
        Number.isSafeInteger(message.sequence) &&
          Number(message.sequence) > peer.sequence,
        "PROTOCOL_MISMATCH",
        "Browser event sequence is stale.",
      );
      peer.sequence = Number(message.sequence);
      if (
        message.event === "tab_closed" &&
        message.target &&
        typeof message.target === "object" &&
        identifier((message.target as { tabId?: unknown }).tabId)
      )
        peer.tabs.delete((message.target as { tabId: string }).tabId);
      this.emit("browser-event", peer, data(message, limits.controlBytes));
      return;
    }
    check(
      message.type === "metadata",
      "PROTOCOL_MISMATCH",
      "Unknown browser protocol message.",
    );
  }
  #offline(peer: BrowserPeer): void {
    if (this.#peers.get(peer.id) !== peer) return;
    this.#peers.delete(peer.id);
    if (this.#profiles.get(peer.profileId) === peer)
      this.#profiles.delete(peer.profileId);
    peer.tabs.clear();
    peer.capabilities = [];
    peer.snapshots.clear();
    for (const lease of this.#leases.values())
      if (lease.peer === peer && !lease.opened)
        lease.reject(
          failure(
            "EXTENSION_OFFLINE",
            "The browser disconnected before its control lease was ready.",
          ),
        );
    for (const pending of [...peer.pending.values()]) {
      pending.reject(
        failure(
          "UNKNOWN_RESULT",
          "The browser connection ended before the operation outcome was confirmed.",
          {
            dispatched: pending.dispatched,
            effect: pending.dispatched ? "unknown" : "none",
            operationId: pending.operationId,
          },
        ),
      );
      pending.cleanup();
    }
    peer.inbox.discard();
    this.emit("offline", peer.info);
  }
  list(): BrowserInfo[] {
    return [...this.#peers.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((peer) => JSON.parse(JSON.stringify(peer.info)) as BrowserInfo);
  }
  get(id: string): BrowserPeer {
    const peer = this.#peers.get(id);
    check(
      peer && !this.#stopping,
      "EXTENSION_OFFLINE",
      "The selected browser is offline.",
    );
    return peer;
  }
  target(target: Target): BrowserPeer {
    check(
      target.bootId === this.bootId,
      "INVALID_TARGET",
      "The browser target belongs to an old Agent boot.",
    );
    const peer = this.get(target.browserId);
    check(
      peer.generation === target.generation &&
        peer.browserSessionId === target.browserSessionId,
      "INVALID_TARGET",
      "The browser target belongs to a stale connection.",
    );
    if (target.tabId)
      check(
        peer.tabs.has(target.tabId),
        "TARGET_GONE",
        "The selected browser tab is no longer available.",
      );
    return peer;
  }
  async waitSnapshot(
    peer: BrowserPeer,
    kind: "tabs" | "capabilities",
    signal: AbortSignal,
    budgetMs = 30000,
  ): Promise<void> {
    signal.throwIfAborted();
    if (kind === "tabs" ? peer.tabsReady : peer.capabilitiesReady) return;
    await new Promise<void>((resolve, reject) => {
      const done = (info: BrowserInfo, type: string) => {
        if (info.id === peer.id && type === kind) {
          cleanup();
          resolve();
        }
      };
      const offline = (info: BrowserInfo) => {
        if (info.id === peer.id) {
          cleanup();
          reject(
            failure(
              "EXTENSION_OFFLINE",
              "The browser disconnected before its complete snapshot was ready.",
            ),
          );
        }
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const timer = setTimeout(
        () => {
          cleanup();
          reject(
            failure(
              "TIMEOUT",
              "The browser did not publish a complete discovery snapshot.",
            ),
          );
        },
        Math.max(1, Math.min(budgetMs, 30000)),
      );
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener("snapshot", done);
        this.removeListener("offline", offline);
        signal.removeEventListener("abort", abort);
      };
      this.on("snapshot", done);
      this.on("offline", offline);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (this.#peers.get(peer.id) !== peer) offline(peer.info);
      else if (kind === "tabs" ? peer.tabsReady : peer.capabilitiesReady)
        done(peer.info, kind);
    });
  }
  #send(
    peer: BrowserPeer,
    value: Record<string, unknown>,
    binding = true,
  ): Promise<void> {
    check(
      peer.socket.readyState === WebSocket.OPEN &&
        (!this.#stopping ||
          value.type === "lease_end" ||
          value.type === "cancel_action"),
      "EXTENSION_OFFLINE",
      "The browser connection is closed.",
    );
    const body = control(
      binding
        ? {
            ...value,
            connectionId: peer.connectionId,
            generation: peer.generation,
          }
        : value,
    );
    check(
      value.type === "lease_end" ||
        value.type === "cancel_action" ||
        peer.socket.bufferedAmount + Buffer.byteLength(body) <=
          2 * limits.controlBytes,
      "QUEUE_FULL",
      "The browser connection write buffer is full.",
    );
    return new Promise((resolve, reject) =>
      peer.socket.send(body, (cause) => (cause ? reject(cause) : resolve())),
    );
  }
  async #binary(
    peer: BrowserPeer,
    prepared: ReturnType<typeof pack>,
    signal: AbortSignal,
  ): Promise<void> {
    for (const stream of prepared.streams) {
      signal.throwIfAborted();
      await this.#send(peer, { v: 1, type: "binary_start", ...stream.meta });
      for (const frame of frames(stream.meta, stream.bytes)) {
        while (peer.socket.bufferedAmount > 1024 * 1024) {
          signal.throwIfAborted();
          await delay(4, undefined, { signal });
        }
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) =>
          peer.socket.send(frame, { binary: true }, (cause) =>
            cause ? reject(cause) : resolve(),
          ),
        );
        await yieldTurn(undefined, { signal });
      }
      await this.#send(peer, { v: 1, type: "binary_end", ...stream.meta });
    }
  }
  action(
    peer: BrowserPeer,
    input: {
      method: string;
      args: unknown;
      target: Target;
      runId: string;
      operationId: string;
      leaseId: string;
      budgetMs: number;
      signal: AbortSignal;
      onDispatched?: () => void;
    },
  ): Promise<unknown> {
    input.signal.throwIfAborted();
    check(
      Number.isFinite(input.budgetMs) &&
        input.budgetMs > 0 &&
        input.budgetMs <= 2147483647,
      "INVALID_ARGUMENT",
      "The browser action deadline is invalid.",
    );
    this.target(input.target);
    check(
      peer.pending.size < limits.inFlight,
      "QUEUE_FULL",
      "This browser has too many in-flight actions.",
    );
    const actionId = randomUUID(),
      binding = {
        actionId,
        operationId: input.operationId,
        generation: peer.generation,
      },
      packed = pack(input.args, binding),
      result = Promise.withResolvers<unknown>();
    void result.promise.catch(() => {});
    const timer = setTimeout(
      () =>
        stop(
          failure(
            "TIMEOUT",
            "The browser action exceeded its remaining deadline.",
            {
              dispatched: pending.dispatched,
              effect: pending.dispatched ? "unknown" : "none",
              operationId: input.operationId,
            },
          ),
        ),
      input.budgetMs,
    );
    const stop = (cause: unknown) => {
      void this.#send(peer, {
        v: 1,
        type: "cancel_action",
        actionId,
        operationId: input.operationId,
        leaseId: input.leaseId,
        reason: "cancelled",
      }).catch(() => {});
      result.reject(cause);
      pending.cleanup();
      peer.inbox.discard(actionId);
    };
    const aborted = () =>
      stop(
        failure(
          "UNKNOWN_RESULT",
          "The browser action was cancelled before its effect was confirmed.",
          {
            dispatched: pending.dispatched,
            effect: pending.dispatched ? "unknown" : "none",
            operationId: input.operationId,
          },
        ),
      );
    const pending: Pending = {
      ...binding,
      runId: input.runId,
      leaseId: input.leaseId,
      resolve: result.resolve,
      reject: result.reject,
      dispatched: false,
      cleanup: () => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", aborted);
        peer.pending.delete(actionId);
        peer.completed.set(actionId, {
          operationId: input.operationId,
          at: Date.now(),
        });
        for (const [id, item] of peer.completed)
          if (Date.now() - item.at > 300000 || peer.completed.size > 1024)
            peer.completed.delete(id);
      },
    };
    peer.pending.set(actionId, pending);
    input.signal.addEventListener("abort", aborted, { once: true });
    const send = (async () => {
      input.signal.throwIfAborted();
      const dispatched = this.#send(peer, {
        v: 1,
        type: "action",
        actionId,
        runId: input.runId,
        operationId: input.operationId,
        leaseId: input.leaseId,
        target: input.target,
        method: input.method,
        args: packed.value,
        ...(packed.valueStream ? { argsStream: packed.valueStream } : {}),
        attachments: packed.attachments,
        budgetMs: input.budgetMs,
      });
      pending.dispatched = true;
      input.onDispatched?.();
      await dispatched;
      await this.#binary(peer, packed, input.signal);
    })();
    void this.#track(send).catch((cause) => stop(cause));
    return result.promise;
  }
  async openLease(
    peer: BrowserPeer,
    input: {
      id: string;
      runId: string;
      operationId: string;
      target: Target;
      signal: AbortSignal;
      onClosed: (evidence?: LeaseEvidence) => void;
    },
  ): Promise<void> {
    const ready = Promise.withResolvers<void>();
    void ready.promise.catch(() => {});
    const lease: LeaseWait = {
      peer,
      generation: peer.generation,
      runId: input.runId,
      operationId: input.operationId,
      resolve: ready.resolve,
      reject: ready.reject,
      opened: false,
      onClosed: input.onClosed,
    };
    check(
      !this.#leases.has(input.id),
      "INVALID_ARGUMENT",
      "The browser lease identity is already used.",
    );
    this.#leases.set(input.id, lease);
    let dispatched: Promise<void>;
    try {
      dispatched = this.#send(peer, {
        v: 1,
        type: "lease_open",
        leaseId: input.id,
        runId: input.runId,
        operationId: input.operationId,
        target: input.target,
      });
    } catch (cause) {
      this.#leases.delete(input.id);
      input.onClosed();
      throw cause;
    }
    // A native send failure can be ambiguous. Only a synchronous admission
    // rejection above proves that the remote lease was never sent.
    await dispatched;
    const timer = setTimeout(
      () =>
        ready.reject(
          failure("TIMEOUT", "The browser did not confirm control readiness."),
        ),
      30000,
    );
    const aborted = () => ready.reject(input.signal.reason);
    input.signal.addEventListener("abort", aborted, { once: true });
    try {
      input.signal.throwIfAborted();
      await ready.promise;
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", aborted);
    }
  }
  endLease(id: string): Promise<void> {
    const lease = this.#leases.get(id);
    if (!lease) return Promise.resolve();
    const peer = this.#peers.get(lease.peer.id);
    if (!peer || peer.browserSessionId !== lease.peer.browserSessionId)
      return Promise.resolve();
    return this.#send(peer, {
      v: 1,
      type: "lease_end",
      leaseId: id,
      runId: lease.runId,
      operationId: lease.operationId,
      originalGeneration: lease.generation,
    }).catch(() => {});
  }
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#stopping = true;
    this.#stop.abort(
      failure("EXTENSION_OFFLINE", "The browser service is stopping."),
    );
    if (this.#timer) clearInterval(this.#timer);
    const task = (async () => {
      await this.#start?.catch(() => {});
      for (const id of this.#leases.keys()) await this.endLease(id);
      for (const peer of this.#peers.values()) this.#offline(peer);
      for (const socket of this.#sockets)
        socket.close(1001, "Browser service stopped");
      const grace = setTimeout(() => {
        for (const socket of this.#sockets) socket.terminate();
      }, 5000);
      try {
        if (this.#wss)
          await new Promise<void>((resolve) =>
            this.#wss!.close(() => resolve()),
          );
        if (this.#server)
          await new Promise<void>((resolve, reject) =>
            this.#server!.close((cause) =>
              cause &&
              (cause as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
                ? reject(cause)
                : resolve(),
            ),
          );
        await Promise.allSettled([...this.#tasks]);
        await this.#persist.catch(() => {});
        this.#started = false;
        this.#closed.resolve();
      } finally {
        clearTimeout(grace);
      }
    })();
    this.#disposing = task;
    void task.catch(() => {
      if (this.#disposing === task) this.#disposing = undefined;
    });
    return task;
  }
}
