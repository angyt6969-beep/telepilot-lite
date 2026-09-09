import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { secureLicenseHash, takeRateLimit, requestAddress } from "./security-core.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const KEY_FILE = path.join(DATA_DIR, "access-keys.json");
const DELETED_FILE = path.join(DATA_DIR, "deleted-users.json");
const CASE_FILE = path.join(DATA_DIR, "support-cases.json");
const CLAIM_DIR = path.join(DATA_DIR, "free-trial-claims");
const SECRET_FILE = path.join(DATA_DIR, ".free-trial-secret");
const BOT_TOKEN = String(process.env.BOT_TOKEN || "");
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
const SUPPORT_USERNAME = "vvschrome";
const CHANNEL_USERNAME = String(process.env.TELEPILOT_FREE_TRIAL_CHANNEL_USERNAME || "telepilott").replace(/^@+/, "");
const SUPPORT_URL = `https://t.me/${SUPPORT_USERNAME}`;
const CHANNEL_URL = `https://t.me/${CHANNEL_USERNAME}`;
const TRIAL_COOKIE = "__Host-telepilot_free_trial";
const TRIAL_TOKEN_TTL_MS = 2 * 60 * 60_000;
const CLAIM_LOCK_STALE_MS = 5 * 60_000;
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const FREE_TRIAL_EMOJI_ID = "4983746717313664194";
export const FREE_TRIAL_BUTTON_TEXT = "Free 1-Day Key";

function validUid(uid) { return /^\d+$/.test(String(uid || "")); }
function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function onboardingPath(uid) { return path.join(userDir(uid), "onboarding.json"); }
function readJson(file, fallback = {}) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function secretBytes(options = {}) {
  const supplied = String(options.secret || process.env.TELEPILOT_FREE_TRIAL_SECRET || process.env.TELEPILOT_SECURITY_SECRET || "");
  if (Buffer.byteLength(supplied, "utf8") >= 32) {
    return crypto.createHash("sha256").update(supplied, "utf8").digest();
  }
  try {
    const existing = fs.readFileSync(SECRET_FILE);
    if (existing.length >= 32) return existing.subarray(0, 32);
  } catch {}
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 });
  const created = crypto.randomBytes(32);
  try {
    const fd = fs.openSync(SECRET_FILE, "wx", 0o600);
    try { fs.writeFileSync(fd, created); } finally { fs.closeSync(fd); }
    return created;
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    const existing = fs.readFileSync(SECRET_FILE);
    if (existing.length < 32) throw new Error("TelePilot free-trial secret is invalid");
    return existing.subarray(0, 32);
  }
}
function hmac(label, options = {}) {
  return crypto.createHmac("sha256", secretBytes(options)).update(String(label)).digest();
}
function safeEqual(a, b) {
  try {
    const left = Buffer.from(String(a || ""), "base64url");
    const right = Buffer.from(String(b || ""), "base64url");
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
  } catch { return false; }
}

export function freeTrialSubject(uid, options = {}) {
  if (!validUid(uid)) throw new Error("Invalid Telegram user ID");
  return hmac(`telepilot-free-trial-subject:v1:${String(uid)}`, options).toString("hex");
}

export function createFreeTrialToken(uid, options = {}) {
  if (!validUid(uid)) throw new Error("Invalid Telegram user ID");
  const now = Number(options.now || Date.now());
  const ttlMs = Math.max(60_000, Math.min(Number(options.ttlMs || TRIAL_TOKEN_TTL_MS), 24 * 60 * 60_000));
  const exp = now + ttlMs;
  const payload = `v1.${String(uid)}.${exp}`;
  const sig = hmac(`telepilot-free-trial-token:${payload}`, options).toString("base64url");
  return `${payload}.${sig}`;
}

export function readFreeTrialToken(token, options = {}) {
  const match = String(token || "").match(/^v1\.(\d+)\.(\d{10,16})\.([A-Za-z0-9_-]{20,100})$/);
  if (!match) return null;
  const uid = match[1], exp = Number(match[2]);
  const now = Number(options.now || Date.now());
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + 24 * 60 * 60_000 + 60_000) return null;
  const payload = `v1.${uid}.${exp}`;
  const expected = hmac(`telepilot-free-trial-token:${payload}`, options).toString("base64url");
  if (!safeEqual(match[3], expected)) return null;
  return { uid, exp };
}

