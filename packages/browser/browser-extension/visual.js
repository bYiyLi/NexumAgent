import { requireValue } from "./errors.js";

export const visualStyles = `[data-nexum-visual-layer="v1"]{position:fixed!important;left:0!important;top:0!important;width:24px!important;height:24px!important;z-index:2147483647!important;pointer-events:none!important;user-select:none!important;filter:drop-shadow(0 0 6px #3b82f6)!important;opacity:1;transition:opacity 120ms linear!important}[data-nexum-visual-layer="v1"][data-nexum-visual-state="thinking"]{animation:nexum-browser-thinking 1800ms ease-in-out infinite}@keyframes nexum-browser-thinking{0%,100%{opacity:0.85}50%{opacity:1}} [data-nexum-visual-layer="v1"] *{pointer-events:none!important}@media print{[data-nexum-visual-layer="v1"]{display:none!important}}@media(prefers-reduced-motion:reduce){[data-nexum-visual-layer="v1"]{transition:none!important;animation:none!important}}`;

/** Self-contained native isolated-world function; no module closure crosses executeScript. */
export async function visualPage(input) {
  const slot = Symbol.for("nexum.browser.visual.v1");
  const now = Date.now();
  // A managed tab remains visually identifiable after its control lease ends.
  // Only the live cursor animation is owned by the lease.
  const state = (globalThis[slot] ??= {
    current: null,
    pinned: null,
    closed: new Map(),
  });
  // An updated worker can encounter tombstones left by the previous build.
  // Preserve them for the maximum native dispatch window, then release them.
  if (state.closed instanceof Set)
    state.closed = new Map(
      [...state.closed].map((token) => [token, now + 250]),
    );
  for (const [closedToken, deadline] of state.closed)
    if (now >= deadline) state.closed.delete(closedToken);
  const token = input.token,
    inputDeadline = Number.isFinite(input.deadline) ? input.deadline : 0;
  if (input.command === "release" || input.command === "clear") {
    if (input.command === "release")
      state.closed.set(
        token,
        Math.max(
          now + 250,
          inputDeadline,
          state.closed.get(token) ?? 0,
          state.current?.token === token ? (state.current.maxDeadline ?? 0) : 0,
        ),
      );
    if (state.current?.token === token) {
      const current = state.current;
      current.stopped = true;
      if (input.command === "release" && input.retain) {
        current.layer?.setAttribute("data-nexum-visual-state", "idle");
        state.pinned = {
          layer: current.layer,
          icon: current.icon,
          x: current.x,
          y: current.y,
        };
      } else {
        current.layer?.remove();
        current.icon?.remove();
      }
      state.current = null;
    }
    if (input.command === "clear") {
      state.pinned?.layer?.remove();
      state.pinned?.icon?.remove();
      state.pinned = null;
    }
    return { ok: true };
  }
  const restoring = input.command === "restore";
  if (!restoring && (state.closed.has(token) || Date.now() >= input.deadline))
    return { ok: false, reason: "VISUAL_TARGET_RELEASED" };
  // A navigation restore may not supersede a live AI action on the same tab.
  if (restoring && state.current) return { ok: true, active: true };
  if (state.current?.token !== token) {
    if (state.current) {
      state.current.stopped = true;
      state.current.layer?.remove();
      state.current.icon?.remove();
    }
    const pinned = state.pinned;
    state.pinned = null;
    state.current = {
      token,
      sequence: -1,
      x: pinned?.x ?? 32,
      y: pinned?.y ?? 72,
      stopped: false,
      maxDeadline: inputDeadline,
      layer: pinned?.layer,
      icon: pinned?.icon,
    };
  }
  const current = state.current;
  current.maxDeadline = Math.max(current.maxDeadline ?? 0, inputDeadline);
  const valid = () =>
    state.current === current &&
    !current.stopped &&
    (restoring || !state.closed.has(token)) &&
    Date.now() < input.deadline;
  const icon = async (mode) => {
    if (!current.original)
      current.original = (async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const original = [
          ...document.querySelectorAll('link[rel~="icon"]'),
        ].find((link) => !link.hasAttribute("data-nexum-visual-icon"));
        let image;
        if (original?.href) {
          const stop = new AbortController(),
            timer = setTimeout(() => stop.abort(), 100);
          let reader;
          try {
            const response = await fetch(original.href, {
              credentials: "omit",
              mode: "cors",
              redirect: "error",
              referrerPolicy: "no-referrer",
              signal: stop.signal,
            });
            if (!response.ok || !response.body) throw Error("icon unavailable");
            reader = response.body.getReader();
            const chunks = [];
            let count = 0;
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              count += part.value.byteLength;
              if (count > 65536) throw Error("icon budget");
              chunks.push(part.value);
            }
            image = await createImageBitmap(
              new Blob(chunks, {
                type: response.headers.get("content-type") || "image/png",
              }),
              { resizeWidth: 32, resizeHeight: 32 },
            );
            if (image.width > 4096 || image.height > 4096)
              throw Error("icon dimensions");
            ctx.drawImage(image, 0, 0, 32, 32);
          } catch {
            ctx.fillStyle = "#e2e8f0";
            ctx.beginPath();
            ctx.arc(16, 16, 13, 0, Math.PI * 2);
            ctx.fill();
          } finally {
            clearTimeout(timer);
            image?.close?.();
            if (reader) {
              try {
                await reader.cancel();
              } catch {}
              reader.releaseLock();
            }
          }
        } else {
          ctx.fillStyle = "#e2e8f0";
          ctx.beginPath();
          ctx.arc(16, 16, 13, 0, Math.PI * 2);
          ctx.fill();
        }
        return canvas;
      })();
    const original = await current.original;
    if (!original || !valid()) return false;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.globalAlpha = mode === "active" ? 0.45 : 1;
    ctx.drawImage(original, 0, 0, 32, 32);
    ctx.globalAlpha = 1;
    if (mode === "active") {
      ctx.fillStyle = "#2563eb";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(9, 5);
      ctx.lineTo(25, 18);
      ctx.lineTo(18, 19);
      ctx.lineTo(21, 27);
      ctx.lineTo(16, 29);
      ctx.lineTo(13, 21);
      ctx.lineTo(8, 26);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = "#2563eb";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(25, 25, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (!current.icon) {
      current.icon = document.createElement("link");
      current.icon.rel = "icon";
      current.icon.setAttribute("data-nexum-visual-icon", "v1");
      (document.head || document.documentElement).append(current.icon);
    }
    current.icon.type = "image/png";
    current.icon.href = canvas.toDataURL("image/png");
    return true;
  };
  const ensureLayer = () => {
    if (current.layer) return current.layer;
    const layer = document.createElement("div");
    layer.setAttribute("data-nexum-visual-layer", "v1");
    layer.setAttribute("aria-hidden", "true");
    layer.setAttribute("role", "presentation");
    layer.style.pointerEvents = "none";
    layer.style.opacity = "0";
    layer.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2L21 14L13.5 15.5L17 22L12.5 24L9.5 17L3 22Z" fill="#2563eb" stroke="white" stroke-width="1.4"/></svg>';
    document.documentElement.append(layer);
    layer.getBoundingClientRect?.();
    layer.style.opacity = "1";
    layer.style.transform = `translate3d(${current.x}px,${current.y}px,0)`;
    current.layer = layer;
    return layer;
  };
  if (input.command === "active" || input.command === "result" || restoring) {
    const result = await icon(input.command === "active" ? "active" : "result");
    const layer = ensureLayer();
    layer.setAttribute(
      "data-nexum-visual-state",
      input.command === "active" ? "thinking" : "idle",
    );
    if (restoring) {
      current.stopped = true;
      state.pinned = { layer, icon: current.icon, x: current.x, y: current.y };
      state.current = null;
    }
    return { ok: result };
  }
  if (input.command !== "move" || !valid())
    return { ok: false, reason: "VISUAL_UNAVAILABLE" };
  if (input.moveSequence <= current.sequence) return { ok: true, stale: true };
  current.sequence = input.moveSequence;
  const sequence = current.sequence;
  const layer = ensureLayer();
  layer.setAttribute("data-nexum-visual-state", "moving");
  const startX = current.x,
    startY = current.y,
    dx = input.point.x - startX,
    dy = input.point.y - startY,
    distance = Math.hypot(dx, dy);
  const duration =
    input.nativeStep === true ||
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    document.visibilityState === "hidden" ||
    distance < 80
      ? 0
      : Math.min(180, Math.max(0, input.deadline - Date.now() - 8));
  const move = (x, y) => {
    current.x = x;
    current.y = y;
    layer.style.transform = `translate3d(${x}px,${y}px,0)`;
  };
  if (!duration) {
    move(input.point.x, input.point.y);
    layer.setAttribute("data-nexum-visual-state", "thinking");
    return { ok: true, arrived: true };
  }
  const started = performance.now();
  return await new Promise((resolve) => {
    let completed = false,
      frame,
      timer;
    const finish = (value) => {
      if (completed) return;
      completed = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      resolve(value);
    };
    const step = () => {
      if (completed) return;
      if (!valid() || current.sequence !== sequence) {
        finish({ ok: false, reason: "VISUAL_MOVE_SUPERSEDED" });
        return;
      }
      const t = Math.min(1, (performance.now() - started) / duration),
        ease = 1 - (1 - t) ** 3,
        bend = Math.sin(Math.PI * t) * Math.min(24, distance * 0.04);
      move(
        startX + dx * ease - (dy / (distance || 1)) * bend,
        startY + dy * ease + (dx / (distance || 1)) * bend,
      );
      if (t === 1) {
        move(input.point.x, input.point.y);
        layer.setAttribute("data-nexum-visual-state", "thinking");
        finish({ ok: true, arrived: true });
      } else frame = requestAnimationFrame(step);
    };
    // Hidden or occluded documents can stop producing animation frames while
    // their task queue remains live. Settle the real injected Promise too:
    // an outer wait timeout cannot prove that its native execution has ended.
    timer = setTimeout(
      () => finish({ ok: false, reason: "VISUAL_TIMEOUT" }),
      Math.max(1, input.deadline - Date.now()),
    );
    frame = requestAnimationFrame(step);
  });
}

