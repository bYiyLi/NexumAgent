import { StringDecoder } from "node:string_decoder";
import { requireCondition } from "../contracts/errors.js";
import { decodeNativeOEM, nativeOEMPages, type WindowsCodePages } from "./windows-encoding.js";

// Only stateless encodings with bounded character tails can be reconstructed
// from a signed, repeatable output cursor. Do not accept arbitrary ICU labels
// (e.g. ISO-2022-JP has shift state that outlives a character).
const aliases = {
  auto: "auto",
  utf8: "utf8", "utf-8": "utf8", cp65001: "utf8",
  utf16le: "utf16le", "utf-16le": "utf16le", ucs2: "utf16le", "ucs-2": "utf16le", cp1200: "utf16le",
  utf16be: "utf-16be", "utf-16be": "utf-16be", cp1201: "utf-16be",
  latin1: "latin1", binary: "latin1", ascii: "ascii",
  base64: "base64", base64url: "base64url", hex: "hex",
  gbk: "gbk", gb2312: "gbk", cp936: "gbk",
  gb18030: "gb18030", cp54936: "gb18030",
  shift_jis: "shift_jis", "shift-jis": "shift_jis", sjis: "shift_jis", "windows-31j": "shift_jis", cp932: "shift_jis",
  big5: "big5", cp950: "big5",
  "euc-kr": "euc-kr", cp949: "euc-kr",
  "windows-874": "windows-874", cp874: "windows-874",
  ibm866: "ibm866", cp866: "ibm866",
  cp437: "cp437", cp850: "cp850", cp852: "cp852", cp855: "cp855", cp857: "cp857", cp858: "cp858", cp860: "cp860", cp861: "cp861", cp862: "cp862", cp863: "cp863", cp864: "cp864", cp865: "cp865", cp869: "cp869",
  "windows-1250": "windows-1250", cp1250: "windows-1250",
  "windows-1251": "windows-1251", cp1251: "windows-1251",
  "windows-1252": "windows-1252", cp1252: "windows-1252",
  "windows-1253": "windows-1253", cp1253: "windows-1253",
  "windows-1254": "windows-1254", cp1254: "windows-1254",
  "windows-1255": "windows-1255", cp1255: "windows-1255",
  "windows-1256": "windows-1256", cp1256: "windows-1256",
  "windows-1257": "windows-1257", cp1257: "windows-1257",
  "windows-1258": "windows-1258", cp1258: "windows-1258",
} as const;
export type OutputEncoding = keyof typeof aliases;
export type CanonicalOutputEncoding = (typeof aliases)[OutputEncoding];
export const outputEncodingLabels = Object.freeze(Object.keys(aliases));

export function normalizeOutputEncoding(value: unknown): CanonicalOutputEncoding | null {
  if (value === null) return null;
  requireCondition(typeof value === "string", "unsupported_output_encoding",
    "Output encoding must be a supported encoding or null.");
  const key = value.toLowerCase();
  requireCondition(Object.hasOwn(aliases, key), "unsupported_output_encoding",
    "This encoding cannot be incrementally decoded. Select a supported encoding or retain raw bytes.");
  return aliases[key as OutputEncoding];
}

const nativeEncodings = new Set<string>(["utf16le", "latin1", "ascii", "base64", "base64url", "hex"]);
const decoderNeed = Object.getOwnPropertyDescriptor(StringDecoder.prototype, "lastNeed")!.get!;
const decoderTotal = Object.getOwnPropertyDescriptor(StringDecoder.prototype, "lastTotal")!.get!;
const decoderChar = Object.getOwnPropertyDescriptor(StringDecoder.prototype, "lastChar")!.get!;

export type AutoEncodingMode = "pending" | "undecided" | "utf8" | "legacy" | "utf16le" | "utf-16be" | "raw";
export const initialAutoModes = (truncated: boolean): AutoEncodingMode[] =>
  truncated ? ["utf8", "utf8", "utf8"] : ["pending", "pending", "utf8"];

// The legacy policy is a fixed per-process observation, not a new guess on
// every read. Only code pages with a supported bounded decoder participate.
export function windowsLegacyEncoding(page: number): CanonicalOutputEncoding | undefined {
  if (!Number.isInteger(page) || page <= 0 || page > 65535 ||
      page === 65001 || page === 1200 || page === 1201) return;
  const label = ("cp" + page) as OutputEncoding;
  if (!Object.hasOwn(aliases, label)) return;
  return aliases[label];
}

