import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || "/data";
const SECURITY_STATE_FILE = path.join(DATA_DIR, "security-state.json");
const SECURITY_EVENT_FILE = path.join(DATA_DIR, "security-events.jsonl");
const SECURITY_EVENT_MAX_BYTES = 2 * 1024 * 1024;
const SECURITY_SECRET = String(process.env.TELEPILOT_SECURITY_SECRET || "");
const SESSION_KEY_B64 = String(process.env.TELEPILOT_SESSION_KEY_B64 || "");

if (SECURITY_SECRET.length < 32) throw new Error("Missing or weak TELEPILOT_SECURITY_SECRET");

function derive(label) {
  return crypto.createHmac("sha256", SECURITY_SECRET).update(String(label)).digest();
}
const KEY_PEPPER = derive("telepilot-license-key-v2");
const BACKUP_KEY = derive("telepilot-backup-v2");
const EVENT_KEY = derive("telepilot-security-event-v1");

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}

export function normalizeLicenseKey(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

export function legacyLicenseHash(value) {
  return crypto.createHash("sha256").update(normalizeLicenseKey(value)).digest("hex");
}

export function secureLicenseHash(value) {
  return crypto.createHmac("sha256", KEY_PEPPER).update(normalizeLicenseKey(value)).digest("hex");
}

export function safeEqualHex(left, right) {
  try {
    const a = Buffer.from(String(left || ""), "hex");
    const b = Buffer.from(String(right || ""), "hex");
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

export function licenseRecordMatches(record, normalizedKey) {
  if (!record?.hash) return false;
  const actual = Number(record.hashVersion || 1) >= 2
    ? secureLicenseHash(normalizedKey)
    : legacyLicenseHash(normalizedKey);
  return safeEqualHex(record.hash, actual);
}

const rateBuckets = new Map();
function pruneBucket(key, now) {
  const bucket = rateBuckets.get(key);
  if (!bucket) return null;
  if (now >= bucket.resetAt) { rateBuckets.delete(key); return null; }
  return bucket;
}

export function takeRateLimit(scope, subject, limit, windowMs) {
  const now = Date.now();
  const key = `${scope}:${String(subject || "unknown")}`;
  let bucket = pruneBucket(key, now);
  if (!bucket) {
    bucket = { count: 0, resetAt: now + Math.max(1000, Number(windowMs || 1000)) };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    ok: bucket.count <= Math.max(1, Number(limit || 1)),
    count: bucket.count,
    retryAfterMs: Math.max(0, bucket.resetAt - now),
  };
}

export function resetRateLimit(scope, subject) {
  rateBuckets.delete(`${scope}:${String(subject || "unknown")}`);
}

function securityState() {
  const raw = readJson(SECURITY_STATE_FILE, { version: 1, lockdown: false, frozen: {} });
  return {
    version: 1,
    lockdown: raw?.lockdown === true,
    frozen: raw?.frozen && typeof raw.frozen === "object" && !Array.isArray(raw.frozen) ? raw.frozen : {},
  };
}

export function isSecurityLockdown() { return securityState().lockdown === true; }
export function isUserFrozen(uid) { return !!securityState().frozen[String(uid)]; }

export function setSecurityLockdown(enabled, actorUid = "") {
  const state = securityState();
  state.lockdown = enabled === true;
  state.lockdownChangedAt = Date.now();
  state.lockdownChangedBy = String(actorUid || "");
  writeJsonAtomic(SECURITY_STATE_FILE, state);
  appendSecurityEvent(enabled ? "lockdown_enabled" : "lockdown_disabled", { actorUid: String(actorUid || "") });
  return state.lockdown;
}

export function setUserFrozen(uid, enabled, actorUid = "") {
  const state = securityState();
  const id = String(uid || "");
  if (!/^\d+$/.test(id)) throw new Error("Invalid Telegram user ID");
  if (enabled) state.frozen[id] = { at: Date.now(), by: String(actorUid || "") };
  else delete state.frozen[id];
  writeJsonAtomic(SECURITY_STATE_FILE, state);
  appendSecurityEvent(enabled ? "user_frozen" : "user_unfrozen", { actorUid: String(actorUid || ""), uid: id });
  return enabled === true;
}

function canonical(value, depth = 0) {
  if (depth > 24) throw new Error("Object nesting is too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite numbers are not allowed");
    return value;
  }
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key], depth + 1);
    return out;
  }
  throw new Error("Unsupported value type");
}

export function stableStringify(value) { return JSON.stringify(canonical(value)); }

export function signBackupPayload(payload) {
  return crypto.createHmac("sha256", BACKUP_KEY).update(stableStringify(payload)).digest("hex");
}

export function verifyBackupSignature(payload, signature) {
  return safeEqualHex(signBackupPayload(payload), signature);
}