const id = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\0\r\n]/.test(value);
const nativeId = (value) => {
  requireValue(
    typeof value === "string" &&
      /^[0-9]+$/.test(value) &&
      Number.isSafeInteger(Number(value)),
    "INVALID_TARGET",
  );
  return Number(value);
};
const key = (value) =>
  JSON.stringify([
    value.leaseId,
    value.target.browserSessionId,
    value.target.tabId,
    value.target.controlEpoch ?? null,
  ]);
const identity = (value) => ({ ...value.target });
function current(value) {
  value.signal?.throwIfAborted();
  requireValue(
    Number.isFinite(value.deadline) && Date.now() < value.deadline,
    "TIMEOUT",
    "The native visual preparation deadline expired.",
  );
}

/** Cold optional UI controller. Decorative failures never replay a business operation. */
export function createVisualController(
  chrome,
  { emit = () => {}, persist = async () => {} } = {},
) {
  let started = false,
    stopped = false,
    browserSessionId,
    disposal;
  const records = new Map(),
    groups = new Map(),
    names = new Map(),
    markers = new Map(),
    closedKeys = new Map(),
    styles = new Map(),
    listeners = [],
    tasks = new Set(),
    taskTokens = new Map(),
    wakeups = new Set();
  let persistence = Promise.resolve();
  const timeout = (deadline, callback) => {
    const duration = Math.max(1, deadline - Date.now()),
      due = performance.now() + duration;
    const cancel = () => {
      clearTimeout(timer);
      wakeups.delete(wake);
    };
    const fire = () => {
      cancel();
      callback();
    };
    const wake = () => {
      if (performance.now() >= due) fire();
    };
    const timer = setTimeout(fire, duration);
    wakeups.add(wake);
    return cancel;
  };
  const save = () => {
    const snapshot = [...markers.values()].map((value) => ({
      ...value,
      target: { ...value.target },
    }));
    const task = persistence.catch(() => {}).then(() => persist(snapshot));
    persistence = task;
    return task;
  };
  const notice = (ctx, reason) => {
    try {
      emit({
        type: "event",
        event: "visual_degraded",
        leaseId: ctx.leaseId,
        runId: ctx.runId,
        operationId: ctx.operationId,
        target: identity(ctx),
        reason,
      });
    } catch {}
  };
  const observe = (task, token) => {
    tasks.add(task);
    if (token !== undefined) taskTokens.set(task, token);
    void task
      .finally(() => {
        tasks.delete(task);
        taskTokens.delete(task);
      })
      .catch(() => {});
    return task;
  };
  const settled = async (token) => {
    while (true) {
      const pending = [...tasks].filter(
        (task) => token === undefined || taskTokens.get(task) === token,
      );
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  };
  const assertCtx = (ctx) => {
    requireValue(
      !stopped &&
        id(ctx.leaseId) &&
        id(ctx.runId) &&
        id(ctx.operationId) &&
        ctx.target &&
        id(ctx.target.browserSessionId) &&
        id(ctx.target.tabId),
      "INVALID_TARGET",
      "Native visual state needs its actual run and target.",
    );
    current(ctx);
    requireValue(
      !(closedKeys.get(key(ctx)) > Date.now()),
      "STALE_REF",
      "This visual control identity was released.",
    );
    if (browserSessionId !== undefined)
      requireValue(
        ctx.target.browserSessionId === browserSessionId,
        "STALE_REF",
      );
  };
  const page = async (record, command, ctx, extra = {}) => {
    const cleanup = command === "release" || command === "clear";
    const restoring = command === "restore";
    const marker = markers.get(record.tabId),
      passive =
        command === "result" &&
        marker?.documentId === record.documentId &&
        key(markerCtx(marker)) === record.token;
    const admit = () => {
      if (passive || restoring) {
        requireValue(!stopped, "EXTENSION_OFFLINE");
        current(ctx);
      } else assertCtx(ctx);
    };
    if (!cleanup) admit();
    if (tasks.size >= 64 && !cleanup)
      return { ok: false, reason: "VISUAL_BUSY" };
    const deadline = Math.min(ctx.deadline, Date.now() + 250);
    const target = { tabId: record.tabId, documentIds: [record.documentId] };
    const flow = (async () => {
      if (command === "move" || restoring) {
        let style = styles.get(record.tabId);
        if (style?.documentId !== record.documentId) {
          const created = {
            documentId: record.documentId,
            promise: chrome.scripting.insertCSS({ target, css: visualStyles }),
          };
          styles.set(record.tabId, created);
          // A later action may retry its own visual preparation after a real
          // native rejection. Never evict a newer document's pending style.
          void created.promise.catch(() => {
            if (styles.get(record.tabId) === created)
              styles.delete(record.tabId);
          });
          style = created;
        }
        await style.promise;
      }
      if (!cleanup) admit();
      const result = await chrome.scripting.executeScript({
        target,
        world: "ISOLATED",
        func: visualPage,
        args: [
          {
            command,
            token: record.token,
            runId: ctx.runId ?? record.runId,
            operationId: ctx.operationId ?? record.operationId,
            target: ctx.target ? { ...ctx.target } : record.target,
            deadline,
            ...extra,
          },
        ],
      });
      return result.length === 1 && result[0]?.result
        ? result[0].result
        : { ok: false, reason: "VISUAL_UNAVAILABLE" };
    })();
    observe(flow, record.token);
    let cancelTimer, onAbort;
    const bounded = new Promise((resolve) => {
      cancelTimer = timeout(deadline, () =>
        resolve({ ok: false, reason: "VISUAL_TIMEOUT" }),
      );
      onAbort = () => resolve({ ok: false, reason: "VISUAL_CANCELLED" });
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal?.aborted) onAbort();
    });
    try {
      return await Promise.race([flow, bounded]);
    } catch {
      return { ok: false, reason: "VISUAL_UNAVAILABLE" };
    } finally {
      cancelTimer();
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  };
  const getRecord = async (ctx) => {
    assertCtx(ctx);
    const token = key(ctx),
      existing = records.get(token);
    for (const [entry, expires] of closedKeys)
      if (Date.now() > expires) closedKeys.delete(entry);
    requireValue(
      !closedKeys.has(token),
      "STALE_REF",
      "This visual control identity was released.",
    );
    const tabId = nativeId(ctx.target.tabId),
      frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    assertCtx(ctx);
    requireValue(
      !closedKeys.has(token),
      "STALE_REF",
      "This visual control identity was released.",
    );
    requireValue(
      id(frame?.documentId),
      "STALE_REF",
      "The actual main document is unavailable for visual feedback.",
    );
    if (existing && existing.documentId === frame.documentId) return existing;
    const record = {
      token,
      tabId,
      documentId: frame.documentId,
      target: identity(ctx),
      leaseId: ctx.leaseId,
      runId: ctx.runId,
      operationId: ctx.operationId,
      result: false,
    };
    records.set(token, record);
    return record;
  };
  const group = async (record, ctx, tab) => {
    const groupKey = JSON.stringify([ctx.runId, tab.windowId]);
    let pending = groups.get(groupKey);
    if (tab.groupId >= 0 && !pending) return; // Existing user/shared groups are never adopted.
    if (!pending) {
      pending = (async () => {
        const latest = await chrome.tabs.get(record.tabId);
        assertCtx(ctx);
        if (latest.groupId >= 0) return null;
        const groupId = await chrome.tabs.group({
          tabIds: [record.tabId],
          createProperties: { windowId: latest.windowId },
        });
        record.groupId = groupId;
        try {
          assertCtx(ctx);
        } catch (cause) {
          const actual = await chrome.tabs.get(record.tabId);
          if (actual.groupId === groupId)
            await chrome.tabs.ungroup([record.tabId]);
          record.groupId = undefined;
          throw cause;
        }
        await chrome.tabGroups.update(groupId, {
          title: names.get(ctx.runId) || "Nexum browser",
          color: "blue",
        });
        return { id: groupId, runId: ctx.runId, windowId: latest.windowId };
      })();
      groups.set(groupKey, pending);
      void pending.catch(() => {
        if (groups.get(groupKey) === pending) groups.delete(groupKey);
      });
    }
    const owned = await pending;
    if (!owned) return;
    const latest = await chrome.tabs.get(record.tabId);
    assertCtx(ctx);
    if (latest.windowId !== owned.windowId) return;
    if (latest.groupId < 0)
      await chrome.tabs.group({ tabIds: [record.tabId], groupId: owned.id });
    if (latest.groupId < 0 || latest.groupId === owned.id)
      record.groupId = owned.id;
  };
  const beforeActionRaw = async (ctx) => {
    assertCtx(ctx);
    let record;
    try {
      record = await getRecord(ctx);
      const tab = await chrome.tabs.get(record.tabId);
      assertCtx(ctx);
      record.result = false;
      // The AI-touched identity belongs to the tab, not to this run.
      markers.set(record.tabId, {
        tabId: record.tabId,
        browserSessionId: ctx.target.browserSessionId,
        documentId: record.documentId,
        target: identity(ctx),
        leaseId: ctx.leaseId,
        runId: ctx.runId,
        operationId: ctx.operationId,
      });
      await save();
      // Grouping and the favicon use the same checked document but do not
      // depend on one another. Both must settle before a business action.
      const [result] = await Promise.all([
        page(record, "active", ctx),
        (async () => {
          await group(record, ctx, tab);
          assertCtx(ctx);
          if (ctx.followSessionTab !== false && !tab.active) {
            await chrome.tabs.update(record.tabId, { active: true });
            assertCtx(ctx);
          }
        })(),
      ]);
      if (!result.ok) {
        notice(ctx, result.reason || "VISUAL_UNAVAILABLE");
        return { degraded: true };
      }
      return { degraded: false };
    } catch (cause) {
      current(ctx);
      notice(ctx, "VISUAL_UNAVAILABLE");
      return { degraded: true };
    }
  };
  const bounded = async (ctx, perform) => {
    assertCtx(ctx);
    if (tasks.size >= 64) {
      notice(ctx, "VISUAL_BUSY");
      return { degraded: true };
    }
    const stop = new AbortController();
    const limited = {
      ...ctx,
      deadline: Math.min(ctx.deadline, Date.now() + 250),
      signal: ctx.signal
        ? AbortSignal.any([ctx.signal, stop.signal])
        : stop.signal,
    };
    const task = observe(
      Promise.resolve().then(() => perform(limited)),
      key(ctx),
    );
    let cancelTimer, onAbort;
    try {
      const status = await Promise.race([
        task,
        new Promise((resolve, reject) => {
          cancelTimer = timeout(limited.deadline, () =>
            resolve({ degraded: true }),
          );
          onAbort = () => reject(ctx.signal.reason);
          ctx.signal?.addEventListener("abort", onAbort, { once: true });
          if (ctx.signal?.aborted) onAbort();
        }),
      ]);
      if (status.degraded)
        stop.abort(new Error("Native visual preparation stopped waiting."));
      current(ctx);
      if (status.degraded) notice(ctx, "VISUAL_UNAVAILABLE");
      return status;
    } catch {
      current(ctx);
      notice(ctx, "VISUAL_UNAVAILABLE");
      return { degraded: true };
    } finally {
      cancelTimer?.();
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  };
  const beforeAction = (ctx) => bounded(ctx, beforeActionRaw);
  // tabs.new and tabs.select are visible AI actions even if no pointer moves.
  // They should not require a CDP input attachment to leave a durable marker.
  const trackTab = (ctx) =>
    bounded(ctx, async (limited) => {
      const tabId = nativeId(ctx.target.tabId);
      const tab = await chrome.tabs.get(tabId);
      assertCtx(limited);
      const frame = await chrome.webNavigation
        .getFrame({ tabId, frameId: 0 })
        .catch(() => null);
      assertCtx(limited);
      const record = {
        tabId,
        token: key(ctx),
        documentId: frame?.documentId ?? "pending",
      };
      markers.set(tabId, {
        tabId,
        browserSessionId: ctx.target.browserSessionId,
        documentId: record.documentId,
        target: identity(ctx),
        leaseId: ctx.leaseId,
        runId: ctx.runId,
        operationId: ctx.operationId,
      });
      await save();
      await group(record, limited, tab);
      if (id(frame?.documentId)) {
        const restored = await page(record, "restore", limited);
        if (!restored.ok) notice(ctx, restored.reason || "VISUAL_UNAVAILABLE");
      }
      return { degraded: false };
    });
  const beforePointer = async (ctx) => {
    assertCtx(ctx);
    requireValue(
      ctx.point &&
        Number.isFinite(ctx.point.x) &&
        Number.isFinite(ctx.point.y) &&
        Math.abs(ctx.point.x) <= 1000000 &&
        Math.abs(ctx.point.y) <= 1000000 &&
        Number.isSafeInteger(ctx.moveSequence) &&
        ctx.moveSequence >= 0,
      "INVALID_ARGUMENT",
    );
    const perform = async (limited) => {
      const status =
        (ctx.visualPrepared === true || ctx.wait === false) &&
        records.has(key(ctx))
          ? { degraded: false }
          : await beforeActionRaw(limited);
      const record = records.get(key(ctx));
      if (!record) return { degraded: true };
      const result = await page(record, "move", limited, {
        point: { x: ctx.point.x, y: ctx.point.y },
        moveSequence: ctx.moveSequence,
        // The native input already traverses the interpolated path; do not
        // run a second, out-of-sync decorative animation for each step.
        nativeStep: true,
      });
      if (!result.ok) notice(ctx, result.reason || "VISUAL_UNAVAILABLE");
      return { degraded: status.degraded || !result.ok };
    };
    if (ctx.wait === false) {
      void bounded(ctx, perform).catch(() => notice(ctx, "VISUAL_UNAVAILABLE"));
      return { degraded: false };
    }
    return await bounded(ctx, perform);
  };
  const markDeliverable = async (ctx) => {
    assertCtx(ctx);
    try {
      requireValue(
        markers.has(nativeId(ctx.target.tabId)) || markers.size < 256,
        "QUEUE_FULL",
        "The visual result marker budget is full.",
      );
      const record = await getRecord(ctx);
      const result = await page(record, "result", ctx);
      assertCtx(ctx);
      if (!result.ok) {
        notice(ctx, result.reason || "VISUAL_UNAVAILABLE");
        return { degraded: true };
      }
      record.result = true;
      markers.set(record.tabId, {
        tabId: record.tabId,
        browserSessionId: ctx.target.browserSessionId,
        documentId: record.documentId,
        target: identity(ctx),
        leaseId: ctx.leaseId,
        runId: ctx.runId,
        operationId: ctx.operationId,
      });
      await save();
      return { degraded: false };
    } catch {
      current(ctx);
      notice(ctx, "VISUAL_UNAVAILABLE");
      return { degraded: true };
    }
  };
  const forgetRun = (runId) => {
    if ([...records.values()].some((record) => record.runId === runId)) return;
    names.delete(runId);
    for (const groupKey of groups.keys())
      if (JSON.parse(groupKey)[0] === runId) groups.delete(groupKey);
  };
  const releaseTab = async (ctx) => {
    const token = key(ctx);
    if (ctx.result === true && !(closedKeys.get(token) > Date.now()))
      await markDeliverable(ctx);
    closedKeys.set(token, Number.POSITIVE_INFINITY);
    await settled(token);
    const record = records.get(token);
    if (!record) {
      closedKeys.set(token, Date.now() + 1000);
      return { degraded: false };
    }
    // Close the input identity, but leave its passive pointer and favicon
    // on any tab the AI has actually touched.
    const retained = markers.has(record.tabId);
    const status = await page(
      record,
      "release",
      { ...ctx, deadline: Date.now() + 250, signal: undefined },
      { retain: retained },
    );
    await settled(token);
    records.delete(token);
    closedKeys.set(token, Date.now() + 1000);
    const styled = styles.get(record.tabId);
    if (!retained && styled?.documentId === record.documentId) {
      styles.delete(record.tabId);
      try {
        await chrome.scripting.removeCSS({
          target: { tabId: record.tabId, documentIds: [record.documentId] },
          css: visualStyles,
        });
      } catch {
        notice(ctx, "VISUAL_UNAVAILABLE");
      }
    }
    if (!retained && record.groupId !== undefined)
      try {
        const tab = await chrome.tabs.get(record.tabId);
        if (tab.groupId === record.groupId)
          await chrome.tabs.ungroup([record.tabId]);
      } catch {
        notice(ctx, "VISUAL_GROUP_UNAVAILABLE");
      }
    forgetRun(record.runId);
    return { degraded: !status.ok };
  };
  const nameSession = async (ctx) => {
    requireValue(
      !stopped &&
        id(ctx.runId) &&
        id(ctx.leaseId) &&
        id(ctx.operationId) &&
        ctx.target &&
        id(ctx.target.browserSessionId),
      "INVALID_TARGET",
    );
    requireValue(
      typeof ctx.name === "string" &&
        ctx.name.trim().length > 0 &&
        ctx.name.length <= 120 &&
        !/[\0\r\n]/.test(ctx.name),
      "INVALID_ARGUMENT",
    );
    current(ctx);
    names.set(ctx.runId, ctx.name.trim());
    let degraded = false;
    for (const pending of groups.values())
      try {
        const value = await pending;
        if (value?.runId === ctx.runId)
          await chrome.tabGroups.update(value.id, {
            title: ctx.name.trim(),
            color: "blue",
          });
      } catch {
        degraded = true;
        notice(ctx, "VISUAL_GROUP_UNAVAILABLE");
      }
    for (const target of ctx.targets ?? [])
      await beforeAction({ ...ctx, target });
    return { degraded };
  };
  const markerCtx = (marker) => ({
    leaseId: marker.leaseId,
    runId: marker.runId,
    operationId: marker.operationId,
    target: marker.target,
    deadline: Date.now() + 250,
  });
  const start = async ({
    browserSessionId: session,
    markers: saved = [],
  } = {}) => {
    requireValue(!stopped, "EXTENSION_OFFLINE");
    if (started) return;
    started = true;
    browserSessionId = session;
    const listen = (event, fn) => {
      if (event?.addListener) {
        event.addListener(fn);
        listeners.push(() => event.removeListener(fn));
      }
    };
    // User switching tabs must not erase the AI-touched indicator.
    listen(chrome.tabs.onRemoved, (tabId) => {
      markers.delete(tabId);
      for (const [token, record] of records)
        if (record.tabId === tabId) records.delete(token);
      void save().catch(() => {});
    });
    listen(chrome.tabs.onUpdated, (tabId, change) => {
      if (change.status !== "complete") return;
      const marker = markers.get(tabId);
      if (!marker) return;
      void observe(
        (async () => {
          const frame = await chrome.webNavigation.getFrame({
            tabId,
            frameId: 0,
          });
          if (stopped || markers.get(tabId) !== marker) return;
          if (!id(frame?.documentId)) return;
          marker.documentId = frame.documentId;
          marker.target = { ...marker.target };
          delete marker.target.pageVersion;
          await page(
            {
              tabId,
              documentId: marker.documentId,
              token: key(markerCtx(marker)),
            },
            "restore",
            markerCtx(marker),
          );
          await save();
        })(),
        key(markerCtx(marker)),
      ).catch(() => {});
    });
    if (session !== undefined)
      for (const value of saved.slice(0, 256))
        if (
          value &&
          value.browserSessionId === session &&
          value.target?.browserSessionId === session &&
          id(value.documentId) &&
          id(value.target?.tabId) &&
          id(value.leaseId) &&
          id(value.runId) &&
          id(value.operationId)
        ) {
          try {
            const tabId = nativeId(value.target.tabId);
            await chrome.tabs.get(tabId); // A closed tab must never be restored.
            if (stopped) return;
            const marker = {
              ...value,
              tabId,
              target: { ...value.target },
            };
            markers.set(tabId, marker);
            const frame = await observe(
              chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
              key(markerCtx(marker)),
            );
            if (stopped) return;
            if (!id(frame?.documentId)) continue;
            marker.documentId = frame.documentId;
            await page(
              {
                tabId,
                documentId: marker.documentId,
                token: key(markerCtx(marker)),
              },
              "restore",
              markerCtx(marker),
            );
          } catch {}
        }
  };
  const dispose = () => {
    if (disposal) return disposal;
    stopped = true;
    for (const remove of listeners.splice(0)) remove();
    for (const token of [...records.keys(), ...taskTokens.values()])
      closedKeys.set(token, Number.POSITIVE_INFINITY);
    disposal = (async () => {
      await settled();
      for (const record of records.values()) {
          const retained = markers.has(record.tabId);
          await page(
            record,
            "release",
            { deadline: Date.now() + 250 },
            { retain: retained },
          );
          if (!retained && record.groupId !== undefined)
            try {
              const tab = await chrome.tabs.get(record.tabId);
              if (tab.groupId === record.groupId)
                await chrome.tabs.ungroup([record.tabId]);
            } catch {}
      }
      await settled();
      for (const [tabId, style] of styles) {
        if (markers.has(tabId)) continue;
        try {
          await chrome.scripting.removeCSS({
            target: { tabId, documentIds: [style.documentId] },
            css: visualStyles,
          });
        } catch {}
      }
      records.clear();
      closedKeys.clear();
      styles.clear();
      groups.clear();
      names.clear();
      await persistence.catch(() => {});
    })();
    void disposal.catch(() => {});
    return disposal;
  };
  return Object.freeze({
    start,
    wake() {
      for (const wake of [...wakeups]) wake();
    },
    beforeAction,
    trackTab,
    beforePointer,
    markDeliverable,
    releaseTab,
    nameSession,
    dispose,
  });
}
