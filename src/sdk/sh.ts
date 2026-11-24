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
import type { ContributionOrigin, JsonObject } from "../contracts/types.js";
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
import type { ProcessOutputPage } from "../process/output-log.js";
import type { Executable } from "../process/environment.js";
import type { ProcessFacts, ProcessSignalReceipt } from "../process/backend.js";
import { object, output, string, integer, boolean, nullable, array, enumeration, nonnegative, jsonObject } from "./schema.js";

type LaunchOptions = ({ command: string; args?: string[]; shellCommand?: never; shell?: never } |
  { shellCommand: string; shell?: string; command?: never; args?: never }) &
  { cwd?: string; env?: Record<string, string | null>; tty?: boolean; cols?: number; rows?: number;
    input?: string | Uint8Array; timeoutMs?: number };
export type ExecOptions = LaunchOptions & { check?: boolean; background?: false };
export type StartOptions = LaunchOptions & { background?: boolean; check?: false };
export interface ProcessSnapshot {
  processId: string;
  status: string;
  state: string;
  lifetime: ResourceSnapshot["lifetime"];
  originRunId: string | null;
  contextId: string | null;
  origin: ContributionOrigin;
  createdAt: number;
  closedAt: number | null;
  handedOffAt: number | null;
  controlAvailable: boolean;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  outputComplete: boolean;
  details: JsonObject;
}
export type ProcessRead = ProcessSnapshot & Omit<ProcessOutputPage, "nextCursor"> & { nextCursor: string | null };
export type ProcessStop = { processId: string; accepted: boolean; confirmed: boolean; facts: ProcessFacts } & Partial<ProcessSnapshot>;
export interface ShSDK {
  exec(options: ExecOptions | string): Promise<ProcessRead>;
  start(options: StartOptions | string): Promise<ProcessSnapshot>;
  get(input: ReadInput): Promise<ProcessRead>;
  list(input?: Omit<ResourceQuery, "kind">): Promise<{ items: ProcessSnapshot[]; nextCursor: string | null }>;
  write(input: { processId: string; data: string | Uint8Array; eof?: boolean } |
    { processId: string; data?: string | Uint8Array; eof: true }): Promise<{ processId: string; accepted: true; bytes: number; eof: boolean }>;
  resize(input: { processId: string; cols: number; rows: number }): Promise<{ processId: string; accepted: true; cols: number; rows: number }>;
  signal(input: { processId: string; signal: NodeJS.Signals }): Promise<{ processId: string } & ProcessSignalReceipt>;
  stop(input: { processId: string; graceMs?: number; forceMs?: number }): Promise<ProcessStop>;
  which(input: string | { command: string; cwd?: string }): Promise<Executable>;
}

export const shSdkUsage = `## JavaScript 进程示例

只有需要受管命令、PTY、进程身份或跨 Run 观察时使用 sh；普通文件读写使用 Node。

~~~javascript
const result = await sh.exec({ command: context.input.command, args: context.input.args ?? [], cwd: context.pwd });
return result;
~~~

运行前在 agent.run.start.input 提供已确认的 command 和可选 args；CLI 路径不明确时先查 sh.which。需要跨 Run 保留进程时明确使用 sh.start({ command, args, background: true })，之后按实际 processId 调用 sh.get({ processId }) / sh.stop({ processId })。观察超时不是进程退出；停止请求返回后仍以真实关闭状态为准。

## 调用参数与结果

- exec(options)、start(options) 各接受一个对象或 shellCommand 字符串。对象选择 command: string + args?: string[]，或 shellCommand: string + shell?: string，不能混用；可选 cwd、env: Record<string,string|null>、tty、cols、rows、input: string | Uint8Array、timeoutMs。cols/rows 只用于 tty，timeoutMs 是 1–2147483647 毫秒；input 上限 1 MiB。
- start 可用 background: true 交接后台；exec 可用 check: true 在非零退出/信号退出时报 process_exit_failed。background 不用于 exec，check 不用于 start。
- get({processId, cursor?, maxBytes?, encoding?, waitMs?}) 返回同一进程快照和输出页 {output,nextCursor,hasMoreOutput,truncated,outputComplete}；encoding 为 null 时保留字节。
- list({status?,state?,runId?,contextId?,limit?,cursor?}?) 返回 {items: 进程快照[], nextCursor}。
- write({processId,data?: string | Uint8Array,eof?: boolean}) 返回 {processId,accepted,bytes,eof}，至少提供 data 或 eof:true。
- resize({processId,cols,rows}) 返回 {processId,accepted,cols,rows}；只支持 PTY。
- signal({processId,signal}) 返回投递回执；stop({processId,graceMs?,forceMs?}) 返回 accepted、confirmed 和真实 facts，不能把 accepted 当退出。
- which(command: string | {command: string,cwd?: string}) 返回实际可执行文件解析结果，不启动命令。

进程快照含 processId/status/state/lifetime、originRunId/contextId/origin、createdAt/closedAt/handedOffAt、controlAvailable、pid/exitCode/signal/outputComplete/details。exec 等待实际退出和输出收尾，返回进程快照与输出页；start 返回启动快照。exec/start 的方法 inputSchema 描述归一化后的对象（包含默认 args/env/tty/cols/rows/background/check）；调用时这些默认字段可省略。cols/rows 启动范围 1–10000，resize 范围 1–1000；文本和参数另有 UTF-8 字节预算。write.data 和启动 input 在归一化后是原生 Uint8Array；output[].data 为字符串或原生 Buffer，不是 JSON 数组。invalid_process_arguments、invalid_process_input、invalid_output_encoding 表示输入不合法；process_exit_failed、process_timeout 或 I/O 失败时保留 processId，回读原进程及输出，不盲目重启同一业务。
`;

