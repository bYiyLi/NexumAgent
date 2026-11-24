import { readFileSync } from "node:fs";
import { requireCondition } from "../contracts/errors.js";

// The installed Host package provides the trusted platform identity.
const installed = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
requireCondition(
  installed.name === "@nexum/node-host" &&
    typeof installed.version === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(installed.version),
  "invalid_control_package",
  "Platform scripts require a recognized Host package and version.",
);
// This is Nexum's platform identity, not the Node Host's npm package name.
export const CONTROL_OWNER = "nexum";
export const CONTROL_VERSION = installed.version;
