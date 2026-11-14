import {
  BrowserActionError,
  requireValue,
  record,
  text,
  nativeId,
} from "./errors.js";
import { readPageBytes } from "./page-data.js";
import { observeSiteSource } from "./site-source.js";

const maximum = 128 * 1024 * 1024;
// Office exports are ZIP documents: confirm their actual central-directory parts, not merely a PK prefix.
function officeArchive(data, format) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    names = new Set();
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--)
    if (
      view.getUint32(at, true) === 0x06054b50 &&
      at + 22 + view.getUint16(at + 20, true) === data.length
    ) {
      end = at;
      break;
    }
  if (
    end < 0 ||
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0
  )
    return false;
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true);
  if (
    count === 65535 ||
    count !== view.getUint16(end + 8, true) ||
    offset + size !== end
  )
    return false;
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return false;
    const length = view.getUint16(at + 28, true),
      extra = view.getUint16(at + 30, true),
      comment = view.getUint16(at + 32, true),
      next = at + 46 + length + extra + comment;
    if (next > end) return false;
    const local = view.getUint32(at + 42, true),
      compressed = view.getUint32(at + 20, true),
      flags = view.getUint16(at + 8, true),
      method = view.getUint16(at + 10, true);
    if (
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      local + 30 > offset ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 8, true) !== method
    )
      return false;
    const localName = view.getUint16(local + 26, true),
      localExtra = view.getUint16(local + 28, true);
    if (
      localName !== length ||
      local + 30 + localName + localExtra + compressed > offset
    )
      return false;
    const name = new TextDecoder().decode(
      data.subarray(at + 46, at + 46 + length),
    );
    if (
      name !==
      new TextDecoder().decode(
        data.subarray(local + 30, local + 30 + localName),
      )
    )
      return false;
    names.add(name);
    at = next;
  }
  return (
    at === end &&
    names.has("[Content_Types].xml") &&
    names.has(
      {
        docx: "word/document.xml",
        xlsx: "xl/workbook.xml",
        pptx: "ppt/presentation.xml",
      }[format],
    )
  );
}
const filename = (value, fallback = "document") => {
  let name = String(value || fallback)
    .replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, "_")
    .replace(/^\.+$/, fallback)
    .slice(0, 120);
  while (new TextEncoder().encode(name).byteLength > 180)
    name = name.slice(0, -1);
  return name || fallback;
};
const nameFromUrl = (url, fallback) => {
  try {
    return filename(
      decodeURIComponent(new URL(url).pathname.split("/").pop()),
      fallback,
    );
  } catch {
    return fallback;
  }
};
const epoch = (ctx) => ctx.lease.epochs?.get(nativeId(ctx.target.tabId));
function current(ctx, value) {
  requireValue(
    value &&
      value.tabId === ctx.target.tabId &&
      value.pageVersion === ctx.router.version(ctx.target.tabId) &&
      value.controlEpoch === epoch(ctx),
    "STALE_REF",
    "The original document-data observation is no longer current.",
  );
  return value;
}
async function fetchFile(ctx, url, token, limit = maximum, name) {
  const metadata = await ctx.router.dataPage(ctx, {
    command: "fetch",
    token,
    url,
    maxBytes: limit,
  });
  return {
    url,
    name: name ?? nameFromUrl(url, "download.bin"),
    mimeType: metadata.mimeType,
    data: await readPageBytes(ctx, token, metadata),
  };
}
export async function listAssets(ctx) {
  const inventories = (ctx.lease.assetInventories ??= new Map());
  const previous = [...inventories].filter(
    ([, value]) => value.tabId === ctx.target.tabId,
  );
  if (previous.length >= 4) {
    const [id, value] = previous[0];
    await ctx.router.dataPage(
      ctx,
      { command: "drop", token: value.token },
      true,
    );
    inventories.delete(id);
  }
  const token = crypto.randomUUID(),
    id = crypto.randomUUID();
  let complete = false;
  try {
    const tree = await ctx.router.send(ctx, "Page.getResourceTree", {}),
      resources = [];
    requireValue(
      tree.frameTree?.frame,
      "CAPABILITY_NOT_ALLOWED",
      "The native page resource tree is unavailable.",
    );
    const visit = (entry) => {
      for (const resource of entry.resources ?? []) {
        requireValue(
          resources.length < 4096,
          "OUTPUT_TOO_LARGE",
          "The native resource inventory exceeds its count budget.",
        );
        resources.push({
          url: resource.url,
          kind:
            {
              Font: "font",
              Image: "image",
              Stylesheet: "stylesheet",
              Media: "video",
              Script: "script",
            }[resource.type] ?? "other",
        });
      }
      for (const child of entry.childFrames ?? []) visit(child);
    };
    visit(tree.frameTree);
    const data = await ctx.router.dataPage(ctx, {
      command: "inventory",
      token,
      resources,
    });
    const value = {
      id,
      target: ctx.router.target(ctx.target.tabId, ctx.lease),
      ...data,
    };
    inventories.set(id, {
      token,
      tabId: ctx.target.tabId,
      pageVersion: ctx.router.version(ctx.target.tabId),
      controlEpoch: epoch(ctx),
      value,
    });
    complete = true;
    return value;
  } finally {
    if (!complete)
      await ctx.router.dataPage(ctx, { command: "drop", token }, true);
  }
}
export async function planAssets(ctx, input) {
  const options = input.options ?? input;
  text(options.inventoryId, 512);
  const inventory = current(
    ctx,
    ctx.lease.assetInventories?.get(options.inventoryId),
  );
  const checked = await ctx.router.dataPage(ctx, {
    command: "inventoryCheck",
    token: inventory.token,
  });
  requireValue(
    checked.pageUrl === inventory.value.pageUrl,
    "STALE_REF",
    "The original native inventory document URL changed.",
  );
  const ids =
    options.assetIds === undefined ? undefined : new Set(options.assetIds);
  requireValue(
    ids === undefined ||
      (Array.isArray(options.assetIds) &&
        ids.size === options.assetIds.length &&
        ids.size <= 128),
  );
  requireValue(
    options.kinds === undefined ||
      (Array.isArray(options.kinds) &&
        options.kinds.every((kind) =>
          ["font", "image", "stylesheet", "video"].includes(kind),
        )),
  );
  const assets = inventory.value.assets.filter(
    (asset) =>
      (!ids || ids.has(asset.id)) &&
      (!options.kinds || options.kinds.includes(asset.kind)),
  );
  requireValue(
    assets.length <= 128,
    "OUTPUT_TOO_LARGE",
    "Select at most 128 explicit assets for one browser bundle.",
  );
  if (ids)
    requireValue(
      [...ids].every((id) => assets.some((asset) => asset.id === id)),
      "INVALID_ARGUMENT",
      "An asset ID is absent from this exact selected inventory.",
    );
  return {
    inventoryId: options.inventoryId,
    target: inventory.value.target,
    pageUrl: inventory.value.pageUrl,
    assets: assets.map(({ id, kind, url, name }) => ({
      id,
      kind,
      url,
      name,
      embedded: /^(?:blob:|data:)/.test(url),
    })),
  };
}
export async function downloadAssets(ctx, urls) {
  requireValue(Array.isArray(urls) && urls.length <= 128);
  urls.forEach((url) => {
    text(url, 1024 * 1024);
    requireValue(/^(?:https?:|blob:|data:)/.test(url));
  });
  const files = [],
    failures = [],
    token = crypto.randomUUID();
  let total = 0;
  try {
    for (const url of urls) {
      ctx.signal?.throwIfAborted();
      try {
        const file = await fetchFile(ctx, url, token, maximum - total);
        total += file.data.byteLength;
        files.push(file);
      } catch (cause) {
        ctx.signal?.throwIfAborted();
        failures.push({
          url,
          reason:
            cause instanceof BrowserActionError
              ? cause.message
              : "The native browser response could not be exported.",
        });
      }
    }
    return { files, failures };
  } finally {
    await ctx.router.dataPage(ctx, { command: "drop", token }, true);
  }
}
export async function bundleAssets(ctx, input) {
  const plan = await planAssets(ctx, input),
    inventory = current(ctx, ctx.lease.assetInventories.get(plan.inventoryId));
  const assets = [],
    failures = [];
  let total = 0;
  for (const selected of plan.assets) {
    ctx.signal?.throwIfAborted();
    current(ctx, inventory);
    try {
      const file = await fetchFile(
        ctx,
        selected.url,
        inventory.token,
        maximum - total,
        selected.name,
      );
      total += file.data.byteLength;
      assets.push({ id: selected.id, kind: selected.kind, ...file });
    } catch (cause) {
      ctx.signal?.throwIfAborted();
      failures.push({
        id: selected.id,
        url: selected.url,
        name: selected.name,
        reason:
          cause instanceof BrowserActionError
            ? cause.message
            : "The native browser asset could not be exported.",
      });
    }
  }
  return {
    inventoryId: plan.inventoryId,
    target: plan.target,
    pageUrl: plan.pageUrl,
    assets,
    failures,
  };
}
export async function planContent(ctx, args) {
  text(args.method, 128);
  const tab = await ctx.chrome.tabs.get(nativeId(ctx.target.tabId));
  let format, source;
  if (
    ["content.exportGsuite", "content.exportYouTubeTranscript"].includes(
      args.method,
    )
  ) {
    const response = await ctx.chrome.scripting.executeScript({
      target: { tabId: nativeId(ctx.target.tabId) },
      world: "MAIN",
      func: observeSiteSource,
      args: [{ method: args.method, format: args.type }],
    });
    requireValue(
      response.length === 1 && response[0]?.result,
      "INVALID_TARGET",
      "The actual site observation produced no main-document result.",
    );
    const observed = response[0].result;
    if (!observed.ok)
      throw new BrowserActionError(observed.error.code, observed.error.message);
    source = observed.value;
    format = args.type ?? "txt";
    requireValue(
      source.pageUrl === tab.url,
      "STALE_REF",
      "The current site document changed during source observation.",
    );
  } else if (
    [
      "cua.downloadMedia",
      "dom.downloadMedia",
      "locator.downloadMedia",
    ].includes(args.method)
  ) {
    const input = args.options ?? args;
    source = {
      kind: "media",
      ...(await ctx.router.page(ctx, {
        ...args,
        ...input,
        nodeId: input.node_id,
        command: "mediaSource",
      })),
      framePath: args.locator?.framePath ?? [],
    };
    format = "media";
  } else {
    requireValue(
      ["tab.exportFile", "content.export"].includes(args.method),
      "CAPABILITY_NOT_ALLOWED",
      "This native content source has no export adapter.",
    );
    format = args.method === "content.export" ? "html" : args.options?.format;
    requireValue(["pdf", "html", "markdown"].includes(format));
  }
  const plans = (ctx.lease.contentPlans ??= new Map());
  while (plans.size >= 16) plans.delete(plans.keys().next().value);
  const id = crypto.randomUUID();
  plans.set(id, {
    tabId: ctx.target.tabId,
    pageVersion: ctx.router.version(ctx.target.tabId),
    controlEpoch: epoch(ctx),
    method: args.method,
    format,
    url: tab.url,
    title: tab.title,
    source,
  });
  return { id, urls: source?.url ? [source.url] : [], sourceUrl: tab.url };
}
export async function exportContent(ctx, args) {
  text(args.planId, 512);
  const plan = current(ctx, ctx.lease.contentPlans?.get(args.planId));
  requireValue(
    plan.method === ctx.method,
    "INVALID_ARGUMENT",
    "The export plan belongs to another content method.",
  );
  const tab = await ctx.chrome.tabs.get(nativeId(ctx.target.tabId));
  requireValue(
    tab.url === plan.url,
    "STALE_REF",
    "The authorized source document changed before export.",
  );
  if (plan.source) {
    const source = plan.source;
    if (source.kind === "transcript-dom")
      return {
        text: source.text,
        name: `${filename(source.title)}.txt`,
        mimeType: "text/plain;charset=utf-8",
        sourceUrl: plan.url,
      };
    if (source.kind === "media") {
      const observed = await ctx.router.page(ctx, {
        framePath: source.framePath,
        ref: source.ref,
        command: "mediaSource",
      });
      requireValue(
        observed.url === source.url,
        "STALE_REF",
        "The observed media source changed after its URL was authorized.",
      );
    }
    const token = crypto.randomUUID();
    try {
      const file = await fetchFile(ctx, source.url, token);
      if (source.kind === "transcript-track") {
        const converted = await ctx.router.dataPage(ctx, {
          command: "transcript",
          token,
        });
        return {
          data: await readPageBytes(ctx, token, converted),
          name: `${filename(source.title)}.txt`,
          mimeType: converted.mimeType,
          sourceUrl: source.url,
        };
      }
      if (source.kind === "gsuite") {
        const expected = {
          pdf: "application/pdf",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          csv: "text/csv",
          md: "text/markdown",
        }[plan.format];
        const signature = new TextDecoder().decode(file.data.subarray(0, 8));
        requireValue(
          plan.format === "pdf"
            ? signature.startsWith("%PDF-")
            : ["docx", "xlsx", "pptx"].includes(plan.format)
              ? officeArchive(file.data, plan.format)
              : !/^\s*</.test(
                  new TextDecoder().decode(file.data.subarray(0, 512)),
                ) &&
                (plan.format === "csv"
                  ? /^text\/csv(?:;|$)/i.test(file.mimeType)
                  : /^text\/(?:markdown|plain)(?:;|$)/i.test(file.mimeType)),
          "FILE_UNAVAILABLE",
          "The browser returned no actual document in the requested Google Workspace format.",
        );
        return {
          data: file.data,
          name: `${filename(source.title)}.${plan.format}`,
          mimeType: expected,
          sourceUrl: source.url,
        };
      }
      return {
        data: file.data,
        name: file.name,
        mimeType: file.mimeType,
        sourceUrl: source.url,
      };
    } finally {
      await ctx.router.dataPage(ctx, { command: "drop", token }, true);
    }
  }
  if (plan.format === "pdf") {
    const response = await ctx.router.send(ctx, "Page.printToPDF", {
      printBackground: true,
      transferMode: "ReturnAsStream",
    });
    text(response.stream, 1024);
    const chunks = [];
    let total = 0;
    try {
      await ctx.router.trackNativeStream(ctx, response.stream);
      while (true) {
        ctx.signal?.throwIfAborted();
        const value = await ctx.router.send(ctx, "IO.read", {
          handle: response.stream,
          size: 65536,
        });
        requireValue(
          typeof value.data === "string" && value.data.length <= 90000,
          "OUTPUT_TOO_LARGE",
          "The native PDF stream chunk exceeds its byte budget.",
        );
        const raw = value.base64Encoded ? atob(value.data) : value.data;
        const bytes = value.base64Encoded
          ? Uint8Array.from(raw, (character) => character.charCodeAt(0))
          : new TextEncoder().encode(raw);
        total += bytes.byteLength;
        requireValue(
          total <= maximum,
          "OUTPUT_TOO_LARGE",
          "The native PDF exceeds its export byte budget.",
        );
        chunks.push(bytes);
        if (value.eof) break;
      }
    } finally {
      await ctx.router.closeNativeStream(ctx, response.stream);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    requireValue(
      data.length >= 5 &&
        new TextDecoder().decode(data.subarray(0, 5)) === "%PDF-",
      "FILE_UNAVAILABLE",
      "The browser did not produce a native PDF document.",
    );
    return {
      data,
      mimeType: "application/pdf",
      name: `${filename(plan.title)}.pdf`,
      sourceUrl: plan.url,
    };
  }
  // Markdown conversion is owned by the approved Node HTML-to-Markdown adapter; raw HTML remains a truthful native source.
  requireValue(["html", "markdown"].includes(plan.format));
  const token = crypto.randomUUID();
  try {
    const metadata = await ctx.router.dataPage(ctx, {
      command: "export",
      format: "html",
      token,
    });
    requireValue(
      metadata.url === plan.url,
      "STALE_REF",
      "The native source document changed during extraction.",
    );
    return {
      text: new TextDecoder().decode(await readPageBytes(ctx, token, metadata)),
      mimeType: "text/html",
      name: `${filename(plan.title)}.html`,
      sourceUrl: plan.url,
    };
  } finally {
    await ctx.router.dataPage(ctx, { command: "drop", token }, true);
  }
}
