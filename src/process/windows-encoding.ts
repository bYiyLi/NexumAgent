import { createRequire } from "node:module";
import { AgentError } from "../contracts/errors.js";
import type { KoffiFunc } from "koffi";

interface EncodingApi {
  acp: KoffiFunc<() => number>;
  oem: KoffiFunc<() => number>;
  input: KoffiFunc<() => number>;
  output: KoffiFunc<() => number>;
  convert: KoffiFunc<(page: number, flags: number, bytes: Buffer, length: number, out: Buffer, capacity: number) => number>;
}
let api: EncodingApi | undefined;
function native(): EncodingApi {
  if (api) return api;
  if (process.platform !== "win32") throw new Error("not Windows");
  const koffi: typeof import("koffi") = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll");
  api = {
    acp: kernel.func("uint32_t __stdcall GetACP()") as EncodingApi["acp"],
    oem: kernel.func("uint32_t __stdcall GetOEMCP()") as EncodingApi["oem"],
    input: kernel.func("uint32_t __stdcall GetConsoleCP()") as EncodingApi["input"],
    output: kernel.func("uint32_t __stdcall GetConsoleOutputCP()") as EncodingApi["output"],
    convert: kernel.func("int32_t __stdcall MultiByteToWideChar(uint32_t page, uint32_t flags, const uint8_t *bytes, int32_t length, _Out_ uint16_t *out, int32_t capacity)") as EncodingApi["convert"],
  };
  return api;
}

export interface WindowsCodePages {
  readonly ansi: number | null;
  readonly oem: number | null;
  readonly hostConsoleInput: number | null;
  readonly hostConsoleOutput: number | null;
  readonly source: "windows-system-and-host-console";
}

/** Actual system and host-console observations, never claims about child stdout. */
export function readWindowsCodePages(): WindowsCodePages | undefined {
  if (process.platform !== "win32") return;
  try {
    const n = native();
    const page = (value: number) => value > 0 && value <= 65535 ? value : null;
    return {
      ansi: page(n.acp()), oem: page(n.oem()),
      hostConsoleInput: page(n.input()), hostConsoleOutput: page(n.output()),
      source: "windows-system-and-host-console",
    };
  } catch {
    // These optional facts do not block ordinary commands.
    return;
  }
}

// Supported single-byte OEM pages not exposed by Node ICU.
// MultiByteToWideChar works on the actual Windows code page, not a guess.
export const nativeOEMPages = [437, 850, 852, 855, 857, 858, 860, 861, 862, 863, 864, 865, 869] as const;
export function decodeNativeOEM(page: number, bytes: Buffer): string | Buffer {
  if (!bytes.length) return "";
  if (process.platform !== "win32" || !nativeOEMPages.some(n => n === page))
    throw new AgentError("unsupported_output_encoding", "This OEM code page requires the Windows native decoder. Select encoding:null to read its bytes.");
  const output = Buffer.alloc(bytes.length * 2);
  try {
    const count = native().convert(page, 8 /* MB_ERR_INVALID_CHARS */, bytes, bytes.length, output, bytes.length);
    return count > 0 && count <= bytes.length ? output.toString("utf16le", 0, count * 2) : bytes;
  } catch {
    throw new AgentError("unsupported_output_encoding", "The Windows native code-page decoder is unavailable.");
  }
}