const kind = "sh.process";
const dialect = "https://json-schema.org/draft/2020-12/schema";
const idSchema = { type: "string", pattern: "^res_[0-9a-f]{32}$" };
const nativeBytes = { type: "object", description: "Native Uint8Array/Buffer; verified and copied by the native byte normalizer. Not a JSON object or number array." };
const boundedText = { type: "string", maxLength: 262144, pattern: "^[^\\u0000]*$" };
const commandText = { ...boundedText, minLength: 1, pattern: "^[^\\u0000\\r\\n]+$" };
const launchSchema = (mode: "exec" | "start") => ({
  $schema: dialect,
  ...object({
    command: commandText,
    shellCommand: { ...boundedText, minLength: 1, maxLength: 1048576 },
    shell: commandText,
    cwd: { ...boundedText, minLength: 1 },
    args: { type: "array", maxItems: 4096, items: boundedText },
    env: { type: "object", maxProperties: 4096, additionalProperties: nullable(boundedText),
      propertyNames: { minLength: 1, maxLength: 1024, pattern: "^[^=\\u0000]+$" } },
    tty: boolean,
    cols: { type: "integer", minimum: 1, maximum: 10000 },
    rows: { type: "integer", minimum: 1, maximum: 10000 },
    input: nativeBytes,
    background: mode === "exec" ? { const: false } : boolean,
    check: mode === "start" ? { const: false } : boolean,
    timeoutMs: { type: "integer", minimum: 1, maximum: 2147483647 },
  }, ["args", "env", "tty", "cols", "rows", "background", "check"]),
  oneOf: [
    { properties: { command: commandText }, required: ["command"], not: { properties: { shell: commandText }, required: ["shell"] } },
    { properties: { shellCommand: { type: "string" }, args: { type: "array", maxItems: 0 } }, required: ["shellCommand"] },
  ],
});
const originSchema = object({ type: enumeration("local", "platform", "extension"), owner: string,
  namespace: nullable(string), version: nullable(string), revision: string });
const processFields = {
  processId: idSchema, status: string, state: string, lifetime: enumeration("run", "instance", "background"),
  originRunId: nullable(string), contextId: nullable(string), origin: originSchema,
  createdAt: nonnegative, closedAt: nullable(nonnegative), handedOffAt: nullable(nonnegative),
  controlAvailable: boolean, pid: nullable(integer), exitCode: nullable(integer), signal: nullable(string),
  outputComplete: boolean, details: jsonObject,
};
const snapshotSchema = object(processFields);
const readSchema = object({ ...processFields, output: array(object({
  stream: enumeration("stdout", "stderr", "terminal"), data: { anyOf: [string, nativeBytes] },
})), nextCursor: nullable(string), hasMoreOutput: boolean, truncated: boolean });
const factsSchema = object({ pid: nullable(integer), startedAt: nullable(nonnegative), rootExited: boolean,
  exitCode: nullable(integer), exitSignal: nullable(string), outputComplete: boolean,
  treeStopped: boolean, closed: boolean, stopRequested: boolean, forceRequested: boolean });
