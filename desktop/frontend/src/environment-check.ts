import type { MessageKey } from "./i18n";

export const environmentCheckPhases = {
  system: "checkSystem",
  conditions: "checkConditions",
  directory: "checkDirectory",
  program: "checkProgram",
  config: "checkConfig",
  service: "checkService",
  version: "checkVersion",
} as const satisfies Record<string, MessageKey>;
