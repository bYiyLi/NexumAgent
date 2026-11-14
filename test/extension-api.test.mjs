import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(import.meta.url);
const agent = realpathSync.native(
  fileURLToPath(new URL("../", import.meta.url)),
);
function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-public-api-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const consumer = path.join(root, "external-extension");
  const modules = path.join(consumer, "node_modules");
  mkdirSync(modules, { recursive: true });
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({
      name: "@fixture/third-party-extension",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: { "nexum-agent": `file:${agent}` },
    }),
  );
  symlinkSync(agent, path.join(modules, "nexum-agent"), "junction");
  symlinkSync(
    path.join(agent, "node_modules", "@types"),
    path.join(modules, "@types"),
    "junction",
  );
  return { root, consumer };
}
function succeeded(result, message) {
  assert.equal(result.error, undefined, `${message}: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `${message}\n${result.stdout}\n${result.stderr}`,
  );
}

const extension = `
import type {
  ExtensionFactory, ExtensionInstance, ExtensionHost, Invocation, MethodDefinition,
  ManagedResource, ResourceRef, ResourceService, ResourceSnapshot, ResourceQuery,
  OutputAPI, OutputIntent, McpResourceReader, McpReadScope, McpResultOptions,
  TransferService, TransferSnapshot, SchemaDialect, JsonObject,
} from "nexum-agent/extension-api";
import type { ExtensionFactory as RootFactory } from "nexum-agent";
// @ts-expect-error Core manager is not part of the extension protocol.
import type { ExtensionRegistry } from "nexum-agent/extension-api";
// @ts-expect-error Core result-resource manager is not part of the extension protocol.
import type { McpResultResources } from "nexum-agent/extension-api";
// @ts-expect-error Root re-exports public types, not Core managers.
import type { ExtensionRegistry as RootRegistry } from "nexum-agent";
// @ts-expect-error The package exports do not grant private dist subpath access.
import type { ExtensionRegistry as PrivateRegistry } from "nexum-agent/dist/extensions/registry.js";

class Connection implements McpResourceReader, ManagedResource {
  readonly connection = "third-party-service";
  readonly #done = Promise.withResolvers<void>();
  readonly closed = this.#done.promise;
  #stopped = false;
  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#stopped) throw new Error("The registered connection is stopped.");
  }
  assertCurrent(): void { if(this.#stopped) throw new Error("Connection is stopped."); }
  async readResource(uri: string, scope: McpReadScope): Promise<unknown> {
    this.assertCurrent(); scope.assertCurrent();
    scope.authorizeConnection(this.connection, uri, "resources.read");
    return {contents:[{uri,mimeType:"text/plain",text:"external resource"}]};
  }
  dispose(): void { this.#stopped = true; this.#done.resolve(); }
}

const createExtension: ExtensionFactory = async (host: ExtensionHost): Promise<ExtensionInstance> => {
  const resources: ResourceService = host.resources;
  const connection: ResourceRef<Connection> = await resources.register({kind:"mcp.connection",value:new Connection()});
  host.authorize({type:"connection",value:connection.value.connection,access:"connect"});
  await connection.value.start(connection.signal);
  connection.report({state:"ready"});
  host.log({level:"info",message:"The shared connection is ready."});
  const dialect: SchemaDialect = "draft7";
  const inspect: MethodDefinition = {
    description:"Inspect an external resource and offer a transfer",
    permissions:["read","transfer.createDownload","transfer.get"],
    schemaDialect:dialect,
    inputSchema:{type:"object",properties:{uri:{type:"string"}},required:["uri"],additionalProperties:false},
    outputSchema:{type:"object"},
    async handle(input: unknown, call: Invocation): Promise<JsonObject | OutputIntent> {
      if(!input || typeof input!=="object" || !("uri" in input) || typeof input.uri!=="string") throw new Error("uri is required");
      const query: ResourceQuery = {kind:"mcp.connection",state:"ready",limit:1};
      const history: readonly ResourceSnapshot[] = (await call.resources.list(query)).items;
      const current: ResourceRef<Connection> = await call.resources.get<Connection>(connection.id);
      const output: OutputAPI = call.output;
      const transfers: TransferService = call.transfer;
      const offer = await transfers.createDownload({uri:input.uri,name:"report.txt",mimeType:"text/plain"});
      const retained: TransferSnapshot = await transfers.get(offer.transferId,{waitMs:0});
      const options: McpResultOptions = {connectionResourceId:current.id,connection:current.value.connection,method:"tools/call"};
      const result = output.mcpResult({
        content:[{type:"text",text:"External SDK result"},{type:"resource_link",uri:input.uri,name:"report.txt",mimeType:"text/plain"}],
        structuredContent:{transferId:retained.transferId,historyCount:history.length},
      },options);
      call.log({level:"info",message:"Inspection completed."});
      call.progress({completed:1});
      return result;
    },
  };
  return {methods:{inspect},dispose:()=>connection.value.dispose()};
};
const rootCompatible: RootFactory = createExtension;
export default rootCompatible;
`;

test("a separate npm extension compiles the complete public factory contract without private type imports", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.consumer, "extension.ts"), extension);
  writeFileSync(
    path.join(f.consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      files: ["extension.ts"],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "-p",
      path.join(f.consumer, "tsconfig.json"),
    ],
    {
      cwd: f.consumer,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
  succeeded(
    result,
    "The external extension must compile with strict public declarations and effective negative-import assertions.",
  );
});

test("the public type entry has no runtime exports or service initialization and private package subpaths remain closed", (t) => {
  const f = fixture(t);
  const home = path.join(f.root, "isolated-home"),
    work = path.join(f.consumer, "runtime-work");
  mkdirSync(home);
  mkdirSync(work);
  const entry = pathToFileURL(
    realpathSync.native(path.join(agent, "dist", "extension-api.js")),
  ).href;
  const script = `
import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import {readdirSync} from "node:fs";
const allowed="nexum-agent/extension-api";
const hooks=registerHooks({resolve(specifier,context,next){
  assert.equal(specifier,allowed,"The type-only entry must not import any Core or other runtime dependency.");
  const resolved=next(specifier,context);
  assert.equal(resolved.url,${JSON.stringify(entry)});
  return resolved;
}});
let namespace;
try{ namespace=await import(allowed); }finally{ hooks.deregister(); }
assert.deepEqual(Object.getOwnPropertyNames(namespace),[]);
for(const specifier of ["nexum-agent/dist/extensions/registry.js","nexum-agent/dist/results/mcp.js","nexum-agent/src/extensions/registry.ts"]){
  await assert.rejects(import(specifier),{code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
}
assert.deepEqual(readdirSync(${JSON.stringify(home)}),[]);
assert.deepEqual(readdirSync(${JSON.stringify(work)}),[]);
console.log("type-only entry and package export boundaries verified");
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: work,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NEXUM_PROFILE: "development",
      },
    },
  );
  succeeded(
    result,
    "Importing the public type entry must stay inert and honor package exports.",
  );
  assert.match(
    result.stdout,
    /type-only entry and package export boundaries verified/,
  );
});
