import type { Messages } from "./i18n";

export type AgentMaterialKind = "skill" | "script" | "instruction";

type ReadingSection = { heading: string; lines: readonly string[] };
type SkillDetail = { kind: "skill"; when: string; files: readonly ({ name: string } & ReadingSection)[] };
type ScriptDetail = {
  kind: "script";
  when: string;
  inputs: readonly { name: string; required: boolean; description: string }[];
  output: string;
  code: string;
};
type InstructionDetail = { kind: "instruction"; scope: string; sections: readonly ReadingSection[] };

export type AgentMaterial = {
  id: string;
  name: string;
  kind: AgentMaterialKind;
  description?: string;
  source?: string;
  revision?: string;
  notice?: "danger" | "advice" | "update";
  problem?: string;
  installedRevision?: string;
  availableRevision?: string;
  updateCheck?: "checked" | "unknown";
  canRemove?: boolean;
  detail?: SkillDetail | ScriptDetail | InstructionDetail;
  // Preview-only examples; these do not grant permission to remove a real resource.
  previewRemoval?: { location: string };
  previewSourceNote?: string;
};

export type AgentMaterialsInventory = {
  state: "loading" | "available" | "partial" | "unavailable";
  items: readonly AgentMaterial[];
};

export type LiveMaterialDetail = {
  content: string;
  complete: boolean;
  member?: string;
  members?: readonly string[];
  treeIncomplete?: boolean;
  when?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

export type ReadMaterial = (item: AgentMaterial, member?: string) => Promise<LiveMaterialDetail>;

export type MaterialRemoval = {
  prepare: (item: AgentMaterial) => Promise<{ name: string; location: string; token: string }>;
  confirm: (item: AgentMaterial, token: string) => Promise<void>;
};

export const unavailableAgentMaterials: AgentMaterialsInventory = { state: "unavailable", items: [] };

// These examples belong exclusively to the explicitly labelled workspace preview.
export function previewAgentMaterials(t: Messages): AgentMaterialsInventory {
  return {
    state: "available",
    items: [
      {
        id: "preview-script-authoring", name: "script-authoring", kind: "skill",
        description: t.agentMaterialsExampleAuthoringDesc, source: t.agentMaterialsBuiltin, previewSourceNote: t.agentMaterialsBuiltinNote,
        detail: { kind: "skill", when: t.agentMaterialsExampleAuthoringWhen, files: [
          { name: "SKILL.md", heading: t.agentMaterialsExampleAuthoringTitle, lines: [
            t.agentMaterialsExampleAuthoringStep1, t.agentMaterialsExampleAuthoringStep2, t.agentMaterialsExampleAuthoringStep3,
          ] },
          { name: "references/authoring.md", heading: t.agentMaterialsExampleReferenceTitle, lines: [
            t.agentMaterialsExampleReferenceStep1, t.agentMaterialsExampleReferenceStep2,
          ] },
        ] },
      },
      {
        id: "preview-image-report", name: "image-report.js", kind: "script",
        description: t.agentMaterialsExampleReportDesc, source: t.agentMaterialsLocal,
        previewRemoval: { location: "scripts/image-report.js" },
        detail: { kind: "script", when: t.agentMaterialsExampleReportWhen,
          inputs: [{ name: "files", required: true, description: t.agentMaterialsExampleReportInput }],
          output: t.agentMaterialsExampleReportOutput,
          code: "// Example: local reading implementation omitted\nconst { files } = context.input;\nconst rows = await readImageMetadata(files);\nreturn formatReport(rows);" },
      },
      {
        id: "preview-agents-md", name: "AGENTS.md", kind: "instruction",
        description: `${t.agentMaterialsPersonal} · ${t.agentMaterialsGeneral}`, source: t.agentMaterialsPersonal,
        detail: { kind: "instruction", scope: t.agentMaterialsGeneral, sections: [
          { heading: t.agentMaterialsExampleInstructionTitle, lines: [t.agentMaterialsExampleInstruction1, t.agentMaterialsExampleInstruction2] },
        ] },
      },
      {
        id: "preview-page-audit", name: "page-audit", kind: "skill",
        description: t.agentMaterialsExampleAuditDesc, source: t.agentMaterialsBrowser, previewSourceNote: t.agentMaterialsBrowserNote,
        detail: { kind: "skill", when: t.agentMaterialsExampleAuditWhen, files: [
          { name: "SKILL.md", heading: t.agentMaterialsExampleAuditTitle, lines: [t.agentMaterialsExampleAuditStep1, t.agentMaterialsExampleAuditStep2] },
        ] },
      },
      {
        id: "preview-file-list", name: "nexum/file.list.js", kind: "script",
        description: t.agentMaterialsExampleListDesc, source: t.agentMaterialsBuiltin, previewSourceNote: t.agentMaterialsBuiltinNote,
        detail: { kind: "script", when: t.agentMaterialsExampleListWhen, inputs: [
          { name: "path", required: false, description: t.agentMaterialsExampleListPath },
          { name: "depth", required: false, description: t.agentMaterialsExampleListDepth },
          { name: "limit", required: false, description: t.agentMaterialsExampleListLimit },
        ], output: t.agentMaterialsExampleListOutput,
        code: "// Example: directory traversal implementation omitted\nconst { path = '.', depth = 1 } = context.input;\nconst entries = await listEntries(path, depth);\nreturn formatDirectory(entries);" },
      },
      {
        id: "preview-writing-assistant", name: "writing-assistant", kind: "skill",
        description: t.agentMaterialsExampleWritingDesc, source: t.agentMaterialsPersonal,
        previewRemoval: { location: "~/.agents/skills/writing-assistant" },
        detail: { kind: "skill", when: t.agentMaterialsExampleWritingWhen, files: [
          { name: "SKILL.md", heading: t.agentMaterialsExampleWritingTitle, lines: [
            t.agentMaterialsExampleWritingStep1, t.agentMaterialsExampleWritingStep2,
          ] },
        ] },
      },
    ],
  };
}
