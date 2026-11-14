import { AgentError, requireCondition } from "./errors.js";
import { canonicalJson, requestWindow } from "./json.js";
import { validateContract } from "./validation.js";
import {
  POLICY_LEASE_MS_V2,
  MAX_RESOURCES_READ_BODY_BYTES_V2,
  MAX_STATE_VALUE_BYTES_V2,
  MAX_STATE_RECEIPT_BYTES_V2,
  MAX_HOST_FEATURE_BYTES_V2,
  type WireAuthorizationV2,
  type WireConnectionV2,
  type WireEnvelopeV2,
  type WireOperationV2,
  type WireRunStartInputV2,
} from "./wire.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value as RecordValue;
const check = (ok: unknown, message: string): void =>
  requireCondition(ok, "invalid_wire", message);

/** Cross-field checks supplement the shared structural schemas; they grant no authority. */
export function validateWireSemantics(contract: string, value: unknown): void {
  const data = record(value);
  if (contract === "wire") {
    if (data.type === "invoke") {
      const context = record(data.context);
      callerFeatures(record(context.caller));
      if (record(context.caller).source === "owner_session")
        check(
          [
            "agent.project.resolve",
            "agent.project.inspect",
            "agent.run.inspect",
            "agent.context.read",
          ].includes(String(data.operation)),
          "An owner session may only inspect its authorized project and context.",
        );
      if (data.operation === "agent.run.inspect")
        check(
          record(context.caller).source === "owner_session",
          "Only an owner session may inspect retained Run facts.",
        );
      const connection = record(context.connection);
      const authorization = record(context.authorization);
      check(
        connection.agentId === authorization.agentId,
        "The policy targets a different Agent.",
      );
      const input = record(data.input);
      if (input.agentId !== undefined)
        check(
          input.agentId === connection.agentId,
          "The operation targets a different Agent.",
        );
      if (input.taskId !== undefined)
        check(
          taskAgent(String(input.taskId)) === connection.agentId,
          "The Task targets a different Agent.",
        );
      if (
        input.projectId !== undefined &&
        authorization.projectId !== undefined
      )
        check(
          input.projectId === authorization.projectId,
          "The project scope does not match the operation.",
        );
      if (data.operation === "agent.open" && input.projectId !== undefined)
        check(
          input.projectId === authorization.projectId,
          "Opening a project requires its matching current project policy.",
        );
      if (data.operation === "host.request") {
        const caller = record(context.caller);
        check(
          input.hostRef === caller.hostRef &&
            record(caller.hostCapabilities ?? {})[String(input.action)] ===
              true,
          "The Host request must use the original negotiated Host association and capability.",
        );
      }
      for (const candidate of [
        input.uri,
        input.resourceUri,
        record(input.target ?? {}).resourceUri,
        ...((input.attachments ?? []) as RecordValue[]).map((item) => item.uri),
      ]) {
        if (candidate !== undefined) {
          let owner: string | undefined;
          try {
            owner = decodeURIComponent(String(candidate).split("/")[3] ?? "");
          } catch {
            /* rejected below */
          }
          check(
            owner === connection.agentId,
            "A resource belongs to a different Agent.",
          );
        }
      }
      validateOperation(String(data.operation), input, false);
    } else if (data.type === "result") {
      validateOperation(String(data.operation), record(data.output), true);
    } else if (data.type === "event") {
      if (record(data.data).caller !== undefined)
        callerFeatures(record(record(data.data).caller));
      if (data.name === "agent.authorization.changed") {
        const policy = record(data.data).authorization;
        if (policy !== null)
          check(
            record(policy).agentId === record(data.connection).agentId,
            "The policy event targets a different Agent.",
          );
      }
    }
  } else if (contract.startsWith("wire.input:")) {
    validateOperation(contract.slice("wire.input:".length), data, false);
  } else if (contract.startsWith("wire.output:")) {
    validateOperation(contract.slice("wire.output:".length), data, true);
  } else if (contract === "wire.body:ResourcesRead") {
    for (const content of data.contents as RecordValue[]) {
      if (typeof content.blob !== "string") continue;
      const blob = content.blob;
      const padding = blob.endsWith("==") ? 2 : blob.endsWith("=") ? 1 : 0;
      check(
        blob.length % 4 !== 1 &&
          (!padding || blob.length % 4 === 0) &&
          (!padding || (blob.length - padding) % 4 === 4 - padding),
        "A resource blob must contain valid base64 text.",
      );
    }
  } else if (contract === "wire.type:StateValue") {
    canonicalJson(data.value, MAX_STATE_VALUE_BYTES_V2);
    canonicalJson(data, MAX_STATE_RECEIPT_BYTES_V2);
  } else if (contract === "wire.type:HostFeatures") {
    canonicalJson(data, MAX_HOST_FEATURE_BYTES_V2);
  } else if (
    contract === "wire.type:Caller" ||
    contract === "wire.type:McpCaller"
  ) {
    callerFeatures(data);
  } else if (
    contract === "wire.type:InvocationContext" ||
    contract === "wire.type:McpInvocationContext" ||
    contract === "wire.type:OwnerSessionInvocationContext"
  ) {
    callerFeatures(record(data.caller));
  } else if (contract === "wire.type:TaskBinding") {
    taskBinding(data);
  } else if (contract === "wire.type:TaskId") {
    taskAgent(String(value));
  } else if (
    contract === "wire.type:TaskView" ||
    contract === "wire.type:TaskCancelOutput"
  ) {
    taskView(data);
  } else if (contract === "wire.type:TaskError") {
    check(
      Buffer.byteLength(String(data.message)) <= 4096,
      "The Task error message exceeds its UTF8 budget.",
    );
  }
}

