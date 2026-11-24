import path from "node:path";
import { realpathSync, mkdtempSync } from "node:fs";
import { requireCondition } from "../contracts/errors.js";
import type { ExtensionHandle } from "../extensions/registry.js";
import { installMaterialDirectory, removeMaterialDirectory, type ManagedReserve } from "../runtime/current-materials.js";
import { privateDirectory } from "../runtime/paths.js";
import { platformSkill, type PlatformNamespace } from "../sdk/platform.js";
import { writeMethodSkill } from "../work/method-skills.js";

/** Build the complete shell Skill before replacing the stable directory.
 * Keep rollback only until Go confirms the catalog publication. */
export async function preparePlatformMaterials(
  work: string,
  namespace: PlatformNamespace,
  handle: ExtensionHandle,
  reserve: ManagedReserve,
) {
  requireCondition(path.isAbsolute(work) && realpathSync.native(work) === work &&
    typeof reserve === "function",
  "invalid_platform_source", "Platform materials require their established profile and storage authority.");
  const { name, generated } = platformSkill(namespace, handle);
  const parent = privateDirectory(work, "cache", "materials", "platform");
  const directory = path.join(parent, namespace);
  const temporary = mkdtempSync(path.join(parent, ".prepare-"));
  try {
    await writeMethodSkill(work, temporary, generated.files, reserve);
    const replacement = installMaterialDirectory(directory, temporary);
    let settled = false;
    return {
      material: {
        ...generated.metadata,
        skillId: `nexum/${name}`,
        path: directory,
        skillFile: path.join(directory, "SKILL.md"),
        scope: { type: "agent" as const, root: work },
        origin: handle.origin,
      },
      confirmPublished() {
        requireCondition(!settled, "invalid_platform_source", "The platform material preparation is already settled.");
        replacement.commit();
        settled = true;
      },
      discard() {
        requireCondition(!settled, "invalid_platform_source", "The platform material preparation is already settled.");
        replacement.rollback();
        settled = true;
      },
      remove() { replacement.remove(); },
    };
  } catch (cause) {
    removeMaterialDirectory(temporary);
    throw cause;
  }
}
