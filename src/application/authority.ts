import path from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { callerKey, type Caller } from "../contracts/caller.js";
import { canonicalJson } from "../contracts/json.js";
import type { Binding } from "../contracts/types.js";
import type { AccessTarget } from "../extensions/api.js";
import type {
  WireAuthorizationV2,
  WireConnectionV2,
  WireInvocationContextV2,
  WireCallerV2,
} from "../contracts/wire.js";
import { validateConnectionV2 } from "../contracts/wire-validation.js";
import { contains } from "../runtime/paths.js";
import { validateContract } from "../contracts/validation.js";

interface Cell {
  readonly policy: WireAuthorizationV2;
}
const copy = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
function targetPath(value: string): string {
  requireCondition(
    path.isAbsolute(value) && !value.includes("\0"),
    "path_not_allowed",
    "A managed filesystem target needs an absolute path.",
  );
  let ancestor = path.normalize(value);
  const remaining: string[] = [];
  while (true) {
    try {
      return path.resolve(realpathSync.native(ancestor), ...remaining);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // Broken redirects and access errors cannot be treated as absent directories.
      if (code !== "ENOENT" || lstatSync(ancestor, { throwIfNoEntry: false }))
        throw new AgentError(
          "path_not_allowed",
          "The managed path cannot be resolved safely.",
        );
      const parent = path.dirname(ancestor);
      requireCondition(
        parent !== ancestor,
        "path_not_allowed",
        "The managed path has no existing ancestor.",
      );
      remaining.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Synchronous current policy for Core callbacks, refreshed only through authenticated Cloud evidence. */
export class AgentAuthority {
  readonly binding: Readonly<Binding & { bootId: string }>;
  readonly work: string;
  #connection?: WireConnectionV2;
  #policies = new Map<string, Cell>();
  constructor(
    binding: Binding & { bootId: string },
    work: string,
  ) {
    this.binding = Object.freeze({
      agentId: binding.agentId,
      profile: binding.profile,
      bootId: binding.bootId,
      cloudEnvironment: binding.cloudEnvironment,
    });
    this.work = realpathSync.native(work);
  }
  connect(binding: WireConnectionV2): void {
    for (const key of [
      "agentId",
      "profile",
      "bootId",
      "cloudEnvironment",
    ] as const)
      requireCondition(
        binding[key] === this.binding[key],
        "runtime_binding_mismatch",
        "This process cannot adopt a different Agent, profile, boot or Cloud environment.",
      );
    this.#connection = copy(binding);
  }
  #key(caller: Caller, projectId: string | null = null): string {
    const session = caller.source === "owner_session";
    requireCondition(
      session
        ? typeof caller.sessionRef === "string" &&
            /^[0-9a-f]{64}$/.test(caller.sessionRef) &&
            caller.clientId === `nexum-console:${caller.sessionRef}` &&
            caller.grantId === undefined
        : (caller.source === undefined || caller.source === "mcp") &&
            typeof caller.grantId === "string" &&
            caller.grantId.length > 0,
      "unauthorized",
      "Current Agent access requires its verified Grant or owner session.",
    );
    requireCondition(
      projectId === null ||
        (typeof projectId === "string" &&
          projectId.length > 0 &&
          projectId.length <= 256),
      "invalid_authorization_scope",
      "The policy must retain its actual Agent or Project scope.",
    );
    return canonicalJson([
      callerKey(caller),
      session ? "owner_session" : "mcp",
      session ? caller.sessionRef : caller.grantId,
      projectId,
    ]);
  }
  observe(context: WireInvocationContextV2): void {
    validateContract("wire.type:Caller", context.caller);
    requireCondition(
      this.#connection,
      "connection_closed",
      "No authenticated control connection exists.",
    );
    validateConnectionV2(context.connection, this.#connection);
    validateContract("wire.type:Authorization", context.authorization);
    requireCondition(
      context.authorization.agentId === this.binding.agentId,
      "agent_mismatch",
      "The current policy belongs to another Agent.",
    );
    const fixed = copy(context),
      projectId = fixed.authorization.projectId ?? null,
      key = this.#key(fixed.caller, projectId);
    this.#policies.set(key, {
      policy: fixed.authorization,
    });
  }
  current(
    caller: Caller,
    projectId: string | null = null,
  ): WireAuthorizationV2 {
    const cell = this.#policies.get(this.#key(caller, projectId));
    requireCondition(
      cell?.policy,
      "forbidden",
      "The current Cloud authority was revoked or is unavailable.",
    );
    return copy(cell.policy);
  }
  /** Cleanup proves original ownership separately; it does not grant new access. */
  cleanupContext(
    caller: WireCallerV2,
    previous: WireInvocationContextV2,
  ): WireInvocationContextV2 {
    for (const key of [
      "agentId",
      "profile",
      "bootId",
      "cloudEnvironment",
    ] as const)
      requireCondition(
        previous.connection[key] === this.binding[key],
        "connection_mismatch",
        "Cleanup cannot adopt a resource from another Agent boot or profile.",
      );
    requireCondition(
      this.#connection && this.#key(caller) === this.#key(previous.caller),
      "forbidden",
      "Cleanup must retain the original verified caller.",
    );
    return copy({
      caller,
      authorization: previous.authorization,
      connection: this.#connection,
    });
  }
  context(
    caller: WireCallerV2,
    projectId: string | null = null,
  ): WireInvocationContextV2 {
    requireCondition(
      this.#connection,
      "connection_closed",
      "No authenticated control connection exists.",
    );
    return {
      caller: copy(caller),
      authorization: this.current(caller, projectId),
      connection: copy(this.#connection),
    };
  }
  authorize(
    caller: Caller,
    target?: AccessTarget,
    projectId: string | null = null,
  ): void {
    const policy = this.current(caller, projectId);
    if (!target) return;
    requireCondition(
      caller.source !== "owner_session" ||
        target.access === "read" ||
        (target.type === "resource" && target.access === "stop"),
      "forbidden",
      "This action is unavailable to the current owner session.",
    );
    if (target.type === "path") {
      const actual = targetPath(target.value);
      // Process execution has its own declared capability. Installed system
      // executables need not live below a data directory; cwd and data access do.
      if (target.access === "execute") return;
      const roots = [
        this.work,
        ...policy.allowedRoots,
        ...(target.access === "read"
          ? [path.join(path.dirname(this.work), "logs")]
          : []),
      ];
      requireCondition(
        roots.some((root) => {
          try {
            return (
              path.isAbsolute(root) &&
              realpathSync.native(root) === root &&
              contains(root, actual)
            );
          } catch {
            return false;
          }
        }),
        "path_not_allowed",
        "The managed path is outside the current approved roots.",
      );
    } else if (target.type === "url") {
      let url: URL;
      try {
        url = new URL(target.value);
      } catch {
        throw new AgentError(
          "url_not_allowed",
          "The managed network target is invalid.",
        );
      }
      requireCondition(
        ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password,
        "url_not_allowed",
        "The managed network target is invalid.",
      );
    }
  }
}
