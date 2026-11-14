import { requireValue } from "./errors.js";

const maximumBytes = 128 * 1024 * 1024;
const chunkBytes = 16384;
const encode = new TextEncoder();
const decode = new TextDecoder();

/** Native browser clipboard API, serialized into this extension's isolated page world. */
export async function clipboardCommand(input) {
  const check = (
    condition,
    code = "INVALID_ARGUMENT",
    message = "The clipboard request is invalid.",
  ) => {
    if (!condition) throw Object.assign(new Error(message), { code });
  };
  const maximum = 128 * 1024 * 1024;
  try {
    const slot = Symbol.for("nexum.browser.clipboard.v1");
    let state = globalThis[slot];
    if (input.command === "drop") {
      if (
        state?.document === document &&
        state.entries.get(input.token)?.leaseId === input.leaseId
      )
        state.entries.delete(input.token);
      return { ok: true, value: null };
    }
    if (!state || state.document !== document) {
      state = { document, entries: new Map() };
      Object.defineProperty(globalThis, slot, {
        configurable: true,
        value: state,
      });
    }
    const size = () =>
      [...state.entries.values()].reduce(
        (total, entry) => total + entry.size,
        0,
      );
    let stage = state.entries.get(input.token);
    if (input.command === "read" || input.command === "prepare") {
      check(
        !stage && state.entries.size < 8,
        "QUEUE_FULL",
        "The browser clipboard staging budget is full.",
      );
      const items = [];
      let total = 0;
      if (input.command === "read") {
        check(
          typeof navigator.clipboard?.read === "function",
          "CAPABILITY_NOT_ALLOWED",
          "This browser does not expose native multi-format clipboard reading.",
        );
        const nativeItems = await navigator.clipboard.read();
        check(
          nativeItems.length <= 16,
          "OUTPUT_TOO_LARGE",
          "The clipboard has too many native items.",
        );
        for (const item of nativeItems) {
          if (item.types.length === 0) continue;
          check(
            item.types.length <= 64,
            "OUTPUT_TOO_LARGE",
            "The clipboard item has too many formats.",
          );
          const entries = [];
          for (const mimeType of item.types) {
            const blob = await item.getType(mimeType);
            total += blob.size;
            check(
              total <= maximum,
              "OUTPUT_TOO_LARGE",
              "The clipboard exceeds its byte budget.",
            );
            entries.push({ mimeType, size: blob.size, blob });
          }
          items.push({
            entries,
            presentationStyle: item.presentationStyle ?? "unspecified",
          });
        }
      } else {
        check(
          typeof navigator.clipboard?.write === "function" &&
            typeof ClipboardItem === "function",
          "CAPABILITY_NOT_ALLOWED",
          "This browser does not expose native multi-format clipboard writing.",
        );
        check(
          Array.isArray(input.items) &&
            input.items.length > 0 &&
            input.items.length <= 16,
        );
        for (const item of input.items) {
          check(
            Array.isArray(item.entries) &&
              item.entries.length > 0 &&
              item.entries.length <= 64,
          );
          const seen = new Set(),
            entries = [];
          for (const entry of item.entries) {
            check(
              typeof entry.mimeType === "string" &&
                entry.mimeType.length > 0 &&
                entry.mimeType.length <= 256 &&
                !seen.has(entry.mimeType),
            );
            seen.add(entry.mimeType);
            check(
              Number.isSafeInteger(entry.size) &&
                entry.size >= 0 &&
                entry.size <= maximum,
            );
            total += entry.size;
            check(
              total <= maximum,
              "OUTPUT_TOO_LARGE",
              "The clipboard exceeds its byte budget.",
            );
            entries.push({
              mimeType: entry.mimeType,
              size: entry.size,
              bytes: null,
              written: 0,
            });
          }
          check(
            ["unspecified", "inline", "attachment"].includes(
              item.presentationStyle ?? "unspecified",
            ),
          );
          items.push({
            entries,
            presentationStyle: item.presentationStyle ?? "unspecified",
          });
        }
      }
      check(
        size() + total <= maximum,
        "QUEUE_FULL",
        "The browser clipboard staging byte budget is full.",
      );
      if (input.command === "prepare")
        for (const item of items)
          for (const entry of item.entries)
            entry.bytes = new Uint8Array(entry.size);
      stage = {
        leaseId: input.leaseId,
        pageVersion: input.pageVersion,
        items,
        size: total,
      };
      state.entries.set(input.token, stage);
      return {
        ok: true,
        value: items.map((item) => ({
          presentationStyle: item.presentationStyle,
          entries: item.entries.map(({ mimeType, size }) => ({
            mimeType,
            size,
          })),
        })),
      };
    }
    check(
      stage &&
        stage.leaseId === input.leaseId &&
        stage.pageVersion === input.pageVersion,
      "STALE_REF",
      "The original clipboard staging document is no longer current.",
    );
    if (input.command === "commit") {
      const items = stage.items.map((item) => {
        const formats = Object.create(null);
        for (const entry of item.entries) {
          check(entry.bytes && entry.written === entry.size);
          formats[entry.mimeType] = new Blob([entry.bytes], {
            type: entry.mimeType,
          });
        }
        return new ClipboardItem(formats, {
          presentationStyle: item.presentationStyle,
        });
      });
      await navigator.clipboard.write(items);
      return { ok: true, value: null };
    }
    const entry = stage.items[input.item]?.entries[input.entry];
    check(
      entry &&
        Number.isSafeInteger(input.offset) &&
        input.offset >= 0 &&
        input.offset <= entry.size,
    );
    if (input.command === "chunk") {
      check(
        entry.blob &&
          Number.isSafeInteger(input.length) &&
          input.length >= 0 &&
          input.length <= 16384 &&
          input.offset + input.length <= entry.size,
      );
      const bytes = new Uint8Array(
        await entry.blob
          .slice(input.offset, input.offset + input.length)
          .arrayBuffer(),
      );
      return { ok: true, value: Array.from(bytes) };
    }
    if (input.command === "append") {
      check(
        entry.bytes &&
          entry.written === input.offset &&
          Array.isArray(input.bytes) &&
          input.bytes.length <= 16384 &&
          input.offset + input.bytes.length <= entry.size &&
          input.bytes.every(
            (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
          ),
      );
      entry.bytes.set(input.bytes, input.offset);
      entry.written += input.bytes.length;
      return { ok: true, value: null };
    }
    check(false);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code:
          typeof cause?.code === "string"
            ? cause.code
            : cause?.name === "NotAllowedError"
              ? "PERMISSION_DENIED"
              : "INVALID_ARGUMENT",
        message:
          typeof cause?.code === "string"
            ? cause.message
            : "The browser rejected the native clipboard operation.",
      },
    };
  }
}