function taskAgent(taskId: string): string {
  try {
    const encoded = taskId.slice(8);
    const bytes = Buffer.from(encoded, "base64url");
    const text = bytes.toString("utf8");
    const route: unknown = JSON.parse(text);
    check(
      /^nx_task_[A-Za-z0-9_-]+$/.test(taskId) &&
        taskId.length <= 1024 &&
        bytes.toString("base64url") === encoded &&
        Buffer.from(text).equals(bytes) &&
        Array.isArray(route) &&
        route.length === 2 &&
        typeof route[0] === "string" &&
        route[0].length > 0 &&
        [...route[0]].length <= 256 &&
        typeof route[1] === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          route[1],
        ),
      "The Task identity must carry its canonical Agent route and UUID.",
    );
    return (route as [string, string])[0];
  } catch {
    throw new AgentError("invalid_wire", "The Task identity is invalid.");
  }
}
function taskBinding(value: RecordValue): void {
  check(
    taskAgent(String(value.taskId)) === value.agentId,
    "The Task binding has a different Agent route.",
  );
  if (value.error !== undefined)
    check(
      Buffer.byteLength(String(record(value.error).message)) <= 4096,
      "The Task error message exceeds its UTF8 budget.",
    );
}
function taskView(value: RecordValue): void {
  const task = record(value.task);
  taskBinding(task);
  const view = record(value.view);
  check(
    task.runId === record(view.run).runId,
    "The Task must retain its original run binding.",
  );
  const result = view.result;
  if (result && record(result).body !== undefined)
    modelBody(record(result).body);
}

function callerFeatures(value: RecordValue): void {
  if (value.source === "owner_session")
    check(
      value.clientId === `nexum-console:${String(value.sessionRef)}`,
      "An owner session must retain its original session association.",
    );
  if (value.hostFeatures !== undefined)
    canonicalJson(value.hostFeatures, MAX_HOST_FEATURE_BYTES_V2);
}