export function freeTrialUrlForUid(uid, options = {}) {
  const base = String(options.publicUrl || PUBLIC_URL || "").replace(/\/$/, "");
  if (!base) return "";
  return `${base}/free-trial?t=${encodeURIComponent(createFreeTrialToken(uid, options))}`;
}

function deletedHash(uid) {
  return crypto.createHash("sha256").update(`telepilot-deleted-user:${String(uid)}`).digest("hex");
}
export function isDeletedForFreeTrial(uid) {
  const db = readJson(DELETED_FILE, { version: 1, users: {} });
  return !!(db?.users && typeof db.users === "object" && db.users[deletedHash(uid)]);
}

export function readFreeTrialTutorial(uid) {
  const saved = readJson(onboardingPath(uid), {});
  const reward = saved?.freeTrialReward && typeof saved.freeTrialReward === "object" ? saved.freeTrialReward : {};
  const furthestSlide = Math.max(1, Math.min(5, Number(reward.furthestSlide || 1) || 1));
  const eligibleAt = Number(reward.eligibleAt || 0) || null;
  return { furthestSlide, eligible: !!eligibleAt, eligibleAt };
}

export function advanceFreeTrialTutorial(uid, targetSlide, options = {}) {
  const id = String(uid || "");
  if (!validUid(id)) return { furthestSlide: 1, eligible: false, eligibleAt: null };
  const target = Math.max(1, Math.min(5, Number(targetSlide) || 1));
  const file = onboardingPath(id);
  const saved = readJson(file, {});
  const reward = saved?.freeTrialReward && typeof saved.freeTrialReward === "object" ? saved.freeTrialReward : {};
  const current = Math.max(1, Math.min(5, Number(reward.furthestSlide || 1) || 1));
  let furthestSlide = current;
  let eligibleAt = Number(reward.eligibleAt || 0) || null;
  if (target <= current + 1) furthestSlide = Math.max(current, target);
  if (!eligibleAt && furthestSlide >= 5) eligibleAt = Number(options.now || Date.now());
  if (furthestSlide !== current || eligibleAt !== (Number(reward.eligibleAt || 0) || null)) {
    writeJsonAtomic(file, {
      ...saved,
      freeTrialReward: {
        ...reward,
        version: 1,
        furthestSlide,
        eligibleAt,
      },
    });
  }
  return { furthestSlide, eligible: !!eligibleAt, eligibleAt };
}

function cloneOther(other) {
  if (!other?.reply_markup?.inline_keyboard) return other;
  return {
    ...(other || {}),
    reply_markup: {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    },
  };
}
function isPurchaseButton(button) {
  const text = String(button?.text || "");
  const url = String(button?.url || "");
  if (!/get(?:\s*\/\s*renew)?\s+(?:a\s+)?key/i.test(text)) return false;
  if (url === SUPPORT_URL) return true;
  try { return new URL(url).pathname === "/checkout"; } catch { return false; }
}
function isTrialButton(button) {
  return String(button?.icon_custom_emoji_id || "") === FREE_TRIAL_EMOJI_ID
    || /claim your free 1 day key/i.test(String(button?.text || ""));
}

export function decorateFreeTrialButton(chatId, text, other, options = {}) {
  const uid = String(chatId || "");
  if (!validUid(uid) || !other?.reply_markup?.inline_keyboard) return { text, other };
  const url = freeTrialUrlForUid(uid, options);
  if (!url) return { text, other };
  const next = cloneOther(other);
  if (next.reply_markup.inline_keyboard.flat().some(isTrialButton)) return { text, other: next };
  const index = next.reply_markup.inline_keyboard.findIndex(row => row.some(isPurchaseButton));
  if (index < 0) return { text, other: next };
  next.reply_markup.inline_keyboard.splice(index + 1, 0, [{
    text: FREE_TRIAL_BUTTON_TEXT,
    url,
    icon_custom_emoji_id: FREE_TRIAL_EMOJI_ID,
  }]);
  return { text, other: next };
}