function nativeBytes(value) {
  requireValue(value instanceof Uint8Array || value instanceof ArrayBuffer);
  const view =
    value instanceof Uint8Array
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
  requireValue(
    view.byteLength <= maximumBytes,
    "OUTPUT_TOO_LARGE",
    "The clipboard entry exceeds its byte budget.",
  );
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}
function prepared(items) {
  requireValue(Array.isArray(items) && items.length > 0 && items.length <= 16);
  let total = 0;
  return items.map((item) => {
    requireValue(
      Array.isArray(item.entries) &&
        item.entries.length > 0 &&
        item.entries.length <= 64,
    );
    const seen = new Set();
    const entries = item.entries.map((entry) => {
      requireValue(
        typeof entry.mimeType === "string" &&
          /^[\x20-\x7e]{1,256}$/.test(entry.mimeType) &&
          !seen.has(entry.mimeType),
      );
      seen.add(entry.mimeType);
      requireValue((entry.text !== undefined) !== (entry.data !== undefined));
      const data =
        entry.text === undefined
          ? nativeBytes(entry.data)
          : (requireValue(typeof entry.text === "string"),
            encode.encode(entry.text));
      total += data.byteLength;
      requireValue(
        total <= maximumBytes,
        "OUTPUT_TOO_LARGE",
        "The clipboard exceeds its byte budget.",
      );
      return { mimeType: entry.mimeType, data };
    });
    requireValue(
      ["unspecified", "inline", "attachment"].includes(
        item.presentationStyle ?? "unspecified",
      ),
    );
    return {
      entries,
      presentationStyle: item.presentationStyle ?? "unspecified",
    };
  });
}
export async function readClipboard(ctx) {
  const token = crypto.randomUUID();
  try {
    const metadata = await ctx.router.clipboardPage(ctx, {
      command: "read",
      token,
    });
    requireValue(Array.isArray(metadata) && metadata.length <= 16);
    let total = 0;
    const result = [];
    for (const [item, descriptor] of metadata.entries()) {
      const entries = [];
      for (const [entry, source] of descriptor.entries.entries()) {
        requireValue(Number.isSafeInteger(source.size) && source.size >= 0);
        total += source.size;
        requireValue(
          total <= maximumBytes,
          "OUTPUT_TOO_LARGE",
          "The clipboard exceeds its byte budget.",
        );
        const data = new Uint8Array(source.size);
        for (let offset = 0; offset < data.length; offset += chunkBytes) {
          const length = Math.min(chunkBytes, data.length - offset),
            bytes = await ctx.router.clipboardPage(ctx, {
              command: "chunk",
              token,
              item,
              entry,
              offset,
              length,
            });
          requireValue(
            Array.isArray(bytes) &&
              bytes.length === length &&
              bytes.every(
                (value) =>
                  Number.isInteger(value) && value >= 0 && value <= 255,
              ),
          );
          data.set(bytes, offset);
        }
        entries.push(
          source.mimeType.startsWith("text/")
            ? { mimeType: source.mimeType, text: decode.decode(data) }
            : { mimeType: source.mimeType, data },
        );
      }
      result.push({ presentationStyle: descriptor.presentationStyle, entries });
    }
    return result;
  } finally {
    await ctx.router.clipboardPage(ctx, { command: "drop", token }, true);
  }
}
export async function writeClipboard(ctx, input) {
  const items = prepared(input),
    token = crypto.randomUUID();
  try {
    await ctx.router.clipboardPage(ctx, {
      command: "prepare",
      token,
      items: items.map((item) => ({
        presentationStyle: item.presentationStyle,
        entries: item.entries.map(({ mimeType, data }) => ({
          mimeType,
          size: data.byteLength,
        })),
      })),
    });
    for (const [item, descriptor] of items.entries())
      for (const [entry, source] of descriptor.entries.entries())
        for (
          let offset = 0;
          offset < source.data.length;
          offset += chunkBytes
        ) {
          await ctx.router.clipboardPage(ctx, {
            command: "append",
            token,
            item,
            entry,
            offset,
            bytes: Array.from(
              source.data.subarray(offset, offset + chunkBytes),
            ),
          });
        }
    await ctx.router.clipboardPage(ctx, { command: "commit", token });
  } finally {
    await ctx.router.clipboardPage(ctx, { command: "drop", token }, true);
  }
}
