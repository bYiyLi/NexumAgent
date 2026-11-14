import {
  BrowserActionError,
  requireValue,
  record,
  text,
  publicError,
} from "./errors.js";
import {
  BrowserBinaryInbox,
  parseControl,
  packBrowserValue,
  unpackBrowserValue,
  browserFrames,
  transportLimits,
} from "./transport.js";
import { routeDefinitions } from "./router.js";

const encode = new TextEncoder();
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const sameBinding = (value, ready) =>
  value.connectionId === ready.connectionId &&
  value.generation === ready.generation;
/** Cold MV3 connection. Import and construction perform no storage, timer or socket I/O. */
export function createExtensionConnection({
  chrome,
  WebSocket: Socket = globalThis.WebSocket,
  router,
  profile,
  extensionVersion,
  url,
  random = Math.random,
  pingMs = 20000,
  offlineMs = 60000,
}) {
  requireValue(
    ["production", "development"].includes(profile),
    "PROFILE_MISMATCH",
    "Use a dedicated production or development extension build.",
  );
  const expectedUrl = `ws://127.0.0.1:${profile === "production" ? 43831 : 43832}/nexum-browser/v1`;
  requireValue(
    url === undefined || url === expectedUrl,
    "PROFILE_MISMATCH",
    "The extension cannot cross its fixed profile endpoint.",
  );
  let started = false,
    stopped = false,
    socket,
    ready,
    identity,
    initialize,
    reconnectTimer,
    keepAlive,
    reconnectAttempt = 0,
    attemptSequence = 0,
    lastMessage = 0,
    sequence = 0,
    snapshotPending = false,
    snapshotDirty = false;
  const clientInstanceId = crypto.randomUUID(),
    inbox = new BrowserBinaryInbox(),
    actions = new Map(),
    receipts = new Map(),
    leases = new Map(),
    pendingLeaseReceipts = new Map();
  let binaryTail = Promise.resolve(),
    binaryProducers = 0;
  const listeners = [];
  const listen = (event, fn) => {
    event?.addListener(fn);
    if (event?.removeListener) listeners.push(() => event.removeListener(fn));
  };
  const state = () => ({
    profile,
    connected: !!ready && socket?.readyState === Socket.OPEN,
    ...(ready
      ? {
          browserId: ready.browserId,
          generation: ready.generation,
          connectionId: ready.connectionId,
        }
      : {}),
  });
  const status = (online) => {
    void Promise.resolve(
      chrome.action?.setBadgeText?.({ text: online ? "" : "OFF" }),
    ).catch(() => {});
    void Promise.resolve(
      chrome.action?.setTitle?.({
        title: online
          ? `Nexum browser (${profile})`
          : `Nexum browser (${profile}) — offline`,
      }),
    ).catch(() => {});
  };
  const bound = (extra) => ({
    v: 1,
    connectionId: ready.connectionId,
    generation: ready.generation,
    ...extra,
  });
  const send = (value, expected = socket) => {
    requireValue(
      expected && expected === socket && expected.readyState === Socket.OPEN,
      "EXTENSION_OFFLINE",
      "The loopback connection is not open.",
    );
    const raw = JSON.stringify(value);
    requireValue(
      encode.encode(raw).byteLength <= transportLimits.controlBytes,
      "OUTPUT_TOO_LARGE",
      "The control frame exceeds its budget.",
    );
    expected.send(raw);
  };
  const sendBytes = async (frame, expected, controller) => {
    while (expected.bufferedAmount > transportLimits.controlBytes) {
      controller?.signal.throwIfAborted();
      requireValue(
        expected === socket && expected.readyState === Socket.OPEN,
        "EXTENSION_OFFLINE",
      );
      await wait(5);
    }
    controller?.signal.throwIfAborted();
    requireValue(
      expected === socket && expected.readyState === Socket.OPEN,
      "EXTENSION_OFFLINE",
    );
    expected.send(frame);
    await wait(0);
  };
  const sendPacked = async (value, action, expected, controller) => {
    requireValue(
      binaryProducers < transportLimits.maxStreams,
      "QUEUE_FULL",
      "The browser byte producer queue is full.",
    );
    binaryProducers++;
    const task = binaryTail.then(async () => {
      controller.signal.throwIfAborted();
      const binding = {
        actionId: action.actionId,
        operationId: action.operationId,
        generation: action.generation,
      };
      const packed = await packBrowserValue(value, binding);
      for (const stream of packed.streams) {
        send(
          {
            v: 1,
            type: "binary_start",
            connectionId: action.connectionId,
            ...stream.meta,
          },
          expected,
        );
        for (const frame of browserFrames(stream.meta, stream.bytes))
          await sendBytes(frame, expected, controller);
        send(
          {
            v: 1,
            type: "binary_end",
            connectionId: action.connectionId,
            ...stream.meta,
          },
          expected,
        );
      }
      return {
        value: packed.value,
        ...(packed.valueStream ? { valueStream: packed.valueStream } : {}),
        ...(packed.attachments.length
          ? { attachments: packed.attachments }
          : {}),
      };
    });
    binaryTail = task.then(
      () => {},
      () => {},
    );
    try {
      return await task;
    } finally {
      binaryProducers--;
    }
  };
  const trimReceipts = () => {
    for (const [id, value] of receipts)
      if (value.completedAt < Date.now() - 300000) receipts.delete(id);
    while (receipts.size + actions.size >= 1024 && receipts.size > 0)
      receipts.delete(receipts.keys().next().value);
  };
  const snapshots = async () => {
    if (!ready || stopped) return;
    if (snapshotPending) {
      snapshotDirty = true;
      return;
    }
    snapshotPending = true;
    const expected = socket,
      generation = ready.generation;
    try {
      const tabs = await router.snapshot();
      requireValue(
        tabs.length <= 10000 &&
          encode.encode(JSON.stringify(tabs)).byteLength <= 4 * 1024 * 1024,
        "OUTPUT_TOO_LARGE",
        "The complete tab snapshot exceeds its budget.",
      );
      const sendSnapshot = (type, items) => {
        const parts = [];
        let current = [],
          bytes = 0;
        for (const item of items) {
          const size = encode.encode(JSON.stringify(item)).byteLength;
          requireValue(size < 256 * 1024, "OUTPUT_TOO_LARGE");
          if (bytes + size > 256 * 1024 && current.length) {
            parts.push(current);
            current = [];
            bytes = 0;
          }
          current.push(item);
          bytes += size;
        }
        parts.push(current);
        const snapshotId = crypto.randomUUID();
        for (let index = 0; index < parts.length; index++)
          send(
            bound({
              type,
              snapshotId,
              index,
              total: parts.length,
              items: parts[index],
            }),
            expected,
          );
      };
      if (expected !== socket || !ready || ready.generation !== generation)
        return;
      sendSnapshot(
        "capabilities",
        routeDefinitions.map((item) => ({ method: item.method })),
      );
      sendSnapshot("tabs", tabs);
    } finally {
      snapshotPending = false;
      if (snapshotDirty) {
        snapshotDirty = false;
        queueMicrotask(
          () =>
            void snapshots().catch(() =>
              socket?.close(1002, "snapshot failure"),
            ),
        );
      }
    }
  };
  const rememberLeaseClosed = async (lease, value) => {
    const receipt = {
      v: 1,
      type: "lease_closed",
      ...value,
      leaseId: lease.leaseId,
      runId: lease.runId,
      operationId: lease.operationId,
      originalGeneration: lease.generation,
      connectionId: lease.connectionId,
      generation: lease.generation,
    };
    pendingLeaseReceipts.set(lease.leaseId, receipt);
    while (pendingLeaseReceipts.size > 256)
      pendingLeaseReceipts.delete(pendingLeaseReceipts.keys().next().value);
    await chrome.storage.session.set({
      nexumClosedLeases: [...pendingLeaseReceipts.values()],
    });
    if (ready)
      send(
        bound({
          ...receipt,
          connectionId: ready.connectionId,
          generation: ready.generation,
        }),
      );
  };
  const closeLease = async (lease) => {
    const value = await router.endLease(lease.leaseId);
    leases.delete(lease.leaseId);
    await rememberLeaseClosed(lease, value);
  };
  const disconnected = async (expected) => {
    if (expected !== socket) return;
    ready = undefined;
    clearInterval(keepAlive);
    keepAlive = undefined;
    status(false);
    for (const action of actions.values())
      action.controller.abort(
        new BrowserActionError(
          "EXTENSION_OFFLINE",
          "The connection closed after browser dispatch.",
          {
            dispatched: action.dispatched,
            effect: action.dispatched ? "unknown" : "none",
          },
        ),
      );
    inbox.discard();
    for (const lease of leases.values()) void closeLease(lease).catch(() => {});
    if (!stopped) schedule();
  };
  const schedule = () => {
    if (stopped || reconnectTimer) return;
    const steps = [1000, 2000, 4000, 8000, 16000, 30000],
      delay =
        steps[Math.min(reconnectAttempt++, steps.length - 1)] *
        (0.8 + random() * 0.4);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect().catch(() => schedule());
    }, delay);
  };
  const completeArgs = (action) => {
    const ids = [
      ...(action.message.attachments ?? []).map((item) => item.streamId),
      ...(action.message.argsStream ? [action.message.argsStream] : []),
    ];
    return ids.every((id) => inbox.complete(id, action.message));
  };
  const ignoredBinary = (binding) => {
    const action = actions.get(binding.actionId),
      receipt = receipts.get(binding.actionId);
    return !!(
      (action?.controller.signal.aborted &&
        action.operationId === binding.operationId &&
        action.generation === binding.generation) ||
      (receipt &&
        receipt.operationId === binding.operationId &&
        receipt.reply.generation === binding.generation)
    );
  };
  const fingerprint = async (raw) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", encode.encode(raw)),
      ),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  const execute = (action) => {
    if (
      action.executing ||
      (!action.controller.signal.aborted && !completeArgs(action))
    )
      return;
    action.executing = true;
    const message = action.message,
      expected = action.socket;
    void (async () => {
      let reply;
      try {
        await action.fingerprint;
        action.controller.signal.throwIfAborted();
        const args = unpackBrowserValue(
          message.args,
          message.attachments,
          message.argsStream,
          inbox,
          message,
        );
        action.controller.signal.throwIfAborted();
        requireValue(
          ready && expected === socket && sameBinding(message, ready),
          "EXTENSION_OFFLINE",
        );
        const value = await router.dispatch(
          { ...message, args },
          action.controller.signal,
          () => {
            action.dispatched = true;
          },
        );
        const packed = await sendPacked(
          value,
          message,
          expected,
          action.controller,
        );
        reply = {
          v: 1,
          type: "action_result",
          actionId: message.actionId,
          operationId: message.operationId,
          runId: message.runId,
          connectionId: message.connectionId,
          generation: message.generation,
          ok: true,
          ...packed,
        };
      } catch (cause) {
        reply = {
          v: 1,
          type: "action_result",
          actionId: message.actionId,
          operationId: message.operationId,
          runId: message.runId,
          connectionId: message.connectionId,
          generation: message.generation,
          ok: false,
          ...publicError(cause, action.dispatched),
        };
      } finally {
        clearTimeout(action.timer);
        inbox.discard(message.actionId);
        actions.delete(message.actionId);
      }
      // Receipts contain only control data. Binary results are not retained for replay.
      const receipt = { ...reply };
      if (receipt.ok && (receipt.attachments?.length || receipt.valueStream)) {
        receipt.ok = false;
        delete receipt.value;
        delete receipt.valueStream;
        delete receipt.attachments;
        Object.assign(receipt, {
          code: "UNKNOWN_RESULT",
          message: "The original byte result cannot be replayed.",
          dispatched: true,
          effect: "unknown",
          retryable: false,
        });
      }
      receipts.set(message.actionId, {
        reply: receipt,
        completedAt: Date.now(),
        operationId: message.operationId,
        fingerprint: await action.fingerprint,
      });
      trimReceipts();
      if (expected === socket && ready && sameBinding(message, ready))
        send(reply, expected);
    })().catch(() => {
      if (expected === socket) expected.close(1002, "protocol failure");
    });
  };
  const receive = async (event, expected) => {
    if (expected !== socket || stopped) return;
    if (typeof event.data !== "string") {
      requireValue(
        ready,
        "PROTOCOL_MISMATCH",
        "Binary data arrived before ready.",
      );
      inbox.push(event.data, ignoredBinary);
      lastMessage = Date.now();
      return;
    }
    const message = parseControl(event.data);
    lastMessage = Date.now();
    if (message.type === "ready") {
      requireValue(
        !ready &&
          message.profile === profile &&
          message.browserSessionId === identity.browserSessionId &&
          message.protocolVersion === 1 &&
          Number.isSafeInteger(message.generation) &&
          message.generation > 0,
        "PROTOCOL_MISMATCH",
        "The ready message belongs to another profile, session or protocol.",
      );
      for (const key of ["bootId", "connectionId", "browserId"])
        text(message[key], 256);
      record(message.limits);
      for (const key of [
        "controlBytes",
        "headerBytes",
        "chunkBytes",
        "maxStreams",
        "valueBytes",
        "inFlight",
      ])
        requireValue(
          message.limits[key] === transportLimits[key],
          "PROTOCOL_MISMATCH",
          "The plugin and package use incompatible wire budgets.",
        );
      ready = Object.freeze(message);
      router.bind(message);
      reconnectAttempt = 0;
      status(true);
      await snapshots();
      for (const receipt of pendingLeaseReceipts.values())
        send(
          bound({
            ...receipt,
            connectionId: ready.connectionId,
            generation: ready.generation,
          }),
        );
      return;
    }
    if (message.type === "error" && !ready)
      throw new BrowserActionError(
        message.code ?? "PROTOCOL_MISMATCH",
        "The local package rejected this plugin connection.",
      );
    requireValue(
      ready && sameBinding(message, ready),
      "PROTOCOL_MISMATCH",
      "The message belongs to a stale browser connection.",
    );
    if (message.type === "ping") {
      send(bound({ type: "pong" }));
      return;
    }
    if (message.type === "pong") return;
    if (message.type === "binary_start") {
      if (ignoredBinary(message)) return;
      inbox.begin(message, (binding) => {
        const action = actions.get(binding.actionId);
        return (
          action &&
          !action.executing &&
          action.operationId === binding.operationId &&
          action.generation === binding.generation &&
          [
            ...(action.message.attachments ?? []).map((a) => a.streamId),
            action.message.argsStream,
          ].includes(binding.streamId)
        );
      });
      return;
    }
    if (message.type === "binary_end") {
      if (ignoredBinary(message)) return;
      try {
        await inbox.end(message);
      } catch (cause) {
        if (ignoredBinary(message)) return;
        throw cause;
      }
      const action = actions.get(message.actionId);
      if (action) execute(action);
      return;
    }
    if (message.type === "action") {
      for (const key of [
        "actionId",
        "operationId",
        "runId",
        "leaseId",
        "method",
      ])
        text(message[key], 256);
      requireValue(
        Number.isFinite(message.budgetMs) &&
          message.budgetMs > 0 &&
          message.budgetMs <= 2147483647 &&
          message.args !== undefined,
        "PROTOCOL_MISMATCH",
        "The action declaration is invalid.",
      );
      trimReceipts();
      if (actions.has(message.actionId)) {
        const prior = actions.get(message.actionId);
        requireValue(
          prior.operationId === message.operationId &&
            (await prior.fingerprint) === (await fingerprint(event.data)),
          "PROTOCOL_MISMATCH",
          "An action ID was rebound.",
        );
        return;
      }
      if (receipts.has(message.actionId)) {
        const prior = receipts.get(message.actionId);
        requireValue(
          prior.operationId === message.operationId &&
            prior.fingerprint === (await fingerprint(event.data)),
          "PROTOCOL_MISMATCH",
          "An action ID was rebound.",
        );
        send(prior.reply);
        return;
      }
      requireValue(
        actions.size < transportLimits.inFlight &&
          actions.size + receipts.size < 1024,
        "QUEUE_FULL",
        "The browser action receipt budget is full.",
      );
      const controller = new AbortController(),
        action = {
          actionId: message.actionId,
          operationId: message.operationId,
          generation: message.generation,
          controller,
          message,
          socket: expected,
          executing: false,
          dispatched: false,
          fingerprint: fingerprint(event.data),
        };
      action.timer = setTimeout(() => {
        controller.abort(
          new BrowserActionError(
            "TIMEOUT",
            "The action reached its browser-side deadline.",
            {
              dispatched: action.dispatched,
              effect: action.dispatched ? "unknown" : "none",
            },
          ),
        );
        execute(action);
      }, message.budgetMs);
      actions.set(message.actionId, action);
      execute(action);
      return;
    }
    if (message.type === "cancel_action") {
      const action = actions.get(message.actionId);
      if (action) {
        requireValue(
          action.operationId === message.operationId,
          "PROTOCOL_MISMATCH",
        );
        action.controller.abort(
          new BrowserActionError(
            "UNKNOWN_RESULT",
            "The action was cancelled; dispatched website effects are not rolled back.",
            {
              dispatched: action.dispatched,
              effect: action.dispatched ? "unknown" : "none",
            },
          ),
        );
        if (!action.executing) execute(action);
      }
      inbox.discard(message.actionId);
      return;
    }
    if (message.type === "lease_open") {
      for (const key of ["leaseId", "runId", "operationId"])
        text(message[key], 256);
      let value;
      try {
        value = await router.openLease(message);
      } catch (cause) {
        const rejected = router.rejectedLeaseOpen?.(cause);
        if (
          rejected?.rejected === true &&
          rejected.leaseId === message.leaseId &&
          rejected.runId === message.runId &&
          rejected.operationId === message.operationId
        ) {
          await rememberLeaseClosed(message, rejected);
          return;
        }
        throw cause;
      }
      leases.set(message.leaseId, message);
      send(
        bound({
          type: "lease_opened",
          ...value,
          leaseId: message.leaseId,
          runId: message.runId,
          operationId: message.operationId,
        }),
      );
      return;
    }
    if (message.type === "lease_end") {
      const lease = leases.get(message.leaseId);
      if (!lease) {
        const prior = pendingLeaseReceipts.get(message.leaseId);
        requireValue(
          prior && prior.runId === message.runId,
          "INVALID_TARGET",
          "Unknown lease cleanup identity.",
        );
        send(
          bound({
            ...prior,
            generation: ready.generation,
            connectionId: ready.connectionId,
          }),
        );
        return;
      }
      requireValue(
        lease.runId === message.runId,
        "INVALID_TARGET",
        "A run cannot close another run's lease.",
      );
      await closeLease(lease);
      return;
    }
    throw new BrowserActionError(
      "PROTOCOL_MISMATCH",
      "The local endpoint sent an unsupported control message.",
    );
  };
  const connect = async () => {
    if (
      stopped ||
      (socket && [Socket.CONNECTING, Socket.OPEN].includes(socket.readyState))
    )
      return;
    await initialize;
    if (stopped) return;
    const expected = new Socket(expectedUrl);
    socket = expected;
    expected.binaryType = "arraybuffer";
    expected.addEventListener("open", () => {
      if (expected !== socket || stopped) {
        expected.close();
        return;
      }
      lastMessage = Date.now();
      send(
        {
          v: 1,
          type: "hello",
          profile,
          extensionId: chrome.runtime.id,
          extensionVersion,
          protocol: { min: 1, max: 1 },
          ...identity,
          clientInstanceId,
          attemptSequence: ++attemptSequence,
          metadata: {
            name: "Nexum browser",
            extensionVersion,
            versionSource: "unknown",
          },
        },
        expected,
      );
      keepAlive = setInterval(() => {
        if (expected !== socket || expected.readyState !== Socket.OPEN) return;
        if (Date.now() - lastMessage >= offlineMs) {
          expected.close(1001, "peer offline");
          return;
        }
        if (ready) send(bound({ type: "ping" }), expected);
      }, pingMs);
    });
    expected.addEventListener("message", (event) => {
      void receive(event, expected).catch(() => {
        if (expected === socket) expected.close(1002, "protocol failure");
      });
    });
    expected.addEventListener("close", () => {
      void disconnected(expected).catch(() => schedule());
    });
    expected.addEventListener("error", () => {
      if (expected === socket && expected.readyState !== Socket.CLOSED)
        expected.close();
    });
  };
  const api = {
    start() {
      requireValue(
        !stopped,
        "EXTENSION_OFFLINE",
        "A disposed plugin connection cannot restart.",
      );
      if (started) return initialize;
      started = true;
      initialize = (async () => {
        const local = await chrome.storage.local.get(["nexumBrowserProfileId"]),
          session = await chrome.storage.session.get([
            "nexumBrowserSessionId",
            "nexumClosedLeases",
            "nexumOwnedControls",
            "nexumVisualMarkers",
          ]);
        requireValue(
          session.nexumBrowserSessionId || !session.nexumOwnedControls?.length,
          "PROFILE_CONFLICT",
          "Native attachment journal exists without its browser session identity.",
        );
        identity = {
          browserProfileId: local.nexumBrowserProfileId ?? crypto.randomUUID(),
          browserSessionId:
            session.nexumBrowserSessionId ?? crypto.randomUUID(),
        };
        if (!local.nexumBrowserProfileId)
          await chrome.storage.local.set({
            nexumBrowserProfileId: identity.browserProfileId,
          });
        if (!session.nexumBrowserSessionId)
          await chrome.storage.session.set({
            nexumBrowserSessionId: identity.browserSessionId,
          });
        for (const receipt of session.nexumClosedLeases ?? [])
          if (receipt && typeof receipt.leaseId === "string")
            pendingLeaseReceipts.set(receipt.leaseId, receipt);
        router.start();
        const owned = session.nexumOwnedControls ?? [];
        requireValue(
          owned.every(
            (entry) =>
              entry.target?.browserSessionId === identity.browserSessionId,
          ),
          "PROFILE_CONFLICT",
          "The saved native control belongs to another browser session.",
        );
        if (router.recoverOwnedControls)
          for (const recovered of await router.recoverOwnedControls(owned))
            await rememberLeaseClosed(recovered.lease, recovered.receipt);
        if (router.startVisual)
          await router.startVisual(
            identity.browserSessionId,
            session.nexumVisualMarkers ?? [],
          );
      })();
      void initialize.then(connect).catch(() => status(false));
      listen(chrome.runtime.onStartup, () => void connect().catch(schedule));
      listen(chrome.alarms?.onAlarm, (alarm) => {
        if (alarm.name === "nexum-browser-connect")
          void connect().catch(schedule);
      });
      void Promise.resolve(
        chrome.alarms?.create?.("nexum-browser-connect", {
          periodInMinutes: 0.5,
        }),
      ).catch(() => {});
      return initialize;
    },
    publish(event) {
      if (!ready || !socket || stopped) return;
      if (event.type === "tabs_changed") {
        void snapshots().catch(() => socket?.close(1002, "snapshot failure"));
        return;
      }
      send(bound({ ...event, sequence: ++sequence }));
    },
    state,
    async dispose() {
      if (stopped) return;
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(keepAlive);
      for (const remove of listeners.splice(0)) remove();
      for (const action of actions.values())
        action.controller.abort(
          new BrowserActionError(
            "EXTENSION_OFFLINE",
            "The plugin connection stopped.",
            {
              dispatched: action.dispatched,
              effect: action.dispatched ? "unknown" : "none",
            },
          ),
        );
      await Promise.allSettled([...leases.values()].map(closeLease));
      await router.dispose();
      if (socket && socket.readyState !== Socket.CLOSED)
        socket.close(1000, "plugin stopped");
      ready = undefined;
      inbox.discard();
      await chrome.alarms?.clear?.("nexum-browser-connect");
    },
  };
  return Object.freeze(api);
}
