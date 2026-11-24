import type { InputRequest, InputReply } from "../runtime/invocation.js";

export interface RestartReceipt {
  requested: true;
  reason: "apply-approved-updates" | "recover-agent";
  afterRun: string;
}
export interface RuntimeSDK {
  sleep(milliseconds: number): Promise<null>;
  requestInput(request: InputRequest): Promise<InputReply>;
  restart(request: { reason: RestartReceipt["reason"] }): Promise<RestartReceipt>;
}
