import { requireCondition } from "../contracts/errors.js";
import { validateContract } from "../contracts/validation.js";
import type { WireInvokeV2 } from "../contracts/wire.js";

export type ApplicationHandler = (input: any) => unknown | Promise<unknown>;
/** Route validated requests and check the response contract. */
export async function dispatchApplication(
  message: WireInvokeV2,
  handlers: Readonly<Record<string, ApplicationHandler>>,
): Promise<unknown> {
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
