import { types, MIMEType } from "node:util";
import { Readable, addAbortSignal } from "node:stream";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { fileTypeFromBuffer } from "file-type";
import { imageSize } from "image-size";
import { parseStream, TrackType, type IAudioMetadata } from "music-metadata";
import { AgentError, requireCondition } from "../contracts/errors.js";

export interface MediaOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
  readonly maxPixels?: number;
  readonly maxDurationSeconds?: number;
  readonly maxMetadataBytes?: number;
}
export interface MediaInfo {
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
}

const viewPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const viewBuffer = Object.getOwnPropertyDescriptor(
  viewPrototype,
  "buffer",
)!.get!;
const viewOffset = Object.getOwnPropertyDescriptor(
  viewPrototype,
  "byteOffset",
)!.get!;
const viewLength = Object.getOwnPropertyDescriptor(
  viewPrototype,
  "byteLength",
)!.get!;
const dataViewLength = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteLength",
)!.get!;
const subarray = Uint8Array.prototype.subarray;
const setBytes = Uint8Array.prototype.set;
const aliases: Readonly<Record<string, string>> = Object.freeze({
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-flac": "audio/flac",
  "audio/x-aiff": "audio/aiff",
  "audio/x-m4a": "audio/mp4",
  "audio/mp3": "audio/mpeg",
});
const normalizeMime = (value: string): string => {
  try {
    requireCondition(
      typeof value === "string" &&
        value.length > 0 &&
        value.length <= 256 &&
        !/[\0\r\n]/.test(value),
      "invalid_media_mime_type",
      "A media MIME type must be bounded valid media-type text.",
    );
    const essence = new MIMEType(value).essence;
    return aliases[essence] ?? essence;
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw new AgentError(
      "invalid_media_mime_type",
      "The declared media MIME type is invalid.",
      undefined,
      { cause },
    );
  }
};

/**
 * Reads bounded format metadata, without decoding image pixels/audio samples.
 * The caller supplies an already-fixed native byte view. Detector confidence is
 * not a guarantee that every frame is decodable by a particular MCP Host.
 */
