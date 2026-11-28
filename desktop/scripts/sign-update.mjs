// Run only in the release job after all four native packages pass signing
// and their checksums have been verified. Private key never enters artifacts.
import fs from "node:fs";
import path from "node:path";
import {createHash, createPrivateKey, createPublicKey, sign, verify} from "node:crypto";

const {VERSION:version, PROFILE:profile, NEXUM_UPDATE_PRIVATE_KEY:privateKey, NEXUM_UPDATE_PUBLIC_KEY:publicKey}=process.env;
const fail=message=>{throw new Error(message)};
if(!version||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version))fail("Invalid manifest version");
if(profile!=="production"&&profile!=="development")fail("Invalid manifest profile");
if((profile==="development")!==version.includes("-"))fail("Version/channel mismatch");
if(version.split("-")[0].split(".").some(part=>Number(part)>65535))fail("Version exceeds platform range");
if(version.includes("-")&&version.slice(version.indexOf("-")+1).split(".").some(p=>/^0\d+$/.test(p)))fail("Invalid numeric prerelease");
if(!privateKey||!publicKey)fail("Desktop update signing configuration missing");
const priv=createPrivateKey({key:Buffer.from(privateKey,"base64"),format:"der",type:"pkcs8"});
if(priv.asymmetricKeyType!=="ed25519")fail("Expected an Ed25519 key");
const pub=createPublicKey(priv);
const jwk=pub.export({format:"jwk"});
const raw=Buffer.from(jwk.x,"base64url").toString("base64");
if(raw!==publicKey)fail("Release private key does not match embedded public key");
const prefix=profile==="production"?"NexumDesktop":"NexumDesktopDev";
const assets=[];
const hash=/^[0-9a-f]{64}$/;
for(const os of ["darwin","windows"])for(const arch of ["amd64","arm64"]){
  const name=prefix+"-"+version+"-"+os+"-"+arch+(os==="darwin"?".dmg":"-installer.exe");
  const meta=JSON.parse(fs.readFileSync(name+".metadata.json","utf8"));
  if(meta.os!==os||meta.arch!==arch||meta.name!==name||!Number.isSafeInteger(meta.size)||meta.size<=0||meta.size>4*1024*1024*1024||
      !hash.test(meta.sha256)||!hash.test(meta.binarySha256))fail("Invalid build metadata: "+name);
  if(fs.statSync(name).size!==meta.size||createHash("sha256").update(fs.readFileSync(name)).digest("hex")!==meta.sha256)fail("Package differs from native build: "+name);
  assets.push({os,arch,name,size:meta.size,sha256:meta.sha256,binarySha256:meta.binarySha256});
}
const manifest=Buffer.from(JSON.stringify({format:1,version,profile,appId:profile==="production"?"com.nexum.desktop":"com.nexum.desktop.dev",assets})+"\n","utf8");
const signature=sign(null,manifest,priv);
if(!verify(null,manifest,pub,signature))fail("Could not verify generated signature");
for(const file of ["update.json","update.json.sig"])if(fs.existsSync(file))fail("Refusing to overwrite "+path.basename(file));
fs.writeFileSync("update.json",manifest,{flag:"wx"});
fs.writeFileSync("update.json.sig",signature.toString("base64")+"\n",{flag:"wx"});
console.log("Verified signed Desktop update manifest for "+profile+" "+version);
