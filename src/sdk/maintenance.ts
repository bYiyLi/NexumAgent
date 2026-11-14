import { requireCondition } from "../contracts/errors.js";
import type { ExtensionFactory, MethodDefinition } from "../extensions/api.js";
import { maintenanceMethods } from "../maintenance/requests.js";

/** Public call-bound facade, identical for built-in and external extensions. */
export const maintenanceExtension: ExtensionFactory = () => {
  const methods: Record<string, MethodDefinition> = {};
  const text = { type: "string", minLength: 1, maxLength: 8192 };
  for (const name of [
    ...maintenanceMethods,
    "get",
    "list",
    "cancel",
  ] as const) {
    const parts = name.split("."),
      group = parts.length === 2 ? parts[0] : null,
      action = parts.at(-1)!;
    const properties: Record<string, unknown> = group
      ? { name: { type: "string", minLength: 1, maxLength: 214 } }
      : name === "list"
        ? {
            target: { enum: ["package", "extension", "mcp", "api"] },
            name: text,
            status: {
              enum: ["pending", "approved", "denied", "cancelled", "expired"],
            },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: text,
          }
        : { requestId: text };
    const required: string[] = group
      ? ["name"]
      : name === "list"
        ? []
        : ["requestId"];
    if (group === "packages" && action !== "remove")
      properties.version = { type: "string", minLength: 1, maxLength: 256 };
    if (group === "mcp" && action !== "remove") {
      properties.config = { type: "object" };
      required.push("config");
    }
    if (group === "api" && action !== "remove")
      Object.assign(properties, {
        url: text,
        path: text,
        config: { type: "object" },
      });
    methods[name] = {
      description: group
        ? `申请 ${name}；用户确认最终修订后才实际执行。`
        : `${name === "get" ? "读取" : name === "list" ? "筛选" : "撤销尚未执行的"}维护申请；不批准或重签。`,
      permissions: [`maintenance.${name}`],
      path: parts,
      normalize(args) {
        requireCondition(
          name === "list" ? args.length <= 1 : args.length === 1,
          "invalid_arguments",
          "Use this maintenance method's declared arguments.",
        );
        return group
          ? args[0]
          : name === "list"
            ? (args[0] ?? {})
            : { requestId: args[0] };
      },
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties,
        required,
      },
      handle(input, call) {
        if (group) {
          const service = call.maintenance[
            group as "packages" | "extensions" | "mcp" | "api"
          ] as unknown as Record<string, (input: unknown) => unknown>;
          return service[action]!(input);
        }
        if (name === "get") return call.maintenance.get(input.requestId);
        if (name === "cancel") return call.maintenance.cancel(input.requestId);
        return call.maintenance.list(input);
      },
    };
  }
  return { methods };
};
