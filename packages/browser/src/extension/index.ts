import { readFile } from "node:fs/promises";
import path from "node:path";
import { Marked } from "marked";
import TurndownService from "turndown";
import type {
  ExtensionFactory,
  ExtensionHost,
  Invocation,
  ManagedResource,
  MethodDefinition,
} from "@nexum/extension-api";
import { browserRoutes } from "../client/routes.js";
import {
  normalizeBrowserValue,
  validateLocatorDescription,
  validateTarget,
} from "../client/serialize.js";
import { BrowserService, type BrowserPeer } from "./service.js";
import { BrowserRuntime } from "./scope.js";
import { collectTabContent } from "./batch.js";
import { preparePlugin, type PluginBuild } from "./assets.js";
import { materializeDownload, prepareFiles } from "./files.js";
import {
  materializeArtifact,
  materializeAssetDownloads,
  materializeAssetBundle,
} from "./artifacts.js";
import type { BrowserFileSource, FileChooserFiles } from "../client/types.js";
import {
  check,
  data,
  failure,
  identifier,
  record,
  permissionDenied,
  type Target,
} from "./protocol.js";

interface Route {
  method: string;
  needsTab: boolean;
  mutating: boolean;
}
class BrowserInstallation implements ManagedResource {
  readonly closed: Promise<void>;
  #done = Promise.withResolvers<void>();
  #stop = new AbortController();
  #flow?: Promise<void>;
  #disposal?: Promise<void>;
  #stopping = false;
  service?: BrowserService;
  runtime?: BrowserRuntime;
  build?: PluginBuild;
  routes: readonly Route[] = [];
  constructor() {
    this.closed = this.#done.promise;
    void this.closed.catch(() => {});
  }
  start(host: ExtensionHost, signal: AbortSignal): Promise<void> {
    check(
      !this.#stopping,
      "EXTENSION_OFFLINE",
      "The browser installation is stopping.",
    );
    if (this.#flow) return this.#flow;
    const combined = AbortSignal.any([signal, this.#stop.signal]);
    const task = (async () => {
      this.build = await preparePlugin(host, combined);
      combined.throwIfAborted();
      const paths = host.context.paths;
      check(
        record(paths) && typeof paths.work === "string",
        "INVALID_ARGUMENT",
        "The Agent work directory is missing.",
      );
      const manifest = JSON.parse(
        await readFile(
          new URL(
            "../../browser-extension/route-manifest.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as unknown;
      check(
        Array.isArray(manifest) &&
          manifest.length <= 512 &&
          manifest.every(
            (value) =>
              record(value) &&
              identifier(value.method) &&
              typeof value.needsTab === "boolean" &&
              typeof value.mutating === "boolean",
          ),
        "PROTOCOL_MISMATCH",
        "The plugin method manifest is invalid.",
      );
      this.routes = manifest as unknown as Route[];
      combined.throwIfAborted();
      host.authorize({
        type: "connection",
        value: `127.0.0.1:${this.build.port}`,
        access: "listen",
      });
      this.service = new BrowserService({
        ...this.build,
        work: paths.work,
        ...(typeof host.config.defaultBrowserId === "string"
          ? { defaultBrowserId: host.config.defaultBrowserId }
          : {}),
      });
      this.runtime = new BrowserRuntime(this.service);
      await this.service.start(combined);
      combined.throwIfAborted();
    })();
    this.#flow = task;
    void task.catch(() => {});
    return task;
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#stopping = true;
    this.#stop.abort(
      failure("EXTENSION_OFFLINE", "The browser extension is stopping."),
    );
    const task = (async () => {
      await this.#flow?.catch(() => {});
      await this.runtime?.dispose();
      await this.service?.dispose();
      if (this.service) await this.service.closed;
      this.#done.resolve();
    })();
    this.#disposal = task;
    void task.catch(() => {
      if (this.#disposal === task) this.#disposal = undefined;
    });
    return task;
  }
}
const methodAliases: Record<string, string> = {
  "tab.devLogs": "dev.logs",
  "tab.dialogAccept": "dialogs.accept",
  "tab.dialogDismiss": "dialogs.dismiss",
};
const markdown = new Marked({ gfm: true });
const artifactMethods = new Set([
  "content.export",
  "content.exportGsuite",
  "content.exportYouTubeTranscript",
  "tab.exportFile",
  "cua.downloadMedia",
  "dom.downloadMedia",
  "locator.downloadMedia",
]);
const networkArtifacts = new Set([
  "pageAssets.download",
  "pageAssets.bundle",
  ...artifactMethods,
]);
function authorizeUrl(call: Invocation, value: unknown): void {
  check(
    typeof value === "string",
    "PROTOCOL_MISMATCH",
    "The browser did not return an exact source URL.",
  );
  const url = new URL(value);
  check(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password,
    "INVALID_ARGUMENT",
    "Remote browser files require an HTTP(S) source without embedded credentials.",
  );
  call.authorize({ type: "url", value: url.href, access: "read" });
}
const fileInputs = new Set(["tab.setFiles", "fileChoosers.setFiles"]);
const localRoutes = new Set([
  "browsers.list",
  "browsers.get",
  "browsers.getDefault",
  "browsers.getForUrl",
  "documentation.get",
  "browsers.documentation",
  "tabs.list",
  "user.openTabs",
  "user.claimTab",
]);
function selected(
  service: BrowserService,
  id: unknown,
  call: Invocation,
): BrowserPeer {
  check(
    identifier(id),
    "INVALID_TARGET",
    "Select a currently connected browser identity.",
  );
  call.authorize({ type: "connection", value: id, access: "read" });
  return service.get(id);
}
function targetOf(input: Record<string, unknown>): Target {
  const value =
    input.target ?? (record(input.locator) ? input.locator.target : undefined);
  validateTarget(value);
  return value as Target;
}
function safeInfo(value: unknown): unknown {
  return value === null ? undefined : value;
}
function noteResult(
  service: BrowserService,
  target: Target,
  value: unknown,
  method: string,
): void {
  let peer: BrowserPeer;
  try {
    peer = service.target({ ...target, tabId: undefined });
  } catch (cause) {
    if ((cause as { code?: string }).code === "EXTENSION_OFFLINE") return;
    throw cause;
  }
  if (method === "tab.close" && target.tabId) {
    peer.tabs.delete(target.tabId);
    return;
  }
  if (
    !["tabs.get", "tabs.new", "tabs.selected", "user.claimTab"].includes(method)
  )
    return;
  if (
    record(value) &&
    record(value.target) &&
    identifier(value.id) &&
    value.target.browserId === peer.id &&
    value.target.bootId === service.bootId &&
    value.target.generation === peer.generation &&
    value.target.browserSessionId === peer.browserSessionId
  ) {
    peer.tabs.set(
      value.id,
      data(
        {
          id: value.id,
          title: value.title ?? "",
          url: value.url ?? "",
          pageVersion: value.target.pageVersion ?? 1,
          active: false,
        },
        16384,
      ) as never,
    );
  }
}
async function local(
  pathName: string,
  input: Record<string, unknown>,
  call: Invocation,
  service: BrowserService,
  runtime: BrowserRuntime,
): Promise<unknown> {
  if (pathName === "browsers.list") {
    const allowed = [];
    for (const info of service.list()) {
      try {
        call.authorize({ type: "connection", value: info.id, access: "read" });
        allowed.push(info);
      } catch (cause) {
        if (!permissionDenied(cause)) throw cause;
      }
    }
    return allowed;
  }
  if (pathName === "browsers.get")
    return selected(service, input.id, call).info;
  if (pathName === "browsers.getDefault" || pathName === "browsers.getForUrl") {
    const peers = (await local(
      "browsers.list",
      {},
      call,
      service,
      runtime,
    )) as { id: string }[];
    check(
      peers.length,
      "EXTENSION_OFFLINE",
      "No approved browser extension is currently online.",
    );
    let chosen =
      peers.find((peer) => peer.id === service.options.defaultBrowserId)?.id ??
      peers[0]!.id;
    if (pathName === "browsers.getForUrl") {
      check(
        typeof input.url === "string",
        "INVALID_ARGUMENT",
        "A URL is required.",
      );
      const url = new URL(input.url);
      check(
        ["http:", "https:"].includes(url.protocol),
        "INVALID_ARGUMENT",
        "Browser URL selection supports HTTP(S).",
      );
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      const candidates = peers.map((info) => service.get(info.id));
      const exact = candidates.find((peer) =>
          [...peer.tabs.values()].some((tab) => tab.url === url.href),
        ),
        origin = candidates.find((peer) =>
          [...peer.tabs.values()].some((tab) => {
            try {
              return new URL(String(tab.url)).origin === url.origin;
            } catch {
              return false;
            }
          }),
        );
      chosen = (exact ?? origin)?.id ?? chosen;
    }
    return service.get(chosen).info;
  }
  if (
    pathName === "documentation.get" ||
    pathName === "browsers.documentation"
  ) {
    if (input.target) service.target(targetOf(input));
    const topic =
      pathName === "browsers.documentation" ? "README" : String(input.name);
    check(
      ["README", "usage", "connection", "lifecycle", "api"].includes(topic),
      "TOPIC_NOT_FOUND",
      "This package has no manual chapter with that name.",
    );
    return readFile(new URL(`../../docs/${topic}.md`, import.meta.url), "utf8");
  }
  const target = targetOf(input),
    peer = selected(service, target.browserId, call);
  service.target({ ...target, tabId: undefined });
  if (pathName === "tabs.list" || pathName === "user.openTabs") {
    await service.waitSnapshot(
      peer,
      "tabs",
      call.signal,
      call.deadline - Date.now(),
    );
    return [...peer.tabs.values()].map((tab) => ({
      id: tab.id,
      providerTabId: tab.id,
      ...(typeof tab.title === "string" ? { title: tab.title } : {}),
      ...(typeof tab.url === "string" ? { url: tab.url } : {}),
    }));
  }
  if (pathName === "user.claimTab") {
    const tab =
      typeof input.tab === "string"
        ? input.tab
        : record(input.tab)
          ? input.tab.id
          : undefined;
    check(
      identifier(tab),
      "INVALID_TARGET",
      "Choose a currently observed tab.",
    );
    await service.waitSnapshot(
      peer,
      "tabs",
      call.signal,
      call.deadline - Date.now(),
    );
    const selectedTarget = { ...target, tabId: tab };
    const value = await runtime.action(
      "tabs.get",
      { target: selectedTarget, id: tab },
      selectedTarget,
      call,
      false,
    );
    noteResult(service, selectedTarget, value, "tabs.get");
    return value;
  }
  throw failure(
    "CAPABILITY_NOT_ALLOWED",
    "This package build has not implemented this local browser route.",
  );
}

const createExtension: ExtensionFactory = async (host) => {
  check(
    Object.keys(host.config).every((key) => key === "defaultBrowserId") &&
      (host.config.defaultBrowserId === undefined ||
        identifier(host.config.defaultBrowserId)),
    "INVALID_ARGUMENT",
    "The browser extension config contains unsupported fields.",
  );
  const installation = new BrowserInstallation(),
    ref = await host.resources.register({
      kind: "browser-service",
      value: installation,
    });
  const abort = () => {
    void installation.dispose().catch(() => {});
  };
  ref.signal.addEventListener("abort", abort, { once: true });
  try {
    ref.signal.throwIfAborted();
    await installation.start(host, ref.signal);
    ref.signal.throwIfAborted();
    const service = installation.service!,
      runtime = installation.runtime!,
      remote = new Map(
        installation.routes.map((route) => [route.method, route]),
      );
    const methods: Record<string, MethodDefinition> = {};
    for (const route of browserRoutes) {
      const implemented = remote.get(
        route.path === "ax.write"
          ? "ax.get"
          : route.path === "tabs.content" &&
              remote.has("tabs.createTemporary") &&
              remote.has("tabs.closeTemporary")
            ? "tabs.createTemporary"
            : route.path === "tab.saveDownload"
              ? "downloads.path"
              : route.path === "tab.requestUserTakeover" &&
                  remote.has("tab.resumeUserControl")
                ? "tab.markHandoff"
                : (methodAliases[route.path] ?? route.path),
      );
      if (!implemented && !localRoutes.has(route.path)) continue;
      const pathName = route.path;
      methods[pathName] = {
        description: `Nexum browser: ${pathName}`,
        path: pathName.split("."),
        permissions:
          pathName === "documentation.get"
            ? []
            : [
                "connection",
                ...(pathName === "downloads.path" ||
                pathName === "tab.saveDownload" ||
                fileInputs.has(pathName) ||
                networkArtifacts.has(pathName)
                  ? ["path"]
                  : []),
                ...(networkArtifacts.has(pathName) ||
                pathName === "tabs.content"
                  ? ["url"]
                  : []),
              ],
        schemaDialect: "draft7",
        inputSchema: route.inputSchema,
        normalize(args: readonly unknown[]) {
          check(
            args.length === 1 && record(args[0]),
            "INVALID_ARGUMENT",
            "Browser data methods accept one explicit named input object.",
          );
          return normalizeBrowserValue(args[0]);
        },
        async handle(input: Record<string, unknown>, call: Invocation) {
          call.signal.throwIfAborted();
          if (localRoutes.has(pathName))
            return local(pathName, input, call, service, runtime);
          const waiter =
            pathName === "waiters.get" || pathName === "waiters.cancel"
              ? runtime.waiter(input.id, call)
              : undefined;
          const target = waiter?.target ?? targetOf(input);
          if (input.locator) validateLocatorDescription(input.locator);
          if (pathName === "user.getTabContext") {
            const id =
              typeof input.tab === "string"
                ? input.tab
                : record(input.tab)
                  ? input.tab.id
                  : undefined;
            check(
              id === undefined || identifier(id),
              "INVALID_TARGET",
              "Choose an actual browser tab.",
            );
            const lookupTarget =
              id === undefined ? target : { ...target, tabId: id };
            const observed = await runtime.action(
              id === undefined ? "tabs.selected" : "tabs.get",
              { target: lookupTarget, ...(id === undefined ? {} : { id }) },
              lookupTarget,
              call,
              false,
            );
            check(
              record(observed) && record(observed.target),
              "INVALID_TARGET",
              "The browser has no current selected tab.",
            );
            const effective = validateTarget(observed.target, true);
            check(
              effective.browserId === target.browserId &&
                effective.bootId === target.bootId &&
                effective.browserSessionId === target.browserSessionId &&
                effective.generation === target.generation &&
                (id === undefined || effective.tabId === id),
              "PROTOCOL_MISMATCH",
              "The observed context target does not belong to this browser request.",
            );
            noteResult(service, effective, observed, "tabs.get");
            // Reserve the exact tab under the actual run before reading any document data.
            return runtime.action(
              pathName,
              { target: effective, tab: effective.tabId },
              effective,
              call,
              false,
            );
          }
          if (pathName === "tabs.content")
            return collectTabContent(
              input,
              target,
              call,
              runtime,
              (target, value, method) =>
                noteResult(service, target, value, method),
            );
          const paths = host.context.paths;
          check(
            record(paths) && typeof paths.work === "string",
            "INVALID_ARGUMENT",
            "The Agent work directory is missing.",
          );
          if (pathName === "tab.requestUserTakeover") {
            await runtime.action(
              "tab.markHandoff",
              { target },
              target,
              call,
              true,
            );
            const reply = await call.requestInput({
              message:
                input.reason === "authentication"
                  ? "请在浏览器中完成认证，然后明确确认是否继续。"
                  : input.reason === "captcha"
                    ? "请在浏览器中完成验证，然后明确确认是否继续。"
                    : "浏览器目标已交还给你；完成操作后，请明确确认是否继续。",
              inputSchema: {
                type: "object",
                properties: { confirmed: { type: "boolean" } },
                required: ["confirmed"],
                additionalProperties: false,
              },
              timeoutMs: Math.max(1, Math.floor(call.deadline - Date.now())),
            });
            check(
              record(reply.input) && reply.input.confirmed === true,
              "USER_TAKEOVER",
              "The user did not confirm renewed browser control.",
            );
            await runtime.resume(target, call);
            return undefined;
          }
          let prepared = waiter
            ? {
                ...input,
                target,
                ...(pathName === "waiters.get"
                  ? { timeoutMs: Math.max(1, waiter.expiresAt - Date.now()) }
                  : {}),
              }
            : input;
          if (fileInputs.has(pathName)) {
            service.target(target);
            call.authorize({
              type: "connection",
              value: target.browserId,
              access: "control",
            });
            prepared = {
              ...prepared,
              files: await prepareFiles(
                input.files as FileChooserFiles | BrowserFileSource[],
                call,
                paths.work,
              ),
            };
          }
          if (pathName === "tab.saveDownload")
            prepared = { target, downloadId: input.id };
          if (
            pathName === "tab.dialogAccept" ||
            pathName === "tab.dialogDismiss"
          ) {
            const dialog = await runtime.action(
              "tab.getJsDialog",
              { target },
              target,
              call,
              false,
            );
            check(
              record(dialog) &&
                typeof dialog.dialogId === "string" &&
                Number.isSafeInteger(dialog.pageVersion),
              "STALE_REF",
              "There is no current native dialog to control.",
            );
            prepared = {
              target,
              dialogId: dialog.dialogId,
              pageVersion: dialog.pageVersion,
              ...(input.text === undefined ? {} : { text: input.text }),
            };
          }
          if (
            (pathName === "dev.logs" || pathName === "tab.devLogs") &&
            record(input.options) &&
            Array.isArray(input.options.levels)
          )
            prepared = {
              ...prepared,
              options: {
                ...input.options,
                levels: input.options.levels.map((level) =>
                  level === "warning" ? "warn" : level,
                ),
              },
            };

          if (
            pathName === "ax.paste" &&
            record(input.options) &&
            input.options.format === "md"
          ) {
            check(
              typeof input.text === "string",
              "INVALID_ARGUMENT",
              "Markdown paste requires text.",
            );
            const html = markdown.parse(input.text, { async: false });
            check(
              typeof html === "string" &&
                Buffer.byteLength(html) <= 128 * 1024 * 1024,
              "OUTPUT_TOO_LARGE",
              "Rendered Markdown exceeds the local byte budget.",
            );
            call.signal.throwIfAborted();
            check(
              Date.now() < call.deadline,
              "TIMEOUT",
              "Markdown rendering exceeded the method deadline.",
            );
            prepared = { ...prepared, html };
          }
          if (pathName === "pageAssets.download") {
            check(
              Array.isArray(input.urls),
              "INVALID_ARGUMENT",
              "Asset downloads require source URLs.",
            );
            for (const url of input.urls) authorizeUrl(call, url);
          }
          if (pathName === "pageAssets.bundle") {
            const plan = await runtime.action(
              "pageAssets.plan",
              input,
              target,
              call,
              false,
            );
            check(
              record(plan) &&
                record(input.options) &&
                plan.inventoryId === input.options.inventoryId &&
                Array.isArray(plan.assets) &&
                plan.assets.length <= 10000,
              "STALE_REF",
              "The asset plan does not match the original inventory.",
            );
            check(
              record(plan.target) &&
                [
                  "bootId",
                  "browserId",
                  "browserSessionId",
                  "generation",
                  "tabId",
                  "controlEpoch",
                ].every(
                  (key) =>
                    (plan.target as Record<string, unknown>)[key] ===
                    (target as unknown as Record<string, unknown>)[key],
                ),
              "STALE_REF",
              "The asset plan belongs to another target identity.",
            );
            authorizeUrl(call, plan.pageUrl);
            for (const asset of plan.assets) {
              check(
                record(asset) && typeof asset.url === "string",
                "PROTOCOL_MISMATCH",
                "The browser asset plan is invalid.",
              );
              const uri = new URL(asset.url);
              if (uri.protocol === "blob:" || uri.protocol === "data:") {
                check(
                  asset.embedded === true &&
                    (uri.protocol !== "blob:" ||
                      uri.origin === new URL(String(plan.pageUrl)).origin),
                  "PROTOCOL_MISMATCH",
                  "An embedded asset is not owned by this document inventory.",
                );
                call.authorize({
                  type: "url",
                  value: asset.url,
                  access: "read",
                });
              } else authorizeUrl(call, asset.url);
            }
            prepared = {
              ...prepared,
              options: {
                ...input.options,
                assetIds: plan.assets.map(
                  (asset) => (asset as Record<string, unknown>).id,
                ),
              },
            };
          }
          if (artifactMethods.has(pathName)) {
            const page = await runtime.action(
              "tab.url",
              { target },
              target,
              call,
              false,
            );
            authorizeUrl(call, page);
            if (remote.has("content.plan")) {
              const plan = await runtime.action(
                "content.plan",
                { target, method: pathName, ...input },
                target,
                call,
                false,
              );
              check(
                record(plan) &&
                  Array.isArray(plan.urls) &&
                  plan.urls.length <= 128,
                "PROTOCOL_MISMATCH",
                "The browser content plan is invalid.",
              );
              for (const url of plan.urls) authorizeUrl(call, url);
              prepared = { ...prepared, planId: plan.id };
            }
          }

          const remoteMethod =
            pathName === "ax.write"
              ? "ax.get"
              : pathName === "tab.saveDownload"
                ? "downloads.path"
                : (methodAliases[pathName] ?? pathName);
          const value = await runtime.action(
            remoteMethod,
            prepared,
            target,
            call,
            implemented!.mutating,
          );
          noteResult(service, target, value, pathName);
          if (
            (pathName === "dev.logs" || pathName === "tab.devLogs") &&
            record(input.options) &&
            typeof input.options.since === "number"
          ) {
            check(
              Array.isArray(value),
              "PROTOCOL_MISMATCH",
              "Native logs must be a bounded list.",
            );
            const since = input.options.since;
            return value.filter(
              (item) =>
                record(item) &&
                typeof item.timestamp === "string" &&
                Date.parse(item.timestamp) >= since,
            );
          }

          if (artifactMethods.has(pathName)) {
            if (
              pathName === "tab.exportFile" &&
              record(input.options) &&
              input.options.format === "markdown" &&
              record(value) &&
              value.mimeType === "text/html"
            ) {
              check(
                typeof value.text === "string",
                "PROTOCOL_MISMATCH",
                "Markdown conversion requires the actual serialized document HTML.",
              );
              const converter = new TurndownService({
                headingStyle: "atx",
                codeBlockStyle: "fenced",
              });
              converter.remove(["script", "style", "noscript"]);
              const converted = converter.turndown(value.text);
              call.signal.throwIfAborted();
              check(
                Date.now() < call.deadline,
                "TIMEOUT",
                "Markdown conversion exceeded the method deadline.",
              );
              return materializeArtifact(
                {
                  text: converted,
                  name:
                    typeof value.name === "string"
                      ? value.name.replace(/\.html?$/i, "") + ".md"
                      : "page.md",
                  mimeType: "text/markdown",
                  ...(typeof value.sourceUrl === "string"
                    ? { sourceUrl: value.sourceUrl }
                    : {}),
                },
                call,
                paths.work,
              );
            }
            return materializeArtifact(value, call, paths.work);
          }
          if (pathName === "pageAssets.download")
            return materializeAssetDownloads(value, call, paths.work);
          if (pathName === "pageAssets.bundle")
            return materializeAssetBundle(value, call, paths.work);
          if (
            pathName === "downloads.path" ||
            pathName === "tab.saveDownload"
          ) {
            if (value === null && pathName === "downloads.path") return null;
            check(
              typeof value === "string",
              "PROTOCOL_MISMATCH",
              "A completed download did not return its actual browser-local file.",
            );
            const artifact = await materializeDownload(
              {
                path: value,
                ...(typeof input.path === "string"
                  ? { destination: input.path }
                  : {}),
              },
              call,
              paths.work,
            );
            return pathName === "downloads.path" ? artifact.path : artifact;
          }
          if (pathName === "ax.write") {
            const mode = input.mode ?? "state";
            if (mode === "state") {
              check(
                typeof value === "string",
                "PROTOCOL_MISMATCH",
                "The accessibility state is not text.",
              );
              return call.output.text(value);
            }
            if (mode === "screenshot") {
              check(
                value instanceof Uint8Array,
                "PROTOCOL_MISMATCH",
                "The accessibility screenshot is not bytes.",
              );
              return call.output.image({ data: value, mimeType: "image/jpeg" });
            }
            check(
              record(value) &&
                typeof value.state === "string" &&
                value.screenshot instanceof Uint8Array,
              "PROTOCOL_MISMATCH",
              "The accessibility result is missing its real state or screenshot.",
            );
            return call.output.result({
              content: [
                call.output.text(value.state),
                call.output.image({
                  data: value.screenshot,
                  mimeType: "image/jpeg",
                }),
              ],
            });
          }
          return [
            "tabs.selected",
            "tab.getJsDialog",
            "tab.title",
            "tab.url",
          ].includes(pathName)
            ? safeInfo(value)
            : value;
        },
      };
    }
    ref.report({
      state: "listening",
      profile: installation.build!.profile,
      port: installation.build!.port,
      pluginDirectory: installation.build!.directory,
      methodCount: Object.keys(methods).length,
    });
    return { methods, dispose: () => installation.dispose() };
  } catch (cause) {
    await installation.dispose();
    throw cause;
  }
};
export default createExtension;
