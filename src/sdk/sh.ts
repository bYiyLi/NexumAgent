import path from "node:path";
import { constants } from "node:os";
import { types } from "node:util";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { safeErrorData } from "../contracts/error-data.js";
import { isPlainRecord } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";
import type {
  ExtensionFactory,
  Invocation,
  MethodDefinition,
} from "../extensions/api.js";
import type {
  ResourceSnapshot,
  ResourceQuery,
} from "../extensions/resources.js";
import { ManagedProcess, isManagedProcess } from "../process/managed.js";
import {
  normalizeLaunch,
  copyProcessInput,
  prepareLaunch,
  type LaunchInput,
} from "../process/launch.js";
import {
  discoverEnvironment,
  whichExecutable,
} from "../process/environment.js";
import { ProcessOutputLog } from "../process/output-log.js";

const kind = "sh.process";
const dialect = "https://json-schema.org/draft/2020-12/schema";
const idSchema = { type: "string", pattern: "^res_[0-9a-f]{32}$" };
const textSchema = { type: "string", minLength: 1, maxLength: 1024 };
const readProperties = {
  processId: idSchema,
  cursor: { type: "string", minLength: 1, maxLength: 4096 },
  maxBytes: { type: "integer", minimum: 1, maximum: 1024 * 1024 },
  encoding: {
    anyOf: [{ type: "string", minLength: 1, maxLength: 32 }, { type: "null" }],
  },
  waitMs: { type: "integer", minimum: 0, maximum: 30000 },
};
type ReadInput = {
  processId: string;
  cursor?: string;
  maxBytes?: number;
  encoding?: BufferEncoding | null;
  waitMs?: number;
};
function schema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): unknown {
  return {
    $schema: dialect,
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
function record(
  args: readonly unknown[],
  fields: readonly string[],
  optional = false,
): Record<string, unknown> {
  requireCondition(
    args.length === 1 || (optional && args.length === 0),
    "invalid_process_arguments",
    "This sh method accepts one explicit input object.",
  );
  const input = args.length ? args[0] : {};
  requireCondition(
    isPlainRecord(input),
    "invalid_process_arguments",
    "sh input must be an ordinary data object.",
  );
  const result = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(input);
  requireCondition(
    keys.length <= fields.length,
    "invalid_process_arguments",
    "The sh input has too many fields.",
  );
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    requireCondition(
      typeof key === "string" &&
        fields.includes(key) &&
        descriptor.enumerable &&
        "value" in descriptor,
      "invalid_process_arguments",
      "sh arguments cannot contain unknown fields, symbols, hidden fields or accessors.",
    );
    result[key] = descriptor.value;
  }
  return result;
}
function missingLiveResource(cause: unknown): boolean {
  if (
    !isAgentError(cause) ||
    Object.getPrototypeOf(cause) !== AgentError.prototype
  )
    return false;
  const code = Object.getOwnPropertyDescriptor(cause, "code");
  return (
    !!code &&
    "value" in code &&
    ["resource_unavailable", "resource_closed"].includes(code.value)
  );
}
function processError(cause: unknown, processId: string): AgentError {
  const safe = safeErrorData(cause, {
    code: "process_failed",
    message:
      "The managed process failed; inspect its retained status and output.",
  });
  const code = (value: unknown): string | undefined => {
    if (
      !value ||
      typeof value !== "object" ||
      types.isProxy(value) ||
      !types.isNativeError(value)
    )
      return;
    const field = Object.getOwnPropertyDescriptor(value, "code");
    return field &&
      "value" in field &&
      typeof field.value === "string" &&
      /^[A-Za-z0-9_.-]{1,256}$/.test(field.value)
      ? field.value
      : undefined;
  };
  const inner =
    cause && typeof cause === "object" && !types.isProxy(cause)
      ? Object.getOwnPropertyDescriptor(cause, "cause")
      : undefined;
  const causeCode =
    inner && "value" in inner
      ? code(inner.value)
      : !isAgentError(cause)
        ? code(cause)
        : undefined;
  return new AgentError(
    safe.code as string,
    safe.message as string,
    {
      ...(isPlainRecord(safe.details) ? safe.details : {}),
      ...(causeCode ? { causeCode } : {}),
      processId,
    } as JsonObject,
  );
}
function snapshot(resource: ResourceSnapshot): JsonObject {
  requireCondition(
    resource.kind === kind,
    "resource_kind_mismatch",
    "This resource is not a managed sh process.",
  );
  const detail = resource.details;
  return {
    processId: resource.id,
    status: resource.status,
    state:
      resource.status === "unavailable"
        ? "unavailable"
        : (detail.state ?? resource.status),
    lifetime: resource.lifetime,
    originRunId: resource.originRunId,
    contextId: resource.contextId,
    origin: resource.origin,
    createdAt: resource.createdAt,
    closedAt: resource.closedAt,
    handedOffAt: resource.handedOffAt,
    controlAvailable: resource.controlAvailable,
    pid: detail.pid ?? null,
    exitCode: detail.exitCode ?? null,
    signal: detail.exitSignal ?? null,
    outputComplete: detail.outputComplete ?? false,
    details: detail,
  };
}

/** Nine process operations registered through the same public extension contract as npm SDKs. */
export const shExtension: ExtensionFactory = (host) => {
  const paths = host.context.paths;
  requireCondition(
    isPlainRecord(paths) &&
      typeof paths.logs === "string" &&
      path.isAbsolute(paths.logs),
    "invalid_process_context",
    "sh needs the Agent profile's public log directory.",
  );
  const agentRoot = path.dirname(paths.logs);
  const outputPath = (id: string) =>
    path.join(agentRoot, "logs", "processes", id + ".output");
  function currentOutput(call: Invocation, id: string): void {
    call.signal.throwIfAborted();
    call.authorize({ type: "path", value: outputPath(id), access: "read" });
  }
  async function live(call: Invocation, id: string): Promise<ManagedProcess> {
    const resource = await call.resources.get<ManagedProcess>(id);
    requireCondition(
      resource.kind === kind && isManagedProcess(resource.value),
      "resource_kind_mismatch",
      "This control belongs to another managed resource implementation.",
    );
    call.signal.throwIfAborted();
    return resource.value;
  }
  async function read(
    call: Invocation,
    input: ReadInput,
    known?: ManagedProcess,
  ): Promise<JsonObject> {
    let resource = await call.resources.describe(input.processId);
    snapshot(resource);
    currentOutput(call, input.processId);
    let managed = known;
    if (!managed && resource.controlAvailable) {
      try {
        managed = await live(call, input.processId);
      } catch (cause) {
        if (!missingLiveResource(cause)) throw cause;
      }
    }
    const revision = managed?.revision;
    let historical: ProcessOutputLog | undefined;
    try {
      let log = managed?.outputReady ? managed.log : undefined;
      if (!managed) {
        historical = new ProcessOutputLog(agentRoot, input.processId);
        await historical.open({ readOnly: true, signal: call.signal });
        log = historical;
      }
      const page = () =>
        log
          ? log.read({
              cursor: input.cursor,
              maxBytes: input.maxBytes,
              encoding: input.encoding,
              signal: call.signal,
            })
          : Promise.resolve({
              output: [],
              nextCursor: null,
              hasMoreOutput: false,
              truncated: false,
              outputComplete: false,
            });
      if (!log && input.cursor !== undefined)
        throw new AgentError(
          "output_not_ready",
          "The process output cannot validate a cursor before its log is ready.",
        );
      let output = await page();
      if (
        managed &&
        !output.output.length &&
        !output.hasMoreOutput &&
        !output.outputComplete &&
        (input.waitMs ?? 0) > 0
      ) {
        await managed.waitForChange(revision!, input.waitMs!, call.signal);
        log = managed.outputReady ? managed.log : undefined;
        output = await page();
      }
      resource = await call.resources.describe(input.processId);
      currentOutput(call, input.processId);
      return { ...snapshot(resource), ...output } as unknown as JsonObject;
    } finally {
      await historical?.close();
    }
  }
  async function launch(
    input: LaunchInput,
    call: Invocation,
    mode: "exec" | "start",
  ): Promise<JsonObject> {
    const managed = new ManagedProcess(agentRoot, input, mode);
    const ref = await call.resources.register({ kind, value: managed });
    let handedOff = false;
    try {
      managed.bind(ref);
      await managed.start((signal) =>
        prepareLaunch(
          input,
          call.context.pwd as string,
          signal,
          (value, access) => call.authorize({ type: "path", value, access }),
        ),
      );
      if (mode === "start") {
        if (input.background) {
          await call.resources.handoff(ref.id);
          handedOff = true;
        }
        return snapshot(await call.resources.describe(ref.id));
      }
      await managed.wait();
      const result = await read(call, { processId: ref.id }, managed);
      if (managed.failure) throw processError(managed.failure, ref.id);
      if (input.check && (result.exitCode !== 0 || result.signal !== null))
        throw new AgentError(
          "process_exit_failed",
          "The process exited with a non-zero status or signal; retained output remains readable.",
          {
            processId: ref.id,
            exitCode: result.exitCode!,
            signal: result.signal!,
          },
        );
      return result;
    } catch (cause) {
      if (!handedOff) await managed.dispose(cause).catch(() => {});
      throw processError(cause, ref.id);
    }
  }
  const method = (
    description: string,
    permission: string,
    inputSchema: unknown,
    normalize: MethodDefinition["normalize"],
    handle: MethodDefinition["handle"],
  ): MethodDefinition => ({
    description,
    permissions: [permission],
    inputSchema,
    normalize,
    handle,
  });
  return {
    methods: {
      exec: method(
        "执行命令并等待真实退出、受管后代及输出收尾。",
        "sh.execute",
        { $schema: dialect, type: "object" },
        (args) => normalizeLaunch(args, "exec"),
        (input, call) => launch(input, call, "exec"),
      ),
      start: method(
        "登记并启动受管进程；仅显式background才交接到后台。",
        "sh.execute",
        { $schema: dialect, type: "object" },
        (args) => normalizeLaunch(args, "start"),
        (input, call) => launch(input, call, "start"),
      ),
      get: method(
        "读取同一托管进程的状态、增量输出并可有界等待。",
        "sh.read",
        schema(readProperties, ["processId"]),
        (args) => {
          const value = record(args, Object.keys(readProperties));
          requireCondition(
            value.encoding === undefined ||
              value.encoding === null ||
              (typeof value.encoding === "string" &&
                Buffer.isEncoding(value.encoding)),
            "invalid_output_encoding",
            "The process output encoding is unsupported.",
          );
          return value;
        },
        (input, call) => read(call, input),
      ),
      list: method(
        "按当前权限查询托管sh进程的活跃与历史状态。",
        "sh.read",
        schema({
          status: textSchema,
          state: textSchema,
          runId: textSchema,
          contextId: textSchema,
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string", maxLength: 4096 },
        }),
        (args) =>
          record(
            args,
            ["status", "state", "runId", "contextId", "limit", "cursor"],
            true,
          ),
        async (input: ResourceQuery, call) => {
          const page = await call.resources.list({ ...input, kind });
          return {
            items: page.items.map(snapshot),
            nextCursor: page.nextCursor,
          };
        },
      ),
      write: method(
        "按序写入托管进程；eof仅关闭普通管道输入。",
        "sh.control",
        schema({ processId: idSchema, data: true, eof: { type: "boolean" } }, [
          "processId",
        ]),
        (args) => {
          const value = record(args, ["processId", "data", "eof"]);
          requireCondition(
            Object.hasOwn(value, "data") || value.eof === true,
            "invalid_process_input",
            "write needs data or explicit eof:true.",
          );
          if (Object.hasOwn(value, "data"))
            value.data = copyProcessInput(value.data);
          return value;
        },
        async (input, call) => {
          const managed = await live(call, input.processId);
          await managed.write(
            input.data ?? new Uint8Array(),
            input.eof ?? false,
            call.signal,
          );
          return {
            processId: input.processId,
            accepted: true,
            bytes: input.data?.byteLength ?? 0,
            eof: input.eof ?? false,
          };
        },
      ),
      resize: method(
        "调整真实PTY尺寸；非PTY明确拒绝。",
        "sh.control",
        schema(
          {
            processId: idSchema,
            cols: { type: "integer", minimum: 1, maximum: 1000 },
            rows: { type: "integer", minimum: 1, maximum: 1000 },
          },
          ["processId", "cols", "rows"],
        ),
        (args) => record(args, ["processId", "cols", "rows"]),
        async (input, call) => {
          await (
            await live(call, input.processId)
          ).resize(input.cols, input.rows);
          return {
            processId: input.processId,
            accepted: true,
            cols: input.cols,
            rows: input.rows,
          };
        },
      ),
      signal: method(
        "投递受支持信号，返回投递事实而不声称已退出。",
        "sh.control",
        schema(
          {
            processId: idSchema,
            signal: { type: "string", enum: Object.keys(constants.signals) },
          },
          ["processId", "signal"],
        ),
        (args) => record(args, ["processId", "signal"]),
        async (input, call) => ({
          processId: input.processId,
          ...((await (
            await live(call, input.processId)
          ).signal(input.signal)) as object),
        }),
      ),
      stop: method(
        "请求停止受管进程树，返回真实确认状态及可继续查询的身份。",
        "sh.control",
        schema(
          {
            processId: idSchema,
            graceMs: { type: "integer", minimum: 0, maximum: 30000 },
            forceMs: { type: "integer", minimum: 0, maximum: 30000 },
          },
          ["processId"],
        ),
        (args) => record(args, ["processId", "graceMs", "forceMs"]),
        async (input, call) => {
          let managed: ManagedProcess;
          try {
            managed = await live(call, input.processId);
          } catch (cause) {
            if (!missingLiveResource(cause)) throw cause;
            const resource = await call.resources.describe(input.processId);
            const result = snapshot(resource);
            if (resource.closedAt === null) throw cause;
            const details = resource.details;
            return {
              ...result,
              accepted: false,
              confirmed: true,
              facts: {
                pid: details.pid ?? null,
                startedAt: details.startedAt ?? null,
                rootExited: details.rootExited === true,
                exitCode: details.exitCode ?? null,
                exitSignal: details.exitSignal ?? null,
                outputComplete: details.outputComplete === true,
                treeStopped: true,
                closed: true,
                stopRequested: details.stopRequested === true,
                forceRequested: details.forceRequested === true,
              },
            };
          }
          const receipt = await managed.stop({
            graceMs: input.graceMs,
            forceMs: input.forceMs,
          });
          call.signal.throwIfAborted();
          return { processId: input.processId, ...receipt };
        },
      ),
      which: method(
        "从本次真实用户环境解析CLI路径，不启动业务命令。",
        "sh.read",
        schema(
          {
            command: {
              type: "string",
              minLength: 1,
              maxLength: 262144,
              pattern: "^[^\\u0000\\r\\n]+$",
            },
            cwd: {
              type: "string",
              minLength: 1,
              maxLength: 262144,
              pattern: "^[^\\u0000]+$",
            },
          },
          ["command"],
        ),
        (args) => {
          if (args.length === 1 && typeof args[0] === "string")
            return { command: args[0] };
          return record(args, ["command", "cwd"]);
        },
        async (input, call) => {
          const cwd = path.resolve(
            call.context.pwd as string,
            input.cwd ?? (call.context.pwd as string),
          );
          call.authorize({ type: "path", value: cwd, access: "read" });
          const environment = await discoverEnvironment({
            cwd,
            signal: call.signal,
          });
          call.authorize({
            type: "path",
            value: environment.cwd,
            access: "read",
          });
          const executable = await whichExecutable(
            input.command,
            environment,
            environment.cwd,
            { signal: call.signal },
          );
          call.authorize({
            type: "path",
            value: executable.path,
            access: "execute",
          });
          call.authorize({
            type: "path",
            value: executable.launchPath,
            access: "execute",
          });
          return executable;
        },
      ),
    },
  };
};
