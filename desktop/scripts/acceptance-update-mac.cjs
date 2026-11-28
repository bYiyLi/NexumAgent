const fs=require("node:fs"),p=require("node:path"),cp=require("node:child_process"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const root=p.resolve(__dirname,"..");
if(process.platform!=="darwin"||!["arm64","x64"].includes(process.arch))throw Error("Native update acceptance requires macOS");
const arch=process.arch==="arm64"?"arm64":"amd64";
fs.mkdirSync(p.join(root,"bin"),{recursive:true});
const dir=fs.mkdtempSync(p.join(root,"bin",".native-update-")),release=p.join(dir,"release"),data=p.join(dir,"data"),id="com.nexum.desktop.dev.acceptance."+p.basename(dir).split("-").pop().toLowerCase(),name="Nexum Update Acceptance",oldVersion="0.1.0-next.1",newVersion="0.1.0-next.2",app=p.join(dir,"installed",name+".app"),newApp=p.join(dir,"payload",name+".app");
const env={...process.env,CGO_ENABLED:"1",MACOSX_DEPLOYMENT_TARGET:"12.0",CGO_CFLAGS:"-mmacosx-version-min=12.0",CGO_LDFLAGS:"-mmacosx-version-min=12.0"};
const run=(cmd,args,timeout=90000)=>{const q=cp.spawnSync(cmd,args,{cwd:root,env,encoding:"utf8",timeout,maxBuffer:8*1024*1024});if(q.status!==0||q.error)throw Error(p.basename(cmd)+" "+args.slice(0,2).join(" ")+" failed: "+q.status+" "+(q.error?.message||"")+" "+(q.stderr||"").slice(-3500));return q.stdout.trim()};
const sha=f=>crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const {publicKey,privateKey}=crypto.generateKeyPairSync("ed25519"),pub=Buffer.from(publicKey.export({format:"jwk"}).x,"base64url").toString("base64");
const read=n=>fs.readFileSync(p.join(root,n),"utf8");
const replace=(s,a,b)=>{assert.equal(s.split(a).length,2,"overlay anchor "+a);return s.replace(a,b)};
const mk=d=>fs.mkdirSync(d,{recursive:true});
for(const d of [release,data,p.dirname(app),p.dirname(newApp)])mk(d);
const overrides={};
function overlay(name,text,variant){const path=p.join(dir,variant+"-"+name.replaceAll("/","_"));fs.writeFileSync(path,text);return path}
let main=replace(read("main.go"),"desktopstate.Resolve(currentProfile)","desktopstate.ResolveAt("+JSON.stringify(data)+",currentProfile)");
let profile=replace(read("internal/desktopstate/profile.go"),'return "Nexum Desktop Dev"',"return "+JSON.stringify(name));
profile=replace(profile,'return "com.nexum.desktop.dev"',"return "+JSON.stringify(id));
let rel=read("internal/updater/release.go");
rel=replace(rel,'"net/url"','"net/url"\n "os"\n "path/filepath"');
rel=replace(rel,'return "Nexum Desktop Dev", "com.nexum.desktop.dev", "nexum-desktop-dev", "NexumDesktopDev"','return '+JSON.stringify(name)+', '+JSON.stringify(id)+', "nexum-desktop-dev", "NexumDesktopDev"');
rel=replace(rel,"Timeout: 0, // each check/download has its own context deadline","Transport: acceptanceTransport{}, Timeout: 0, // test fixture transport only");
rel+="\ntype acceptanceTransport struct{}\nfunc(acceptanceTransport)RoundTrip(r *http.Request)(*http.Response,error){name:=filepath.Base(r.URL.Path);if r.URL.Hostname()==\"api.github.com\"{name=\"releases.json\"};f,e:=os.Open(filepath.Join("+JSON.stringify(release)+",name));if e!=nil{return nil,e};st,e:=f.Stat();if e!=nil{f.Close();return nil,e};return &http.Response{StatusCode:200,Body:f,ContentLength:st.Size(),Header:make(http.Header),Request:r},nil}\n";
for(const [n,s] of Object.entries({"main.go":main,"internal/desktopstate/profile.go":profile,"internal/updater/release.go":rel}))overrides[p.join(root,n)]=overlay(n,s,"shared");
const oldOverlay=p.join(dir,"old.json"),newOverlay=p.join(dir,"new.json");
const oldStore=replace(read("internal/desktopstate/store.go"),"const schemaVersion = 2","const schemaVersion = 1");
fs.writeFileSync(oldOverlay,JSON.stringify({Replace:{...overrides,[p.join(root,"internal/desktopstate/store.go")]:overlay("store.go",oldStore,"old")}}));
fs.writeFileSync(newOverlay,JSON.stringify({Replace:overrides}));
const template=read("bin/development/Nexum Desktop Dev.app/Contents/Info.plist");
function build(bundle,v,ov){
 const contents=p.join(bundle,"Contents");mk(p.join(contents,"MacOS"));mk(p.join(contents,"Resources"));
 const binary=p.join(contents,"MacOS","nexum-desktop-dev");
 fs.copyFileSync(p.join(root,"build/darwin/icons.icns"),p.join(contents,"Resources","icons.icns"));
 fs.writeFileSync(p.join(contents,"Info.plist"),template.replaceAll("com.nexum.desktop.dev",id).replaceAll("Nexum Desktop Dev",name));
 run("go",["build","-overlay",ov,"-tags","production,desktopdev","-ldflags","-X main.version="+v+" -X main.distributionBuild=true -X main.updatePublicKey="+pub,"-o",binary,"."],300000);
 run("/usr/bin/codesign",["--force","--sign","-",bundle]);run("/usr/bin/codesign",["--verify","--deep","--strict",bundle]);
 return binary;
}
const binary=build(app,oldVersion,oldOverlay);const sourceSHA=sha(binary);console.log("old native application built",oldVersion);
const newBinary=build(newApp,newVersion,newOverlay),targetSHA=sha(newBinary);console.log("new native application built",newVersion);
assert.notEqual(sourceSHA,targetSHA);
const dmgName="NexumDesktopDev-"+newVersion+"-darwin-"+arch+".dmg",dmg=p.join(release,dmgName);
run("/usr/bin/hdiutil",["create","-volname",name,"-srcfolder",p.dirname(newApp),"-format","UDZO",dmg],120000);
run("/usr/bin/hdiutil",["verify",dmg],90000);
const assets=[];
for(const os of ["darwin","windows"])for(const arch of ["arm64","amd64"]){
 const asset="NexumDesktopDev-"+newVersion+"-"+os+"-"+arch+(os==="darwin"?".dmg":"-installer.exe");
 if(asset!==dmgName)fs.writeFileSync(p.join(release,asset),"test-only unused "+asset);
 const file=p.join(release,asset);
 assets.push({os,arch,name:asset,size:fs.statSync(file).size,sha256:sha(file),binarySha256:targetSHA});
}
const manifest=Buffer.from(JSON.stringify({format:1,version:newVersion,profile:"development",appId:id,assets}));
fs.writeFileSync(p.join(release,"update.json"),manifest);fs.writeFileSync(p.join(release,"update.json.sig"),crypto.sign(null,manifest,privateKey).toString("base64"));
fs.writeFileSync(p.join(release,"releases.json"),JSON.stringify([{tag_name:"desktop/v"+newVersion,draft:false,prerelease:true,assets:[{name:"update.json"},{name:"update.json.sig"},...assets.map(a=>({name:a.name}))]}]));
const profileRoot=p.join(data,"NexumDesktopDev");mk(profileRoot);
const db=p.join(profileRoot,"desktop.sqlite"),log=p.join(profileRoot,"logs/desktop.log"),stateFile=p.join(profileRoot,"updates/state.json");
run("/usr/bin/sqlite3",[db,"PRAGMA application_id=1314407492; PRAGMA user_version=1; CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO settings VALUES('profile','development'),('theme','dark'),('language','en-US'),('hideOnClose','false'),('desktopNotifications','false');"]);
fs.chmodSync(db,0o600);
console.log("signed fixture and schema-1 preferences prepared");
const jxa='ObjC.import("AppKit"); var a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('+JSON.stringify(id)+'); var r=[];for(var i=0;i<Number(a.count);i++){var v=a.objectAtIndex(i);r.push({pid:Number(v.processIdentifier),path:ObjC.unwrap(v.bundleURL.path),active:Boolean(v.active)});}JSON.stringify(r);';
const getApps=()=>JSON.parse(run("/usr/bin/osascript",["-l","JavaScript","-e",jxa],10000));
(async()=>{
 let result;
 try{
 run("/usr/bin/open",["-n",app],10000);
 console.log("isolated update started",id);
 let state=null,logs="";
 for(let i=0;i<240;i++){
  await new Promise(r=>setTimeout(r,500));
  if(fs.existsSync(stateFile)){try{state=JSON.parse(fs.readFileSync(stateFile,"utf8"))}catch{}}
  if(fs.existsSync(log))logs=fs.readFileSync(log,"utf8");
  if(i%20===0)console.log("observed",state?.phase||"no update state",logs.split("\n").filter(l=>l.includes("bootstrap phase")||l.includes("bootstrap failed")).slice(-1)[0]||"");
  if(state?.phase==="complete"&&logs.includes('"updateCheck":"current"')&&logs.includes("desktop frontend ready"))break;
  if(state?.phase==="installFailed"||state?.phase==="permission"||logs.includes("desktop bootstrap failed")){break}
 }
 const values=run("/usr/bin/sqlite3",[db,"PRAGMA user_version; SELECT key||'='||value FROM settings ORDER BY key;"]);
 const version=Number(values.split("\n")[0]);
 const currentHash=sha(binary);
 const jobs=fs.existsSync(p.join(profileRoot,"updates/staging"))?fs.readdirSync(p.join(profileRoot,"updates/staging")):[];
 const helperLogs=jobs.flatMap(j=>{const f=p.join(profileRoot,"updates/staging",j,"install.log");return fs.existsSync(f)?[fs.readFileSync(f,"utf8")]:[]});
 const copiedLogs=fs.existsSync(p.join(profileRoot,"logs"))?fs.readdirSync(p.join(profileRoot,"logs")).filter(n=>/^update-/.test(n)).map(n=>fs.readFileSync(p.join(profileRoot,"logs",n),"utf8")):[];
 const backups=fs.existsSync(p.join(profileRoot,"backups"))?fs.readdirSync(p.join(profileRoot,"backups")):[];
 result={id,app,sourceSHA,targetSHA,currentHash,statePhase:state?.phase,version,values,environmentTables:version===2?run("/usr/bin/sqlite3",[db,"SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('environments','ssh_host_keys');"]):null,backupCount:backups.length,logs:logs.split("\n").filter(l=>/bootstrap phase|bootstrap failed|desktop frontend ready/.test(l)).slice(-25),helperLogs:[...helperLogs,...copiedLogs].map(s=>s.slice(-3500)),apps:getApps(),jobs};
 result.passed=currentHash===targetSHA&&state?.phase==="complete"&&version===2&&values.includes("theme=dark")&&values.includes("language=en-US")&&values.includes("hideOnClose=false")&&result.environmentTables==="2"&&backups.length===1&&logs.includes("desktop frontend ready")&&result.apps.length===1;
 console.log(JSON.stringify(result));
 fs.writeFileSync(p.join(dir,"result.json"),JSON.stringify(result,null,2));
 if(!result.passed)process.exitCode=1;
 }finally{
 // Never terminate any app except the test-specific, exact bundle.
 const apps=getApps();
 if(apps.some(a=>a.path!==app))throw Error("unexpected acceptance bundle, refusing termination");
 const terminate='ObjC.import("AppKit"); var a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('+JSON.stringify(id)+'); for(var i=0;i<Number(a.count);i++){var v=a.objectAtIndex(i);if(ObjC.unwrap(v.bundleURL.path)==='+JSON.stringify(app)+')v.terminate;}';
 run("/usr/bin/osascript",["-l","JavaScript","-e",terminate],10000);
 for(let i=0;i<20&&getApps().length;i++)await new Promise(r=>setTimeout(r,300));
 const remaining=getApps();console.log("acceptance remaining apps",JSON.stringify(remaining));if(remaining.length)process.exitCode=1;
 }
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});