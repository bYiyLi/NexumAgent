import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = "frontend/public/nexum-mark.svg";
const manifest = "build/brand-icons.json";
const files = ["build/appicon.png", "build/darwin/icons.icns", "build/windows/icon.ico", "build/tray-template.png"];
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => fs.readFileSync(path.join(root, file));
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");

function assert(condition, message) {
  if (!condition) throw new Error("Brand icons: " + message);
}

function checkPng(bytes, size, name) {
  assert(bytes.length > 33 && bytes.subarray(0, 8).equals(pngSignature), name + " is not PNG");
  assert(bytes.readUInt32BE(16) === size && bytes.readUInt32BE(20) === size, name + " dimensions");
}

function checkIco(bytes) {
  assert(bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1, "invalid ICO header");
  const count = bytes.readUInt16LE(4);
  assert(count === icoSizes.length && bytes.length >= 6 + count * 16, "invalid ICO directory");
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const start = 6 + i * 16;
    const width = bytes[start] || 256;
    const height = bytes[start + 1] || 256;
    const size = bytes.readUInt32LE(start + 8);
    const offset = bytes.readUInt32LE(start + 12);
    assert(width === height && size > 0 && offset >= 6 + count * 16 && offset + size <= bytes.length, "invalid ICO image");
    checkPng(bytes.subarray(offset, offset + size), width, "ICO image");
    sizes.push(width);
  }
  assert(sizes.sort((a, b) => a - b).join(",") === icoSizes.join(","), "missing ICO sizes");
}

function checkIcns(bytes) {
  assert(bytes.length >= 8 && bytes.toString("ascii", 0, 4) === "icns" && bytes.readUInt32BE(4) === bytes.length, "invalid ICNS header");
  // Wails 3.1.0 emits the retina 16pt (32px) and larger PNG representations.
  const types = new Map([["ic10", 1024], ["ic14", 512], ["ic09", 512], ["ic13", 256], ["ic08", 256], ["ic07", 128], ["ic12", 64], ["ic11", 32]]);
  const seen = new Set();
  let offset = 8;
  while (offset < bytes.length) {
    assert(offset + 8 <= bytes.length, "truncated ICNS chunk");
    const length = bytes.readUInt32BE(offset + 4);
    assert(length >= 8 && offset + length <= bytes.length, "invalid ICNS chunk length");
    const type = bytes.toString("ascii", offset, offset + 4);
    if (types.has(type)) {
      checkPng(bytes.subarray(offset + 8, offset + length), types.get(type), "ICNS " + type);
      seen.add(type);
    }
    offset += length;
  }
  for (const type of types.keys()) assert(seen.has(type), "missing ICNS representation " + type);
}

function validateAssets(assets) {
  checkPng(assets[files[0]], 1024, "app icon");
  checkIcns(assets[files[1]]);
  checkIco(assets[files[2]]);
  checkPng(assets[files[3]], 64, "macOS menu bar template");
}

function assetManifest(svg, assets) {
  return {
    source: { path: source, sha256: hash(svg) },
    assets: Object.fromEntries(files.map(file => [file, hash(assets[file])])),
  };
}

// All normal builds verify the checked-in outputs without installing a renderer.
export function verifyBrandIcons() {
  const svg = read(source);
  const assets = Object.fromEntries(files.map(file => [file, read(file)]));
  validateAssets(assets);
  const expected = assetManifest(svg, assets);
  const recorded = JSON.parse(read(manifest).toString("utf8"));
  assert(recorded.source?.path === source && recorded.source?.sha256 === expected.source.sha256,
    "SVG source changed; regenerate with pnpm icons:generate on macOS");
  for (const file of files) {
    assert(recorded.assets?.[file] === expected.assets[file], file + " differs from generated brand assets; regenerate together");
  }
}

function run(command, args) {
  const r = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(command + " failed: " + r.status);
}

function render(temp, name, size, body) {
  const svg = path.join(temp, name + ".svg");
  const png = path.join(temp, name + ".png");
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
    '" viewBox="0 0 64 64">' + body + "</svg>\n");
  run("/usr/bin/sips", ["-s", "format", "png", svg, "--out", png]);
  return png;
}

function generateBrandIcons() {
  assert(process.platform === "darwin", "regeneration requires native macOS; ordinary builds use the checked-in assets");
  const svg = read(source);
  const text = svg.toString("utf8");
  const match = text.match(/^\s*<svg\b[^>]*\bviewBox="0 0 44 44"[^>]*>([\s\S]*)<\/svg>\s*$/);
  assert(match, "unexpected Nexum mark SVG structure; review the composition before regenerating");
  const mark = match[1];
  const mono = mark.replace(/stroke="url\(#nexum-mark-[ab]\)"/g, 'stroke="#000000"')
    .replace(/\sopacity="\.95"/g, "");
  assert(mono !== mark && !/stroke="url\(/.test(mono), "unrecognised mark strokes; review the template");
  const app = '<rect x="5.5" y="5.5" width="53" height="53" rx="13" fill="#F8FAFC" stroke="#DCE3EB" stroke-width="0.65"/>' +
    '<svg x="9.5" y="9.5" width="45" height="45" viewBox="0 0 44 44">' + mark + "</svg>";
  const tray = '<svg x="3" y="3" width="58" height="58" viewBox="0 0 44 44">' + mono + "</svg>";
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const temp = fs.mkdtempSync(path.join(bin, ".brand-icons-"));
  const prior = new Map([...files, manifest].map(file => [file, fs.existsSync(path.join(root, file)) ? hash(read(file)) : null]));
  try {
    const appPng = render(temp, "appicon", 1024, app);
    const trayPng = render(temp, "tray-template", 64, tray);
    const icns = path.join(temp, "icons.icns");
    const ico = path.join(temp, "icon.ico");
    run(path.join(root, ".tools", "wails3"), ["generate", "icons", "-input", appPng,
      "-macfilename", icns, "-windowsfilename", ico, "-sizes", icoSizes.join(",")]);
    const assets = Object.fromEntries(files.map((file, i) => [file, fs.readFileSync([appPng, icns, ico, trayPng][i])]));
    validateAssets(assets);
    assert(hash(read(source)) === hash(svg), "source changed during generation");
    for (const [file, digest] of prior) {
      const actual = fs.existsSync(path.join(root, file)) ? hash(read(file)) : null;
      assert(actual === digest, file + " changed during generation");
    }
    for (const file of files) fs.writeFileSync(path.join(root, file), assets[file]);
    fs.writeFileSync(path.join(root, manifest), JSON.stringify(assetManifest(svg, assets), null, 2) + "\n");
    verifyBrandIcons();
    console.log("Generated and verified Nexum native brand icons.");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "generate") generateBrandIcons();
  else if (process.argv[2] === "check") {
    verifyBrandIcons();
    console.log("Nexum brand icons verified.");
  } else throw new Error("Use generate or check");
}
