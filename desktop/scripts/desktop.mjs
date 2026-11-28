import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBrandIcons } from "./brand-icons.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const frontend = path.join(root, "frontend");
const tools = path.join(root, ".tools");
const win = process.platform === "win32";
const mac = process.platform === "darwin";
const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
const wails = path.join(tools, win ? "wails3.exe" : "wails3");
const packageJSON = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const [action, target = "development", extra] = process.argv.slice(2);
const version = process.env.NEXUM_DESKTOP_VERSION || packageJSON.version;
const matchVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version);
if (!matchVersion) throw new Error("Invalid Desktop version");
const numericVersion = version.split("-")[0];
if (version.includes("-") && version.slice(version.indexOf("-") + 1).split(".").some(part => /^0[0-9]+$/.test(part))) throw new Error("Invalid numeric prerelease");
const releaseBuild = process.env.NEXUM_DESKTOP_RELEASE_BUILD === "true";

function updateKey(profile) {
  const raw = process.env[profile === "production" ? "NEXUM_DESKTOP_UPDATE_PUBLIC_KEY_PRODUCTION" : "NEXUM_DESKTOP_UPDATE_PUBLIC_KEY_DEVELOPMENT"] ?? "";
  if (releaseBuild && (!raw || Buffer.from(raw,"base64").length !== 32 || Buffer.from(raw,"base64").toString("base64") !== raw)) {
    throw new Error("Missing or invalid Desktop channel update public key");
  }
  if (releaseBuild && process.env.NEXUM_DESKTOP_UPDATE_PUBLIC_KEY_PRODUCTION === process.env.NEXUM_DESKTOP_UPDATE_PUBLIC_KEY_DEVELOPMENT) {
    throw new Error("Desktop release channels must have different trust keys");
  }
  return releaseBuild ? raw : "";
}
if (numericVersion.split(".").some(part => Number(part) > 65535)) throw new Error("Version exceeds Windows resource range");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env, PATH: tools + path.delimiter + (options.env?.PATH ?? process.env.PATH ?? "") },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(path.basename(command) + " failed (exit " + result.status + ", signal " + result.signal + ")");
}

function pnpm(args, cwd = root) {
  const entry = process.env.npm_execpath;
  if (!entry) throw new Error("Run through the documented pnpm command");
  run(process.execPath, [entry, ...args], { cwd });
}

function platformCheck() {
  if ((!win && !mac) || !arch) throw new Error("Desktop builds require native macOS or Windows x64/arm64");
  if (target !== "production" && target !== "development") throw new Error("Unknown Desktop profile");
}

function installTools() {
  fs.mkdirSync(tools, { recursive: true });
  run("go", ["install", "github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0"], { env: { GOBIN: tools } });
}

function bindings() {
  fs.mkdirSync(path.join(frontend, "dist"), { recursive: true });
  // The generator loads the Go package before Vite has built assets.
  const placeholder = path.join(frontend, "dist", ".gitkeep");
  if (!fs.existsSync(placeholder)) fs.writeFileSync(placeholder, "");
  run(wails, ["generate", "bindings", "-ts", "-i", "-clean=true"]);
}

function check() {
  verifyBrandIcons();
  bindings();
  pnpm(["lint"], frontend);
  pnpm(["typecheck"], frontend);
  pnpm(["test"], frontend);
  pnpm(["build"], frontend);
  const env = { CGO_ENABLED: mac ? "1" : "0",
    ...(mac ? { MACOSX_DEPLOYMENT_TARGET: "12.0", CGO_CFLAGS: "-mmacosx-version-min=12.0", CGO_LDFLAGS: "-mmacosx-version-min=12.0" } : {}) };
  run("go", ["mod", "tidy", "-diff"], { env });
  run("go", ["vet", "./..."], { env });
  for (const tags of ["", "production", "production,desktopdev"]) {
    run("go", ["test", "-count=1", ...(tags ? ["-tags", tags] : []), "./..."], { env });
  }
}

function identity(profile) {
  return profile === "production"
    ? { name: "Nexum Desktop", id: "com.nexum.desktop", executable: "nexum-desktop", asset: "NexumDesktop" }
    : { name: "Nexum Desktop Dev", id: "com.nexum.desktop.dev", executable: "nexum-desktop-dev", asset: "NexumDesktopDev" };
}

function profileVersion(profile) {
  return profile === "development" && !version.includes("-") ? version + "-dev" : version;
}

function pathsFor(profile) {
  const identityValue = identity(profile);
  const out = path.join(root, "bin", profile);
  const bundle = path.join(out, identityValue.name + ".app");
  return {
    ...identityValue,
    out,
    release: path.join(out, "release"),
    bundle,
    binary: win ? path.join(out, identityValue.executable + ".exe") : path.join(bundle, "Contents", "MacOS", identityValue.executable),
  };
}

