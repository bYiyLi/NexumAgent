import path from "node:path";
import { realpathSync } from "node:fs";
import { requireCondition } from "../contracts/errors.js";
import type { ExtensionHandle } from "../extensions/registry.js";
import type { ManagedReserve, MaterialRetention } from "../runtime/material-retention.js";
import { platformSkill, type PlatformNamespace } from "../sdk/platform.js";
import { writeMethodSkill } from "../work/method-skills.js";

/**
 * Prepare an immutable Skill from a real platform Registry handle. The
 * caller retains the hold until Go has atomically published the matching
 * method table and material, or has confirmed that publication did not occur.
 */
export async function preparePlatformMaterials(
  work: string,
  namespace: PlatformNamespace,
  handle: ExtensionHandle,
  retention: MaterialRetention,
  reserve: ManagedReserve,
) {
  requireCondition(path.isAbsolute(work) && realpathSync.native(work) === work &&
    retention.root === path.dirname(work) && typeof reserve === "function",
  "invalid_platform_source", "Platform materials require their established profile and storage authority.");
  const { name, generated } = platformSkill(namespace, handle);
  const directory = path.join(work, "skills", ".generated", "platform", namespace, generated.revision);
  const hold = await retention.hold("skill", directory);
  try {
    await writeMethodSkill(work, directory, generated.files, reserve);
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
      revision: generated.revision,
      /** Once Go confirms publication, mark it live before releasing the hold. */
      confirmPublished() {
        requireCondition(!settled, "invalid_platform_source", "The platform material preparation is already settled.");
        retention.setPublished(`platform:${namespace}`, directory);
        hold.release();
        settled = true;
      },
      /** Only use when Go confirms publication did not take place. */
      discard() {
        requireCondition(!settled, "invalid_platform_source", "The platform material preparation is already settled.");
        hold.release();
        settled = true;
      },
    };
  } catch (cause) {
    hold.release();
    throw cause;
  }
}
