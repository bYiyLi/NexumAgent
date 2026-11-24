import type { Instruction, SkillMetadata } from "./discovery.js";
import type { ContributionOrigin } from "../contracts/types.js";
export type PublishedInstruction = Omit<Instruction, "disabled" | "path"> & { path: string | null; content: string };
export type PublishedSkill = Omit<SkillMetadata, "disabled">;
export interface PublishedMaterials {
  instructions: readonly PublishedInstruction[];
  skills: readonly PublishedSkill[];
  goSourceOrigins?: readonly ContributionOrigin[];
}
