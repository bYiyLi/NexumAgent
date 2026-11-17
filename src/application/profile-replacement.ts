import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentError, requireCondition } from "../contracts/errors.js";
import type { ProfileConfiguration } from "./config.js";

interface ReplacementIntent {
  profile: string;
  serverUrl: string;
  tokenDigest: string;
  archiveId: string;
}

function invalid(): never {
  throw new AgentError(
    "agent_identity_replacement_failed",
    "The locally authorized Agent identity replacement cannot be completed safely.",
  );
}

function safeDirectory(directory: string): void {
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry)
    requireCondition(
      entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        realpathSync.native(directory) === directory,
      "agent_identity_replacement_failed",
      "The Agent identity archive directory is unsafe.",
    );
}

function boundIdentity(
  filename: string,
): { id: string; profile: string; environment: string } | undefined {
  const info = lstatSync(filename, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) invalid();
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT agent_id, profile, cloud_environment FROM runtime_meta WHERE singleton=1",
      )
      .get();
    if (
      typeof row?.agent_id !== "string" ||
      typeof row.profile !== "string" ||
      typeof row.cloud_environment !== "string"
    )
      invalid();
    return {
      id: row.agent_id,
      profile: row.profile,
      environment: row.cloud_environment,
    };
  } finally {
    database.close();
  }
}

/** Only an explicit local install may replace another authenticated Agent ID.
 *  Never infer machine identity from the hostname or let automatic upgrades
 *  erase/repurpose another Agent's SQLite, work files, credentials or logs.
 */
export async function acceptInstalledAgentIdentity(
  config: ProfileConfiguration,
  agentId: string,
): Promise<boolean> {
  const root = config.root;
  const marker = path.join(root, "program", "identity-replacement.json");
  const entry = lstatSync(marker, { throwIfNoEntry: false });
  if (!entry) return false;
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size > 4096 ||
    realpathSync.native(root) !== root
  )
    invalid();
  safeDirectory(path.join(root, "program"));
  // An existing state junction may not borrow another profile's metadata.
  safeDirectory(path.join(root, "state"));
  let intent: ReplacementIntent;
  try {
    intent = JSON.parse(readFileSync(marker, "utf8")) as ReplacementIntent;
  } catch {
    return invalid();
  }
  if (
    !intent ||
    intent.profile !== config.profile ||
    intent.serverUrl !== config.serverUrl ||
    intent.tokenDigest !==
      createHash("sha256").update(config.token).digest("hex") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      intent.archiveId,
    )
  )
    invalid();

  const prior = boundIdentity(path.join(root, "state", "runtime.sqlite"));
  if (
    prior &&
    (prior.profile !== config.profile || prior.environment !== config.profile)
  )
    invalid();
  if (prior?.id === agentId) {
    await rm(marker);
    return false; // Same Agent with a rotated Token keeps all local state.
  }

  const archives = path.join(root, "previous-agents");
  const archive = path.join(archives, intent.archiveId);
  safeDirectory(archives);
  safeDirectory(archive);
  const continuing =
    lstatSync(archive, { throwIfNoEntry: false }) !== undefined;
  if (!prior && !continuing) {
    await rm(marker); // First installation, nothing to retire.
    return false;
  }
  if (continuing && prior?.id === agentId) invalid();
  await mkdir(archives, { recursive: true, mode: 0o700 });
  await mkdir(archive, { mode: 0o700, recursive: true });
  // Move the identity's complete local data, not just the SQLite file. Keep
  // the managed Node/program and the newly selected Token in place.
  // State goes last so an interrupted archive still exposes the old binding.
  for (const name of ["work", "logs", "state"]) {
    const source = path.join(root, name);
    const destination = path.join(archive, name);
    const current = lstatSync(source, { throwIfNoEntry: false });
    const saved = lstatSync(destination, { throwIfNoEntry: false });
    if (current && (!current.isDirectory() || current.isSymbolicLink()))
      invalid();
    if (saved && (!saved.isDirectory() || saved.isSymbolicLink())) invalid();
    if (current && saved) invalid(); // Do not merge or overwrite unknown data.
    if (current) await rename(source, destination);
  }
  await rm(marker);
  return true;
}
