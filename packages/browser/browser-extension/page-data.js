import { requireValue } from "./errors.js";

/** Serialized into the actual document's isolated world; network reads retain its browser credentials and CORS policy. */
export async function pageDataCommand(input) {
  const check = (
    condition,
    code = "INVALID_ARGUMENT",
    message = "The browser data request is invalid.",
  ) => {
    if (!condition) throw Object.assign(new Error(message), { code });
  };
  const maximum = 128 * 1024 * 1024;
  const filename = (url, fallback) => {
    let name;
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop());
    } catch {}
    return (name || fallback)
      .replace(/[\\/\x00-\x1f\x7f]/g, "_")
      .slice(0, 180)
      .replace(/^\.+$/, "asset");
  };
  try {
    const slot = Symbol.for("nexum.browser.data.v1");
    let state = globalThis[slot];
    if (!state || state.document !== document) {
      state = { document, stages: new Map(), cancelled: new Map() };
      Object.defineProperty(globalThis, slot, {
        configurable: true,
        value: state,
      });
    }
    let stage = state.stages.get(input.token);
    if (input.command === "cancel") {
      state.cancelled.set(input.token, input.leaseId);
      while (state.cancelled.size > 128)
        state.cancelled.delete(state.cancelled.keys().next().value);
      if (stage?.leaseId === input.leaseId) stage.controller?.abort();
      return { ok: true, value: null };
    }
    if (input.command === "drop") {
      if (stage?.leaseId === input.leaseId) {
        stage.controller?.abort();
        for (const url of stage.objectUrls ?? []) URL.revokeObjectURL(url);
        state.stages.delete(input.token);
      }
      if (state.cancelled.get(input.token) === input.leaseId)
        state.cancelled.delete(input.token);
      return { ok: true, value: null };
    }
    check(
      state.cancelled.get(input.token) !== input.leaseId,
      "CANCELLED",
      "The original browser data request was cancelled.",
    );
    if (!stage) {
      check(
        ["inventory", "fetch", "export"].includes(input.command),
        "STALE_REF",
        "The original native document data is no longer available.",
      );
      check(
        state.stages.size < 16,
        "QUEUE_FULL",
        "The document's native data staging budget is full.",
      );
      stage = {
        leaseId: input.leaseId,
        pageVersion: input.pageVersion,
        objectUrls: [],
        objectBytes: 0,
      };
      state.stages.set(input.token, stage);
    }
    check(
      stage.leaseId === input.leaseId &&
        stage.pageVersion === input.pageVersion,
      "STALE_REF",
      "The original browser-data document is no longer current.",
    );
    if (input.command === "inventoryCheck") {
      check(
        stage.inventory,
        "STALE_REF",
        "The original native page inventory is no longer available.",
      );
      return { ok: true, value: { pageUrl: location.href } };
    }
    if (input.command === "chunk") {
      check(
        stage.blob &&
          Number.isSafeInteger(input.offset) &&
          input.offset >= 0 &&
          Number.isInteger(input.length) &&
          input.length >= 0 &&
          input.length <= 16384 &&
          input.offset + input.length <= stage.blob.size,
      );
      return {
        ok: true,
        value: Array.from(
          new Uint8Array(
            await stage.blob
              .slice(input.offset, input.offset + input.length)
              .arrayBuffer(),
          ),
        ),
      };
    }
    if (input.command === "export") {
      check(["html", "text"].includes(input.format));
      const copy =
        input.format === "html"
          ? document.documentElement.cloneNode(true)
          : null;
      if (copy)
        for (const node of copy.querySelectorAll(
          '[data-nexum-visual-layer="v1"],[data-nexum-visual-icon="v1"]',
        ))
          node.remove();
      const value =
        input.format === "html"
          ? `${document.doctype ? "<!DOCTYPE html>\n" : ""}${copy.outerHTML}`
          : (document.body?.innerText ??
            document.documentElement.textContent ??
            "");
      const blob = new Blob([value], {
        type:
          input.format === "html"
            ? "text/html;charset=utf-8"
            : "text/plain;charset=utf-8",
      });
      check(
        blob.size <= maximum,
        "OUTPUT_TOO_LARGE",
        "The exported document exceeds its byte budget.",
      );
      stage.blob = blob;
      return {
        ok: true,
        value: {
          size: blob.size,
          mimeType: blob.type,
          url: location.href,
          title: document.title,
        },
      };
    }
    if (input.command === "transcript") {
      check(
        stage.blob &&
          stage.blob.size > 0 &&
          stage.blob.size <= 16 * 1024 * 1024,
        "FILE_UNAVAILABLE",
        "The actual caption response is empty or exceeds its transcript budget.",
      );
      const raw = await stage.blob.text();
      let lines;
      if (raw.trimStart().startsWith("{")) {
        const value = JSON.parse(raw);
        check(
          Array.isArray(value.events) && value.events.length <= 20000,
          "FILE_UNAVAILABLE",
          "The caption response has no timed transcript events.",
        );
        lines = value.events
          .map((event) =>
            (event.segs ?? [])
              .map((segment) => segment.utf8 ?? "")
              .join("")
              .trim(),
          )
          .filter(Boolean);
      } else {
        const xml = new DOMParser().parseFromString(raw, "text/xml");
        check(
          !xml.querySelector("parsererror"),
          "FILE_UNAVAILABLE",
          "The caption response is not readable timed text.",
        );
        const nodes = [...xml.querySelectorAll("text,p")];
        check(
          nodes.length > 0 && nodes.length <= 20000,
          "FILE_UNAVAILABLE",
          "The caption response has no timed text segments.",
        );
        lines = nodes.map((node) => node.textContent.trim()).filter(Boolean);
      }
      check(
        lines.length > 0,
        "FILE_UNAVAILABLE",
        "The actual caption response contains no transcript text.",
      );
      stage.blob = new Blob([lines.join("\n")], {
        type: "text/plain;charset=utf-8",
      });
      check(stage.blob.size <= 16 * 1024 * 1024, "OUTPUT_TOO_LARGE");
      return {
        ok: true,
        value: {
          size: stage.blob.size,
          mimeType: stage.blob.type,
          url: location.href,
        },
      };
    }
    if (input.command === "inventory") {
      const assets = [],
        byUrl = new Map(),
        inlineSvgs = [],
        ownedUrls = new Set(
          [...document.querySelectorAll('[data-nexum-visual-icon="v1"]')]
            .map((node) => node.href)
            .filter(Boolean),
        );
      const classify = (url, hint) =>
        ["font", "image", "stylesheet", "video", "script"].includes(hint)
          ? hint
          : /\.(?:woff2?|ttf|otf)(?:[?#]|$)/i.test(url)
            ? "font"
            : /\.(?:png|jpe?g|gif|webp|svg|avif|ico)(?:[?#]|$)/i.test(url)
              ? "image"
              : /\.css(?:[?#]|$)/i.test(url)
                ? "stylesheet"
                : /\.(?:mp4|webm|mov|m3u8)(?:[?#]|$)/i.test(url)
                  ? "video"
                  : /\.m?js(?:[?#]|$)/i.test(url)
                    ? "script"
                    : "other";
      const add = (raw, hint, source) => {
        if (typeof raw !== "string" || !raw) return;
        let url;
        try {
          url = new URL(raw, document.baseURI).href;
        } catch {
          return;
        }
        if (!/^(?:https?:|blob:|data:)/.test(url)) return;
        if (ownedUrls.has(url)) return;
        let asset = byUrl.get(url);
        if (!asset) {
          check(
            assets.length < 4096,
            "OUTPUT_TOO_LARGE",
            "The page asset count exceeds its inventory budget.",
          );
          asset = {
            id: `asset_${assets.length + 1}`,
            kind: classify(url, hint),
            name: filename(url, `asset_${assets.length + 1}`),
            url,
            sources: [],
          };
          byUrl.set(url, asset);
          assets.push(asset);
        }
        if (asset.kind === "other" && classify(url, hint) !== "other")
          asset.kind = classify(url, hint);
        if (
          source &&
          asset.sources.length < 16 &&
          !asset.sources.some(
            (entry) =>
              entry.kind === source.kind && entry.property === source.property,
          )
        )
          asset.sources.push(source);
      };
      const nodes = document.querySelectorAll("*");
      check(
        nodes.length <= 20000,
        "OUTPUT_TOO_LARGE",
        "The current page exceeds the asset-observation node budget.",
      );
      for (const node of nodes) {
        if (
          node.closest?.(
            '[data-nexum-visual-layer="v1"],[data-nexum-visual-icon="v1"]',
          )
        )
          continue;
        const tag = node.tagName;
        for (const attribute of ["src", "poster", "href"]) {
          if (attribute === "href" && tag !== "LINK") continue;
          const hint =
            tag === "SCRIPT"
              ? "script"
              : tag === "VIDEO" || tag === "SOURCE"
                ? "video"
                : tag === "LINK" && /stylesheet/i.test(node.rel ?? "")
                  ? "stylesheet"
                  : tag === "IMG" || attribute === "poster"
                    ? "image"
                    : undefined;
          add(node.getAttribute(attribute), hint, {
            kind: "attribute",
            property: attribute,
          });
        }
        if (node.currentSrc)
          add(node.currentSrc, tag === "VIDEO" ? "video" : "image", {
            kind: "attribute",
            property: "currentSrc",
          });
        const style = getComputedStyle(node);
        for (const property of [
          "background-image",
          "border-image-source",
          "mask-image",
          "list-style-image",
        ])
          for (const match of style
            .getPropertyValue(property)
            .matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g))
            add(match[1] ?? match[2] ?? match[3], "image", {
              kind: "computedStyle",
              property,
            });
        if (tag === "svg" || tag === "SVG") {
          const markup = node.outerHTML;
          check(
            new TextEncoder().encode(markup).byteLength <= 1024 * 1024,
            "OUTPUT_TOO_LARGE",
            "An inline SVG exceeds its export budget.",
          );
          const blob = new Blob([markup], { type: "image/svg+xml" }),
            url = URL.createObjectURL(blob);
          stage.objectUrls.push(url);
          stage.objectBytes += blob.size;
          check(
            stage.objectBytes <= maximum,
            "OUTPUT_TOO_LARGE",
            "The inline asset bytes exceed their inventory budget.",
          );
          add(url, "image", { kind: "attribute", property: "outerHTML" });
          const asset = byUrl.get(url);
          asset.name = `${asset.id}.svg`;
          inlineSvgs.push({ id: asset.id, markup, name: asset.name });
        }
      }
      for (const resource of input.resources ?? [])
        add(resource.url, resource.kind, { kind: "resource" });
      for (const resource of performance.getEntriesByType("resource"))
        add(
          resource.name,
          resource.initiatorType === "img"
            ? "image"
            : resource.initiatorType === "script"
              ? "script"
              : undefined,
          { kind: "resource" },
        );
      for (const asset of assets)
        if (asset.url.startsWith("data:")) {
          check(
            asset.url.length <= Math.ceil((maximum * 4) / 3) + 4096,
            "OUTPUT_TOO_LARGE",
            "An embedded asset exceeds its byte budget.",
          );
          const response = await fetch(asset.url),
            blob = await response.blob();
          check(
            stage.objectBytes + blob.size <= maximum,
            "OUTPUT_TOO_LARGE",
            "The embedded asset bytes exceed their inventory budget.",
          );
          const url = URL.createObjectURL(blob);
          stage.objectUrls.push(url);
          stage.objectBytes += blob.size;
          asset.url = url;
        }
      const summary = {
        byKind: {},
        inlineSvgCount: inlineSvgs.length,
        totalCount: assets.length,
      };
      for (const asset of assets)
        summary.byKind[asset.kind] = (summary.byKind[asset.kind] ?? 0) + 1;
      const value = { assets, inlineSvgs, pageUrl: location.href, summary };
      check(
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
          1024 * 1024,
        "OUTPUT_TOO_LARGE",
        "The page inventory exceeds its metadata budget.",
      );
      stage.inventory = value;
      return { ok: true, value };
    }
    if (input.command === "fetch") {
      check(
        typeof input.url === "string" &&
          /^(?:https?:|blob:|data:)/.test(input.url),
      );
      const limit = Math.min(input.maxBytes ?? maximum, maximum);
      check(Number.isSafeInteger(limit) && limit >= 0);
      const controller = new AbortController();
      stage.controller = controller;
      if (state.cancelled.get(input.token) === input.leaseId)
        controller.abort();
      const response = await fetch(input.url, {
        credentials: "include",
        redirect: "error",
        signal: controller.signal,
      });
      check(
        response.ok && response.type !== "opaque",
        "FILE_UNAVAILABLE",
        "The browser could not read the requested native response.",
      );
      const declared = Number(response.headers.get("content-length"));
      check(
        !Number.isFinite(declared) || declared <= limit,
        "OUTPUT_TOO_LARGE",
        "The browser response exceeds its declared byte budget.",
      );
      const chunks = [],
        reader = response.body?.getReader();
      let total = 0;
      try {
        if (reader)
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            check(
              total <= limit,
              "OUTPUT_TOO_LARGE",
              "The browser response exceeds its byte budget.",
            );
            chunks.push(next.value);
          }
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      const mimeType =
        response.headers.get("content-type")?.slice(0, 256) ||
        "application/octet-stream";
      stage.blob = new Blob(chunks, { type: mimeType });
      stage.controller = undefined;
      return {
        ok: true,
        value: { size: total, mimeType, url: response.url || input.url },
      };
    }
    check(false);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code:
          typeof cause?.code === "string"
            ? cause.code
            : cause?.name === "AbortError"
              ? "CANCELLED"
              : "FILE_UNAVAILABLE",
        message:
          typeof cause?.code === "string"
            ? cause.message
            : "The browser rejected the native document-data operation.",
      },
    };
  }
}

export async function readPageBytes(ctx, token, metadata) {
  requireValue(
    Number.isSafeInteger(metadata.size) &&
      metadata.size >= 0 &&
      metadata.size <= 128 * 1024 * 1024,
    "OUTPUT_TOO_LARGE",
    "The native document bytes exceed their transfer budget.",
  );
  const data = new Uint8Array(metadata.size);
  for (let offset = 0; offset < data.length; offset += 16384) {
    const length = Math.min(16384, data.length - offset),
      bytes = await ctx.router.dataPage(ctx, {
        command: "chunk",
        token,
        offset,
        length,
      });
    requireValue(
      Array.isArray(bytes) &&
        bytes.length === length &&
        bytes.every(
          (value) => Number.isInteger(value) && value >= 0 && value <= 255,
        ),
      "PROTOCOL_MISMATCH",
      "The native document byte chunk was invalid.",
    );
    data.set(bytes, offset);
  }
  return data;
}
