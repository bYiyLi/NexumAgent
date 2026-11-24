// Test-only reference for the pre-migration discovery contract.
// No runtime module imports this file. Production discovery lives in Go.
import { readdir, realpath, stat, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import ignore from "ignore";
import { AgentError, requireCondition } from "../../dist/contracts/errors.js";
import { contains } from "../../dist/runtime/paths.js";
import { boundedFile, parseSkillFrontmatter, selectorKey } from "../../dist/work/discovery.js";
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const missing = (error) => error.code === "ENOENT" ||
    error.code === "ENOTDIR";
function check(signal) {
    signal?.throwIfAborted();
}
function utf8(bytes, filename) {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
        throw new AgentError("material_encoding", "A text material is not valid UTF-8.", { path: filename });
    }
}
async function canonicalFile(filename, boundary) {
    try {
        const actual = await realpath(filename);
        if (boundary && !contains(boundary, actual))
            return null;
        return (await stat(actual)).isFile() ? actual : null;
    }
    catch (error) {
        if (missing(error))
            return null;
        throw error;
    }
}
async function canonicalDirectory(filename, boundary) {
    try {
        const actual = await realpath(filename);
        if (boundary && !contains(boundary, actual))
            return null;
        return (await stat(actual)).isDirectory() ? actual : null;
    }
    catch (error) {
        if (missing(error))
            return null;
        throw error;
    }
}
function origin(agentId, revision) {
    return {
        type: "local",
        owner: "local:" + agentId,
        namespace: null,
        version: null,
        revision,
    };
}
function groups(root) {
    return [
        {
            kind: "agents",
            paths: [
                path.join(root, "AGENTS.override.md"),
                path.join(root, "AGENTS.md"),
            ],
        },
        { kind: "claude", paths: [path.join(root, "CLAUDE.md")] },
        { kind: "gemini", paths: [path.join(root, "GEMINI.md")] },
        { kind: "context", paths: [path.join(root, "CONTEXT.md")] },
    ];
}
function ignored(filename, directory, matcher, root) {
    if (!matcher || !root)
        return false;
    const relative = path.relative(root, filename).split(path.sep).join("/");
    return (relative.length > 0 && matcher.ignores(relative + (directory ? "/" : "")));
}
function scopedPatterns(content, scope) {
    if (!scope)
        return content.split(/\r?\n/);
    requireCondition(!/[\r\n]/.test(scope), "discovery_scope_invalid", "An ignore-file scope cannot contain line separators.");
    // node-ignore owns matching and negation. Qualify directory-scoped patterns
    // into one ordered matcher so re-included parents also affect descendants.
    const prefix = scope.replace(/[\\*?\[\]#!]/g, "\\$&") + "/";
    return content.split(/\r?\n/).map((line) => {
        if (!line || line.startsWith("#") || line === "!")
            return line;
        const negative = line.startsWith("!") ? "!" : "";
        let pattern = negative ? line.slice(1) : line;
        if (pattern === "/")
            return "";
        if (pattern.startsWith("/"))
            return negative + prefix + pattern.slice(1);
        const inner = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
        return negative + prefix + (inner.includes("/") ? "" : "**/") + pattern;
    });
}
export async function discoverMaterials(options) {
    check(options.signal);
    const work = await realpath(options.work);
    const home = options.home ? await realpath(options.home) : null;
    const project = options.projectRoot
        ? await realpath(options.projectRoot)
        : null;
    const disabled = new Set();
    for (const selector of options.disabledItems ?? []) {
        requireCondition(project &&
            ["instruction", "skill"].includes(selector.kind) &&
            /^[0-9a-f]{64}$/.test(selector.key), "invalid_visibility", "Visibility selectors require a project and a valid kind/key.");
        disabled.add(selector.kind + ":" + selector.key);
    }
    const result = {
        instructions: [],
        nestedInstructions: [],
        skills: [],
        warnings: [],
        nestedComplete: true,
        skillsComplete: true,
    };
    const seenInstructions = new Set();
    async function instructions(root, scope, boundary, matcher = null, nested = false, custom, knownNames) {
        let actualScope;
        for (const group of custom ?? groups(root)) {
            check(options.signal);
            for (const candidate of group.paths) {
                // The directory was enumerated for this very walk. Do not issue
                // several known-missing realpath/stat requests for every directory.
                // Existing candidates still receive their full security/read checks.
                if (knownNames && !knownNames.has(path.basename(candidate)))
                    continue;
                if (ignored(candidate, false, matcher, boundary))
                    continue;
                const actual = await canonicalFile(candidate, boundary);
                if (!actual)
                    continue;
                if (seenInstructions.has(actual))
                    break;
                if (nested && result.nestedInstructions.length >= 100) {
                    result.nestedComplete = false;
                    return;
                }
                if (nested && !actualScope) {
                    const canonicalScope = await realpath(root);
                    requireCondition(!boundary || contains(boundary, canonicalScope), "discovery_path_escape", "An instruction scope escaped the project root.");
                    actualScope = { type: "directory", root: canonicalScope };
                }
                const key = selectorKey("instruction", actual);
                const hidden = disabled.has("instruction:" + key);
                const info = await stat(actual);
                let revision = "stat:" +
                    hash([info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":"));
                let content;
                if (!nested && !hidden) {
                    const read = await boundedFile(actual, 65536, options.signal);
                    revision = read.revision;
                    content = utf8(read.bytes, actual);
                }
                const item = {
                    instructionId: "local:" + key,
                    kind: group.kind,
                    path: actual,
                    scope: actualScope ?? scope,
                    origin: origin(options.agentId, revision),
                    ...(content === undefined ? {} : { content }),
                    truncated: false,
                    disabled: hidden,
                };
                (nested ? result.nestedInstructions : result.instructions).push(item);
                seenInstructions.add(actual);
                break;
            }
        }
    }
    if (home) {
        const personal = { type: "personal", root: home };
        await instructions(home, personal, undefined, null, false, [
            { kind: "agents", paths: [path.join(home, ".agents", "AGENTS.md")] },
            {
                kind: "agents",
                paths: [
                    path.join(home, ".codex", "AGENTS.override.md"),
                    path.join(home, ".codex", "AGENTS.md"),
                ],
            },
            { kind: "claude", paths: [path.join(home, ".claude", "CLAUDE.md")] },
            { kind: "gemini", paths: [path.join(home, ".gemini", "GEMINI.md")] },
        ]);
    }
    await instructions(work, { type: "agent", root: work }, work);
    if (project) {
        await instructions(project, { type: "project", root: project }, project);
        let directories = 0;
        const maximum = options.maxDirectories ?? 50000;
        requireCondition(Number.isInteger(maximum) && maximum > 0 && maximum <= 50000, "invalid_discovery_limit", "The directory budget must be between 1 and 50000.");
        async function walk(directory, inherited, isRoot = false) {
            check(options.signal);
            if (result.nestedInstructions.length >= 100) {
                result.nestedComplete = false;
                return;
            }
            if (!isRoot)
                requireCondition(++directories <= maximum, "discovery_limit", "Nested instruction discovery exceeded its effective directory budget.");
            const entries = await readdir(directory, { withFileTypes: true });
            entries.sort((a, b) => compare(a.name, b.name));
            const knownNames = new Set(entries.map((entry) => entry.name));
            let matcher = inherited;
            const control = path.join(directory, ".gitignore");
            let entry;
            if (knownNames.has(".gitignore")) {
                try {
                    entry = await lstat(control);
                }
                catch (error) {
                    if (!missing(error))
                        throw error;
                }
            }
            if (entry?.isFile() && !entry.isSymbolicLink()) {
                const actual = await realpath(control);
                requireCondition(contains(project, actual), "discovery_path_escape", "A project ignore file escaped its root.");
                const read = await boundedFile(actual, 65536, options.signal);
                const scope = path
                    .relative(project, directory)
                    .split(path.sep)
                    .join("/");
                matcher = ignore({ ignorecase: false })
                    .add(inherited)
                    .add(scopedPatterns(utf8(read.bytes, actual), scope));
            }
            if (!isRoot) {
                await instructions(directory, { type: "directory", root: directory }, project, matcher, true, undefined, knownNames);
                if (!result.nestedComplete)
                    return;
            }
            for (const child of entries) {
                check(options.signal);
                if (!child.isDirectory() ||
                    child.isSymbolicLink() ||
                    child.name.toLowerCase() === ".git")
                    continue;
                const filename = path.join(directory, child.name);
                if (!ignored(filename, true, matcher, project))
                    await walk(filename, matcher);
                if (!result.nestedComplete)
                    break;
            }
        }
        await walk(project, ignore({ ignorecase: false }), true);
    }
    const collections = [];
    if (project)
        for (const name of [".agents", ".codex", ".claude"])
            collections.push({
                root: path.join(project, name, "skills"),
                scope: { type: "project", root: project },
                boundary: project,
            });
    // Nexum-derived method descriptions are not user Skills. They are injected
    // from the authorized live capability catalog, never rediscovered as files.
    if (home)
        for (const parts of [
            [".agents", "skills"],
            [".codex", "skills"],
            [".codex", "skills", ".system"],
            [".claude", "skills"],
        ])
            collections.push({
                root: path.join(home, ...parts),
                scope: { type: "personal", root: home },
            });
    const seenSkills = new Set(), seenNames = new Set();
    for (const collection of collections) {
        check(options.signal);
        const root = await canonicalDirectory(collection.root, collection.boundary);
        if (!root)
            continue;
        const entries = await readdir(root, { withFileTypes: true });
        entries.sort((a, b) => compare(a.name, b.name));
        for (const entry of entries) {
            check(options.signal);
            if (entry.name.startsWith("."))
                continue;
            if (result.skills.length >= 100) {
                result.skillsComplete = false;
                break;
            }
            const skillRoot = await canonicalDirectory(path.join(root, entry.name), root);
            if (!skillRoot)
                continue;
            const file = await canonicalFile(path.join(skillRoot, "SKILL.md"), skillRoot);
            if (!file || seenSkills.has(file))
                continue;
            let metadata, revision;
            try {
                const read = await boundedFile(file, 1024 * 1024, options.signal);
                metadata = parseSkillFrontmatter(read.bytes, path.basename(skillRoot).normalize("NFC"));
                revision = read.revision;
            }
            catch (error) {
                check(options.signal);
                result.warnings.push({
                    code: error instanceof AgentError ? error.code : "skill_unavailable",
                    path: file,
                    message: error instanceof AgentError
                        ? error.message
                        : "Skill metadata could not be loaded.",
                });
                continue;
            }
            if (seenNames.has(metadata.name.normalize("NFC")))
                continue;
            const key = selectorKey("skill", file);
            result.skills.push({
                ...metadata,
                skillId: "local:" + key,
                path: skillRoot,
                skillFile: file,
                scope: collection.scope,
                origin: origin(options.agentId, revision),
                disabled: disabled.has("skill:" + key),
            });
            seenSkills.add(file);
            seenNames.add(metadata.name.normalize("NFC"));
        }
        if (!result.skillsComplete)
            break;
    }
    if (!result.skillsComplete)
        result.warnings.push({
            code: "skill_discovery_limit",
            path: null,
            message: "Local Skill discovery reached its 100-item bound; the directory may contain more Skills.",
        });
    if (!result.nestedComplete)
        result.warnings.push({
            code: "instruction_discovery_limit",
            path: project,
            message: "Nested instruction discovery reached its 100-item bound.",
        });
    result.nestedInstructions.sort((a, b) => compare(a.scope.root, b.scope.root) || compare(a.path, b.path));
    result.skills.sort((a, b) => compare(a.skillId, b.skillId));
    check(options.signal);
    return result;
}
