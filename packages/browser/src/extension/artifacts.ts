import { mkdir, lstat, realpath, unlink, rmdir } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { types } from "node:util";
import type { Invocation } from "@nexum/extension-api";
import type {
  BrowserArtifact,
  BrowserTarget,
  PageAssetKind,
  PageAssetBundle,
} from "../client/types.js";
import { dataObject, validateTarget } from "../client/serialize.js";
import {
  materializeDownload,
  prepareFiles,
  browserFileBudget,
} from "./files.js";
import { check, failure } from "./protocol.js";

export type ArtifactSource = (
  | { data: Uint8Array | ArrayBuffer | Blob; name: string; mimeType: string }
  | { text: string; name: string; mimeType: string }
  | { path: string; name?: string; mimeType?: string; expectedSize?: number }
) & { sourceUrl?: string };
export interface AssetFileSource {
  url: string;
  name: string;
  mimeType: string;
  data: Uint8Array | ArrayBuffer | Blob;
}
export interface AssetDownloadSource {
  files: AssetFileSource[];
  failures: { url: string; reason: string }[];
}
export interface AssetBundleSource {
  inventoryId: string;
  target: BrowserTarget;
  pageUrl: string | null;
  assets: (AssetFileSource & { id: string; kind: PageAssetKind })[];
  failures: { id: string; url: string; name: string; reason: string }[];
}
const kinds = new Set([
  "other",
  "script",
  "font",
  "image",
  "stylesheet",
  "video",
]);
function current(call: Invocation): void {
  if (call.signal.aborted)
    throw failure("CANCELLED", "Browser artifact preparation was cancelled.");
  check(
    Number.isFinite(call.deadline) && Date.now() < call.deadline,
    "DEADLINE_EXCEEDED",
    "Browser artifact preparation exceeded its deadline.",
  );
}
function text(value: unknown, maximum: number, label: string): string {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= maximum &&
      !/[\0\r\n]/.test(value),
    "PROTOCOL_MISMATCH",
    `${label} must be bounded text.`,
  );
  return value;
}
function media(value: unknown): string {
  const result = text(value, 256, "An artifact MIME type");
  check(
    /^[\x20-\x7e]+$/.test(result),
    "PROTOCOL_MISMATCH",
    "Artifact MIME metadata must use media-type text.",
  );
  return result;
}
function name(value: unknown): string {
  const result = text(value, 255, "An artifact filename");
  check(
    result !== "." && result !== ".." && !/[\\/\x00-\x1f\x7f]/.test(result),
    "PROTOCOL_MISMATCH",
    "An artifact name must be a filename, not a path.",
  );
  return result;
}
function url(value: unknown): string {
  const source = text(value, 32768, "An artifact source URL");
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw failure(
      "PROTOCOL_MISMATCH",
      "An artifact source URL must be absolute.",
    );
  }
  check(
    ["http:", "https:", "blob:", "data:", "file:", "about:"].includes(
      parsed.protocol,
    ) &&
      !parsed.username &&
      !parsed.password,
    "PROTOCOL_MISMATCH",
    "An artifact source URL has an unsupported scheme or embedded credentials.",
  );
  return source;
}
function authorizeUrl(value: unknown, call: Invocation): string {
  const source = url(value);
  current(call);
  call.authorize({ type: "url", value: source, access: "read" });
  return source;
}
function array(value: unknown, maximum: number): unknown[] {
  check(
    Array.isArray(value) && !types.isProxy(value),
    "PROTOCOL_MISMATCH",
    "Artifact batches must be plain arrays.",
  );
  const count = Object.getOwnPropertyDescriptor(value, "length")!.value;
  check(
    count <= maximum,
    "OUTPUT_TOO_LARGE",
    "The artifact batch exceeds its item budget.",
  );
  const result: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const field = Object.getOwnPropertyDescriptor(value, String(i));
    check(
      field && "value" in field,
      "PROTOCOL_MISMATCH",
      "Artifact arrays cannot contain accessors or holes.",
    );
    result.push(field.value);
  }
  return result;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.isFile() && b.isFile();
}
async function removePrepared(file: {
  path: string;
  stat: BigIntStats;
}): Promise<void> {
  try {
    const actual = await lstat(file.path, { bigint: true });
    check(
      sameFile(file.stat, actual),
      "FILE_CHANGED",
      "A temporary artifact was replaced; its replacement was preserved.",
    );
    await unlink(file.path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  try {
    await rmdir(path.dirname(file.path));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

/** Only fixes already obtained content. It performs no network request or browser action. */
export async function materializeArtifact(
  source: unknown,
  call: Invocation,
  work: string,
  options: { destination?: string } = {},
): Promise<BrowserArtifact> {
  current(call);
  const item = dataObject(source, [
    "data",
    "text",
    "path",
    "name",
    "mimeType",
    "expectedSize",
    "sourceUrl",
  ]);
  const destination = dataObject(options, ["destination"]).destination;
  check(
    destination === undefined || typeof destination === "string",
    "INVALID_ARGUMENT",
    "An artifact destination must be path text.",
  );
  const count = ["data", "text", "path"].filter((key) =>
    Object.hasOwn(item, key),
  ).length;
  check(
    count === 1,
    "PROTOCOL_MISMATCH",
    "An artifact must provide exactly one native byte, text or file source.",
  );
  const sourceUrl =
    item.sourceUrl === undefined
      ? undefined
      : authorizeUrl(item.sourceUrl, call);
  const filename = item.name === undefined ? undefined : name(item.name),
    mimeType = item.mimeType === undefined ? undefined : media(item.mimeType);
  let prepared: { path: string; stat: BigIntStats } | undefined;
  let artifact: BrowserArtifact | undefined,
    committed: { path: string; stat: BigIntStats } | undefined,
    caught: unknown;
  try {
    if (Object.hasOwn(item, "path")) {
      check(
        typeof item.path === "string",
        "PROTOCOL_MISMATCH",
        "An artifact file source must be a local path.",
      );
      artifact = await materializeDownload(
        {
          path: item.path,
          name: filename,
          expectedSize: item.expectedSize as number | undefined,
          destination: destination as string | undefined,
        },
        call,
        work,
      );
      committed = {
        path: artifact.path,
        stat: await lstat(artifact.path, { bigint: true }),
      };
      if (sourceUrl !== undefined) authorizeUrl(sourceUrl, call);
      artifact = {
        ...artifact,
        ...(mimeType === undefined ? {} : { mimeType }),
      };
    } else {
      check(
        filename !== undefined && mimeType !== undefined,
        "PROTOCOL_MISMATCH",
        "Native artifact content requires an explicit name and MIME type.",
      );
      let data: Uint8Array | ArrayBuffer | Blob;
      if (Object.hasOwn(item, "text")) {
        check(
          typeof item.text === "string",
          "PROTOCOL_MISMATCH",
          "An artifact text source must be a string.",
        );
        check(
          Buffer.byteLength(item.text) <= browserFileBudget,
          "OUTPUT_TOO_LARGE",
          "The artifact text exceeds the local transport budget.",
        );
        data = Buffer.from(item.text, "utf8");
      } else data = item.data as Uint8Array | ArrayBuffer | Blob;
      const [fixed] = await prepareFiles(
        [{ data, name: filename, mimeType }],
        call,
        work,
      );
      check(
        fixed,
        "PROTOCOL_MISMATCH",
        "Native artifact preparation did not return its real file.",
      );
      prepared = {
        path: fixed.path,
        stat: await lstat(fixed.path, { bigint: true }),
      };
      artifact = await materializeDownload(
        {
          path: fixed.path,
          name: filename,
          destination: destination as string | undefined,
        },
        call,
        work,
      );
      committed = {
        path: artifact.path,
        stat: await lstat(artifact.path, { bigint: true }),
      };
      if (sourceUrl !== undefined) authorizeUrl(sourceUrl, call);
      artifact = { ...artifact, mimeType };
    }
    current(call);
  } catch (cause) {
    caught = cause;
  } finally {
    if (prepared)
      try {
        await removePrepared(prepared);
      } catch {
        caught ??= failure(
          "FILE_CLEANUP_FAILED",
          "Temporary browser artifact cleanup was not confirmed.",
        );
      }
  }
  if (caught) {
    if (committed) await removeArtifact(committed);
    throw caught;
  }
  return artifact!;
}
async function removeArtifact(file: {
  path: string;
  stat: BigIntStats;
}): Promise<void> {
  try {
    const actual = await lstat(file.path, { bigint: true });
    check(
      sameFile(file.stat, actual),
      "FILE_CHANGED",
      "An undelivered artifact was replaced; its replacement was preserved.",
    );
    await unlink(file.path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}
function reason(cause: unknown): string {
  if (cause && typeof cause === "object" && !types.isProxy(cause)) {
    const code = Object.getOwnPropertyDescriptor(cause, "code");
    if (
      code &&
      "value" in code &&
      typeof code.value === "string" &&
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code.value)
    )
      return code.value;
  }
  return "ARTIFACT_PREPARATION_FAILED";
}
function itemFailure(cause: unknown): boolean {
  // Authorization/configuration/cancellation errors remain fatal, even after a prior file succeeded.
  if (cause && typeof cause === "object" && !types.isProxy(cause)) {
    let prototype: object | null = cause;
    for (let depth = 0; prototype && depth < 64; depth++) {
      if (types.isProxy(prototype)) return false;
      const ownName = Object.getOwnPropertyDescriptor(prototype, "name"),
        constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
      const constructorName =
        constructor &&
        "value" in constructor &&
        typeof constructor.value === "function" &&
        !types.isProxy(constructor.value)
          ? Object.getOwnPropertyDescriptor(constructor.value, "name")
          : undefined;
      if (
        (ownName &&
          "value" in ownName &&
          ownName.value === "SourceConfigError") ||
        (constructorName &&
          "value" in constructorName &&
          constructorName.value === "SourceConfigError")
      )
        return false;
      prototype = Object.getPrototypeOf(prototype);
    }
  }
  return [
    "INVALID_ARGUMENT",
    "PROTOCOL_MISMATCH",
    "OUTPUT_TOO_LARGE",
    "FILE_CHANGED",
    "FILE_SIZE_MISMATCH",
    "FILE_IO_FAILED",
    "ENOENT",
    "EISDIR",
    "EACCES",
    "EPERM",
    "ENOSPC",
    "EIO",
    "EINVAL",
    "ENAMETOOLONG",
  ].includes(reason(cause));
}
function fileSource(value: unknown, call: Invocation): AssetFileSource {
  const item = dataObject(value, [
    "id",
    "kind",
    "url",
    "name",
    "mimeType",
    "data",
  ]);
  const source = authorizeUrl(item.url, call),
    filename = name(item.name),
    mimeType = media(item.mimeType);
  check(
    Object.hasOwn(item, "data"),
    "PROTOCOL_MISMATCH",
    "An asset has no actual byte payload.",
  );
  return {
    url: source,
    name: filename,
    mimeType,
    data: item.data as Uint8Array | ArrayBuffer | Blob,
  };
}
function failureSource(
  value: unknown,
  call: Invocation,
  bundle: boolean,
): { url: string; reason: string; id?: string; name?: string } {
  const item = dataObject(
    value,
    bundle ? ["id", "url", "name", "reason"] : ["url", "reason"],
  );
  return {
    url: authorizeUrl(item.url, call),
    reason: text(item.reason, 1024, "An asset failure reason"),
    ...(bundle
      ? { id: text(item.id, 256, "An asset identity"), name: name(item.name) }
      : {}),
  };
}
export async function materializeAssetDownloads(
  input: unknown,
  call: Invocation,
  work: string,
): Promise<{
  files: (BrowserArtifact & { url: string })[];
  failures: { url: string; reason: string }[];
}> {
  current(call);
  const batch = dataObject(input, ["files", "failures"]);
  const sources = array(batch.files, 1024).map((value) =>
    fileSource(value, call),
  );
  const failures = array(batch.failures, 1024).map((value) =>
    failureSource(value, call, false),
  );
  check(
    sources.length + failures.length <= 1024,
    "OUTPUT_TOO_LARGE",
    "The asset download batch exceeds its item budget.",
  );
  const files: (BrowserArtifact & { url: string })[] = [],
    committed: { path: string; stat: BigIntStats }[] = [];
  try {
    for (const source of sources) {
      try {
        const artifact = await materializeArtifact(
          {
            data: source.data,
            name: source.name,
            mimeType: source.mimeType,
            sourceUrl: source.url,
          },
          call,
          work,
        );
        committed.push({
          path: artifact.path,
          stat: await lstat(artifact.path, { bigint: true }),
        });
        files.push({ ...artifact, url: source.url });
      } catch (cause) {
        if (!itemFailure(cause)) throw cause;
        failures.push({ url: source.url, reason: reason(cause) });
      }
    }
    current(call);
    return { files, failures };
  } catch (cause) {
    for (const file of committed) await removeArtifact(file);
    throw cause;
  }
}
async function bundleDirectory(
  call: Invocation,
  work: string,
): Promise<{ path: string; stat: BigIntStats }> {
  check(
    path.isAbsolute(work),
    "INVALID_CONTEXT",
    "Browser artifacts require an absolute profile work directory.",
  );
  const run = text(call.context.runId, 128, "A browser artifact run identity");
  check(
    /^[A-Za-z0-9_-]+$/.test(run),
    "INVALID_CONTEXT",
    "A browser artifact requires the actual run identity.",
  );
  current(call);
  call.authorize({ type: "path", value: work, access: "write" });
  let parent = await realpath(work);
  call.authorize({ type: "path", value: parent, access: "write" });
  for (const segment of ["tmp", "browser", run]) {
    const next = path.join(parent, segment);
    current(call);
    call.authorize({ type: "path", value: next, access: "write" });
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    const stat = await lstat(next, { bigint: true });
    check(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (await realpath(next)) === next,
      "FILE_CHANGED",
      "The browser artifact directory was redirected.",
    );
    parent = next;
  }
  const target = path.join(parent, `${randomUUID()}-assets`);
  current(call);
  call.authorize({ type: "path", value: target, access: "write" });
  await mkdir(target, { mode: 0o700 });
  const stat = await lstat(target, { bigint: true });
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await realpath(target)) === target,
    "FILE_CHANGED",
    "The browser bundle directory was redirected.",
  );
  return { path: target, stat };
}
async function bundleCurrent(
  directory: { path: string; stat: BigIntStats },
  call: Invocation,
): Promise<void> {
  current(call);
  call.authorize({ type: "path", value: directory.path, access: "write" });
  const stat = await lstat(directory.path, { bigint: true });
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === directory.stat.dev &&
      stat.ino === directory.stat.ino &&
      (await realpath(directory.path)) === directory.path,
    "FILE_CHANGED",
    "The browser bundle directory changed during preparation.",
  );
}

export async function materializeAssetBundle(
  input: unknown,
  call: Invocation,
  work: string,
): Promise<PageAssetBundle> {
  const started = performance.now();
  current(call);
  const batch = dataObject(input, [
    "inventoryId",
    "target",
    "pageUrl",
    "assets",
    "failures",
  ]);
  const inventoryId = text(batch.inventoryId, 256, "A page inventory identity"),
    target = validateTarget(batch.target, true);
  call.authorize({
    type: "connection",
    value: target.browserId,
    access: "read",
  });
  const pageUrl =
    batch.pageUrl === null ? null : authorizeUrl(batch.pageUrl, call);
  const sources = array(batch.assets, 1024).map((value) => {
    const item = dataObject(value, [
      "id",
      "kind",
      "url",
      "name",
      "mimeType",
      "data",
    ]);
    const id = text(item.id, 256, "An asset identity");
    check(
      typeof item.kind === "string" && kinds.has(item.kind),
      "PROTOCOL_MISMATCH",
      "An asset kind is unsupported.",
    );
    return { ...fileSource(value, call), id, kind: item.kind as PageAssetKind };
  });
  const failures = array(batch.failures, 1024).map(
    (value) =>
      failureSource(value, call, true) as {
        id: string;
        url: string;
        name: string;
        reason: string;
      },
  );
  const identities = [...sources, ...failures].map((item) => item.id);
  check(
    identities.length <= 1024 && new Set(identities).size === identities.length,
    "PROTOCOL_MISMATCH",
    "A bundle must contain unique inventory asset identities within its item budget.",
  );
  const directory = await bundleDirectory(call, work),
    written: { path: string; stat: BigIntStats }[] = [];
  const assets: PageAssetBundle["assets"] = [];
  try {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!;
      await bundleCurrent(directory, call);
      const prefix = `${String(index + 1).padStart(4, "0")}-`;
      let basename = source.name;
      while (Buffer.byteLength(prefix + basename) > 255)
        basename = basename.slice(0, -1);
      const destination = path.join(directory.path, prefix + basename);
      try {
        const artifact = await materializeArtifact(
          {
            data: source.data,
            name: source.name,
            mimeType: source.mimeType,
            sourceUrl: source.url,
          },
          call,
          work,
          { destination },
        );
        written.push({
          path: artifact.path,
          stat: await lstat(artifact.path, { bigint: true }),
        });
        assets.push({
          ...artifact,
          id: source.id,
          kind: source.kind,
          url: source.url,
        });
      } catch (cause) {
        if (!itemFailure(cause)) throw cause;
        failures.push({
          id: source.id,
          url: source.url,
          name: source.name,
          reason: reason(cause),
        });
      }
    }
    await bundleCurrent(directory, call);
    if (pageUrl !== null) authorizeUrl(pageUrl, call);
    const summary = {
      requestedCount: identities.length,
      downloadedCount: assets.length,
      failedCount: failures.length,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    };
    const manifest = {
      schemaVersion: 1,
      inventoryId,
      target,
      pageUrl,
      assets: assets.map(({ path: filename, ...asset }) => ({
        ...asset,
        file: path.basename(filename),
      })),
      failures,
      summary,
    };
    const saved = await materializeArtifact(
      {
        text: JSON.stringify(manifest, null, 2) + "\n",
        name: "manifest.json",
        mimeType: "application/json",
        ...(pageUrl === null ? {} : { sourceUrl: pageUrl }),
      },
      call,
      work,
      { destination: path.join(directory.path, "manifest.json") },
    );
    written.push({
      path: saved.path,
      stat: await lstat(saved.path, { bigint: true }),
    });
    await bundleCurrent(directory, call);
    return {
      directoryPath: directory.path,
      manifestPath: saved.path,
      assets,
      failures,
      summary,
    };
  } catch (cause) {
    let cleanupFailed = false;
    for (const file of written)
      try {
        const actual = await lstat(file.path, { bigint: true });
        check(
          sameFile(file.stat, actual),
          "FILE_CHANGED",
          "An undelivered bundle member was replaced.",
        );
        await unlink(file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          cleanupFailed = true;
      }
    try {
      await rmdir(directory.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        cleanupFailed = true;
    }
    if (cleanupFailed)
      throw failure(
        "FILE_CLEANUP_FAILED",
        "Browser bundle preparation failed and its undelivered file cleanup was not confirmed.",
      );
    throw cause;
  }
}
