import { crc32, deflateSync } from "node:zlib";

export function monochromePng(width, height) {
  const chunk = (type, bytes) => {
    const result = Buffer.alloc(12 + bytes.length);
    result.writeUInt32BE(bytes.length);
    result.write(type, 4, 4, "ascii");
    bytes.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, 8 + bytes.length)), 8 + bytes.length);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // Packed grayscale, one filter byte per scanline.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((Math.ceil(width / 8) + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function iconWithManyImages(count) {
  const picture = monochromePng(256, 256);
  const directory = Buffer.alloc(6 + count * 16);
  directory.writeUInt16LE(1, 2); // ICO format.
  directory.writeUInt16LE(count, 4);
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16;
    // A zero width/height byte means 256. Each entry has its own PNG payload.
    directory.writeUInt16LE(1, offset + 4);
    directory.writeUInt16LE(1, offset + 6);
    directory.writeUInt32LE(picture.length, offset + 8);
    directory.writeUInt32LE(directory.length + i * picture.length, offset + 12);
  }
  return Buffer.concat([directory, ...Array(count).fill(picture)]);
}