export async function validateMedia(
  data: Uint8Array,
  kind: "image" | "audio",
  hintedMime?: string,
  options: MediaOptions = {},
): Promise<MediaInfo> {
  options.signal?.throwIfAborted();
  requireCondition(
    kind === "image" || kind === "audio",
    "invalid_media_source",
    "Inline media must identify its image or audio channel.",
  );
  requireCondition(
    !types.isProxy(data) && types.isUint8Array(data),
    "invalid_media_source",
    "Media validation needs fixed native bytes.",
  );
  const buffer = Reflect.apply(viewBuffer, data, []) as ArrayBuffer;
  requireCondition(
    !types.isSharedArrayBuffer(buffer),
    "invalid_media_source",
    "Shared media bytes must be fixed before validation.",
  );
  const offset = Reflect.apply(viewOffset, data, []) as number;
  const length = Reflect.apply(viewLength, data, []) as number;
  const span = new Uint8Array(buffer, offset, length);
  const byteLimit =
    options.maxBytes ?? (kind === "image" ? 10 : 32) * 1024 * 1024;
  requireCondition(
    Number.isSafeInteger(byteLimit) &&
      byteLimit > 0 &&
      byteLimit <= 256 * 1024 * 1024,
    "invalid_media_options",
    "Media byte probes need a positive bounded budget.",
  );
  requireCondition(
    length > 0,
    "invalid_media_data",
    "Inline media cannot be empty.",
  );
  requireCondition(
    length <= byteLimit,
    "media_too_large",
    "Inline media exceeds its channel's byte budget.",
    { kind, maxBytes: byteLimit },
  );
  const maxPixels = options.maxPixels ?? 40_000_000;
  const maxDuration = options.maxDurationSeconds ?? 7200;
  const maxMetadata = options.maxMetadataBytes ?? 1024 * 1024;
  requireCondition(
    Number.isSafeInteger(maxPixels) &&
      maxPixels > 0 &&
      maxPixels <= 1_000_000_000 &&
      Number.isFinite(maxDuration) &&
      maxDuration > 0 &&
      maxDuration <= 7 * 86400 &&
      Number.isSafeInteger(maxMetadata) &&
      maxMetadata >= 8192 &&
      maxMetadata <= 16 * 1024 * 1024,
    "invalid_media_options",
    "Media probes require bounded pixel, duration and metadata limits.",
  );
  const hint = hintedMime === undefined ? undefined : normalizeMime(hintedMime);
  // Some metadata readers construct DataView over input.buffer without passing
  // its byteLength. Exact backing stores keep a truncated view/probe from reading
  // bytes outside the actual supplied range or our bounded metadata window.
  const bytes = new Uint8Array(length);
  Reflect.apply(setBytes, bytes, [span]);
  const probe = new Uint8Array(Math.min(length, maxMetadata));
  Reflect.apply(setBytes, probe, [
    Reflect.apply(subarray, bytes, [0, probe.length]),
  ]);
  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    detected = await fileTypeFromBuffer(probe, {
      maxBufferSize: maxMetadata,
      signal: options.signal,
    });
  } catch (cause) {
    options.signal?.throwIfAborted();
    throw new AgentError(
      "invalid_media_data",
      "The media header could not be read within its probe budget.",
      undefined,
      { cause },
    );
  }
  options.signal?.throwIfAborted();
  requireCondition(
    detected,
    "unsupported_media_format",
    "The bytes do not identify a supported inline media format; they may be returned as a file resource.",
  );
  let mimeType = normalizeMime(detected.mime);
  if (kind === "image") {
    requireCondition(
      mimeType.startsWith("image/"),
      "media_type_mismatch",
      "The bytes do not contain an image format.",
    );
    let dimensions: ReturnType<typeof imageSize>;
    try {
      dimensions = imageSize(probe);
    } catch (cause) {
      throw new AgentError(
        length > maxMetadata
          ? "media_metadata_too_large"
          : "invalid_media_data",
        "The image dimensions could not be validated within the bounded header probe.",
        undefined,
        { cause },
      );
    }
    let totalPixels = 0;
    const images = dimensions.images?.length ? dimensions.images : [dimensions];
    requireCondition(
      images.length <= 4096,
      "media_metadata_too_large",
      "The image contains too many dimension entries.",
    );
    for (const image of images) {
      requireCondition(
        Number.isSafeInteger(image.width) &&
          image.width > 0 &&
          Number.isSafeInteger(image.height) &&
          image.height > 0,
        "invalid_media_data",
        "The image dimensions must be positive representable integers.",
      );
      requireCondition(
        image.width <= Math.floor(maxPixels / image.height),
        "media_dimensions_exceeded",
        "The image exceeds its pixel budget.",
        { maxPixels },
      );
      totalPixels += image.width * image.height;
      requireCondition(
        totalPixels <= maxPixels,
        "media_dimensions_exceeded",
        "The image's combined dimension entries exceed its pixel budget.",
        { maxPixels },
      );
    }
    compareHint(hint, mimeType);
    options.signal?.throwIfAborted();
    return { mimeType, width: dimensions.width, height: dimensions.height };
  }

  // Container detectors can identify an audio-only MP4/WebM as video. The audio
  // parser must confirm the absence of video before choosing its audio MIME.
  requireCondition(
    mimeType.startsWith("audio/") ||
      ["video/mp4", "video/webm", "application/ogg"].includes(mimeType),
    "media_type_mismatch",
    "The bytes do not contain an audio-capable format.",
  );
  if (mimeType === "audio/wav") riffMetadataBudget(bytes, maxMetadata);
  let metadata: IAudioMetadata;
  let observerFailure: AgentError | undefined;
  let events = 0,
    metadataBytes = 0,
    metadataNodes = 0;
  let model: IAudioMetadata | undefined;
  const scanned = new WeakMap<object, number>();
  const metadataValue = (
    value: unknown,
    depth = 0,
    ancestors = new Set<object>(),
  ): void => {
    metadataBytes += 16;
    if (
      ++metadataNodes > Math.min(65536, Math.floor(maxMetadata / 8)) ||
      depth > 32 ||
      metadataBytes > maxMetadata
    ) {
      observerFailure = new AgentError(
        "media_metadata_too_large",
        "The audio metadata exceeds its cumulative processing budget.",
      );
      throw observerFailure;
    }
    if (typeof value === "string") metadataBytes += Buffer.byteLength(value);
    else if (value && typeof value === "object") {
      if (types.isArrayBufferView(value))
        metadataBytes += Reflect.apply(
          types.isDataView(value) ? dataViewLength : viewLength,
          value,
          [],
        ) as number;
      else if (!ancestors.has(value)) {
        ancestors.add(value);
        for (const [key, descriptor] of Object.entries(
          Object.getOwnPropertyDescriptors(value),
        )) {
          metadataBytes += Buffer.byteLength(key);
          if (descriptor.enumerable && "value" in descriptor)
            metadataValue(descriptor.value, depth + 1, ancestors);
        }
        ancestors.delete(value);
      }
    }
    if (metadataBytes > maxMetadata) {
      observerFailure = new AgentError(
        "media_metadata_too_large",
        "The audio metadata exceeds its cumulative processing budget.",
      );
      throw observerFailure;
    }
  };
  const inspect = (current = model): void => {
    options.signal?.throwIfAborted();
    if (!current) return;
    // Native tags and parser warnings do not emit common/format notifications.
    // Audit appended entries while the bounded source feeds the parser, not just
    // its final common tags. A final pass covers parsers buffering a whole block.
    for (const list of [
      ...Object.values(current.native),
      current.quality.warnings,
      current.format.trackInfo,
    ]) {
      const previous = scanned.get(list) ?? 0;
      for (let index = previous; index < list.length; index++)
        metadataValue(list[index]);
      scanned.set(list, list.length);
    }
  };
  const source = Readable.from(
    (async function* () {
      for (let position = 0; position < bytes.length; position += 4096) {
        inspect();
        yield Reflect.apply(subarray, bytes, [
          position,
          Math.min(bytes.length, position + 4096),
        ]) as Uint8Array;
        // Yield to native cancellation and bound work between collector checks.
        await setImmediate(
          undefined,
          options.signal ? { signal: options.signal } : undefined,
        );
      }
      inspect();
    })(),
    { objectMode: false, highWaterMark: 4096 },
  );
  if (options.signal) addAbortSignal(options.signal, source);
  const closed = finished(source, { cleanup: true });
  void closed.catch(() => {});
  try {
    metadata = await parseStream(
      source,
      { mimeType, size: length },
      {
        duration: true,
        skipCovers: true,
        includeChapters: false,
        maxMemoryAllocation: maxMetadata,
        maxMetadataEntries: Math.min(4096, Math.floor(maxMetadata / 16)),
        maxChapterCount: 1,
        observer(event) {
          model = event.metadata;
          inspect();
          if (++events > 8192) {
            observerFailure = new AgentError(
              "media_metadata_too_large",
              "The audio metadata exceeds its observation budget.",
            );
            throw observerFailure;
          }
          if (event.tag.type === "format") metadataValue(event.tag.value);
        },
      },
    );
    inspect(metadata);
  } catch (cause) {
    options.signal?.throwIfAborted();
    if (observerFailure) throw observerFailure;
    const limited =
      cause instanceof Error &&
      /allocation limit|buffer(?:ing| size)?.*limit/i.test(cause.message);
    throw new AgentError(
      limited ? "media_metadata_too_large" : "invalid_media_data",
      "The audio format could not be validated within its metadata budget.",
      undefined,
      { cause },
    );
  } finally {
    source.destroy();
    await closed.catch(() => {});
  }
  options.signal?.throwIfAborted();
  if (observerFailure) throw observerFailure;
  const format = metadata.format;
  requireCondition(
    format.hasAudio === true &&
      format.hasVideo !== true &&
      typeof format.codec === "string" &&
      format.codec.length > 0,
    "invalid_media_data",
    "The container must describe a valid audio track without video.",
  );
  const durations = [
    format.duration,
    format.containerDuration,
    ...format.trackInfo
      .filter((track) => track.type === TrackType.audio)
      .map((track) => track.duration),
  ].filter((value): value is number => value !== undefined);
  requireCondition(
    durations.length > 0 &&
      durations.every((value) => Number.isFinite(value) && value >= 0),
    "unsupported_media_format",
    "This audio track's duration could not be validated; return it as a file resource.",
  );
  const duration = durations.reduce(
    (maximum, value) => Math.max(maximum, value),
    0,
  );
  requireCondition(
    duration <= maxDuration,
    "media_duration_exceeded",
    "The audio exceeds its duration budget.",
    { maxDurationSeconds: maxDuration },
  );
  requireCondition(
    !metadata.quality.warnings.some((warning) =>
      /truncat|exceed|unexpected end|end of (?:file|stream)|invalid (?:frame|header|chunk)|corrupt|out of bounds/i.test(
        warning.message,
      ),
    ),
    "invalid_media_data",
    "The audio parser reported incomplete or inconsistent media data.",
  );
  if (mimeType === "video/mp4") mimeType = "audio/mp4";
  else if (mimeType === "video/webm") mimeType = "audio/webm";
  else if (mimeType === "application/ogg") mimeType = "audio/ogg";
  compareHint(hint, mimeType);
  return { mimeType, duration };
}

