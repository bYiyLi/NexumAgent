const fs = require("node:fs"), p = require("node:path"), cp = require("node:child_process"), assert = require("node:assert/strict");
const root = p.resolve(__dirname, "..");
if (process.platform !== "darwin") throw Error("Requires native macOS");
fs.mkdirSync(p.join(root, "bin"), { recursive: true });
const dir = fs.mkdtempSync(p.join(root, "bin", ".environment-acceptance-"));
const data = p.join(dir, "data"), bundle = p.join(dir, "Environment Acceptance.app"), id = "com.nexum.desktop.dev.environmenttest." + p.basename(dir).split("-").pop().toLowerCase();
const result = p.join(dir, "result.json");
const env = { ...process.env, CGO_ENABLED: "1", MACOSX_DEPLOYMENT_TARGET: "12.0", CGO_CFLAGS: "-mmacosx-version-min=12.0", CGO_LDFLAGS: "-mmacosx-version-min=12.0" };
function run(cmd, args, timeout = 30000) {
  const r = cp.spawnSync(cmd, args, { cwd: root, env, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0 || r.error) throw Error(p.basename(cmd) + " failed: " + r.status + " " + (r.error?.message || "") + " " + (r.stderr || "").slice(-3000));
  return r.stdout.trim();
}
function replace(text, before, after) {
  assert.equal(text.split(before).length, 2, "Missing or ambiguous fixture anchor " + before);
  return text.replace(before, () => after);
}
const read = name => fs.readFileSync(p.join(root, name), "utf8");
const overlay = {};
function add(name, source) {
  const path = p.join(dir, name.replaceAll("/", "_"));
  fs.writeFileSync(path, source);
  overlay[p.join(root, name)] = path;
}
let main = replace(read("main.go"), '"embed"', '"embed"\n"context"\n"crypto/ed25519"\n"crypto/rand"\n"encoding/json"\n"errors"\n"fmt"\n"net"\n"sync"\n"time"\n"github.com/pkg/sftp"\n"golang.org/x/crypto/ssh"');
main = replace(main, "desktopstate.Resolve(currentProfile)", "desktopstate.ResolveAt("+JSON.stringify(data)+",currentProfile)");
main = replace(main, "runErr := app.Run()", "if err:=installEnvironmentAcceptance(app,w,service);err!=nil{log.Fatal(err)}\n runErr := app.Run()");
main += "\nconst acceptanceJSPath="+JSON.stringify(p.join(root,"scripts/fixtures/environment-ui.js"))+
  "\nconst acceptanceResultPath="+JSON.stringify(result)+"\n"+read("scripts/fixtures/environment-native.go.txt");
add("main.go", main);
let profile = replace(read("internal/desktopstate/profile.go"), 'return "Nexum Desktop Dev"', 'return "Environment Acceptance"');
profile = replace(profile, 'return "com.nexum.desktop.dev"', "return "+JSON.stringify(id));
add("internal/desktopstate/profile.go", profile);
const overlayFile = p.join(dir, "overlay.json");
fs.writeFileSync(overlayFile, JSON.stringify({ Replace: overlay }));
const contents = p.join(bundle, "Contents"), binary = p.join(contents, "MacOS", "nexum-desktop-dev");
fs.mkdirSync(p.dirname(binary), { recursive: true });
fs.mkdirSync(p.join(contents, "Resources"), { recursive: true });
const template = read("bin/development/Nexum Desktop Dev.app/Contents/Info.plist");
fs.writeFileSync(p.join(contents,"Info.plist"), template.replaceAll("com.nexum.desktop.dev",id).replaceAll("Nexum Desktop Dev","Environment Acceptance"));
fs.copyFileSync(p.join(root,"build/darwin/icons.icns"), p.join(contents,"Resources/icons.icns"));
const db = p.join(data,"NexumDesktopDev","desktop.sqlite");
fs.mkdirSync(p.dirname(db), { recursive: true });
run("/usr/bin/sqlite3",[db,"PRAGMA application_id=1314407492; PRAGMA user_version=1; CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO settings VALUES('profile','development'),('theme','light'),('language','en-US'),('hideOnClose','false');"]);
fs.chmodSync(db,0o600);
run("go",["build","-overlay",overlayFile,"-tags","production,desktopdev","-o",binary,"."],300000);
run("/usr/bin/codesign",["--force","--sign","-",bundle]);
run("/usr/bin/codesign",["--verify","--deep","--strict",bundle]);
const jxa = 'ObjC.import("AppKit"); var a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('+JSON.stringify(id)+'); var r=[];for(var i=0;i<Number(a.count);i++){var v=a.objectAtIndex(i);r.push({pid:Number(v.processIdentifier),path:ObjC.unwrap(v.bundleURL.path)});}JSON.stringify(r);';
const apps = () => JSON.parse(run("/usr/bin/osascript",["-l","JavaScript","-e",jxa],10000));
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
(async ()=>{
  try {
    run("/usr/bin/open",["-n",bundle],10000);
    for(let i=0;i<240&&!fs.existsSync(result);i++) await sleep(500);
    if(!fs.existsSync(result)) throw Error("Native environment result missing");
    const report=JSON.parse(fs.readFileSync(result,"utf8"));
    console.log(JSON.stringify(report));
    if(!report.passed) process.exitCode=1;
  } finally {
    if(apps().some(a=>a.path!==bundle)) throw Error("Unexpected test application; refusing termination");
    const term='ObjC.import("AppKit"); var a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('+JSON.stringify(id)+'); for(var i=0;i<Number(a.count);i++){var v=a.objectAtIndex(i);if(ObjC.unwrap(v.bundleURL.path)==='+JSON.stringify(bundle)+')v.terminate;}';
    run("/usr/bin/osascript",["-l","JavaScript","-e",term],10000);
    for(let i=0;i<30&&apps().length;i++) await sleep(250);
    console.log("Remaining isolated apps:",apps().length);
    if(apps().length) process.exitCode=1;
  }
})().catch(e=>{console.error(e.message);process.exitCode=1});