function plist(info, hot) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundlePackageType</key><string>APPL</string>',
    '<key>CFBundleName</key><string>' + info.name + '</string>',
    '<key>CFBundleDisplayName</key><string>' + info.name + '</string>',
    '<key>CFBundleIdentifier</key><string>' + info.id + '</string>',
    '<key>CFBundleExecutable</key><string>' + info.executable + '</string>',
    '<key>CFBundleVersion</key><string>' + numericVersion + '</string>',
    '<key>CFBundleShortVersionString</key><string>' + numericVersion + '</string>',
    '<key>CFBundleIconFile</key><string>icons.icns</string>',
    '<key>LSMinimumSystemVersion</key><string>12.0</string>',
    '<key>NSHighResolutionCapable</key><true/>',
    '<key>NSLocalNetworkUsageDescription</key><string>连接你添加的局域网远程环境。 / Connect to remote environments on your local network.</string>',
    hot ? '<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>' : '',
    '</dict></plist>',
    '',
  ].join("\n");
}

function build(profile, hot = false) {
  verifyBrandIcons();
  const info = pathsFor(profile);
  bindings();
  pnpm(["build"], frontend);
  fs.mkdirSync(info.out, { recursive: true });
  if (mac) {
    fs.rmSync(info.bundle, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(info.binary), { recursive: true });
    const resources = path.join(info.bundle, "Contents", "Resources");
    fs.mkdirSync(resources, { recursive: true });
    fs.copyFileSync(path.join(root, "build/darwin/icons.icns"), path.join(resources, "icons.icns"));
    fs.writeFileSync(path.join(info.bundle, "Contents", "Info.plist"), plist(info, hot));
  }
  const tags = hot ? [] : ["production", ...(profile === "development" ? ["desktopdev"] : [])];
  if (hot && releaseBuild) throw new Error("HMR cannot be a distribution build");
  const key = updateKey(profile);
  const flags = ["-w", "-s", "-X", "main.version=" + profileVersion(profile),
    "-X", "main.distributionBuild=" + String(releaseBuild), ...(key ? ["-X", "main.updatePublicKey=" + key] : []),
    ...(win ? ["-H", "windowsgui"] : [])];
  const env = { GOOS: mac ? "darwin" : "windows", GOARCH: arch, CGO_ENABLED: mac ? "1" : "0",
    ...(mac ? { MACOSX_DEPLOYMENT_TARGET: "12.0", CGO_CFLAGS: "-mmacosx-version-min=12.0", CGO_LDFLAGS: "-mmacosx-version-min=12.0" } : {}) };
  const syso = path.join(root, "nexum_desktop_windows_" + arch + ".syso");
  let generated = false;
  try {
    if (win) {
      if (fs.existsSync(syso)) throw new Error("Unexpected resource object; inspect before building");
      const infoFile = path.join(info.out, "info.json");
      fs.writeFileSync(infoFile, JSON.stringify({
        fixed: { file_version: numericVersion, product_version: numericVersion },
        info: { "0409": { FileVersion: numericVersion, ProductVersion: profileVersion(profile), CompanyName: "Nexum", FileDescription: info.name, ProductName: info.name } },
      }));
      run(wails, ["generate", "syso", "-arch", arch, "-icon", "build/windows/icon.ico", "-manifest", "build/windows/wails.exe.manifest", "-info", infoFile, "-out", syso]);
      generated = true;
    }
    run("go", ["build", "-trimpath", "-buildvcs=false", ...(tags.length ? ["-tags", tags.join(",")] : []), "-ldflags", flags.join(" "), "-o", info.binary, "."], { env });
  } finally {
    if (generated) fs.rmSync(syso, { force: true });
  }
  if (mac) {
    run("codesign", ["--force", "--sign", "-", info.bundle]);
    run("codesign", ["--verify", "--deep", "--strict", info.bundle]);
    run("plutil", ["-lint", path.join(info.bundle, "Contents", "Info.plist")]);
  }
  console.log("Built " + profile + " Desktop: " + info.binary);
  return info;
}

function signingRequired(profile) {
  const requested = process.env.NEXUM_DESKTOP_SIGNING ?? "candidate";
  if (requested !== "candidate" && requested !== "required") throw new Error("Unknown signing policy");
  if (requested === "required" && (profile !== "production" || !releaseBuild)) throw new Error("Distribution signing requires a trusted production release build");
  if (releaseBuild && profile === "production" && requested !== "required") throw new Error("Production release requires platform signing");
  return requested === "required";
}

function requireEnv(key) {
  const value = process.env[key];
  if (!value) throw new Error("Missing signing setting: " + key);
  return value;
}

function windowsSign(file) {
  // Certificate is installed in the signing account's certificate store by CI.
  const thumbprint = requireEnv("NEXUM_WINDOWS_SIGN_THUMBPRINT");
  if (!/^[0-9a-fA-F]{40}$/.test(thumbprint)) throw new Error("Invalid certificate thumbprint");
  const signer = requireEnv("NEXUM_WINDOWS_SIGNTOOL");
  run(signer, ["sign", "/sha1", thumbprint, "/fd", "SHA256", "/tr", "http://timestamp.digicert.com", "/td", "SHA256", file]);
  run(signer, ["verify", "/pa", "/all", file]);
}

