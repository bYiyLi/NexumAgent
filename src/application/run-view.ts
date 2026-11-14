import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { authorizeCall } from "../contracts/caller.js";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type {
  ContributionOrigin,
  JsonObject,
  RunRecord,
} from "../contracts/types.js";
import type {
  WireBudgetsV2,
  WireErrorV2,
  WireFixedStreamRefV2,
  WireResultBodyV2,
  WireResultV2,
  WireRunV2,
  WireRunViewV2,
  WireTransferDeliveryV2,
} from "../contracts/wire.js";
import { validateContract } from "../contracts/validation.js";
import { contains } from "../runtime/paths.js";
import type { RunDetails, RunView } from "../runtime/engine.js";
import type {
  ResultEncoder,
  ResultScope,
  StoredResult,
} from "../results/encoder.js";

const iso = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();
const json = <T>(value: T, maximum = 1024 * 1024): T =>
  JSON.parse(canonicalJson(value, maximum)) as T;
function error(value: JsonObject | null | undefined): WireErrorV2 | null {
  if (!value) return null;
  return {
    code: typeof value.code === "string" ? value.code : "agent_error",
    message:
      typeof value.message === "string"
        ? value.message
        : "The Agent operation failed.",
    ...((value.details &&
      typeof value.details === "object" &&
      !Array.isArray(value.details)) ||
    value.phase
      ? {
          details: {
            ...((value.details as JsonObject) ?? {}),
            ...(value.phase ? { phase: value.phase } : {}),
          },
        }
      : {}),
  };
}
function retained(
  root: string | undefined,
  run: RunRecord,
  ref: string | null,
): boolean {
  if (!ref || !root) return false;
  try {
    const filename = path.resolve(root, ref);
    const allowed = [
      path.join(root, "work", "tmp", "runs", run.runId),
      path.join(root, "logs", "runs", run.runId),
    ];
    return (
      allowed.some((dir) => contains(dir, filename)) &&
      realpathSync.native(filename) === filename &&
      lstatSync(filename).isFile()
    );
  } catch {
    return false;
  }
}
export function projectRunRecord(
  run: RunRecord,
  options: {
    readonly root?: string;
    readonly availability?: Partial<WireRunV2["availability"]>;
  } = {},
): WireRunV2 {
  const source = run.source;
  const candidate = source.origin;
  const origin =
    candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    ["local", "platform", "extension"].includes(String(candidate.type)) &&
    typeof candidate.owner === "string" &&
    typeof candidate.revision === "string"
      ? (json(candidate) as ContributionOrigin)
      : null;
  return {
    runId: run.runId,
    contextId: run.contextId,
    projectId: run.projectId,
    revision: run.revision,
    status: run.status,
    scriptName: run.scriptName,
    source: ({ inline: "inline", script: "named", replay: "history" } as const)[
      run.sourceKind
    ],
    origin,
    replayOfRunId:
      typeof source.replayRunId === "string" ? source.replayRunId : null,
    acceptedAt: iso(run.acceptedAt)!,
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.endedAt),
    updatedAt: iso(run.updatedAt)!,
    deadlineAt: iso(run.deadlineAt)!,
    error: error(run.error),
    stop: json(run.stop),
    cleanup: json(run.cleanup),
    availability: {
      code: retained(options.root, run, run.codeRef),
      input: retained(options.root, run, run.inputRef),
      result: retained(options.root, run, run.resultRef),
      logs: retained(options.root, run, run.logsRef),
      ...options.availability,
    },
    ...(typeof source.scriptDesc === "string"
      ? {
          scriptDesc: source.scriptDesc.slice(0, 2048),
          ...(source.scriptDesc.length > 2048
            ? { descriptionTruncated: true }
            : {}),
        }
      : {}),
  };
}
export interface RunProjectionPorts {
  readonly readOnly?: boolean;
  readonly encoder: ResultEncoder;
  readonly scope: ResultScope;
  readonly budgets: WireBudgetsV2;
  shipJson(
    value: JsonObject,
    purpose: "result-meta",
  ): Promise<WireFixedStreamRefV2>;
}
function hasInlineIcon(value: JsonObject): boolean {
  return (value.content as JsonObject[]).some(
    (item) =>
      Array.isArray(item.icons) &&
      item.icons.some((icon) => {
        if (
          !icon ||
          typeof icon !== "object" ||
          Array.isArray(icon) ||
          typeof icon.src !== "string"
        )
          return false;
        try {
          return new URL(icon.src).protocol === "data:";
        } catch {
          return false;
        }
      }),
  );
}

