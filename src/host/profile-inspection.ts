import path from "node:path";
import { createHash } from "node:crypto";
import { discoverMaterials, enabledMaterials } from "../work/discovery.js";
import { ScriptCatalog, type ScriptSource } from "../runtime/scripts.js";

export type ProfileResource = {
  id: string;
  name: string;
  type: "instruction" | "skill" | "script" | "npm" | "mcp" | "openapi";
  parentId?: string;
  description?: string;
};
export type ProfileInventory = {
  resources: ProfileResource[];
  complete: boolean;
  warnings: string[];
};
const stableId = (type: string, value: string) =>
  type + ":" + createHash("sha256").update(value).digest("hex").slice(0, 32);

/** Read-only local metadata discovery. No Work Context, Run, or registration is created. */
export async function inspectProfileInventory(input: {
  root: string;
  agentId: string;
  home: string | null;
  packages: ReadonlyMap<string, string>;
  scriptSources: readonly ScriptSource[];
  signal: AbortSignal;
}): Promise<ProfileInventory> {
  const work = path.join(input.root, "work");
  const discovered = enabledMaterials(await discoverMaterials({
    agentId: input.agentId, work, home: input.home, signal: input.signal,
  }));
  const generatedRoot = path.join(work, "skills", ".generated") + path.sep;
  const resources: ProfileResource[] = [];
  for (const item of discovered.instructions) {
    if (item.path.startsWith(generatedRoot)) continue;
    resources.push({
      id: stableId("instruction", item.instructionId),
      name: path.basename(item.path), type: "instruction",
    });
  }
  for (const item of discovered.skills) {
    if (item.skillFile.startsWith(generatedRoot)) continue;
    resources.push({
      id: stableId("skill", item.skillId), name: item.name, type: "skill",
      description: item.description.slice(0, 1024),
    });
  }
  const scripts = new ScriptCatalog(work, input.agentId, () => input.scriptSources).discover();
  for (const item of scripts.entries) {
    resources.push({
      id: stableId("script", item.origin.owner + ":" + item.scriptName),
      name: item.scriptName, type: "script", description: item.scriptDesc.slice(0, 1024),
    });
  }
  for (const [name, version] of input.packages) {
    resources.push({ id: "npm:" + name, name, type: "npm", description: version });
  }
  const warnings = [
    ...discovered.warnings.map((item) => item.code),
    ...scripts.warnings.map((item) => item.code),
  ];
  const complete = discovered.skillsComplete && discovered.nestedComplete &&
    resources.length <= 180 && warnings.length === 0;
  if (resources.length > 180) warnings.push("resource_inventory_limit");
  return {
    resources: resources.slice(0, 180),
    complete,
    warnings: [...new Set(warnings)].slice(0, 30),
  };
}
