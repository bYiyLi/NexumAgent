import type { OutputIntent } from "./output.js";
import type { InputRequest, InputReply } from "../runtime/invocation.js";

export interface RestartReceipt {
  requested: true;
  reason: "apply-approved-updates" | "recover-agent";
  afterRun: string;
}
export interface ResourceReadOptions {
  uri: string;
  mode?: "auto" | "content";
  startLine?: number;
  endLine?: number;
}
export type ResourceReadResult =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "image" | "audio"; readonly value: OutputIntent }
  | { readonly kind: "file" };
export interface RuntimeSDK {
  readResource(options: ResourceReadOptions): Promise<ResourceReadResult>;
  sleep(milliseconds: number): Promise<null>;
  requestInput(request: InputRequest): Promise<InputReply>;
  restart(request: { reason: RestartReceipt["reason"] }): Promise<RestartReceipt>;
}