function fixedStream(value: unknown): void {
  const stream = record(value);
  if (stream.size !== undefined)
    check(
      Number(stream.size) <= Number(stream.maxBytes),
      "The fixed stream exceeds its byte budget.",
    );
}
function submission(value: RecordValue): void {
  if (value.requestId === undefined) return;
  const request = String(value.requestId);
  const declared = record(value.submission);
  const issuedAt = Number(/^req_(\d{13})_/.exec(request)?.[1]);
  check(
    declared.issuedAt === issuedAt &&
      declared.expiresAt === issuedAt + 86_400_000,
    "The submission window must exactly match its request identifier.",
  );
}
function modelBody(value: unknown): void {
  const body = record(value);
  fixedStream(body);
  check(
    body.purpose === "result-meta" &&
      body.direction === "agent-to-cloud" &&
      body.mimeType === "application/json",
    "A model description body requires its fixed outgoing JSON stream.",
  );
}
function validateOperation(
  operation: string,
  value: RecordValue,
  output: boolean,
): void {
  if (operation === "agent.context.read") {
    if (!output)
      check(
        value.cursor === undefined || value.startLine === undefined,
        "A material cursor cannot switch its original start line.",
      );
    if (output && value.startLine !== undefined)
      check(
        Number(value.endLine) >= Number(value.startLine),
        "A material line range must be ordered.",
      );
    const relative = (path: unknown, empty: boolean): void =>
      check(
        typeof path === "string" &&
          ((empty && path === "") ||
            (path !== "" &&
              !path.startsWith("/") &&
              !path.includes("\\") &&
              !path.includes("\0") &&
              !/^[A-Za-z]:/.test(path) &&
              path
                .split("/")
                .every(
                  (part) => part !== "" && part !== "." && part !== "..",
                ))),
        "A material path must stay relative to its selected material root.",
      );
    if (!output && value.relativePath !== undefined)
      relative(value.relativePath, true);
    if (output && value.entries !== undefined)
      for (const entry of value.entries as RecordValue[])
        relative(entry.displayPath, false);
  }
  if (operation.startsWith("agent.tasks.")) {
    if (output) {
      if (operation === "agent.tasks.create") taskBinding(value);
      else taskView(value);
    } else if (value.taskId !== undefined) taskAgent(String(value.taskId));
  }
  if (
    output &&
    [
      "agent.run.start",
      "agent.run.get",
      "agent.run.inspect",
      "agent.run.input",
    ].includes(operation)
  ) {
    const result = value.result;
    if (result && record(result).body !== undefined)
      modelBody(record(result).body);
  }
  if (output && operation === "agent.run.inspect") {
    const result = record(value.result ?? {});
    check(
      value.transient === undefined &&
        result.body === undefined &&
        result.protocolMeta === undefined,
      "A retained Run inspection cannot allocate streams or expose transient delivery authority.",
    );
  }
  if (output && operation === "agent.run.cancel") {
    const result = record(value.view).result;
    if (result && record(result).body !== undefined)
      modelBody(record(result).body);
  }
  if (
    output &&
    operation === "agent.resources.list" &&
    value.body !== undefined
  )
    modelBody(value.body);
  if (!output && operation === "agent.run.start") submission(value);
  if (
    !output &&
    operation === "agent.run.list" &&
    value.from !== undefined &&
    value.to !== undefined
  )
    check(
      Date.parse(String(value.from)) <= Date.parse(String(value.to)),
      "The history range is reversed.",
    );
  if (!output && operation === "transfer.prepare") {
    const target = record(value.target);
    if (value.direction === "upload")
      check(
        target.path !== undefined && target.resourceUri === undefined,
        "An upload needs one canonical destination path.",
      );
    else
      check(
        target.resourceUri !== undefined &&
          target.path === undefined &&
          target.size !== undefined &&
          target.sha256 !== undefined &&
          target.mimeType !== undefined,
        "A download needs the fixed resource description.",
      );
    for (const name of ["size", "expectedSize"])
      if (target[name] !== undefined)
        check(
          Number(target[name]) <= Number(value.maxBytes),
          "The transfer exceeds its declared byte budget.",
        );
  }
  if (!output && operation === "agent.transfer.commitClaim") {
    const stream = record(value.stream);
    check(
      stream.purpose === "transfer",
      "A transfer claim requires a transfer stream.",
    );
    fixedStream(stream);
    if (value.contentLength !== undefined)
      check(
        Number(value.contentLength) <= Number(stream.maxBytes),
        "The content length exceeds the stream budget.",
      );
  }
  if (output && operation === "attachment.open") {
    const stream = record(value.stream);
    fixedStream(stream);
    check(
      stream.purpose === "attachment" && stream.direction === "cloud-to-agent",
      "An attachment needs its own incoming stream.",
    );
    if (value.size !== undefined)
      check(
        Number(value.size) <= Number(stream.maxBytes),
        "The attachment size exceeds its stream budget.",
      );
    for (const key of ["size", "sha256", "mimeType"])
      if (value[key] !== undefined && stream[key] !== undefined)
        check(
          value[key] === stream[key],
          "The attachment metadata disagrees with its stream.",
        );
  }
  if (operation === "stream.prepare")
    fixedStream(output ? value.stream : value);
  if (operation.startsWith("agent.maintenance.") && value.body !== undefined) {
    const stream = record(value.body);
    fixedStream(stream);
    check(
      stream.purpose === "maintenance" &&
        stream.direction === (output ? "agent-to-cloud" : "cloud-to-agent") &&
        stream.mimeType === "application/json",
      "A maintenance body needs its fixed JSON stream in the correct direction.",
    );
  }
  if (operation === "host.request") {
    const stream = record(value.body);
    fixedStream(stream);
    check(
      stream.purpose === (output ? "host-response" : "host-request") &&
        stream.direction === (output ? "cloud-to-agent" : "agent-to-cloud") &&
        stream.mimeType === "application/json",
      "A Host body needs the correct fixed JSON stream direction and purpose.",
    );
  }
  if (output && operation === "agent.resources.read") {
    if (value.body !== undefined) {
      modelBody(value.body);
      check(
        Number(record(value.body).maxBytes) <= MAX_RESOURCES_READ_BODY_BYTES_V2,
        "A complete resource result body exceeds its independent JSON budget.",
      );
    }
    for (const content of (value.contents ?? []) as RecordValue[]) {
      if (content.stream !== undefined) {
        const stream = record(content.stream);
        fixedStream(stream);
        check(
          stream.purpose === "resource" &&
            stream.direction === "agent-to-cloud" &&
            stream.mimeType === content.mimeType,
          "A resource body needs the matching resource stream.",
        );
      }
    }
  }
  if (operation.startsWith("state.user.")) {
    if (!output) {
      check(
        typeof value.key === "string" &&
          Buffer.byteLength(value.key) <= 256 &&
          !value.key.includes("\0"),
        "A user-state key must be nonempty bounded UTF8 text without NUL.",
      );
      if (operation === "state.user.set")
        canonicalJson(value.value, MAX_STATE_VALUE_BYTES_V2);
    } else {
      const state = operation === "state.user.get" ? value.state : value;
      if (state && operation !== "state.user.delete")
        canonicalJson(record(state).value, MAX_STATE_VALUE_BYTES_V2);
      canonicalJson(value, MAX_STATE_RECEIPT_BYTES_V2);
    }
  }
}