export function selectWindowsFallback(pages?: WindowsCodePages): number {
  if (!pages) return 0;
  for (const page of [pages.hostConsoleOutput, pages.oem, pages.ansi]) {
    if (page !== null && windowsLegacyEncoding(page) !== undefined) return page;
  }
  return 0;
}

interface OutputDecoder {
  write(bytes: Buffer): string | Buffer;
  end(): string | Buffer;
  carry(): string;
  mode?(): AutoEncodingMode;
}

// The original bytes always remain in the ring. Invalid text or a truncated
// final character is returned as bytes, not silently replaced with U+FFFD.
class LosslessText implements OutputDecoder {
  private readonly label: string;
  constructor(label: string, private pending: Buffer) {
    this.label = label === "utf16le" ? "utf-16le" : label;
    // Fail explicitly if a differently built Node runtime lacks this codec.
    requireCondition(supportsTextDecoder(this.label), "unsupported_output_encoding",
      "The current Node runtime does not provide this text encoding.");
  }
  write(bytes: Buffer): string | Buffer {
    const input = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    this.pending = Buffer.alloc(0);
    const make = () => new TextDecoder(this.label, { fatal: true, ignoreBOM: true });
    try {
      const decoder = make();
      const text = decoder.decode(input, { stream: true });
      try {
        decoder.decode();
        return text;
      } catch {
        // The stream accepted all bytes except an incomplete final character.
        // Stateless supported codecs have at most three pending bytes.
        for (let n = 1; n <= Math.min(3, input.length); n++) {
          try {
            if (make().decode(input.subarray(0, input.length - n)) === text) {
              this.pending = Buffer.from(input.subarray(input.length - n));
              return text;
            }
          } catch { /* Continue to the actual character boundary. */ }
        }
      }
    } catch { /* Invalid or unknown source bytes. */ }
    return input;
  }
  end(): Buffer {
    const bytes = this.pending;
    this.pending = Buffer.alloc(0);
    return bytes;
  }
  carry(): string { return this.pending.toString("base64"); }
}

function supportsTextDecoder(label: string): boolean {
  try { new TextDecoder(label, { fatal: true }); return true; }
  catch { return false; }
}

const bom = [
  { bytes: Buffer.from([0xff, 0xfe, 0x00, 0x00]), mode: "raw" as const },
  { bytes: Buffer.from([0x00, 0x00, 0xfe, 0xff]), mode: "raw" as const },
  { bytes: Buffer.from([0xef, 0xbb, 0xbf]), mode: "utf8" as const },
  { bytes: Buffer.from([0xff, 0xfe]), mode: "utf16le" as const },
  { bytes: Buffer.from([0xfe, 0xff]), mode: "utf-16be" as const },
];
// Classify exactly the first non-ASCII UTF-8 character, independently of
// pipe chunks and page size. Incomplete valid prefixes need more bytes;
// invalid prefixes may select the original process's Windows fallback.
function utf8Prefix(bytes: Buffer): "valid" | "incomplete" | "invalid" {
  const first = bytes[0]!;
  const width = first >= 0xc2 && first <= 0xdf ? 2
    : first >= 0xe0 && first <= 0xef ? 3
    : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
  if (!width) return "invalid";
  for (let i = 1; i < Math.min(width, bytes.length); i++) {
    const byte = bytes[i]!;
    const low = i === 1 && first === 0xe0 ? 0xa0 : i === 1 && first === 0xf0 ? 0x90 : 0x80;
    const high = i === 1 && first === 0xed ? 0x9f : i === 1 && first === 0xf4 ? 0x8f : 0xbf;
    if (byte < low || byte > high) return "invalid";
  }
  return bytes.length < width ? "incomplete" : "valid";
}

// A decoder that cannot be loaded must still deliver its pending original
// bytes, even if the next page is empty or the reader has reopened the log.
function rawDecoder(pending: Buffer): OutputDecoder {
  const take = (bytes: Buffer) => {
    const value = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    pending = Buffer.alloc(0);
    return value;
  };
  return {
    write: take,
    end: () => take(Buffer.alloc(0)),
    carry: () => pending.toString("base64"),
  };
}

class AutoDecoder implements OutputDecoder {
  private active?: OutputDecoder;

  constructor(
    private pending: Buffer,
    private detected: AutoEncodingMode,
    private readonly fallback?: CanonicalOutputEncoding,
  ) {
    if (detected !== "pending" && detected !== "undecided") {
      this.active = this.decoder(detected, pending);
      this.pending = Buffer.alloc(0);
    }
  }

