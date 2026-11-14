import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { validateMedia } from "../dist/results/media.js";

function png(width = 1, height = 1) {
  const chunk = (type, data) => {
    const name = Buffer.from(type),
      value = Buffer.alloc(12 + data.length);
    value.writeUInt32BE(data.length);
    name.copy(value, 4);
    data.copy(value, 8);
    value.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
    return value;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 80, 100, 120, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const gif = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
// A real 1x1 RGB JPEG fixture; colour profiles and camera metadata are omitted.
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD5/ooor7Q+PP/Z",
  "base64",
);
function wav(samples = 40, metadataBytes = 0) {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(8000, 12);
  fmt.writeUInt32LE(16000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const body = Buffer.alloc(8 + samples * 2);
  body.write("data");
  body.writeUInt32LE(samples * 2, 4);
  const parts = [fmt];
  if (metadataBytes) {
    const info = Buffer.alloc(20 + metadataBytes + (metadataBytes % 2));
    info.write("LIST");
    info.writeUInt32LE(info.length - 8, 4);
    info.write("INFOINAM", 8);
    info.writeUInt32LE(metadataBytes, 16);
    info.fill(65, 20, 20 + metadataBytes - 1);
    parts.push(info);
  }
  parts.push(body);
  const data = Buffer.concat(parts),
    header = Buffer.alloc(12);
  header.write("RIFF");
  header.writeUInt32LE(4 + data.length, 4);
  header.write("WAVE", 8);
  return Buffer.concat([header, data]);
}
function waveWithChunks(chunks) {
  const basic = wav(),
    data = Buffer.concat([
      basic.subarray(0, 36),
      ...chunks,
      basic.subarray(36),
    ]);
  data.writeUInt32LE(data.length - 8, 4);
  return data;
}
function infoTags(values) {
  const entries = values.map((value, index) => {
    const text = Buffer.from(value + "\0"),
      chunk = Buffer.alloc(8 + text.length + (text.length & 1));
    chunk.write(`ZZZ${index}`, 0);
    chunk.writeUInt32LE(text.length, 4);
    text.copy(chunk, 8);
    return chunk;
  });
  const body = Buffer.concat([Buffer.from("INFO"), ...entries]),
    result = Buffer.alloc(8 + body.length);
  result.write("LIST");
  result.writeUInt32LE(body.length, 4);
  body.copy(result, 8);
  return result;
}
function commentTag(text) {
  const payload = Buffer.concat([
      Buffer.from([0, 101, 110, 103, 0]),
      Buffer.from(text),
    ]),
    frame = Buffer.alloc(10 + payload.length);
  frame.write("COMM");
  frame.writeUInt32BE(payload.length, 4);
  payload.copy(frame, 10);
  const header = Buffer.alloc(10);
  header.write("ID3");
  header[3] = 3;
  let size = frame.length;
  for (let index = 9; index >= 6; index--) {
    header[index] = size & 127;
    size >>>= 7;
  }
  const data = Buffer.concat([header, frame]),
    chunk = Buffer.alloc(8 + data.length + (data.length & 1));
  chunk.write("id3 ");
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  return chunk;
}
function audioMp4(durations, movieDuration = 1) {
  const box = (name, ...values) => {
    const body = Buffer.concat(values),
      result = Buffer.alloc(8 + body.length);
    result.writeUInt32BE(result.length);
    result.write(name, 4);
    body.copy(result, 8);
    return result;
  };
  const movie = Buffer.alloc(100);
  movie.writeUInt32BE(1000, 12);
  movie.writeUInt32BE(movieDuration * 1000, 16);
  movie.writeUInt32BE(65536, 20);
  movie.writeUInt16BE(256, 24);
  const tracks = durations.map((duration, index) => {
    const track = Buffer.alloc(84);
    track.writeUInt32BE(1, 0);
    track.writeUInt32BE(index + 1, 12);
    track.writeUInt32BE(duration * 1000, 20);
    track.writeUInt16BE(256, 36);
    const media = Buffer.alloc(24);
    media.writeUInt32BE(1000, 12);
    media.writeUInt32BE(duration * 1000, 16);
    const handler = Buffer.alloc(28);
    handler.write("soun", 8);
    const entry = Buffer.alloc(36);
    entry.writeUInt32BE(36);
    entry.write("mp4a", 4);
    entry.writeUInt16BE(1, 14);
    entry.writeUInt16BE(1, 24);
    entry.writeUInt16BE(16, 26);
    entry.writeUInt16BE(8000, 32);
    const table = Buffer.alloc(8);
    table.writeUInt32BE(1, 4);
    return box(
      "trak",
      box("tkhd", track),
      box(
        "mdia",
        box("mdhd", media),
        box("hdlr", handler),
        box("minf", box("stbl", box("stsd", table, entry))),
      ),
    );
  });
  // A minimal timing/sample-description fixture. No AAC samples are decoded by
  // this metadata-only validator; this tests the complete container timing bound.
  return Buffer.concat([
    box("ftyp", Buffer.from("M4A \0\0\0\0M4A isom")),
    box("moov", box("mvhd", movie), ...tracks),
  ]);
}

test("real PNG, GIF and JPEG byte formats supply image MIME and bounded dimensions", async () => {
  for (const [data, mime] of [
    [png(), "image/png"],
    [gif, "image/gif"],
    [jpeg, "image/jpeg"],
  ]) {
    assert.deepEqual(await validateMedia(data, "image"), {
      mimeType: mime,
      width: 1,
      height: 1,
    });
  }
  assert.equal(
    (await validateMedia(jpeg, "image", "IMAGE/JPG")).mimeType,
    "image/jpeg",
  );
  assert.equal(
    (await validateMedia(png(), "image", "application/octet-stream")).mimeType,
    "image/png",
  );
});

test("actual bytes, rather than a supplied MIME string or requested channel, determine media type", async () => {
  await assert.rejects(() => validateMedia(png(), "image", "image/jpeg"), {
    code: "media_type_mismatch",
  });
  await assert.rejects(() => validateMedia(png(), "audio", "audio/wav"), {
    code: "media_type_mismatch",
  });
  await assert.rejects(() => validateMedia(wav(), "image"), {
    code: "media_type_mismatch",
  });
  await assert.rejects(
    () => validateMedia(Buffer.from("not media"), "image", "image/png"),
    { code: "unsupported_media_format" },
  );
  await assert.rejects(() => validateMedia(Buffer.alloc(0), "image"), {
    code: "invalid_media_data",
  });
  await assert.rejects(
    () => validateMedia(png(), "image", "image/png\r\ninvalid"),
    { code: "invalid_media_mime_type" },
  );
});

test("native byte views preserve subranges and do not execute shadow accessors or iteration hooks", async () => {
  const data = png(),
    outer = Buffer.concat([
      Buffer.from("private-prefix"),
      data,
      Buffer.from("private-tail"),
    ]);
  const view = new Uint8Array(outer.buffer, outer.byteOffset + 14, data.length);
  let executed = 0;
  for (const property of ["byteLength", "byteOffset", "buffer"])
    Object.defineProperty(view, property, {
      get() {
        executed++;
        throw Error("not allowed");
      },
    });
  view[Symbol.iterator] = () => {
    executed++;
    throw Error("not allowed");
  };
  assert.deepEqual(await validateMedia(view, "image"), {
    mimeType: "image/png",
    width: 1,
    height: 1,
  });
  assert.equal(executed, 0);
  const proxy = new Proxy(view, {
    get() {
      executed++;
      throw Error("not allowed");
    },
  });
  await assert.rejects(() => validateMedia(proxy, "image"), {
    code: "invalid_media_source",
  });
  assert.equal(executed, 0);
  await assert.rejects(
    () => validateMedia(new Uint8Array(new SharedArrayBuffer(16)), "image"),
    { code: "invalid_media_source" },
  );
});

test("byte and dimension checks reject expensive input before decoding or returning a fake preview", async () => {
  await assert.rejects(() => validateMedia(png(100000, 100000), "image"), {
    code: "media_dimensions_exceeded",
  });
  await assert.rejects(
    () => validateMedia(png(), "image", undefined, { maxBytes: 10 }),
    { code: "media_too_large" },
  );
  await assert.rejects(
    () => validateMedia(Buffer.alloc(10 * 1024 * 1024 + 1), "image"),
    { code: "media_too_large" },
  );
  await assert.rejects(
    () => validateMedia(png(), "image", undefined, { maxPixels: 0 }),
    { code: "invalid_media_options" },
  );
  await assert.rejects(() => validateMedia(png().subarray(0, 20), "image"), {
    code: "invalid_media_data",
  });
});

test("real PCM WAV data supplies audio MIME and checked duration without retaining audio tags", async () => {
  assert.deepEqual(await validateMedia(wav(), "audio"), {
    mimeType: "audio/wav",
    duration: 0.005,
  });
  assert.equal(
    (await validateMedia(wav(), "audio", "audio/x-wav")).mimeType,
    "audio/wav",
  );
  await assert.rejects(
    () =>
      validateMedia(wav(), "audio", undefined, { maxDurationSeconds: 0.001 }),
    { code: "media_duration_exceeded" },
  );
  await assert.rejects(() => validateMedia(wav(), "audio", "audio/mpeg"), {
    code: "media_type_mismatch",
  });
});

test("truncated audio and metadata allocation attacks are errors, even when a parser can infer duration", async () => {
  await assert.rejects(() => validateMedia(wav().subarray(0, 46), "audio"), {
    code: "invalid_media_data",
  });
  await assert.rejects(() => validateMedia(wav().subarray(0, 20), "audio"), {
    code: "invalid_media_data",
  });
  await assert.rejects(
    () =>
      validateMedia(wav(40, 20000), "audio", undefined, {
        maxMetadataBytes: 8192,
      }),
    { code: "media_metadata_too_large" },
  );
});

test("cumulative unknown tags, nested comments and warning floods cannot bypass the metadata budget", async () => {
  const ignored = Buffer.alloc(2000 * 8);
  for (let offset = 0; offset < ignored.length; offset += 8)
    ignored.write("ODD!", offset);
  for (const value of [
    waveWithChunks([ignored]),
    waveWithChunks([
      infoTags(["x".repeat(3000), "y".repeat(3000), "z".repeat(3000)]),
    ]),
    waveWithChunks([commentTag("q".repeat(8080))]),
  ]) {
    await assert.rejects(
      () =>
        validateMedia(value, "audio", undefined, { maxMetadataBytes: 8192 }),
      { code: "media_metadata_too_large" },
    );
  }
  // Each INFO value fits the parser's single-allocation budget, but the WAV
  // parser would retain all of them privately until the final INFO flush.
  await assert.rejects(
    () =>
      validateMedia(
        waveWithChunks([
          infoTags(Array.from({ length: 20 }, () => "r".repeat(70000))),
        ]),
        "audio",
      ),
    { code: "media_metadata_too_large" },
  );
});

test("audio duration covers the complete MP4 container and every audio track", async () => {
  assert.deepEqual(await validateMedia(audioMp4([1, 3], 2), "audio"), {
    mimeType: "audio/mp4",
    duration: 3,
  });
  await assert.rejects(() => validateMedia(audioMp4([1, 10800]), "audio"), {
    code: "media_duration_exceeded",
  });
  await assert.rejects(() => validateMedia(audioMp4([1], 10800), "audio"), {
    code: "media_duration_exceeded",
  });
});

test("cancellation follows the actual native parser promise instead of manufacturing completion", async () => {
  const first = new AbortController(),
    reason = new Error("cancel media");
  first.abort(reason);
  await assert.rejects(
    () => validateMedia(wav(), "audio", undefined, { signal: first.signal }),
    (error) => error === reason,
  );
  const second = new AbortController(),
    pending = validateMedia(wav(), "audio", undefined, {
      signal: second.signal,
    });
  second.abort(reason);
  await assert.rejects(
    () => pending,
    (error) => error === reason,
  );
});