/** Called at admission/refresh against the current trusted clock, never by schema fixtures. */
export function validatePolicyLeaseV2(
  policy: WireAuthorizationV2,
  now = Date.now(),
): void {
  validateContract("wire.type:Authorization", policy);
  const expiry = Date.parse(policy.expiresAt);
  requireCondition(
    Number.isSafeInteger(now) &&
      expiry > now &&
      expiry <= now + POLICY_LEASE_MS_V2,
    "authorization_expired",
    "The current policy lease is expired or exceeds its allowed lifetime.",
  );
}
export function validateSubmissionV2(
  input: WireRunStartInputV2,
  now = Date.now(),
): void {
  validateContract("wire.input:agent.run.start", input);
  if (input.requestId === undefined) return;
  const window = requestWindow(input.requestId, now);
  check(
    input.submission?.issuedAt === window.issuedAt &&
      input.submission.expiresAt === window.expiresAt,
    "The submission window does not match the accepted request.",
  );
}
export function validateConnectionV2(
  actual: WireConnectionV2,
  expected: WireConnectionV2,
): void {
  validateContract("wire.type:Connection", actual);
  for (const key of [
    "agentId",
    "profile",
    "bootId",
    "cloudEnvironment",
    "connectionId",
  ] as const)
    requireCondition(
      actual[key] === expected[key],
      "connection_mismatch",
      "The message belongs to another connection binding.",
    );
}
export function validateReplyV2(
  value: unknown,
  id: string,
  operation: WireOperationV2,
): void {
  validateContract("wire", value);
  const message = record(value);
  requireCondition(
    (message.type === "result" || message.type === "error") &&
      message.id === id &&
      (message.type !== "result" || message.operation === operation),
    "reply_mismatch",
    "The reply does not match its original invocation.",
  );
}
export function decodeEnvelopeV2(bytes: string | Uint8Array): WireEnvelopeV2 {
  let raw: string;
  try {
    raw =
      typeof bytes === "string"
        ? bytes
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AgentError(
      "invalid_json",
      "The control message contains invalid UTF-8.",
    );
  }
  requireCondition(
    Buffer.byteLength(raw) <= 1024 * 1024,
    "data_too_large",
    "The control message exceeds its byte budget.",
  );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AgentError(
      "invalid_json",
      "The control message contains invalid JSON.",
    );
  }
  canonicalJson(value);
  validateContract("wire", value);
  return value as WireEnvelopeV2;
}