/** Core facts become bounded wire data here; no result is rerun and no media is encoded as control JSON. */
export async function projectRunView(
  view: RunView | RunDetails,
  ports: RunProjectionPorts,
): Promise<WireRunViewV2> {
  authorizeCall(() => ports.scope.assertCurrent());
  ports.scope.signal?.throwIfAborted();
  const textBytes = Math.min(65536, ports.budgets.textBytes ?? 65536);
  const controlBytes = Math.min(
    1024 * 1024,
    ports.budgets.controlBytes ?? 1024 * 1024,
  );
  requireCondition(
    textBytes > 0 && controlBytes > 0,
    "run_context_too_large",
    "The current response budget cannot carry the Run state.",
    { runId: view.run.runId, status: view.run.status },
  );
  const projected: WireRunViewV2 = {
    run: projectRunRecord(view.run, {
      root: ports.encoder.artifacts.root,
      availability: { result: view.result !== null },
    }),
    wait: view.wait
      ? {
          waitId: view.wait.waitId,
          revision: view.wait.revision,
          status: view.wait.status,
          deliveryState: view.wait.deliveryState,
          request: json(view.wait.request),
          createdAt: iso(view.wait.createdAt)!,
          deadlineAt: iso(view.wait.deadlineAt)!,
          consumedAt: iso(view.wait.consumedAt),
          error: error(view.wait.error),
        }
      : null,
    result: null,
    observedAt: new Date().toISOString(),
    operations: json(view.operations),
    resources: json(view.resources),
    ...(view.unavailable ? { unavailable: error(view.unavailable)! } : {}),
  };
  const output = projected as unknown as JsonObject;
  const notes: JsonObject = {};
  if ("snapshots" in view) {
    const snapshots = view.snapshots;
    for (const name of ["code", "input", "logs"] as const) {
      const snapshot = snapshots[name];
      if (snapshot.status === "available" && Object.hasOwn(snapshot, "value")) {
        if (name === "input") output.input = snapshot.value!;
        else {
          const text =
            name === "code" && isPlainRecord(snapshot.value)
              ? snapshot.value.code
              : snapshot.value;
          requireCondition(
            typeof text === "string",
            "run_detail_invalid",
            "The retained Run text snapshot is invalid.",
          );
          output[name] = {
            text,
            complete: snapshot.truncated !== true,
            nextCursor: null,
          };
        }
      }
      if (
        snapshot.status === "unavailable" ||
        snapshot.status === "too_large" ||
        snapshot.truncated
      ) {
        notes[name] = {
          status: snapshot.status,
          bytes: snapshot.bytes,
          ...(snapshot.nextOffset === undefined
            ? {}
            : { nextOffset: snapshot.nextOffset }),
          ...(snapshot.startOffset === undefined
            ? {}
            : {
                startOffset: snapshot.startOffset,
                endOffset: snapshot.endOffset!,
                dataOffset: snapshot.dataOffset!,
              }),
          ...(snapshot.ref &&
          retained(ports.encoder.artifacts.root, view.run, snapshot.ref)
            ? { path: path.resolve(ports.encoder.artifacts.root, snapshot.ref) }
            : {}),
        };
      }
    }
  }
  const size = () => Buffer.byteLength(canonicalJson(output));
  // Optional retained bodies may be omitted whole, rather than returning a partial JSON value or Schema.
  const frameLimit = Math.max(0, textBytes - (view.result ? 4096 : 1024));
  for (const name of ["logs", "input", "code"] as const) {
    if (size() <= frameLimit) break;
    if (Object.hasOwn(output, name)) {
      delete output[name];
      notes[name] = {
        ...((notes[name] as JsonObject) ?? {}),
        reason: "context_budget",
      };
    }
  }
  for (const group of [projected.operations, projected.resources]) {
    while (size() > frameLimit && group.items.length > 0) {
      (group.items as JsonObject[]).pop();
      (group as { complete: boolean }).complete = false;
    }
  }
  if (Object.keys(notes).length) {
    const previous = projected.unavailable;
    output.unavailable = {
      code: previous?.code ?? "retained_details_partial",
      message:
        previous?.message ??
        "Some retained details are unavailable or exceed this observation's context budget.",
      details: { ...(previous?.details ?? {}), snapshots: notes },
    };
  }
  requireCondition(
    size() <= Math.min(textBytes - 512, controlBytes - 512),
    "run_context_too_large",
    "The complete mandatory Run or input-request metadata exceeds this response budget.",
    { runId: view.run.runId, status: view.run.status },
  );
  if (view.result) {
    let described: Awaited<ReturnType<ResultEncoder["describe"]>> | undefined;
    const unavailable = (reason: string) => {
      output.unavailable = {
        code: "retained_result_partial",
        message:
          "The saved result cannot be included completely in this read-only view.",
        details: {
          ...(projected.unavailable?.details ?? {}),
          result: { reason },
        },
      };
    };
    try {
      described = await ports.encoder.describe(
        view.result as StoredResult,
        ports.scope,
        {
          textBytes: Math.max(1, textBytes - size() - 512),
          ...(ports.readOnly ? { readOnly: true } : {}),
        },
      );
    } catch (cause) {
      if (
        !ports.readOnly ||
        !isAgentError(cause) ||
        ![
          "resource_expired",
          "resource_changed",
          "resource_unavailable",
        ].includes(cause.code)
      )
        throw cause;
      unavailable(cause.code);
    }
    if (described) {
      validateContract("wire.body:Result", described.result);
      if (ports.readOnly) {
        if (
          hasInlineIcon(described.result) ||
          Buffer.byteLength(canonicalJson(described.result, 64 * 1024 * 1024)) +
            size() >
            Math.min(textBytes, controlBytes) - 512
        )
          unavailable("context_budget");
        else
          output.result = JSON.parse(
            canonicalJson(described.result, controlBytes),
          ) as JsonObject;
      } else {
        let protocolMeta: WireResultV2["protocolMeta"];
        if (described.hostMeta)
          protocolMeta = {
            stream: await ports.shipJson(described.hostMeta, "result-meta"),
          };
        // The same fixed metadata body carries large standard icons without putting data URIs into WSS JSON.
        const body =
          hasInlineIcon(described.result) ||
          Buffer.byteLength(canonicalJson(described.result, 64 * 1024 * 1024)) +
            size() >
            controlBytes - 1024;
        const result = body
          ? {
              body: await ports.shipJson(described.result, "result-meta"),
              ...(protocolMeta ? { protocolMeta } : {}),
            }
          : { ...described.result, ...(protocolMeta ? { protocolMeta } : {}) };
        output.result = JSON.parse(
          canonicalJson(result, controlBytes),
        ) as JsonObject;
        if (described.transfers.length)
          output.transient = {
            transfers: described.transfers as unknown as JsonObject[],
          };
      }
    }
  }
  authorizeCall(() => ports.scope.assertCurrent());
  ports.scope.signal?.throwIfAborted();
  requireCondition(
    Buffer.byteLength(canonicalJson(output)) <= controlBytes - 256,
    "data_too_large",
    "The actual Run response exceeds its control-message budget.",
  );
  return projected;
}
