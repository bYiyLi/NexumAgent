import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import { requireCondition } from "../contracts/errors.js";
import {
  mcpSource, wrapMcpResourceResult, wrapMcpResult,
  type McpMethod, type McpSourceIdentity,
} from "../results/mcp.js";
import {
  TransferOfferDelivery, type TransferOfferScope, type TransferRequest,
} from "../transfer/offers.js";

/** These services belong to the trusted host, never to guest input. */
export interface HostBrandServices {
  readonly authorizeMcp?: (source: McpSourceIdentity, method: McpMethod | "resources/read") => boolean;
  readonly offers?: TransferOfferDelivery;
  readonly transferScope?: TransferOfferScope;
}

/** Rebuild private identities only from the Go-owned sdk.call response. */
export function decodeHostBrands(value: unknown, brands: unknown,
  services?: HostBrandServices): unknown {
  requireCondition(Array.isArray(brands) && brands.length <= 128,
    "invalid_sdk_result", "The SDK brands are invalid.");
  if (brands.length === 0) return value;
  requireCondition(services, "sdk_brand_unavailable", "Source-aware SDK results are unavailable.");
  const paths = new Set<string>();
  // Check every placeholder before issuing any authority-bearing value.
  for (const item of brands) {
    requireCondition(isPlainRecord(item) && Array.isArray(item.path) && item.path.length <= 32 &&
      Object.hasOwn(item, "data") && (item.kind === "mcp" || item.kind === "transfer"),
    "invalid_sdk_result", "The SDK brand is invalid.");
    requireCondition(item.path.every((part: unknown) => typeof part === "string" ||
      (typeof part === "number" && Number.isSafeInteger(part) && part >= 0)),
    "invalid_sdk_result", "The SDK brand path is invalid.");
    const path = item.path as (string | number)[];
    const key = canonicalJson(path);
    requireCondition(!paths.has(key), "invalid_sdk_result", "The SDK brand path is duplicated.");
    paths.add(key);
    let cursor: unknown = value;
    for (const part of path.slice(0, -1)) {
      requireCondition(cursor !== null && typeof cursor === "object" && Object.hasOwn(cursor, part),
        "invalid_sdk_result", "The SDK brand path does not exist.");
      cursor = (cursor as Record<string, unknown>)[String(part)];
    }
    const last = path[path.length - 1];
    requireCondition(path.length === 0 ? value === null :
      cursor !== null && typeof cursor === "object" && last !== undefined &&
      Object.hasOwn(cursor, last) && (cursor as Record<string, unknown>)[String(last)] === null,
    "invalid_sdk_result", "The SDK brand placeholder is invalid.");
  }
  for (const item of brands) {
    requireCondition(isPlainRecord(item) && Array.isArray(item.path) && item.path.length <= 32 &&
      Object.hasOwn(item, "data") && (item.kind === "mcp" || item.kind === "transfer"),
    "invalid_sdk_result", "The SDK brand is invalid.");
    requireCondition(item.path.every((part: unknown) => typeof part === "string" ||
      (typeof part === "number" && Number.isSafeInteger(part) && part >= 0)),
    "invalid_sdk_result", "The SDK brand path is invalid.");
    const path = item.path as (string | number)[];
    let cursor: unknown = value;
    for (const part of path.slice(0, -1)) {
      requireCondition(cursor !== null && typeof cursor === "object" && Object.hasOwn(cursor, part),
        "invalid_sdk_result", "The SDK brand path does not exist.");
      cursor = (cursor as Record<string, unknown>)[String(part)];
    }
    const last = path[path.length - 1];
    requireCondition(path.length === 0 ? value === null :
      cursor !== null && typeof cursor === "object" && last !== undefined &&
      Object.hasOwn(cursor, last) && (cursor as Record<string, unknown>)[String(last)] === null,
    "invalid_sdk_result", "The SDK brand placeholder is invalid.");
    let branded: unknown;
    if (item.kind === "mcp") {
      requireCondition(typeof item.method === "string", "invalid_sdk_result", "The MCP method is missing.");
      const source = mcpSource(item.source);
      const method = item.method as McpMethod | "resources/read";
      requireCondition(services.authorizeMcp?.(source, method) === true,
        "mcp_source_unavailable", "The MCP source is unavailable or not authorized.");
      branded = method === "resources/read"
        ? wrapMcpResourceResult(item.data, source)
        : wrapMcpResult(item.data, source, method);
    } else {
      requireCondition(services.offers && services.transferScope,
        "sdk_brand_unavailable", "Transfer delivery is unavailable.");
      requireCondition(isPlainRecord(item.request), "invalid_sdk_result", "The transfer request is missing.");
      branded = services.offers.issue(item.data, item.request as TransferRequest, services.transferScope);
    }
    if (path.length === 0) {
      value = branded;
      continue;
    }
    Object.defineProperty(cursor!, String(last), { value: branded, writable: true,
      enumerable: true, configurable: true });
  }
  return value;
}