function packageApp(profile) {
  const sign = signingRequired(profile);
  if (sign && mac) { requireEnv("NEXUM_MAC_SIGN_IDENTITY"); requireEnv("NEXUM_MAC_NOTARY_PROFILE"); }
  if (sign && win) { requireEnv("NEXUM_WINDOWS_SIGN_THUMBPRINT"); requireEnv("NEXUM_WINDOWS_SIGNTOOL"); }
  const info = build(profile);
  fs.mkdirSync(info.release, { recursive: true });
  let artifact;
  if (mac) {
    if (sign) {
      run("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", requireEnv("NEXUM_MAC_SIGN_IDENTITY"), info.bundle]);
      run("codesign", ["--verify", "--deep", "--strict", info.bundle]);
    }
    artifact = path.join(info.release, info.asset + "-" + profileVersion(profile) + "-darwin-" + arch + ".dmg");
    const staging = path.join(info.out, "dmg-staging");
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging);
    run("ditto", [info.bundle, path.join(staging, info.name + ".app")]);
    fs.symlinkSync("/Applications", path.join(staging, "Applications"));
    try {
      run("hdiutil", ["create", "-volname", info.name, "-srcfolder", staging, "-format", "UDZO", "-ov", artifact]);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    if (sign) {
      run("codesign", ["--force", "--timestamp", "--sign", requireEnv("NEXUM_MAC_SIGN_IDENTITY"), artifact]);
      run("xcrun", ["notarytool", "submit", artifact, "--keychain-profile", requireEnv("NEXUM_MAC_NOTARY_PROFILE"), "--wait"]);
      run("xcrun", ["stapler", "staple", artifact]);
      run("xcrun", ["stapler", "validate", artifact]);
    }
    run("hdiutil", ["verify", artifact]);
  } else {
    if (sign) windowsSign(info.binary);
    artifact = path.join(info.release, info.asset + "-" + profileVersion(profile) + "-windows-" + arch + "-installer.exe");
    // Work in an isolated staging tree. The Wails NSIS macro includes the
    // WebView2 bootstrapper; unique product and uninstall names keep profiles separate.
    const stage = path.join(info.out, "nsis");
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    for (const file of ["project.nsi", "wails_tools.nsh"]) fs.copyFileSync(path.join(root, "build/windows/nsis", file), path.join(stage, file));
    fs.copyFileSync(path.join(root, "build/windows/icon.ico"), path.join(stage, "icon.ico"));
    run(wails, ["generate", "webview2bootstrapper", "-dir", stage]);
    run("makensis", [
      "/DINFO_PROJECTNAME=" + info.executable,
      "/DINFO_PRODUCTNAME=" + info.name,
      "/DINFO_PRODUCTVERSION=" + numericVersion,
      "/DINFO_COPYRIGHT=Nexum",
      "/DUNINST_KEY_NAME=" + info.id,
      "/DWAILS_INSTALL_SCOPE=user",
      "/DREQUEST_EXECUTION_LEVEL=user",
      "/DNEXUM_OUTPUT_FILE=" + artifact,
      "/DARG_WAILS_" + arch.toUpperCase() + "_BINARY=" + info.binary,
      "project.nsi",
    ], { cwd: stage });
    if (sign) windowsSign(artifact);
  }
  const digest = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
  fs.writeFileSync(artifact + ".sha256", digest + "  " + path.basename(artifact) + "\n");
  // Internal build evidence: the signed manifest binds both package bytes and
  // the actual post-install executable (after platform signing).
  const metadata = {os: mac ? "darwin" : "windows", arch, name: path.basename(artifact),
    size: fs.statSync(artifact).size, sha256: digest,
    binarySha256: createHash("sha256").update(fs.readFileSync(info.binary)).digest("hex")};
  fs.writeFileSync(artifact + ".metadata.json", JSON.stringify(metadata) + "\n");
  console.log("Package: " + artifact + "\nSHA-256: " + digest + "\nSigning policy: " + (sign ? "required" : "candidate"));
}

switch (action) {
  case "tools": installTools(); break;
  case "prepare": bindings(); break;
  case "check": platformCheck(); check(); break;
  case "build": platformCheck(); build(target, extra === "hot"); break;
  case "package": platformCheck(); packageApp(target); break;
  case "run": {
    platformCheck();
    if (target !== "development") throw new Error("Local run is restricted to the development profile");
    run(pathsFor(target).binary, extra === "preview-startup" ? ["--preview-startup"] : extra === "preview-agent-lifecycle" ? ["--preview-agent-lifecycle"] : extra === "preview-environment" ? ["--preview-environment"] : extra === "preview-environment-check" ? ["--preview-environment-check"] : extra === "preview-agent-upgrade" ? ["--preview-agent-upgrade"] : extra === "preview-agent-repair" ? ["--preview-agent-repair"] : extra === "preview-agent-start" ? ["--preview-agent-start"] : extra === "preview-agent-workspace" ? ["--preview-agent-workspace"] : []);
    break;
  }
  case "dev":
    platformCheck();
    run(wails, ["dev", "-config", "build/config.yml", "-port", "9245"]);
    break;
  default: throw new Error("Unknown Desktop command");
}
