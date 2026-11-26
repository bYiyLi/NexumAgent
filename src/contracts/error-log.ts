import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { isAgentError } from "./errors.js";
import type { JsonObject, JsonValue } from "./types.js";

import { errorInlineBytes } from "./error-data.js";
const generatedFile = /^\d{2}-\d{2}-\d{2}-\d{9}_[a-zA-Z0-9_-]{1,64}_[a-f0-9]{32}\.log$/;
const generatedDay = /^\d{4}-\d{2}-\d{2}$/;
const privateField = /^(?:password|passwd|secret|token|accesstoken|refreshtoken|idtoken|apikey|privatekey|clientsecret|credential|credentials|authorization|cookie|cookies|setcookie|headers|requestheaders|responseheaders|requestbody|responsebody|actual|expected)$/i;

function own(value: object, key: PropertyKey): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}

export function redactDiagnostic(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi, "$1: [REDACTED]")
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|api[_-]?key|password|passwd|credential|secret|token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&]+)/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\bbearer\s+[^\s,;]+|nx_agt_[A-Za-z0-9_-]+/gi, "[REDACTED]");
}

/** Never invoke an arbitrary thrown object's getters, Proxy traps, toJSON or
 * string conversion. Collect native Error fields and causes only. */
export function describeDiagnostic(cause: unknown, observedStack?: string): string {
  const active = new Set<object>();
  let visited = 0;
  function visit(value: unknown, depth: number, errorOnly = false): JsonValue {
    if (++visited > 4096 || depth > 64) return "[diagnostic traversal limit]";
    if (typeof value === "string") return redactDiagnostic(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "bigint") return String(value);
    if (typeof value !== "object") return "[" + typeof value + "]";
    if (types.isProxy(value)) return "[Proxy not evaluated]";
    if (active.has(value)) return "[circular cause]";
    active.add(value);
    try {
      if (types.isNativeError(value) || isAgentError(value)) {
        const result: JsonObject = { type: "Error" };
        for (const key of ["name","message","code","errno","syscall","path","dest","stack","diagnosticIncomplete"]) {
          const one = own(value,key);
          if (typeof one === "string" || typeof one === "number" || typeof one === "boolean") result[key] = visit(one,depth+1);
        }
        if (depth === 0 && observedStack !== undefined) result.stack = redactDiagnostic(observedStack);
        const nested = own(value,"cause");
        if (nested !== undefined) result.cause = visit(nested,depth+1,true);
        const errors = own(value,"errors");
        if (Array.isArray(errors) && !types.isProxy(errors)) result.errors = visit(errors,depth+1,true);
        const details = own(value,"details");
        if (details !== undefined) result.details = visit(details,depth+1);
        return result;
      }
      if (Array.isArray(value)) {
        const result: JsonValue[] = [];
        const length = own(value,"length") as number;
        for (let i=0;i<length;i++) {
          if (visited > 4096) {result.push("[diagnostic traversal limit]");break;}
          result.push(visit(own(value,String(i)),depth+1,errorOnly));
        }
        return result;
      }
      if (errorOnly) return "[non-native object not evaluated]";
      const result: JsonObject = Object.create(null);
      for (const key of Object.keys(value)) {
        if (visited > 4096) {result["diagnosticIncomplete"]="traversal limit";break;}
        if (privateField.test(key.replace(/[_-]/g,""))) result[key]="[REDACTED]";
        else result[key]=visit(own(value,key),depth+1);
      }
      return result;
    } finally {active.delete(value);}
  }
  return JSON.stringify(visit(cause,0,true),null,2)+"\n";
}

function directory(value: string, create: boolean): string {
  if (create) {
    try { mkdirSync(value,{mode:0o700}); } catch (error) {
      if (!error || typeof error !== "object" || own(error,"code") !== "EEXIST") throw error;
    }
  }
  const stat = lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(value) !== value)
    throw new Error("Error log directory is redirected.");
  return value;
}

export function isSavedErrorLog(root: string, value: unknown): value is string {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value)!==value) return false;
  const rel = path.relative(path.join(root,"logs","errors"), value).split(path.sep);
  if (rel.length!==2 || !generatedDay.test(rel[0]!) || !generatedFile.test(rel[1]!)) return false;
  try {
    directory(root,false);
    directory(path.join(root,"logs"),false);
    directory(path.join(root,"logs","errors"),false);
    directory(path.dirname(value),false);
    const stat=lstatSync(value);
    return stat.isFile() && !stat.isSymbolicLink() && realpathSync.native(value)===value;
  } catch { return false; }
}

/** Profile root comes only from the authenticated Host configuration. The
 * native Agent's existing cleanup owns 120-hour expiry for this shared format. */
export function saveErrorLog(root: string, component: string, diagnostic: string): string {
  directory(root,false);
  const logs=directory(path.join(root,"logs"),true);
  const errors=directory(path.join(logs,"errors"),true);
  const now=new Date().toISOString();
  const day=directory(path.join(errors,now.slice(0,10)),true);
  const time=now.slice(11,19).replaceAll(":","-")+"-"+now.slice(20,23)+"000000";
  const label=/^[a-zA-Z0-9_-]{1,64}$/.test(component)?component:"unknown";
  const file=path.join(day,time+"_"+label+"_"+randomUUID().replaceAll("-","")+".log");
  const pending=file+"."+process.pid+".pending";
  let fd: number | undefined;
  let ownsPending=false;
  try {
    fd=openSync(pending,"wx",0o600);
    ownsPending=true;
    writeFileSync(fd,redactDiagnostic(diagnostic),"utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd=undefined;
    directory(day,false);
    renameSync(pending,file);
    return file;
  } finally {
    if (fd!==undefined) {try {closeSync(fd);}catch{/* preserve write failure */}}
    if (ownsPending) {try {unlinkSync(pending);}catch{/* published or already absent */}}
  }
}

/** Attach a truthful local path before the public transport clips diagnostics.
 * Arbitrary native/guest text is not automatically a public message. */
export function retainErrorData(root: string|undefined, component: string, cause: unknown, publicData: JsonObject, observedStack?: string): JsonObject {
  if (!root) return publicData;
  const existing = publicData.details;
  const details: JsonObject = existing && typeof existing==="object" && !Array.isArray(existing) ? {...existing} : {};
  if (isSavedErrorLog(root,details.logPath)) return publicData;
  delete details.logPath;
  delete details.diagnosticRetained;
  delete details.logSaveFailed;
  try {
    const diagnostic=describeDiagnostic(cause,observedStack);
    // A short trusted AgentError whose message and details were already
    // preserved has no additional diagnostic to persist.
    if (isAgentError(cause) && own(cause,"message")===publicData.message &&
        own(cause,"cause")===undefined && observedStack===undefined &&
        details.omitted!==true && Buffer.byteLength(diagnostic)<=errorInlineBytes)
      return {...publicData, details};
    details.logPath=saveErrorLog(root,component,diagnostic);
    details.diagnosticRetained=true;
    details.truncated=Buffer.byteLength(diagnostic)>errorInlineBytes;
  } catch {
    details.diagnosticRetained=false;
    details.logSaveFailed=true;
  }
  return {...publicData,details};
}