export function installFreeTrialUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotFreeTrialUiInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for free-trial UI");
  Object.defineProperty(ApiClass.prototype, "__telepilotFreeTrialUiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = decorateFreeTrialButton(chatId, text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = decorateFreeTrialButton(chatId, text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
  return true;
}

function deletionTargetForCase(caseId) {
  const db = readJson(CASE_FILE, { version: 1, cases: [] });
  const item = Array.isArray(db?.cases) ? db.cases.find(row => String(row?.id || "") === String(caseId || "")) : null;
  const uid = String(item?.uid || "");
  return validUid(uid) ? uid : "";
}
function freeTrialKeyIdsForUid(uid) {
  const db = readJson(KEY_FILE, { version: 2, keys: [] });
  return new Set((Array.isArray(db?.keys) ? db.keys : [])
    .filter(row => row?.source === "free_trial" && String(row?.boundTo || "") === String(uid))
    .map(row => String(row?.id || ""))
    .filter(Boolean));
}
function revokeFreeTrialKeyIds(ids) {
  if (!ids?.size) return 0;
  const db = readJson(KEY_FILE, { version: 2, keys: [] });
  if (!Array.isArray(db?.keys)) return 0;
  let changed = 0;
  for (const row of db.keys) {
    if (row?.source !== "free_trial" || !ids.has(String(row?.id || ""))) continue;
    if (!row.revokedAt) { row.revokedAt = Date.now(); changed += 1; }
  }
  if (changed) writeJsonAtomic(KEY_FILE, db);
  return changed;
}

export function installFreeTrialTutorialTracking(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotFreeTrialTutorialTrackingInstalled) return false;
  const originalCallbackQuery = BotClass.prototype.callbackQuery;
  if (typeof originalCallbackQuery !== "function") throw new Error("Unsupported grammY Bot shape for free-trial tutorial tracking");
  Object.defineProperty(BotClass.prototype, "__telepilotFreeTrialTutorialTrackingInstalled", { value: true });
  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const data = String(ctx?.callbackQuery?.data || "");
      const match = data.match(/^linear_tutorial:([1-5])$/);
      const uid = ctx?.from?.id ? String(ctx.from.id) : "";
      if (match && validUid(uid)) advanceFreeTrialTutorial(uid, Number(match[1]));

      const deletion = data.match(/^support_admin_delete_final:(TP-SUP-[A-Z2-9]+):[A-Za-z0-9_-]+$/);
      const targetUid = deletion ? deletionTargetForCase(deletion[1]) : "";
      const trialKeyIds = targetUid ? freeTrialKeyIdsForUid(targetUid) : new Set();
      const result = await handler.call(this, ctx, next);
      if (targetUid && isDeletedForFreeTrial(targetUid)) revokeFreeTrialKeyIds(trialKeyIds);
      return result;
    });
    return originalCallbackQuery.call(this, trigger, ...wrapped);
  };
  return true;
}

export function membershipAllowsFreeTrial(member) {
  const status = String(member?.status || "");
  if (["creator", "administrator", "member"].includes(status)) return true;
  return status === "restricted" && member?.is_member === true;
}

