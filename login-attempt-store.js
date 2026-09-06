import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getExternalSessionKey } from "./security-core.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const LEGACY_KEY_FILE = path.join(DATA_DIR, ".personal-session-key");
const EXTERNAL_KEY = getExternalSessionKey();

function fileFor(uid) { return path.join(USERS_DIR, String(uid), "pending-login.enc"); }
function legacyKey() { try { const b=fs.readFileSync(LEGACY_KEY_FILE); return b.length===32?b:null; } catch { return null; } }
function key() { return EXTERNAL_KEY || legacyKey(); }
function seal(value) {
  const k=key(); if(!k) throw new Error("Login-state encryption key unavailable");
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv("aes-256-gcm",k,iv), data=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return JSON.stringify({v:1,keyVersion:EXTERNAL_KEY?"env":"legacy",iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),data:data.toString("base64")});
}
function open(raw) {
  const p=JSON.parse(raw), k=p?.keyVersion==="env"?EXTERNAL_KEY:legacyKey(); if(!k) throw new Error("Login-state encryption key unavailable");
  const d=crypto.createDecipheriv("aes-256-gcm",k,Buffer.from(p.iv,"base64"));d.setAuthTag(Buffer.from(p.tag,"base64"));return JSON.parse(Buffer.concat([d.update(Buffer.from(p.data,"base64")),d.final()]).toString("utf8"));
}
function safeRecord(record) {
  return {
    uid:String(record.uid||""), token:String(record.token||""), browserToken:String(record.browserToken||""), phone:String(record.phone||""),
    stage:String(record.stage||""), error:String(record.error||"").slice(0,180), createdAt:Number(record.createdAt||0), phoneCodeHash:String(record.phoneCodeHash||""),
    isCodeViaApp:record.isCodeViaApp===true, codeFailures:Number(record.codeFailures||0), passwordFailures:Number(record.passwordFailures||0), sessionString:String(record.sessionString||""),
  };
}
export function persistLoginAttempt(attempt) {
  if(!attempt?.uid || !attempt?.client) return;
  const record=safeRecord({ ...attempt, sessionString:attempt.client.session?.save?.() || "" });
  if(!/^\d+$/.test(record.uid)||(!record.token&&!record.browserToken)||!record.sessionString)return;
  const file=fileFor(record.uid);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,seal(record),{mode:0o600});fs.renameSync(tmp,file);
}
export function removePersistedLogin(uid) { try { fs.rmSync(fileFor(uid),{force:true}); } catch {} }
export function loadPersistedLogins(ttlMs) {
  const out=[],now=Date.now();let dirs=[];try{dirs=fs.readdirSync(USERS_DIR,{withFileTypes:true});}catch{return out;}
  for(const dir of dirs){if(!dir.isDirectory()||!/^\d+$/.test(dir.name))continue;const file=fileFor(dir.name);if(!fs.existsSync(file))continue;try{const r=safeRecord(open(fs.readFileSync(file,"utf8")));if(!r.createdAt||now-r.createdAt>Number(ttlMs||0)||!r.sessionString||(!r.token&&!r.browserToken)){fs.rmSync(file,{force:true});continue;}out.push(r);}catch{try{fs.rmSync(file,{force:true});}catch{}}}
  return out;
}
