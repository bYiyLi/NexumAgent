import { MIMEType } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";
import { createOutput } from "../sdk/output.js";
import type { ResourceReadResult } from "../sdk/runtime.js";
import { visitGoResourceBytes } from "./blob.js";

const responseBytes = 128 * 1024 * 1024;
type TextSource = (visit: (chunk: Buffer) => void) => Promise<void>;
type ResourceReadScope = { instanceId: string; runId: string; methodId: string };
type Call = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
export type ResourceReadResolver = (plan: unknown, methodId: string) => Promise<ResourceReadResult>;
const isLine = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const jsonMime = (mime: string) => mime === "application/json" || mime.endsWith("+json");

/** Strict UTF-8, one-based inclusive lines. Read through EOF even for a range
 * so the caller's verified fixed-source reader checks its entire digest.
 * Accumulate only selected text; no implicit pagination or truncation. */
export async function renderResourceText(source: TextSource, resource: { name: string; mimeType: string; uri: string },
  startLine?: number, endLine?: number, signal?: AbortSignal): Promise<string> {
  const first = startLine ?? 1, last = endLine ?? Number.MAX_SAFE_INTEGER;
  requireCondition(isLine(first) && isLine(last) && first <= last,
    "invalid_arguments", "Text line ranges are one-based and inclusive; endLine must not precede startLine.");
  const originalJson = startLine === undefined && endLine === undefined && jsonMime(new MIMEType(resource.mimeType).essence);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: originalJson });
  const parts: string[] = [];
  let bytes = 0, line = 1, hasData = false, prefixed = false, pendingCR = false;
  const append = (value: string) => {
    bytes += Buffer.byteLength(value);
    requireCondition(bytes <= responseBytes, "mcp_response_too_large",
      "The selected resource text exceeds the response budget. Supply a smaller line range or use mode download.");
    if (value) parts.push(value);
  };
  const prefix = () => `    ${line} | `;
  function consume(value: string) {
    if (originalJson) { append(value); return; }
    const chunkParts: string[] = [];
    let from = 0;
    while (from < value.length) {
      const nl = value.indexOf("\n", from);
      let part = (pendingCR ? "\r" : "") + value.slice(from, nl < 0 ? value.length : nl);
      pendingCR = false;
      if (nl < 0 && part.endsWith("\r")) {
        pendingCR = true;
        part = part.slice(0, -1);
      } else if (nl >= 0 && part.endsWith("\r")) part = part.slice(0, -1);
      if (part.length || pendingCR) hasData = true;
      if (line >= first && line <= last && (part.length || pendingCR || nl >= 0)) {
        if (!prefixed) { chunkParts.push(prefix()); prefixed = true; }
        chunkParts.push(part);
        if (nl >= 0) chunkParts.push("\n");
      }
      if (nl < 0) break;
      line++;
      hasData = false;
      prefixed = false;
      from = nl + 1;
    }
    append(chunkParts.join(""));
  }
  function decode(chunk?: Buffer): string {
    try { return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true }); }
    catch (cause) { throw new AgentError("invalid_resource_encoding", "The registered resource is not valid UTF-8 text; use mode download for the original bytes.", undefined, { cause }); }
  }
  await source(chunk => { signal?.throwIfAborted(); consume(decode(chunk)); });
  consume(decode());
  signal?.throwIfAborted();
  if (originalJson) return parts.join("");
  if (pendingCR && line >= first && line <= last) append("\r");
  const total = line - 1 + Number(hasData);
  requireCondition(first <= total || (total === 0 && first === 1), "resource_range_invalid", "startLine is beyond the end of this resource.");
  const end = Math.min(last, total);
  const next = end < total ? end + 1 : null;
  const body = parts.join("");
  const header = `## ${JSON.stringify(resource.name)}\nResource: ${resource.uri}\nMIME: ${resource.mimeType}\nLines ${total === 0 ? 0 : first}–${end} / ${total}${next === null && first === 1 ? " · Complete" : ""}\n\n`;
  const footer = next === null ? "" : `\n\nNextLine: ${next}`;
  requireCondition(bytes + Buffer.byteLength(header + footer) <= responseBytes, "mcp_response_too_large",
    "The selected resource text exceeds the response budget. Supply a smaller line range or use mode download.");
  return header + body.replace(/\n$/, "") + footer;
}

/** Interpret only the receipt of the Go-owned runtime.readResource method.
 * The original URI is resolved again by the result encoder for native media. */
export async function resolveResourceRead(plan: unknown, scope: ResourceReadScope, call: Call,
  signal: AbortSignal, pwd: string): Promise<ResourceReadResult> {
  signal.throwIfAborted();
  requireCondition(isPlainRecord(plan) && isPlainRecord(plan.resource), "invalid_resource", "The authorized resource receipt is invalid.");
  const resource = plan.resource;
  requireCondition(typeof resource.uri === "string" && typeof resource.name === "string" &&
    typeof resource.mimeType === "string" && typeof resource.sha256 === "string" && /^[a-f0-9]{64}$/.test(resource.sha256) &&
    Number.isSafeInteger(resource.size) && (resource.size as number) >= 0 && (resource.size as number) <= 256 * 1024 * 1024,
    "invalid_resource", "The authorized resource metadata is invalid.");
  if (plan.kind === "file") return { kind: "file" };
  if (plan.kind === "image" || plan.kind === "audio") {
    const output = createOutput(pwd, () => signal.throwIfAborted());
    const source = { uri: resource.uri, mimeType: resource.mimeType };
    return plan.kind === "image" ? { kind: "image", value: output.image(source) } : { kind: "audio", value: output.audio(source) };
  }
  requireCondition(plan.kind === "text" && isPlainRecord(plan.ref) && plan.ref.id === resource.uri && plan.ref.kind === "buffer" &&
    plan.ref.name === resource.name && plan.ref.contentType === resource.mimeType &&
    (plan.startLine === undefined || isLine(plan.startLine)) && (plan.endLine === undefined || isLine(plan.endLine)),
    "invalid_resource", "The authorized text reader is invalid.");
  const identity = { size: resource.size as number, sha256: resource.sha256, mimeType: resource.mimeType };
  const text = await renderResourceText(visit => visitGoResourceBytes(plan.ref, scope, call, signal, identity, visit),
    { name: resource.name, mimeType: resource.mimeType, uri: resource.uri }, plan.startLine, plan.endLine, signal);
  // The verified staging read can take time. Check current resource authority
  // again before delivering text, and never substitute another identity.
  const current = await call("artifacts.metadata", { instanceId: scope.instanceId, runId: scope.runId, uri: resource.uri }, signal);
  requireCondition(isPlainRecord(current) && current.uri === resource.uri && current.sha256 === identity.sha256 &&
    current.size === identity.size && current.mimeType === identity.mimeType && current.name === resource.name,
    "resource_changed", "The resource no longer matches its original identity.");
  signal.throwIfAborted();
  return { kind: "text", value: text };
}
