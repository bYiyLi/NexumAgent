import path from "node:path";
import { realpathSync } from "node:fs";
import type { AccessTarget } from "../extensions/api.js";
import { requireCondition } from "../contracts/errors.js";
import { canonicalJson, digest } from "../contracts/json.js";
import type { ContributionOrigin } from "../contracts/types.js";
import { createMcpAdapter } from "../adapters/mcp.js";
import type { ConfigurationActivation } from "../maintenance/configuration.js";
import type { MaintenanceScope } from "../maintenance/requests.js";
import { atomicText, privateDirectory } from "../runtime/paths.js";
import type { MaterialRetention } from "../runtime/material-retention.js";
import {
  ExtensionRegistry,
  type ExtensionHandle,
  type ExtensionReplacement,
} from "../extensions/registry.js";
import type { PublishedMaterials } from "../work/service.js";

interface ActiveSource {
  readonly kind: "api" | "mcp";
  readonly name: string;
  readonly objectId: string;
  readonly revision: string;
  readonly handle: ExtensionHandle;
  readonly materials: PublishedMaterials;
  available: boolean;
}
/** Approved API/MCP sources use the same Registry and its native disposal boundary. */
export class ConfigurationSources implements ConfigurationActivation {
  #active = new Map<string, ActiveSource>();
  #candidates = new Set<ExtensionHandle>();
  #holds = new Map<ExtensionHandle, { release(): void }>();
  #approvedPaths = new Map<string, Set<string>>();
  #unresolvedCommands = new Map<string, string>();
  authorizeInstance(origin: ContributionOrigin, target: AccessTarget): boolean {
    if (target.type !== "path") return false;
    const key = canonicalJson(origin),
      approved = this.#approvedPaths.get(key);
    if (!approved) return false;
    const actual = realpathSync.native(target.value);
    if (approved.has(actual)) return true;
    const command = this.#unresolvedCommands.get(key);
    // A bare approved command is resolved exactly once by the existing native
    // launcher. Keep that actual executable identity for this fixed instance.
    if (
      target.access === "execute" &&
      command &&
      path
        .basename(target.value)
        .toLowerCase()
        .replace(/\.exe$/, "") === command.toLowerCase().replace(/\.exe$/, "")
    ) {
      approved.add(actual);
      this.#unresolvedCommands.delete(key);
      return true;
    }
    return false;
  }
  constructor(
    readonly work: string,
    readonly registry: ExtensionRegistry,
    readonly reserve?: (bytes: number) => Promise<{ release(): void }>,
    readonly materialRetention?: MaterialRetention,
  ) {}
  published(): PublishedMaterials {
    const values = [...this.#active.values()].filter(
      (value) => value.available,
    );
    return {
      docs: values.flatMap((value) => [...value.materials.docs]),
      instructions: values.flatMap((value) => [
        ...value.materials.instructions,
      ]),
      skills: [],
    };
  }
  async prepare(
    input: Parameters<ConfigurationActivation["prepare"]>[0],
    scope: MaintenanceScope,
  ): Promise<{ publish(): void; dispose(): Promise<void> }> {
    scope.signal.throwIfAborted();
    scope.assertCurrent();
    const key = input.kind + ":" + input.name;
    let previous = this.#active.get(key);
    requireCondition(
      !previous || previous.objectId === input.objectId,
      "configuration_identity_mismatch",
      "An approved source must retain its fixed identity.",
    );
    if (previous?.revision === input.revision && previous.available)
      return { publish() {}, async dispose() {} };
    if (previous && !previous.available) {
      const closed = await this.registry.disable(previous.handle);
      requireCondition(
        closed.status === "disabled",
        "configuration_cleanup_unconfirmed",
        "The prior source still requires real cleanup.",
      );
      this.#active.delete(key);
      this.#approvedPaths.delete(canonicalJson(previous.handle.origin));
      this.#unresolvedCommands.delete(canonicalJson(previous.handle.origin));
      previous = undefined;
    }
    const adapter =
      input.kind === "api"
        ? input.api
        : input.mcp &&
          createMcpAdapter(input.mcp, {
            revision: input.revision,
            authProviderFactory: input.mcpOAuth,
            hostCapabilities: {
              sampling: { context: {}, tools: {} },
              elicitation: { form: {}, url: {} },
              roots: {},
            },
          });
    requireCondition(
      adapter,
      "configuration_not_prepared",
      "The approved source needs its validated adapter.",
    );
    const origin: ContributionOrigin = {
      type: "platform",
      owner: input.objectId,
      namespace: input.kind,
      version: "1",
      revision: input.revision,
    };
    if (input.mcp?.transport === "stdio") {
      const paths = new Set<string>();
      if (path.isAbsolute(input.mcp.command))
        paths.add(realpathSync.native(input.mcp.command));
      else {
        requireCondition(
          path.basename(input.mcp.command) === input.mcp.command,
          "configuration_command_invalid",
          "A relative executable must be a bare OS command.",
        );
        this.#unresolvedCommands.set(canonicalJson(origin), input.mcp.command);
      }
      if (input.mcp.cwd) paths.add(realpathSync.native(input.mcp.cwd));
      this.#approvedPaths.set(canonicalJson(origin), paths);
    }
    const source = {
      apiVersion: 1 as const,
      origin,
      permissions: adapter.permissions,
      bindingPath: adapter.bindingPath,
    };
    let replacement: ExtensionReplacement | undefined;
    let handle: ExtensionHandle | undefined;
    let published = false;
    try {
      if (previous) {
        replacement = await this.registry.prepareReplacement(
          previous.handle,
          source,
          adapter.factory,
        );
        handle = replacement.candidate;
      } else handle = await this.registry.prepare(source, adapter.factory);
      this.#candidates.add(handle);
      scope.signal.throwIfAborted();
      scope.assertCurrent();
      // Physical names depend on fixed identity/revision, preserving case and path isolation.
      const parts = [
        "docs",
        "adapters",
        input.kind,
        digest(input.name),
        digest(input.revision),
      ];
      const directory = path.join(this.work, ...parts);
      const filename = path.join(directory, "README.md");
      const hold = await this.materialRetention?.hold("extension", directory);
      if (hold) this.#holds.set(handle, hold);
      const catalog = adapter.catalog();
      const api = input.api;
      const markdown = api
        ? api.documentation.markdown
        : `# MCP ${input.name}\n\n\`mcp[${JSON.stringify(input.name)}]\`\n\n\`\`\`json\n${canonicalJson({ catalog, methods: handle.methods }, 16 * 1024 * 1024)}\n\`\`\`\n`;
      const space = await this.reserve?.(
        Buffer.byteLength(markdown) +
          Buffer.byteLength(api?.documentation.types ?? "") +
          2048,
      );
      try {
        privateDirectory(this.work, ...parts);
        atomicText(filename, markdown);
        if (api)
          atomicText(
            path.join(directory, "index.d.ts"),
            api.documentation.types,
          );
      } finally {
        space?.release();
      }
      const instruction =
        input.kind === "mcp" && catalog && "instructions" in catalog
          ? catalog.instructions
          : null;
      const materials: PublishedMaterials = {
        docs: [
          {
            name: `${input.kind}.${input.name}`,
            description: `已批准的 ${input.kind} SDK 用法与调用定义`,
            path: filename,
            owner: origin.owner,
            version: "1",
          },
        ],
        instructions:
          typeof instruction === "string" && instruction.length
            ? [
                {
                  instructionId: `mcp:${input.objectId}`,
                  kind: "mcp",
                  path: null,
                  scope: { type: "agent", root: this.work },
                  origin,
                  content: instruction,
                  truncated: false,
                },
              ]
            : [],
        skills: [],
      };
      const active: ActiveSource = {
        kind: input.kind,
        name: input.name,
        objectId: input.objectId,
        revision: input.revision,
        handle,
        materials,
        available: true,
      };
      if (replacement) {
        const retired = await this.registry.retireReplacement(replacement);
        previous!.available = false;
        if (retired.status === "disabled")
          this.materialRetention?.setPublished(
            "configuration:" + input.objectId,
            null,
          );
        requireCondition(
          retired.status === "disabled",
          "configuration_cleanup_unconfirmed",
          "The previous source has not actually closed.",
        );
      }
      scope.signal.throwIfAborted();
      scope.assertCurrent();
      return {
        publish: () => {
          requireCondition(
            !published,
            "configuration_already_published",
            "This candidate has already been published.",
          );
          const commit = () => {
            this.materialRetention?.setPublished(
              "configuration:" + input.objectId,
              directory,
            );
            this.#active.set(key, active);
          };
          if (replacement)
            this.registry.publishReplacement(replacement, commit);
          else this.registry.publish(handle!, commit);
          published = true;
          this.#holds.get(handle!)?.release();
          this.#holds.delete(handle!);
          this.#candidates.delete(handle!);
          this.#approvedPaths.delete(canonicalJson(handle!.origin));
          this.#unresolvedCommands.delete(canonicalJson(handle!.origin));
        },
        dispose: async () => {
          if (published) return;
          const result = await this.registry.disable(handle!);
          requireCondition(
            result.status === "disabled",
            "configuration_cleanup_unconfirmed",
            "The candidate source has not actually closed.",
          );
          this.#holds.get(handle!)?.release();
          this.#holds.delete(handle!);
          this.#candidates.delete(handle!);
          this.#approvedPaths.delete(canonicalJson(handle!.origin));
          this.#unresolvedCommands.delete(canonicalJson(handle!.origin));
        },
      };
    } catch (cause) {
      handle ??= this.registry.preparationFailure(cause, source) ?? undefined;
      if (handle) {
        this.#candidates.add(handle);
        const result = await this.registry
          .disable(handle)
          .catch(() => undefined);
        if (result?.status === "disabled") {
          this.#holds.get(handle)?.release();
          this.#holds.delete(handle);
          this.#candidates.delete(handle);
          this.#approvedPaths.delete(canonicalJson(handle.origin));
          this.#unresolvedCommands.delete(canonicalJson(handle.origin));
        }
      }
      throw cause;
    }
  }
  async remove(
    input: Parameters<ConfigurationActivation["remove"]>[0],
    scope: MaintenanceScope,
  ): Promise<void> {
    scope.signal.throwIfAborted();
    scope.assertCurrent();
    const key = input.kind + ":" + input.name,
      active = this.#active.get(key);
    if (!active) return;
    requireCondition(
      active.objectId === input.objectId && active.revision === input.revision,
      "configuration_revision_mismatch",
      "Remove only the exact approved source.",
    );
    const result = await this.registry.disable(active.handle, () => {
      active.available = false;
    });
    active.available = false;
    if (result.status === "disabled") {
      this.materialRetention?.setPublished(
        "configuration:" + input.objectId,
        null,
      );
      this.#active.delete(key);
      this.#approvedPaths.delete(canonicalJson(active.handle.origin));
      this.#unresolvedCommands.delete(canonicalJson(active.handle.origin));
    }
    requireCondition(
      result.status === "disabled",
      "configuration_cleanup_unconfirmed",
      "The source has not actually closed.",
    );
  }
  async close(): Promise<void> {
    for (const handle of new Set([
      ...this.#candidates,
      ...[...this.#active.values()].map((value) => value.handle),
    ])) {
      const result = await this.registry.disable(handle);
      requireCondition(
        result.status === "disabled",
        "shutdown_unconfirmed",
        "An approved adapter has not actually closed.",
      );
      this.#holds.get(handle)?.release();
      this.#holds.delete(handle);
      this.#candidates.delete(handle);
      this.#approvedPaths.delete(canonicalJson(handle.origin));
      this.#unresolvedCommands.delete(canonicalJson(handle.origin));
      for (const [key, active] of this.#active)
        if (active.handle === handle) {
          this.materialRetention?.setPublished(
            "configuration:" + active.objectId,
            null,
          );
          this.#active.delete(key);
        }
    }
  }
}