  private decoder(
    mode: Exclude<AutoEncodingMode, "pending" | "undecided">,
    pending: Buffer,
  ): OutputDecoder {
    if (mode === "raw") return rawDecoder(pending);
    if (mode !== "legacy") return new LosslessText(mode, pending);
    requireCondition(this.fallback, "invalid_output_cursor", "The original Windows fallback is unavailable.");
    // Optional native/ICU codecs must never prevent automatic output reads.
    try {
      return outputDecoder(this.fallback, pending.toString("base64"));
    } catch {
      this.detected = "raw";
      return rawDecoder(pending);
    }
  }

  private writeActive(bytes: Buffer): string | Buffer {
    const decoder = this.active!;
    if (this.detected !== "legacy") return decoder.write(bytes);
    const previous = Buffer.from(decoder.carry(), "base64");
    try {
      return decoder.write(bytes);
    } catch {
      // Preserve the tail from before the failed native conversion.
      this.detected = "raw";
      this.active = rawDecoder(previous);
      return this.active.write(bytes);
    }
  }

  write(bytes: Buffer): string | Buffer {
    if (this.active) return this.writeActive(bytes);
    const input = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    this.pending = Buffer.alloc(0);
    if (this.detected === "pending") {
      // Longer signatures precede shorter ones (UTF-32LE vs UTF-16LE).
      if (bom.some(item => input.length < item.bytes.length &&
          item.bytes.subarray(0, input.length).equals(input))) {
        this.pending = Buffer.from(input);
        return "";
      }
      const match = bom.find(item => input.subarray(0, item.bytes.length).equals(item.bytes));
      if (match) {
        this.detected = match.mode;
        this.active = this.decoder(this.detected, Buffer.alloc(0));
        return this.writeActive(this.detected === "raw" ? input : input.subarray(match.bytes.length));
      }
      this.detected = "undecided";
    }
    let ascii = 0;
    while (ascii < input.length && input[ascii]! < 0x80) ascii++;
    const prefix = input.subarray(0, ascii);
    const rest = input.subarray(ascii);
    if (!rest.length) return prefix.toString("ascii");
    const classification = utf8Prefix(rest);
    if (classification === "incomplete") {
      this.pending = Buffer.from(rest);
      return prefix.toString("ascii");
    }
    this.detected = classification === "invalid" && this.fallback ? "legacy" : "utf8";
    this.active = this.decoder(this.detected, Buffer.alloc(0));
    const value = this.writeActive(rest);
    return Buffer.isBuffer(value) ? Buffer.concat([prefix, value]) : prefix.toString("ascii") + value;
  }
  end(): string | Buffer {
    if (this.active) return this.active.end();
    const bytes = this.pending;
    this.pending = Buffer.alloc(0);
    if (this.detected === "pending" && bytes.equals(Buffer.from([0xff, 0xfe]))) {
      this.detected = "utf16le";
      return "";
    }
    if (this.detected === "undecided" && bytes.length && this.fallback) {
      this.detected = "legacy";
      this.active = this.decoder("legacy", Buffer.alloc(0));
      const value = this.writeActive(bytes);
      // Preserve incomplete/invalid final bytes in their original encoding.
      const tail = this.active.end();
      return typeof value === "string" && tail.length === 0 ? value : bytes;
    }
    return bytes;
  }
  carry(): string { return this.active?.carry() ?? this.pending.toString("base64"); }
  mode(): AutoEncodingMode { return this.detected; }
}

export function outputDecoder(selected: CanonicalOutputEncoding, carry: string,
  mode?: AutoEncodingMode, fallback?: CanonicalOutputEncoding): OutputDecoder {
  const pending = Buffer.from(carry, "base64");
  if (selected === "auto") return new AutoDecoder(pending, mode ?? "utf8", fallback);
  const oemPage = nativeOEMPages.find(n => selected === "cp" + n);
  if (oemPage !== undefined) {
    requireCondition(process.platform === "win32", "unsupported_output_encoding",
      "This OEM code page requires the Windows native decoder; select encoding:null for raw bytes.");
    return { write: bytes => decodeNativeOEM(oemPage, bytes), end: () => "", carry: () => "" };
  }
  if (!nativeEncodings.has(selected)) return new LosslessText(selected, pending);
  // Preserve the existing BufferEncoding semantics for explicitly selected
  // native representations (including binary/hex/base64).
  const decoder = new StringDecoder(selected as BufferEncoding);
  if (pending.length) decoder.write(pending);
  return {
    write: bytes => decoder.write(bytes),
    end: () => decoder.end(),
    carry: () => {
      const need = decoderNeed.call(decoder) as number;
      const total = decoderTotal.call(decoder) as number;
      return need ? (decoderChar.call(decoder) as Buffer)
        .subarray(0, total - need).toString("base64") : "";
    },
  };
}