const stopSchema = object({ ...processFields, accepted: boolean, confirmed: boolean, facts: factsSchema },
  ["processId", "accepted", "confirmed", "facts"]);
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
export type ReadInput = {
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
function snapshot(resource: ResourceSnapshot): ProcessSnapshot {
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
        : (typeof detail.state === "string" ? detail.state : resource.status),
    lifetime: resource.lifetime,
    originRunId: resource.originRunId,
    contextId: resource.contextId,
    origin: resource.origin,
    createdAt: resource.createdAt,
    closedAt: resource.closedAt,
    handedOffAt: resource.handedOffAt,
    controlAvailable: resource.controlAvailable,
    pid: typeof detail.pid === "number" ? detail.pid : null,
    exitCode: typeof detail.exitCode === "number" ? detail.exitCode : null,
    signal: typeof detail.exitSignal === "string" ? detail.exitSignal : null,
    outputComplete: detail.outputComplete === true,
    details: detail,
  };
}

/** Nine process operations registered through the same public extension contract as npm SDKs. */
export function createShExtension(reserveOutput?: (resourceId: string, bytes: number) => Promise<{release(): void}>): ExtensionFactory {
 return (host) => {
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
  ): Promise<ProcessRead> {
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
      return { ...snapshot(resource), ...output };
    } finally {
      await historical?.close();
    }
  }
  async function launch(
    input: LaunchInput,
    call: Invocation,
    mode: "exec" | "start",
  ): Promise<ProcessSnapshot | ProcessRead> {
    // Admission belongs to this current caller; the ticket's release remains
    // valid after explicit background handoff and the creating call settles.
    const storage = call.storage ?? host.storage;
    let processId: string | undefined;
    const managed = new ManagedProcess(
      agentRoot,
      input,
      mode,
      reserveOutput ? {reserve: (bytes) => {
        requireCondition(processId, "invalid_process_start", "A process must be registered before reserving its output.");
        return reserveOutput(processId, bytes);
      }} : storage ? { reserve: (bytes) => storage.reserve(bytes) } : {},
    );
    const ref = await call.resources.register({ kind, value: managed });
    processId = ref.id;
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
          result.signal !== null
            ? "The managed process exited on a signal; inspect its retained output."
            : "The managed process exited with code " + String(result.exitCode) + "; inspect its retained output.",
          {
            method: "sh.exec",
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
    permission: string | readonly string[],
    inputSchema: unknown,
    outputSchema: object,
    normalize: MethodDefinition["normalize"],
    handle: MethodDefinition["handle"],
  ): MethodDefinition => ({
    description,
    permissions: typeof permission === "string" ? [permission] : permission,
    inputSchema,
    outputSchema: output(outputSchema),
    normalize,
    handle,
  });
  return {
    methods: {
      exec: method(
        "执行命令并等待真实退出、受管后代及输出收尾。",
        ["sh.execute", "storage.reserve"],
        launchSchema("exec"),
        readSchema,
        (args) => normalizeLaunch(args, "exec"),
        (input, call) => launch(input, call, "exec"),
      ),
      start: method(
        "登记并启动受管进程；仅显式background才交接到后台。",
        ["sh.execute", "storage.reserve"],
        launchSchema("start"),
        snapshotSchema,
        (args) => normalizeLaunch(args, "start"),
        (input, call) => launch(input, call, "start"),
      ),
      get: method(
        "读取同一托管进程的状态、增量输出并可有界等待。",
        "sh.read",
        schema(readProperties, ["processId"]),
        readSchema,
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
        object({ items: array(snapshotSchema), nextCursor: nullable(string) }),
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
        schema({ processId: idSchema, data: nativeBytes, eof: { type: "boolean" } }, [
          "processId",
        ]),
        object({ processId: idSchema, accepted: { const: true }, bytes: nonnegative, eof: boolean }),
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
        object({ processId: idSchema, accepted: { const: true }, cols: integer, rows: integer }),
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
        object({ processId: idSchema, requested: string, delivered: boolean,
          mechanism: enumeration("process-group", "job-object", "terminal-input") }),
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
        stopSchema,
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
        object({ command: string, launchPath: string, path: string,
          kind: enumeration("native", "batch"), platform: string }),
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
}

export const shExtension = createShExtension();