function compareHint(hint: string | undefined, actual: string): void {
  // Generic bytes do not claim a codec. PNG also covers its APNG extension.
  requireCondition(
    hint === undefined ||
      hint === "application/octet-stream" ||
      hint === actual ||
      (hint === "image/png" && actual === "image/apng"),
    "media_type_mismatch",
    "The declared MIME type disagrees with the actual media format.",
    { ...(hint ? { declared: hint } : {}), actual },
  );
}

// music-metadata buffers ordinary WAV INFO values before adding them to its
// observable collector. A size/count preflight closes that concrete gap without
// decoding audio or replacing the library's format/duration validation.
function riffMetadataBudget(bytes: Uint8Array, maximum: number): void {
  if (bytes.length < 12) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(bytes.length, 8 + view.getUint32(4, true));
  const id = (at: number) =>
    String.fromCharCode(
      bytes[at]!,
      bytes[at + 1]!,
      bytes[at + 2]!,
      bytes[at + 3]!,
    );
  let cost = 0;
  const charge = (amount: number) => {
    cost += amount;
    requireCondition(
      cost <= maximum,
      "media_metadata_too_large",
      "The WAV metadata exceeds its cumulative header budget.",
    );
  };
  for (let offset = 12; offset + 8 <= end;) {
    const size = view.getUint32(offset + 4, true),
      name = id(offset);
    requireCondition(
      size <= end - offset - 8,
      "invalid_media_data",
      "A WAV chunk exceeds its actual file boundary.",
    );
    charge(96);
    if (["fmt ", "fact", "CSET", "bext", "id3 ", "ID3 "].includes(name))
      charge(size);
    else if (name === "LIST" && size >= 4 && id(offset + 8) === "INFO") {
      charge(size);
      const until = offset + 8 + size;
      for (let tag = offset + 12; tag + 8 <= until;) {
        const length = view.getUint32(tag + 4, true);
        requireCondition(
          length <= until - tag - 8,
          "invalid_media_data",
          "A WAV INFO value exceeds its actual list boundary.",
        );
        charge(96);
        tag += 8 + length + (length & 1);
      }
    }
    offset += 8 + size + (size & 1);
  }
}
