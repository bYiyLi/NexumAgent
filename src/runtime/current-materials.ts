import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { requireCondition } from "../contracts/errors.js";

export type ManagedReserve = (bytes: number) => Promise<{ release(): void }>;

function directoryInfo(directory: string) {
  const info = lstatSync(directory, { throwIfNoEntry: false });
  requireCondition(!info || (info.isDirectory() && !info.isSymbolicLink() &&
    realpathSync.native(directory) === directory), "material_path_escape",
  "A generated material directory cannot redirect.");
  return info;
}

// Both paths are siblings below a program-owned canonical parent. No file is
// modified in place. A portable replacement may briefly be absent, never half
// generated. The temporary rollback directory is not a retained revision.
export function installMaterialDirectory(directory: string, stage: string) {
  const parent = path.dirname(directory);
  requireCondition(path.dirname(stage) === parent && stage !== directory &&
    path.basename(stage).startsWith(".prepare-") &&
    realpathSync.native(parent) === parent,
  "material_path_escape", "Material replacement requires a private sibling stage.");
  const prepared = directoryInfo(stage);
  requireCondition(prepared, "material_unavailable", "The prepared material tree is missing.");
  const previous = directoryInfo(directory);
  const backup = path.join(parent, ".retire-" + randomUUID());
  if (previous) renameSync(directory, backup);
  try {
    renameSync(stage, directory);
  } catch (cause) {
    if (previous) renameSync(backup, directory);
    throw cause;
  }
  let settled = false;
  const current = () => {
    const info = directoryInfo(directory);
    requireCondition(info && info.dev === prepared.dev && info.ino === prepared.ino,
      "material_changed", "The material directory was replaced by another publisher.");
  };
  return {
    commit() {
      requireCondition(!settled, "material_changed", "The replacement is already settled.");
      current();
      settled = true;
      if (previous) {
        try { removeMaterialDirectory(backup); }
        catch { console.warn("Generated material cleanup failed: material_cleanup_failed"); }
      }
    },
    rollback() {
      requireCondition(!settled, "material_changed", "The replacement is already settled.");
      current();
      // Keep the complete new tree available as a stage until the previous
      // tree has been restored. If restoration fails, do not lose both.
      renameSync(directory, stage);
      try {
        if (previous) renameSync(backup, directory);
      } catch (cause) {
        renameSync(stage, directory);
        throw cause;
      }
      settled = true;
      removeMaterialDirectory(stage);
    },
    remove() {
      current();
      removeMaterialDirectory(directory);
    },
  };
}

export function removeMaterialDirectory(directory: string): void {
  const parent = path.dirname(directory);
  requireCondition(realpathSync.native(parent) === parent, "material_path_escape",
    "A generated material parent cannot redirect.");
  if (directoryInfo(directory)) rmSync(directory, { recursive: true, force: true });
}
