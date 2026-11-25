/**
{"scriptName":"installation.js","scriptDesc":"获取 Browser 已准备的稳定插件加载目录和版本","scriptWhenUse":"用户要安装、重新加载或核对 Chrome/Edge 插件路径时；不需要已连接浏览器","scriptInputSchema":{"type":"object","additionalProperties":false},"scriptOpenDefault":true,"scriptOutputSchema":{"oneOf":[{"type":"object","properties":{"assetsReady":{"const":true},"profile":{"enum":["production","development"]},"directory":{"type":"string"},"name":{"type":"string"},"extensionVersion":{"type":"string"},"extensionId":{"type":"string","pattern":"^[a-p]{32}$"}},"required":["assetsReady","profile","directory","name","extensionVersion","extensionId"],"additionalProperties":false},{"type":"object","properties":{"assetsReady":{"const":false},"code":{"const":"browser_assets_unavailable"}},"required":["assetsReady","code"],"additionalProperties":false}]}}
*/
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { createHash } = await import("node:crypto");
const unavailable = { assetsReady: false, code: "browser_assets_unavailable" };
try {
  const work = context.paths?.work;
  if (typeof work !== "string" || !path.isAbsolute(work)) return unavailable;
  const root = await fs.realpath(work);
  if (path.relative(root, work) !== "") return unavailable;
  const parent = path.join(root, ".nexum-browser");
  const directory = path.join(parent, "extension");
  for (const target of [parent, directory]) {
    const info = await fs.lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        path.relative(target, await fs.realpath(target)) !== "") return unavailable;
  }
  async function readOwnedJSON(name) {
    const file = path.join(directory, name);
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 65536 ||
        path.relative(file, await fs.realpath(file)) !== "") throw Error("invalid asset");
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size)
        throw Error("changed asset");
      const bytes = Buffer.alloc(65537);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const after = await fs.lstat(file);
      if (size !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
          after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw Error("changed asset");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    } finally { await handle.close(); }
  }
  const installation = await readOwnedJSON("nexum-installation.json");
  const manifest = await readOwnedJSON("manifest.json");
  if (!["production","development"].includes(installation.profile) ||
      !/^[a-p]{32}$/.test(installation.extensionId) ||
      typeof manifest.key !== "string" || typeof manifest.name !== "string" ||
      typeof manifest.version !== "string" || manifest.version !== installation.extensionVersion ||
      !Array.isArray(installation.files) || installation.files.length > 512 ||
      !installation.files.includes("manifest.json")) return unavailable;
  const extensionId = [...createHash("sha256").update(Buffer.from(manifest.key,"base64")).digest().subarray(0,16)]
    .map(value => String.fromCharCode(97+(value>>4),97+(value&15))).join("");
  if (extensionId !== installation.extensionId) return unavailable;
  for (const name of installation.files) {
    if (typeof name !== "string" || !name || name === "." || name === ".." ||
        /[\\/:\u0000]/.test(name)) return unavailable;
    const file = path.join(directory,name);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() ||
        path.relative(file,await fs.realpath(file)) !== "") return unavailable;
  }
  // Assets ready is not evidence that a browser has installed or loaded them.
  return { assetsReady:true, profile:installation.profile, directory, name:manifest.name,
    extensionVersion:manifest.version, extensionId };
} catch {
  return unavailable;
}
