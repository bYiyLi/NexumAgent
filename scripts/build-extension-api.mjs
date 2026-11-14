import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { generateDtsBundle } from "dts-bundle-generator";

export const agentRoot = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);

/** Build only the explicitly type-exported public surface from its real source. */
export async function buildExtensionApi({
  root = agentRoot,
  outDir = path.join(root, "packages/extension-api/dist"),
} = {}) {
  const entry = path.join(root, "src/extension-api.ts");
  const original = await readFile(entry, "utf8");
  const parsed = ts.createSourceFile(
    entry,
    original,
    ts.ScriptTarget.Latest,
    true,
  );
  if (
    parsed.statements.some(
      (node) => !ts.isExportDeclaration(node) || !node.isTypeOnly,
    )
  )
    throw new Error(
      "The public extension entry must contain type exports only.",
    );
  const [declarations] = generateDtsBundle(
    [
      {
        filePath: entry,
        failOnClass: true,
        libraries: { allowedTypesLibraries: ["node"] },
        output: { sortNodes: true, exportReferencedTypes: false },
      },
    ],
    { preferredConfigPath: path.join(root, "tsconfig.json") },
  );
  if (!declarations) throw new Error("The public type bundle is empty.");
  const output = ts.createSourceFile(
    "index.d.ts",
    declarations,
    ts.ScriptTarget.Latest,
    true,
  );
  const forbidden = new Set([
    "SqliteStore",
    "ResourceManager",
    "RunEngine",
    "ArtifactStore",
    "Registry",
    "TransferServices",
    "AgentToken",
    "loadProfileConfig",
  ]);
  const inspect = (node) => {
    if (
      ts.isClassDeclaration(node) ||
      (ts.isIdentifier(node) && forbidden.has(node.text))
    )
      throw new Error(
        "The public bundle contains a private Core implementation type.",
      );
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!node.moduleSpecifier.text.startsWith("node:"))
        throw new Error(
          "The public bundle depends on an Agent source or runtime module.",
        );
    }
    if (ts.isImportTypeNode(node))
      throw new Error("The public bundle contains a source import type.");
    ts.forEachChild(node, inspect);
  };
  inspect(output);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "index.d.ts"), declarations + "\n");
  await writeFile(
    path.join(outDir, "index.js"),
    "// Type-only public contract: no Agent initialization.\nexport {};\n",
  );
  return { outDir, declarations };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === "--out-dir"))
    throw new Error("Use --out-dir with one explicit directory.");
  await buildExtensionApi(args.length ? { outDir: path.resolve(args[1]) } : {});
}
