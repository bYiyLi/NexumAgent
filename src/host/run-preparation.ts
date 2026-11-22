import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import { requireCondition } from "../contracts/errors.js";
import { compileInputSchema } from "../contracts/validation.js";
import { ScriptCatalog, scriptHeader, type ScriptSnapshot, type ScriptSource } from "../runtime/scripts.js";

/** Script discovery and parsing are shared with work discovery, not a second executor. */
export class RunPreparation {
  constructor(readonly root: string, readonly agentId: string, readonly instanceId: string) {}

  prepare(value: unknown, signal: AbortSignal): ScriptSnapshot {
    requireCondition(isPlainRecord(value) && value.instanceId === this.instanceId &&
      typeof value.runId === "string" && Array.isArray(value.sources) &&
      value.sources.every((source: unknown) => isPlainRecord(source) &&
        (source.type === "platform" || source.type === "extension") &&
        typeof source.owner === "string" && typeof source.namespace === "string" &&
        typeof source.version === "string" && typeof source.directory === "string"),
    "invalid_run_scope", "Script preparation needs a Go-established Run and source snapshot.");
    signal.throwIfAborted();
    const catalog = new ScriptCatalog(path.join(this.root, "work"), this.agentId,
      () => value.sources as unknown as ScriptSource[]);
    let snapshot: ScriptSnapshot;
    if (typeof value.code === "string") snapshot = catalog.enroll(value.code).snapshot;
    else if (typeof value.scriptName === "string") snapshot = catalog.resolve(value.scriptName);
    else {
      requireCondition(isPlainRecord(value.replay) && typeof value.replay.code === "string" &&
        isPlainRecord(value.replay.origin) &&
        createHash("sha256").update(value.replay.code).digest("hex") === value.replay.origin.revision &&
        (value.replay.name === null || typeof value.replay.name === "string"),
      "snapshot_changed", "The retained script does not match its recorded source.");
      snapshot = { name: value.replay.name, code: value.replay.code,
        metadata: scriptHeader(value.replay.code), origin: value.replay.origin as unknown as ScriptSnapshot["origin"], path: null };
    }
    if (snapshot.metadata) compileInputSchema(snapshot.metadata.scriptInputSchema)(value.input ?? null);
    signal.throwIfAborted();
    return JSON.parse(canonicalJson(snapshot, 2 * 1024 * 1024)) as ScriptSnapshot;
  }

  validate(value: unknown): object {
    requireCondition(isPlainRecord(value) && value.instanceId === this.instanceId &&
      Object.hasOwn(value, "schema"), "invalid_input_schema", "The input schema is missing.");
    const validate = compileInputSchema(value.schema);
    if (Object.hasOwn(value, "input")) validate(value.input);
    return { valid: true };
  }
}
