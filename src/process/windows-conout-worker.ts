/**
 * Adapted from node-pty@1.2.0-beta.18's worker/conoutSocketWorker.js.
 * Copyright (c) 2020, Microsoft Corporation (MIT License).
 * Copyright (c) 2018 - present Microsoft Corporation. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createServer, Socket, type Server } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

if (
  process.platform !== "win32" ||
  !parentPort ||
  typeof workerData?.conoutPipeName !== "string" ||
  !workerData.conoutPipeName ||
  workerData.conoutPipeName.length > 32768 ||
  workerData.conoutPipeName.includes("\0")
)
  throw new Error("The Windows ConPTY output worker configuration is invalid.");

const port = parentPort;
const conoutPipeName: string = workerData.conoutPipeName;
const conoutSocket = new Socket();
let server: Server | undefined;
let workerSocket: Socket | undefined;
let ended = false;
let failed = false;

function fail(error?: NodeJS.ErrnoException): void {
  if (failed) return;
  failed = true;
  const code =
    typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : "UNKNOWN";
  // Native error.message/path may contain private pipe names. Send only a code.
  port.postMessage({ type: "error", code });
  conoutSocket.destroy();
  workerSocket?.destroy();
  server?.close();
  port.close();
}

conoutSocket.on("error", fail);
conoutSocket.on("end", () => {
  ended = true;
  port.postMessage("end");
  // pipe() ends the downstream writable after its pending writes. Do not exit
  // here: workerSocket still owns any bytes queued before native EOF.
});
conoutSocket.on("close", () => {
  if (!ended && !failed) fail();
});

// Leave this socket in Buffer mode. A StringDecoder here would irreversibly
// replace invalid bytes and might merge/split native byte chunks.
conoutSocket.connect(conoutPipeName, () => {
  if (failed) return;
  server = createServer((socket) => {
    if (workerSocket || failed) {
      socket.destroy();
      return;
    }
    workerSocket = socket;
    // One parent consumer only; close the listener while retaining this socket.
    server!.close();
    socket.on("error", fail);
    socket.on("close", () => {
      if (!ended && !failed) {
        fail();
        return;
      }
      conoutSocket.destroy();
      port.close();
    });
    conoutSocket.pipe(socket);
  });
  server.on("error", fail);
  server.listen(`${conoutPipeName}-worker`, () => port.postMessage("ready"));
});