export function assertSafeObject(value, options = {}) {
  const maxDepth = Number(options.maxDepth || 20);
  const maxNodes = Number(options.maxNodes || 5000);
  let nodes = 0;
  const walk = (item, depth) => {
    nodes += 1;
    if (nodes > maxNodes) throw new Error("Configuration is too complex");
    if (depth > maxDepth) throw new Error("Configuration is nested too deeply");
    if (item === null || ["string", "number", "boolean"].includes(typeof item)) return;
    if (Array.isArray(item)) {
      for (const child of item) walk(child, depth + 1);
      return;
    }
    if (typeof item !== "object") throw new Error("Unsupported configuration value");
    for (const key of Object.keys(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe configuration field");
      walk(item[key], depth + 1);
    }
  };
  walk(value, 0);
  return true;
}

function sanitizeSecurityData(data = {}) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (/password|secret|token|session|code|phone|hash/i.test(key)) continue;
    if (typeof value === "string") out[key] = redactSecrets(value).slice(0, 500);
    else if (typeof value === "number" || typeof value === "boolean" || value == null) out[key] = value;
  }
  return out;
}

function lastSecurityHash() {
  try {
    if (!fs.existsSync(SECURITY_EVENT_FILE)) return "";
    const raw = fs.readFileSync(SECURITY_EVENT_FILE, "utf8").trim();
    if (!raw) return "";
    const line = raw.slice(raw.lastIndexOf("\n") + 1);
    return String(JSON.parse(line)?.hash || "");
  } catch { return ""; }
}

export function appendSecurityEvent(type, data = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const base = { ts: Date.now(), type: String(type || "security_event"), ...sanitizeSecurityData(data), prev: lastSecurityHash() };
    const hash = crypto.createHmac("sha256", EVENT_KEY).update(stableStringify(base)).digest("hex");
    fs.appendFileSync(SECURITY_EVENT_FILE, `${JSON.stringify({ ...base, hash })}\n`, { mode: 0o600 });
    const stat = fs.statSync(SECURITY_EVENT_FILE);
    if (stat.size > SECURITY_EVENT_MAX_BYTES) {
      const raw = fs.readFileSync(SECURITY_EVENT_FILE);
      let trimmed = raw.subarray(Math.max(0, raw.length - Math.floor(SECURITY_EVENT_MAX_BYTES / 2)));
      const newline = trimmed.indexOf(0x0a);
      if (newline >= 0) trimmed = trimmed.subarray(newline + 1);
      fs.writeFileSync(SECURITY_EVENT_FILE, trimmed, { mode: 0o600 });
    }
  } catch {}
}

export function readSecurityEvents(limit = 100) {
  try {
    if (!fs.existsSync(SECURITY_EVENT_FILE)) return [];
    return fs.readFileSync(SECURITY_EVENT_FILE, "utf8").trim().split("\n").filter(Boolean).slice(-Math.max(1, limit)).reverse().map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

const confirmationTokens = new Map();
export function issueConfirmationToken(actorUid, action, target = "", ttlMs = 120000) {
  const token = crypto.randomBytes(10).toString("base64url");
  confirmationTokens.set(token, {
    actorUid: String(actorUid || ""), action: String(action || ""), target: String(target || ""), expiresAt: Date.now() + Math.min(300000, Math.max(10000, Number(ttlMs || 120000))),
  });
  return token;
}

export function consumeConfirmationToken(token, actorUid, action, target = "") {
  const item = confirmationTokens.get(String(token || ""));
  confirmationTokens.delete(String(token || ""));
  if (!item || item.expiresAt < Date.now()) return false;
  return item.actorUid === String(actorUid || "") && item.action === String(action || "") && item.target === String(target || "");
}

export function getExternalSessionKey() {
  if (!SESSION_KEY_B64) return null;
  try {
    const key = Buffer.from(SESSION_KEY_B64, "base64");
    return key.length === 32 ? key : null;
  } catch { return null; }
}

export function redactSecrets(value) {
  return String(value ?? "")
    .replace(/TP-(?:[A-Z2-9]{4}-){2}[A-Z2-9]{4}/gi, "TP-[REDACTED]")
    .replace(/TP-(?:[A-Z2-9]{5}-){3}[A-Z2-9]{5}/gi, "TP-[REDACTED]")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "[BOT_TOKEN_REDACTED]")
    .replace(/((?:[?&]|\b)(?:token|code|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/("(?:token|password|code|phone|session|api_hash)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/\+\d{7,15}\b/g, "[PHONE_REDACTED]");
}

function sanitizeConsoleArg(arg) {
  if (typeof arg === "string") return redactSecrets(arg);
  if (arg instanceof Error) {
    const copy = new Error(redactSecrets(arg.message));
    copy.name = arg.name;
    return copy;
  }
  return arg;
}

export function installConsoleRedaction() {
  if (console.__telepilotRedactionInstalled) return;
  Object.defineProperty(console, "__telepilotRedactionInstalled", { value: true });
  for (const method of ["log", "warn", "error", "info"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(...args.map(sanitizeConsoleArg));
  }
}

export function requestAddress(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  return forwarded[forwarded.length - 1] || String(req?.socket?.remoteAddress || "unknown");
}
