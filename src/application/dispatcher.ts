import { requireCondition } from "../contracts/errors.js";
import { validateContract } from "../contracts/validation.js";
import { validateConnectionV2 } from "../contracts/wire-validation.js";
import type { WireConnectionV2, WireInvokeV2 } from "../contracts/wire.js";

export type ApplicationHandler = (input: any) => unknown | Promise<unknown>;
/** Wire validation and routing only; the owning Core services implement behavior. */
export async function dispatchApplication(
  message: WireInvokeV2,
  binding: WireConnectionV2,
  handlers: Readonly<Record<string, ApplicationHandler>>,
): Promise<unknown> {
  validateContract("wire", message);
  validateConnectionV2(message.context.connection, binding);
  const handler = Object.hasOwn(handlers, message.operation)
    ? handlers[message.operation]
    : undefined;
  requireCondition(
    handler,
    "invalid_control_direction",
    "This operation is not an Agent application entry.",
  );
  const output = await handler(message.input);
  validateContract("wire.output:" + message.operation, output);
  return output;
}