export async function verifyFreeTrialMembership(uid, options = {}) {
  if (!validUid(uid)) throw new Error("Invalid Telegram user ID");
  const token = String(options.botToken ?? BOT_TOKEN);
  if (!token) throw new Error("Membership verification is not configured");
  const channel = String(options.channelUsername || CHANNEL_USERNAME).replace(/^@+/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Membership verification is unavailable");
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getChatMember`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: `@${channel}`, user_id: Number(uid) }),
    signal: AbortSignal.timeout(8000),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok || data?.ok !== true || !data?.result) throw new Error("Could not verify channel membership");
  return membershipAllowsFreeTrial(data.result);
}

function randomSegment(length = 5) {
  let out = "";
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  return out;
}
function makeKey() { return `TP-${randomSegment()}-${randomSegment()}-${randomSegment()}-${randomSegment()}`; }
function encryptionKey(options = {}) { return hmac("telepilot-free-trial-key-encryption:v1", options); }
function encryptTrialKey(key, subject, options = {}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(options), iv);
  cipher.setAAD(Buffer.from(`free-trial:${subject}`, "utf8"));
  const body = Buffer.concat([cipher.update(String(key), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
function decryptTrialKey(encrypted, subject, options = {}) {
  try {
    const raw = Buffer.from(String(encrypted || ""), "base64url");
    if (raw.length < 29) return "";
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), body = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(options), iv);
    decipher.setAAD(Buffer.from(`free-trial:${subject}`, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch { return ""; }
}
function claimPath(subject) { return path.join(CLAIM_DIR, `${subject}.json`); }
function lockPath(subject) { return path.join(CLAIM_DIR, `${subject}.lock`); }
function readClaim(subject) { return readJson(claimPath(subject), null); }
function publicClaimKey(subject, claim, options = {}) {
  const key = decryptTrialKey(claim?.encryptedKey, subject, options);
  return key ? { key, keyId: String(claim?.keyId || ""), claimedAt: Number(claim?.claimedAt || 0) || null, alreadyClaimed: true } : null;
}
function acquireClaimLock(subject) {
  fs.mkdirSync(CLAIM_DIR, { recursive: true, mode: 0o700 });
  const file = lockPath(subject);
  const attempt = () => {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const age = Date.now() - fs.statSync(file).mtimeMs;
        if (age > CLAIM_LOCK_STALE_MS) { fs.unlinkSync(file); return attempt(); }
      } catch {}
      return false;
    }
  };
  return attempt();
}
function releaseClaimLock(subject) {
  try { fs.unlinkSync(lockPath(subject)); } catch {}
}
function issueFreeTrialKey(uid, subject, options = {}) {
  const raw = readJson(KEY_FILE, { version: 2, keys: [] });
  const db = { version: 2, keys: Array.isArray(raw?.keys) ? raw.keys : [] };
  const existing = db.keys.find(row => row?.source === "free_trial" && String(row?.freeTrialSubject || "") === subject);
  if (existing) {
    const key = decryptTrialKey(existing.freeTrialEncryptedKey, subject, options);
    if (!key) throw new Error("Existing free-trial key cannot be recovered safely");
    return { key, record: existing, alreadyIssued: true };
  }
  let key = "", hash = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    key = makeKey();
    hash = secureLicenseHash(key);
    if (!db.keys.some(row => String(row?.hash || "") === hash)) break;
    key = "";
  }
  if (!key) throw new Error("Could not allocate a unique TelePilot key");
  const encryptedKey = encryptTrialKey(key, subject, options);
  const record = {
    id: crypto.randomBytes(5).toString("hex"),
    hash,
    hashVersion: 2,
    hint: `${key.slice(0, 8)}-•••••-•••••-•••••`,
    durationDays: 1,
    lifetime: false,
    boundTo: String(uid),
    createdAt: Date.now(),
    redeemedAt: null,
    redeemedBy: null,
    revokedAt: null,
    source: "free_trial",
    freeTrialSubject: subject,
    freeTrialEncryptedKey: encryptedKey,
  };
  db.keys.push(record);
  writeJsonAtomic(KEY_FILE, db);
  return { key, record, alreadyIssued: false };
}

export async function claimFreeTrial(uid, options = {}) {
  const id = String(uid || "");
  if (!validUid(id)) return { ok: false, code: "invalid_user", error: "Invalid Telegram account." };
  if (isDeletedForFreeTrial(id)) return { ok: false, code: "deleted", error: "This TelePilot account has been deleted. Contact support if you need help." };
  const subject = freeTrialSubject(id, options);
  const prior = readClaim(subject);
  const priorKey = publicClaimKey(subject, prior, options);
  if (priorKey) return { ok: true, ...priorKey };

  let member = false;
  try {
    const checker = options.membershipChecker || verifyFreeTrialMembership;
    member = await checker(id, options);
  } catch {
    return { ok: false, code: "membership_unavailable", error: `TelePilot could not verify @${CHANNEL_USERNAME} membership right now. Try again shortly or contact support.` };
  }
  if (!member) return { ok: false, code: "join_required", error: `Join @${CHANNEL_USERNAME} first, then tap Verify & claim again.` };

  if (!acquireClaimLock(subject)) return { ok: false, code: "in_progress", error: "Your free key is already being prepared. Try again in a moment." };
  try {
    const afterLock = publicClaimKey(subject, readClaim(subject), options);
    if (afterLock) return { ok: true, ...afterLock };
    const issued = issueFreeTrialKey(id, subject, options);
    const encryptedKey = encryptTrialKey(issued.key, subject, options);
    const claimedAt = Date.now();
    writeJsonAtomic(claimPath(subject), {
      version: 1,
      status: "issued",
      claimedAt,
      keyId: issued.record.id,
      encryptedKey,
    });
    return { ok: true, key: issued.key, keyId: issued.record.id, claimedAt, alreadyClaimed: issued.alreadyIssued === true };
  } finally {
    releaseClaimLock(subject);
  }
}

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers?.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}
function trialSession(req) { return readFreeTrialToken(readCookies(req)[TRIAL_COOKIE] || ""); }
function trialCookie(token) {
  return `${TRIAL_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(TRIAL_TOKEN_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}
function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(value));
}
function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://t.me",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  });
  res.end(html);
}
function expiredPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TelePilot Free Trial</title><style>body{margin:0;background:#05080d;color:#f5f8fc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.box{max-width:460px;background:#111820;border:1px solid #263545;border-radius:22px;padding:28px;box-shadow:0 24px 70px #0008}a{color:#49bfff}</style></head><body><div class="box"><h1>✈️ TelePilot</h1><p>This free-trial link is missing or expired.</p><p>Open <a href="https://t.me/telepilotsbot">@telepilotsbot</a> and press <b>${FREE_TRIAL_BUTTON_TEXT}</b> again.</p></div></body></html>`;
}
function trialPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>TelePilot — Free 1-day key</title><style>
:root{color-scheme:dark;--bg:#05080d;--card:rgba(12,18,27,.82);--text:#f5f8fc;--muted:#93a2b5;--blue:#2aabee;--cyan:#49d8ff;--green:#7de8ad;--danger:#ff8e9a}*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{background:radial-gradient(circle at 50% -20%,rgba(36,104,173,.17),transparent 42%),var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;min-height:100svh;display:grid;place-items:center;padding:clamp(16px,4vw,42px);overflow-x:hidden}.ambient{position:fixed;inset:clamp(12px,3vw,32px);overflow:hidden;border-radius:clamp(28px,5vw,54px);pointer-events:none;background:linear-gradient(145deg,rgba(255,255,255,.035),rgba(255,255,255,.008) 55%,rgba(42,171,238,.035)),#10151c;border:1px solid rgba(255,255,255,.055);box-shadow:0 28px 90px rgba(0,0,0,.42)}.glow{position:absolute;width:min(68vw,760px);aspect-ratio:1;border-radius:50%;filter:blur(76px);opacity:.45}.a{left:-20%;top:-34%;background:radial-gradient(circle,rgba(35,139,255,.8),rgba(42,171,238,.25) 38%,transparent 68%);animation:a 15s ease-in-out infinite alternate}.b{right:-22%;bottom:-38%;background:radial-gradient(circle,rgba(73,216,255,.58),rgba(20,96,220,.24) 40%,transparent 69%);animation:b 18s ease-in-out infinite alternate}@keyframes a{to{transform:translate3d(42%,30%,0) scale(1.14)}}@keyframes b{to{transform:translate3d(-42%,-26%,0) scale(.93)}}.shell{position:relative;z-index:2;width:min(520px,100%)}.brand{display:flex;align-items:center;justify-content:center;gap:11px;margin-bottom:18px;font-weight:750}.mark{width:40px;height:40px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(145deg,rgba(42,171,238,.24),rgba(22,135,255,.1));border:1px solid rgba(91,200,255,.24)}.card{position:relative;overflow:hidden;border-radius:28px;padding:clamp(24px,5vw,34px);background:linear-gradient(155deg,rgba(255,255,255,.055),rgba(255,255,255,.012) 40%),var(--card);border:1px solid rgba(255,255,255,.1);box-shadow:0 32px 90px rgba(0,0,0,.46);backdrop-filter:blur(22px)}.card:before{content:"";position:absolute;left:12%;right:12%;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(105,208,255,.72),transparent)}.badge{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:999px;background:rgba(42,171,238,.08);border:1px solid rgba(76,188,255,.14);color:#a9dfff;font-size:12px;font-weight:700;margin-bottom:15px}.dot{width:6px;height:6px;border-radius:50%;background:#56d6ff;box-shadow:0 0 14px rgba(86,214,255,.8)}h1{margin:0;font-size:clamp(29px,7vw,38px);line-height:1.05;letter-spacing:-.04em}.sub{margin:13px 0 0;color:var(--muted);font-size:15px;line-height:1.58}.steps{margin:22px 0 0;display:grid;gap:10px}.step{padding:14px 15px;border-radius:16px;background:rgba(3,8,14,.44);border:1px solid rgba(255,255,255,.065);color:#dce5ef;font-size:14px;line-height:1.45}.step b{color:#fff}.actions{display:grid;gap:10px;margin-top:18px}.btn{min-height:50px;border:0;border-radius:15px;display:flex;align-items:center;justify-content:center;text-decoration:none;color:#fff;font:inherit;font-size:15px;font-weight:730;cursor:pointer;background:linear-gradient(135deg,#2aabee,#177dff);box-shadow:0 12px 28px rgba(16,130,255,.22)}.btn.secondary{background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09);box-shadow:none}.btn:disabled{opacity:.5;cursor:default}.status{margin-top:18px;padding:14px 15px;border-radius:15px;color:#cbd7e5;font-size:13px;line-height:1.5;background:rgba(3,8,14,.44);border:1px solid rgba(255,255,255,.065)}.status.ok{color:var(--green)}.status.error{color:var(--danger)}.keybox{margin-top:12px;padding:15px;border-radius:15px;background:rgba(42,171,238,.08);border:1px solid rgba(73,216,255,.18)}.key{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;word-break:break-all;color:#eaf8ff}.copy{width:100%;min-height:42px;margin-top:10px;border-radius:12px;border:1px solid rgba(139,177,214,.17);background:rgba(255,255,255,.05);color:#dce5ef;font-weight:680}.fine{margin:16px 2px 0;color:#66798d;font-size:11px;line-height:1.5;text-align:center}.hidden{display:none!important}@media(max-width:560px){body{padding:12px}.ambient{inset:8px;border-radius:30px}.card{border-radius:24px;padding:24px 20px}.glow{filter:blur(56px)}}@media(prefers-reduced-motion:reduce){.glow{animation:none!important}}</style></head><body><div class="ambient"><div class="glow a"></div><div class="glow b"></div></div><main class="shell"><div class="brand"><div class="mark">✈️</div><span>TelePilot</span></div><section class="card"><div class="badge"><span class="dot"></span>Free access</div><h1>Your <strong><em>Free</em></strong> 1-day key</h1><p class="sub">Join <b>@${CHANNEL_USERNAME}</b>, then verify your membership. The free 1-day key can be claimed once per Telegram account.</p><div class="steps"><div class="step"><b>1. Join the channel</b><br>Membership in @${CHANNEL_USERNAME} is checked by TelePilot when you claim.</div><div class="step"><b>2. Claim your key</b><br>Your 1-day key is bound to the Telegram account that opened this page.</div></div><div class="actions"><a class="btn secondary" href="${CHANNEL_URL}" rel="noreferrer">Join @${CHANNEL_USERNAME}</a><button id="claim" class="btn" type="button">Verify & claim key</button></div><div id="status" class="status">Checking your tutorial reward…</div><div id="keybox" class="keybox hidden"><div id="key" class="key"></div><button id="copy" class="copy" type="button">Copy key</button></div><p class="fine">One free trial per Telegram account. Leaving/rejoining, changing username, reinstalling TelePilot or deleting normal account data does not reset a used reward. Abuse controls may retain a minimal anti-abuse marker as described in the Privacy Policy.</p></section></main><script>
const S=document.getElementById('status'),B=document.getElementById('claim'),K=document.getElementById('key'),KB=document.getElementById('keybox'),C=document.getElementById('copy');function showError(m){S.className='status error';S.textContent=m}function showKey(k,again){K.textContent=k;KB.classList.remove('hidden');S.className='status ok';S.textContent=again?'This Telegram account already claimed its free key. Here is the same key again.':'Free 1-day key created. Copy it, return to TelePilot and redeem it.'}async function session(){try{const r=await fetch('/free-trial/session',{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Session expired.');if(d.deleted){B.disabled=true;return showError('This TelePilot account has been deleted. Contact support if you need help.')}if(d.key){showKey(d.key,true);B.textContent='Key already claimed'}else{S.textContent='Join @${CHANNEL_USERNAME}, then tap Verify & claim key.'}}catch(e){B.disabled=true;showError(e.message||'Could not load your free-trial session.')}}B.onclick=async()=>{B.disabled=true;S.className='status';S.textContent='Verifying channel membership…';try{const r=await fetch('/free-trial/claim',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not claim your free key.');showKey(d.key,!!d.alreadyClaimed);B.textContent='Key claimed'}catch(e){showError(e.message||'Could not claim your free key.');B.disabled=false}};C.onclick=async()=>{try{await navigator.clipboard.writeText(K.textContent);C.textContent='Copied';setTimeout(()=>C.textContent='Copy key',1600)}catch{C.textContent='Select and copy the key'}};session();
</script></body></html>`;
}

async function handleFreeTrialHttp(req, res) {
  const url = new URL(req.url || "/", "http://telepilot.local");
  if (!url.pathname.startsWith("/free-trial")) return false;
  if (req.method === "GET" && url.pathname === "/free-trial") {
    const token = url.searchParams.get("t") || "";
    if (token) {
      if (!readFreeTrialToken(token)) { sendHtml(res, 410, expiredPage()); return true; }
      res.writeHead(303, { location: "/free-trial", "set-cookie": trialCookie(token), "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end();
      return true;
    }
    const session = trialSession(req);
    sendHtml(res, session ? 200 : 401, session ? trialPage() : expiredPage());
    return true;
  }
  const session = trialSession(req);
  if (!session) { sendJson(res, 401, { error: "Free-trial session expired. Open the button in TelePilot again." }); return true; }
  if (req.method === "GET" && url.pathname === "/free-trial/session") {
    const ipLimit = takeRateLimit("free-trial-session-ip", requestAddress(req), 80, 10 * 60_000);
    if (!ipLimit.ok) { sendJson(res, 429, { error: "Too many requests. Try again later." }); return true; }
    const deleted = isDeletedForFreeTrial(session.uid);
    const subject = freeTrialSubject(session.uid);
    const existing = deleted ? null : publicClaimKey(subject, readClaim(subject));
    sendJson(res, 200, { eligible: !deleted, deleted, channel: `@${CHANNEL_USERNAME}`, ...(existing ? { key: existing.key, claimedAt: existing.claimedAt } : {}) });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/free-trial/claim") {
    const a = takeRateLimit("free-trial-claim-ip", requestAddress(req), 20, 10 * 60_000);
    const b = takeRateLimit("free-trial-claim-user", session.uid, 8, 10 * 60_000);
    if (!a.ok || !b.ok) { sendJson(res, 429, { error: "Too many claim attempts. Try again later." }); return true; }
    const result = await claimFreeTrial(session.uid);
    sendJson(res, result.ok ? 200 : result.code === "in_progress" ? 409 : result.code === "membership_unavailable" ? 503 : 403, result.ok ? { key: result.key, alreadyClaimed: result.alreadyClaimed, claimedAt: result.claimedAt } : { error: result.error, code: result.code });
    return true;
  }
  sendJson(res, 404, { error: "not found" });
  return true;
}

export function installFreeTrialWeb() {
  if (http.__telepilotFreeTrialWebInstalled) return false;
  Object.defineProperty(http, "__telepilotFreeTrialWebInstalled", { value: true });
  const previousCreateServer = http.createServer.bind(http);
  http.createServer = function(...args) {
    const index = args.findIndex(value => typeof value === "function");
    if (index < 0) return previousCreateServer(...args);
    const listener = args[index];
    args[index] = async function(req, res) {
      try {
        if (await handleFreeTrialHttp(req, res)) return;
      } catch (err) {
        console.warn("TelePilot free-trial HTTP error:", String(err?.message || err).slice(0, 160));
        if (!res.headersSent) return sendJson(res, 500, { error: "Free-trial request failed." });
        try { res.end(); } catch {}
        return;
      }
      return listener(req, res);
    };
    return previousCreateServer(...args);
  };
  return true;
}
