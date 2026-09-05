import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import bigInt from "big-integer";
import { Bot, InlineKeyboard } from "grammy";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import {
  appendSecurityEvent,
  getExternalSessionKey,
  isSecurityLockdown,
  isUserFrozen,
  legacyLicenseHash,
  licenseRecordMatches,
  normalizeLicenseKey,
  readSecurityEvents,
  requestAddress,
  resetRateLimit,
  secureLicenseHash,
  setSecurityLockdown,
  setUserFrozen,
  takeRateLimit,
  installConsoleRedaction,
} from "./security-core.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
const INTERVAL_VALUES = [1, 5, 10, 15, 30, 45, 60, 90, 120];
const REMOVE_PAGE_SIZE = 8;
const POST_GAP_MS = 1500;
const IDLE_STATE_MS = 30 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const KEY_FILE = path.join(DATA_DIR, "access-keys.json");
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const LEGACY_SETTINGS_FILE = path.join(DATA_DIR, "telepilot-settings.json");
const SESSION_KEY_FILE = path.join(DATA_DIR, ".personal-session-key");
const ADMIN_EVENT_FILE = path.join(DATA_DIR, "admin-events.jsonl");
const ADMIN_PAGE_SIZE = 8;
const ADMIN_EVENT_MAX_BYTES = 2 * 1024 * 1024;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!API_ID) throw new Error("Missing API_ID");
if (!API_HASH) throw new Error("Missing API_HASH");
if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL/RAILWAY_PUBLIC_DOMAIN");

fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_DIR = path.join(DATA_DIR, "users");
fs.mkdirSync(USERS_DIR, { recursive: true });
const states = new Map();
const loginAttempts = new Map();

// TELEPILOT_SECURITY_PACK_V1
installConsoleRedaction();
const sensitiveCallbacks = new Map();

function sensitiveCallbackKey(uid, data) {
  return String(uid || "") + ":" + String(data || "");
}
function authorizeSensitiveCallback(uid, data, ttlMs = 120_000) {
  if (!uid || !data) return;
  sensitiveCallbacks.set(
    sensitiveCallbackKey(uid, data),
    Date.now() + Math.min(300_000, Math.max(10_000, Number(ttlMs || 120_000))),
  );
}
function consumeSensitiveCallback(uid, data) {
  const key = sensitiveCallbackKey(uid, data);
  const expiresAt = Number(sensitiveCallbacks.get(key) || 0);
  sensitiveCallbacks.delete(key);
  return expiresAt > Date.now();
}
function authorizeSensitiveKeyboard(uid, keyboard) {
  for (const row of keyboard?.inline_keyboard || []) {
    for (const button of row || []) {
      const data = String(button?.callback_data || "");
      if (data.includes("_confirm")) authorizeSensitiveCallback(uid, data);
    }
  }
}
async function notifySecurityAdmins(text) {
  const message = String(text || "").slice(0, 700);
  for (const id of ADMIN_IDS) {
    try { await bot.api.sendMessage(Number(id), `🛡 TelePilot Security\n\n${message}`); } catch {}
  }
}
function rateLimitMessage(result) {
  const seconds = Math.max(1, Math.ceil(Number(result?.retryAfterMs || 0) / 1000));
  const wait = seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
  return `Too many attempts. Try again in about ${wait}.`;
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch (err) { console.warn(`Could not read ${path.basename(file)}:`, err?.message || err); return fallback; }
}
function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function settingsFile(uid) { return path.join(userDir(uid), "settings.json"); }
function personalSessionFile(uid) { return path.join(userDir(uid), "personal-session.enc"); }

function resolveAdminIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) if (/^\d+$/.test(part)) ids.add(part);
  }
  const persisted = readJson(ADMIN_FILE, {});
  for (const value of Array.isArray(persisted.adminIds) ? persisted.adminIds : []) {
    if (/^\d+$/.test(String(value))) ids.add(String(value));
  }
  const legacy = readJson(LEGACY_SETTINGS_FILE, {});
  if (/^\d+$/.test(String(legacy.ownerId || ""))) ids.add(String(legacy.ownerId));
  if (ids.size) {
    try { writeJsonAtomic(ADMIN_FILE, { version: 1, adminIds: [...ids] }); } catch {}
  }
  return ids;
}
const ADMIN_IDS = resolveAdminIds();
function isAdmin(uid) { return ADMIN_IDS.has(String(uid)); }

function normalizeSavedGroups(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "");
    if (!/^-\d+$/.test(id)) continue;
    out.push({
      id,
      label: String(item.label || item.title || id).slice(0, 120),
      type: String(item.type || "group"),
      username: item.username ? String(item.username) : "",
    });
  }
  return out;
}
function loadUserSettings(uid) { return readJson(settingsFile(uid), {}); }
function createState(uid) {
  const saved = loadUserSettings(uid);
  return {
    uid: Number(uid),
    adMessage: typeof saved.adMessage === "string" ? saved.adMessage : "",
    adEntities: Array.isArray(saved.adEntities) ? saved.adEntities : [],
    groups: normalizeSavedGroups(saved.groups),
    intervalMinutes: INTERVAL_VALUES.includes(Number(saved.intervalMinutes)) ? Number(saved.intervalMinutes) : 30,
    totalSent: Number.isFinite(Number(saved.totalSent)) ? Number(saved.totalSent) : 0,
    lastRunAt: Number.isFinite(Number(saved.lastRunAt)) ? Number(saved.lastRunAt) : null,
    lastCycleSuccess: Number.isFinite(Number(saved.lastCycleSuccess)) ? Number(saved.lastCycleSuccess) : 0,
    lastCycleFailed: Number.isFinite(Number(saved.lastCycleFailed)) ? Number(saved.lastCycleFailed) : 0,
    accessLifetime: saved.accessLifetime === true,
    accessUntil: Number.isFinite(Number(saved.accessUntil)) ? Number(saved.accessUntil) : null,
    accessKeyId: typeof saved.accessKeyId === "string" ? saved.accessKeyId : null,
    accessRevoked: saved.accessRevoked === true,
    personalUsername: typeof saved.personalUsername === "string" ? saved.personalUsername : "",
    telegramUsername: typeof saved.telegramUsername === "string" ? saved.telegramUsername : "",
    telegramFirstName: typeof saved.telegramFirstName === "string" ? saved.telegramFirstName : "",
    telegramLastName: typeof saved.telegramLastName === "string" ? saved.telegramLastName : "",
    createdAt: Number.isFinite(Number(saved.createdAt)) ? Number(saved.createdAt) : null,
    lastSeenAt: Number.isFinite(Number(saved.lastSeenAt)) ? Number(saved.lastSeenAt) : null,
    postingTimer: null,
    posting: false,
    cyclePromise: null,
    nextRunAt: null,
    awaiting: null,
    awaitingPromptMessageId: null,
    awaitingPromptChatId: null,
    personalClient: null,
    personalRestorePromise: null,
    lastTouchedAt: Date.now(),
  };
}
function getState(uid) {
  const key = String(uid);
  if (!states.has(key)) states.set(key, createState(uid));
  const state = states.get(key);
  state.lastTouchedAt = Date.now();
  return state;
}
function saveState(state) {
  fs.mkdirSync(userDir(state.uid), { recursive: true, mode: 0o700 });
  writeJsonAtomic(settingsFile(state.uid), {
    version: 3,
    adMessage: state.adMessage,
    adEntities: state.adEntities,
    groups: state.groups,
    intervalMinutes: state.intervalMinutes,
    totalSent: state.totalSent,
    lastRunAt: state.lastRunAt,
    lastCycleSuccess: state.lastCycleSuccess,
    lastCycleFailed: state.lastCycleFailed,
    accessLifetime: state.accessLifetime,
    accessUntil: state.accessUntil,
    accessKeyId: state.accessKeyId,
    accessRevoked: state.accessRevoked,
    personalUsername: state.personalUsername,
    telegramUsername: state.telegramUsername,
    telegramFirstName: state.telegramFirstName,
    telegramLastName: state.telegramLastName,
    createdAt: state.createdAt,
    lastSeenAt: state.lastSeenAt,
  });
}

function hasAccess(state) {
  if (!state) return false;
  if (isAdmin(state.uid)) return true;
  if (state.accessRevoked) return false;
  if (state.accessLifetime) return true;
  return Number(state.accessUntil || 0) > Date.now();
}
function accessLabel(state) {
  if (isAdmin(state.uid)) return "Owner access";
  if (state.accessRevoked) return "Revoked";
  if (state.accessLifetime) return "Lifetime";
  if (!state.accessUntil || state.accessUntil <= Date.now()) return "Inactive";
  const days = Math.max(1, Math.ceil((state.accessUntil - Date.now()) / 86_400_000));
  return `${days} day${days === 1 ? "" : "s"} left`;
}
function formatAccessExpiry(state) {
  if (isAdmin(state.uid)) return "Owner access";
  if (state.accessLifetime) return "Lifetime";
  if (!state.accessUntil || state.accessUntil <= Date.now()) return "Expired";
  return new Date(state.accessUntil).toISOString().slice(0, 10);
}

function loadKeyDb() {
  const db = readJson(KEY_FILE, { version: 2, keys: [] });
  return { version: 2, keys: Array.isArray(db.keys) ? db.keys : [] };
}
function saveKeyDb(db) { writeJsonAtomic(KEY_FILE, { version: 2, keys: db.keys }); }
function normalizeKey(value) { return normalizeLicenseKey(value); }
function hashKey(value, version = 2) {
  return Number(version) >= 2 ? secureLicenseHash(value) : legacyLicenseHash(value);
}
function randomKeySegment(length = 5) {
  let out = "";
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  return out;
}
function generateLicenseKey(duration, boundTo = null) {
  const db = loadKeyDb();
  const boundUid = boundTo == null || boundTo === "" ? null : String(boundTo);
  if (boundUid && !/^\d+$/.test(boundUid)) throw new Error("Bound Telegram ID must be numeric");
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = `TP-${randomKeySegment()}-${randomKeySegment()}-${randomKeySegment()}-${randomKeySegment()}`;
    const keyHash = hashKey(key, 2);
    if (db.keys.some(item => item.hash === keyHash)) continue;
    const record = {
      id: crypto.randomBytes(5).toString("hex"),
      hash: keyHash,
      hashVersion: 2,
      hint: `${key.slice(0, 8)}-•••••-•••••-•••••`,
      durationDays: duration === "lifetime" ? null : duration,
      lifetime: duration === "lifetime",
      boundTo: boundUid,
      createdAt: Date.now(),
      redeemedAt: null,
      redeemedBy: null,
      revokedAt: null,
    };
    db.keys.push(record);
    saveKeyDb(db);
    return { key, record };
  }
  throw new Error("Could not generate a unique key");
}
function redeemLicenseKey(state, rawKey) {
  const uid = String(state?.uid || "");
  const rate = takeRateLimit("key-redeem", uid, 5, 10 * 60_000);
  if (!rate.ok) {
    appendSecurityEvent("key_redeem_rate_limited", { uid });
    void notifySecurityAdmins(`Repeated access-key attempts were blocked for Telegram user ${uid}.`);
    return { ok: false, error: rateLimitMessage(rate) };
  }
  const normalized = normalizeKey(rawKey);
  const supported = /^TP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalized)
    || /^TP-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(normalized);
  if (!supported) {
    appendSecurityEvent("key_redeem_failed", { uid, reason: "format" });
    return { ok: false, error: "This key cannot be used." };
  }
  const db = loadKeyDb();
  const record = db.keys.find(item => licenseRecordMatches(item, normalized));
  if (!record || record.revokedAt || record.redeemedAt || (record.boundTo && String(record.boundTo) !== uid)) {
    appendSecurityEvent("key_redeem_failed", {
      uid,
      reason: record?.boundTo && String(record.boundTo) !== uid ? "bound_mismatch" : "unusable",
    });
    return { ok: false, error: "This key cannot be used." };
  }
  record.redeemedAt = Date.now();
  record.redeemedBy = uid;
  if (record.lifetime) {
    state.accessLifetime = true;
    state.accessUntil = null;
  } else {
    const base = Math.max(Date.now(), Number(state.accessUntil || 0));
    state.accessUntil = base + Number(record.durationDays) * 86_400_000;
  }
  state.accessKeyId = record.id;
  state.accessRevoked = false;
  saveKeyDb(db);
  saveState(state);
  resetRateLimit("key-redeem", uid);
  logAdminEvent("key_redeemed", {
    uid,
    keyId: record.id,
    duration: record.lifetime ? "lifetime" : `${record.durationDays}d`,
  });
  appendSecurityEvent("key_redeemed", { uid, keyId: record.id, bound: !!record.boundTo });
  return { ok: true, record };
}
function revokeKey(identifier) {
  const value = normalizeKey(identifier);
  const db = loadKeyDb();
  const record = /^TP-/.test(value)
    ? db.keys.find(item => licenseRecordMatches(item, value))
    : db.keys.find(item => String(item.id).toLowerCase() === String(identifier || "").trim().toLowerCase());
  if (!record) return { ok: false, error: "Key not found." };
  if (!record.revokedAt) record.revokedAt = Date.now();
  saveKeyDb(db);
  if (record.redeemedBy) {
    const state = getState(record.redeemedBy);
    if (state.accessKeyId === record.id) {
      state.accessRevoked = true;
      stopPostingLoop(state);
      saveState(state);
    }
  }
  return { ok: true, record };
}

const EXTERNAL_SESSION_ENCRYPTION_KEY = getExternalSessionKey();
function getLegacySessionEncryptionKey() {
  try {
    if (fs.existsSync(SESSION_KEY_FILE)) {
      const raw = fs.readFileSync(SESSION_KEY_FILE);
      if (raw.length === 32) return raw;
    }
    if (EXTERNAL_SESSION_ENCRYPTION_KEY) return null;
    const key = crypto.randomBytes(32);
    fs.writeFileSync(SESSION_KEY_FILE, key, { mode: 0o600 });
    return key;
  } catch (err) {
    throw new Error(`Could not initialize personal session encryption key: ${err?.message || err}`);
  }
}
const LEGACY_SESSION_ENCRYPTION_KEY = getLegacySessionEncryptionKey();
const SESSION_ENCRYPTION_KEY = EXTERNAL_SESSION_ENCRYPTION_KEY || LEGACY_SESSION_ENCRYPTION_KEY;
if (!SESSION_ENCRYPTION_KEY) throw new Error("No personal-session encryption key is available");

function encryptSession(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SESSION_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 2,
    keyVersion: EXTERNAL_SESSION_ENCRYPTION_KEY ? "env" : "legacy",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}
function decryptSession(payload) {
  const parsed = JSON.parse(payload);
  let key = null;
  if (parsed?.v === 1) key = LEGACY_SESSION_ENCRYPTION_KEY;
  else if (parsed?.v === 2 && parsed?.keyVersion === "env") key = EXTERNAL_SESSION_ENCRYPTION_KEY;
  else if (parsed?.v === 2 && parsed?.keyVersion === "legacy") key = LEGACY_SESSION_ENCRYPTION_KEY;
  else throw new Error("Unsupported session format");
  if (!key) throw new Error("Session encryption key is unavailable");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
function hasPersonalSession(uid) {
  try { return fs.existsSync(personalSessionFile(uid)) && fs.statSync(personalSessionFile(uid)).size > 20; }
  catch { return false; }
}
function savePersonalSession(uid, sessionString) {
  fs.mkdirSync(userDir(uid), { recursive: true, mode: 0o700 });
  const file = personalSessionFile(uid);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, encryptSession(sessionString), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function loadPersonalSession(uid) {
  const raw = fs.readFileSync(personalSessionFile(uid), "utf8");
  const parsed = JSON.parse(raw);
  const session = decryptSession(raw);
  if (parsed?.v === 1 && EXTERNAL_SESSION_ENCRYPTION_KEY) {
    savePersonalSession(uid, session);
    appendSecurityEvent("session_encryption_migrated", { uid: String(uid) });
  }
  return session;
}
function removePersonalSession(uid) {
  try { fs.rmSync(personalSessionFile(uid), { force: true }); } catch {}
}

const bot = new Bot(BOT_TOKEN);
const botInfo = await bot.api.getMe();
const BOT_USER_ID = botInfo.id;

function sanitizeBotEntities(entities = []) {
  const allowed = new Set(["bold", "italic", "underline", "strikethrough", "spoiler", "blockquote", "expandable_blockquote", "code", "pre", "text_link", "custom_emoji"]);
  return entities.filter(e => allowed.has(e?.type)).map(e => ({
    type: e.type,
    offset: Number(e.offset),
    length: Number(e.length),
    ...(e.url ? { url: String(e.url) } : {}),
    ...(e.language ? { language: String(e.language) } : {}),
    ...(e.custom_emoji_id ? { custom_emoji_id: String(e.custom_emoji_id) } : {}),
  })).filter(e => Number.isInteger(e.offset) && Number.isInteger(e.length) && e.offset >= 0 && e.length > 0);
}
function toMtprotoEntities(entities = []) {
  const out = [];
  for (const e of entities) {
    const b = { offset: Number(e.offset), length: Number(e.length) };
    try {
      switch (e.type) {
        case "bold": out.push(new Api.MessageEntityBold(b)); break;
        case "italic": out.push(new Api.MessageEntityItalic(b)); break;
        case "underline": out.push(new Api.MessageEntityUnderline(b)); break;
        case "strikethrough": out.push(new Api.MessageEntityStrike(b)); break;
        case "spoiler": out.push(new Api.MessageEntitySpoiler(b)); break;
        case "code": out.push(new Api.MessageEntityCode(b)); break;
        case "pre": out.push(new Api.MessageEntityPre({ ...b, language: e.language || "" })); break;
        case "text_link": out.push(new Api.MessageEntityTextUrl({ ...b, url: e.url || "" })); break;
        case "blockquote": out.push(new Api.MessageEntityBlockquote({ ...b, collapsed: false })); break;
        case "expandable_blockquote": out.push(new Api.MessageEntityBlockquote({ ...b, collapsed: true })); break;
        case "custom_emoji":
          if (/^\d+$/.test(e.custom_emoji_id || "")) {
            out.push(new Api.MessageEntityCustomEmoji({ ...b, documentId: bigInt(e.custom_emoji_id) }));
          }
          break;
      }
    } catch {}
  }
  return out;
}

async function safeDelete(chatId, messageId) {
  if (!chatId || !messageId) return;
  try { await bot.api.deleteMessage(chatId, messageId); } catch {}
}
async function autoDeleteNotice(chatId, text, ms = 9000) {
  try {
    const m = await bot.api.sendMessage(chatId, text);
    setTimeout(() => void safeDelete(chatId, m.message_id), ms);
  } catch {}
}
function clearAwaiting(state) {
  state.awaiting = null;
  state.awaitingPromptMessageId = null;
  state.awaitingPromptChatId = null;
}
function privateOnly(ctx) { return ctx.chat?.type === "private"; }
function stateFromCtx(ctx) { const uid = ctx.from?.id; return uid ? getState(uid) : null; }
function formatInterval(m) {
  const v = Number(m);
  if (v < 60) return `${v} min`;
  if (v % 60 === 0) return `${v / 60}h`;
  return `${Math.floor(v / 60)}h ${v % 60}m`;
}
function formatAgo(ts) {
  if (!ts) return "Never";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return "Just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function formatUntil(state) {
  if (!state.posting) return "—";
  if (!state.nextRunAt) return state.cyclePromise ? "after current cycle" : "—";
  const s = Math.max(0, Math.ceil((state.nextRunAt - Date.now()) / 1000));
  if (s < 60) return "<1 min";
  return formatInterval(Math.ceil(s / 60));
}
function accountLabel(state) {
  if (!hasPersonalSession(state.uid)) return "Bot posting";
  if (state.personalUsername) return `@${state.personalUsername}`;
  return "Personal account";
}

async function ensurePersonalClient(state) {
  if (!hasPersonalSession(state.uid)) return null;
  if (state.personalClient) return state.personalClient;
  if (state.personalRestorePromise) return state.personalRestorePromise;
  state.personalRestorePromise = (async () => {
    let client;
    try {
      client = new TelegramClient(new StringSession(loadPersonalSession(state.uid)), API_ID, API_HASH, {
        connectionRetries: 5,
        floodSleepThreshold: 60,
      });
      await client.connect();
      if (!(await client.checkAuthorization())) throw new Error("Saved Telegram session is no longer authorized");
      const me = await client.getMe();
      state.personalUsername = me?.username || state.personalUsername || "";
      state.personalClient = client;
      saveState(state);
      return client;
    } catch (err) {
      try { await client?.disconnect(); } catch {}
      console.warn(`Could not restore personal Telegram account for user ${state.uid}:`, err?.message || err);
      return null;
    } finally {
      state.personalRestorePromise = null;
    }
  })();
  return state.personalRestorePromise;
}

function cancelLoginAttempt(uid, reason = "cancelled") {
  const attempt = loginAttempts.get(String(uid));
  if (!attempt) return;
  loginAttempts.delete(String(uid));
  attempt.stage = reason;
  try { void attempt.client?.disconnect(); } catch {}
}
function createLoginToken() { return crypto.randomBytes(32).toString("base64url"); }
function cleanPhone(value) {
  const phone = String(value || "").trim().replace(/[\s()-]+/g, "");
  return /^\+\d{7,15}$/.test(phone) ? phone : null;
}
function telegramErrorCode(err) {
  return String(err?.errorMessage || err?.description || err?.message || "").toUpperCase();
}
function cleanAuthError(err) {
  const code = telegramErrorCode(err);
  if (code.includes("PHONE_CODE_INVALID")) return "That login code was incorrect.";
  if (code.includes("PHONE_CODE_EXPIRED")) return "That login code expired. Start the connection again.";
  if (code.includes("PASSWORD_HASH_INVALID")) return "That 2FA password was incorrect.";
  if (code.includes("PHONE_NUMBER_INVALID")) return "Telegram rejected that phone number.";
  if (code.includes("PHONE_NUMBER_BANNED")) return "Telegram says this phone number is banned.";
  if (code.includes("FLOOD_WAIT")) return "Telegram temporarily rate-limited login attempts. Try again later.";
  if (code.includes("PHONE_NUMBER_UNOCCUPIED")) return "That phone number is not registered to a Telegram account.";
  return "Telegram could not complete the login.";
}

async function completeLogin(attempt, user) {
  const state = getState(attempt.uid);
  const me = (user?.username || user?.firstName) ? user : await attempt.client.getMe();
  savePersonalSession(attempt.uid, attempt.client.session.save());
  state.personalUsername = me?.username || "";
  if (state.personalClient && state.personalClient !== attempt.client) {
    try { await state.personalClient.disconnect(); } catch {}
  }
  state.personalClient = attempt.client;
  saveState(state);
  logAdminEvent("account_connected", { uid: String(state.uid) });
  appendSecurityEvent("account_connected", { uid: String(state.uid) });
  void notifySecurityAdmins(`A personal Telegram account was connected for user ${state.uid}.`);
  attempt.client = null;
  attempt.stage = "done";
  attempt.doneAt = Date.now();
  try {
    await bot.api.sendMessage(
      attempt.uid,
      `✅ Personal account connected${state.personalUsername ? ` as @${state.personalUsername}` : ""}.\n\nTelePilot will now post using this personal account.`,
      { reply_markup: new InlineKeyboard().text("✈️ Open TelePilot", "home") },
    );
  } catch {}
  setTimeout(() => {
    const current = loginAttempts.get(String(attempt.uid));
    if (current === attempt) loginAttempts.delete(String(attempt.uid));
  }, 2 * 60_000);
}

async function beginPersonalLogin(uid, phone) {
  cancelLoginAttempt(uid, "replaced");
  const token = createLoginToken();
  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 0,
  });
  const attempt = {
    uid: Number(uid),
    token,
    browserToken: "",
    phone,
    client,
    stage: "starting",
    error: "",
    createdAt: Date.now(),
    phoneCodeHash: "",
    isCodeViaApp: false,
    codeFailures: 0,
    passwordFailures: 0,
  };
  loginAttempts.set(String(uid), attempt);
  try {
    await client.connect();
    const sent = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    attempt.phoneCodeHash = sent.phoneCodeHash;
    attempt.isCodeViaApp = sent.isCodeViaApp === true;
    attempt.stage = "code";
    appendSecurityEvent("login_started", { uid: String(uid) });
    return {
      url: `${PUBLIC_URL.replace(/\/+$/, "")}/connect?token=${encodeURIComponent(token)}`,
      isCodeViaApp: attempt.isCodeViaApp,
    };
  } catch (err) {
    attempt.error = cleanAuthError(err);
    attempt.stage = "error";
    appendSecurityEvent("login_start_failed", { uid: String(uid), reason: telegramErrorCode(err).slice(0, 80) });
    try { await client.disconnect(); } catch {}
    loginAttempts.delete(String(uid));
    throw new Error(attempt.error);
  }
}

function getAttemptByToken(token) {
  if (!token || typeof token !== "string") return null;
  for (const attempt of loginAttempts.values()) {
    if (attempt.token !== token) continue;
    if (Date.now() - attempt.createdAt > LOGIN_TTL_MS) {
      cancelLoginAttempt(attempt.uid, "expired");
      return null;
    }
    return attempt;
  }
  return null;
}
function getAttemptByBrowserToken(token) {
  if (!token || typeof token !== "string") return null;
  for (const attempt of loginAttempts.values()) {
    if (attempt.browserToken !== token) continue;
    if (Date.now() - attempt.createdAt > LOGIN_TTL_MS) {
      cancelLoginAttempt(attempt.uid, "expired");
      return null;
    }
    return attempt;
  }
  return null;
}
function rotateBrowserToken(attempt) {
  const token = createLoginToken();
  attempt.browserToken = token;
  return token;
}
function failLoginAttempt(attempt, kind, err) {
  const field = kind === "password" ? "passwordFailures" : "codeFailures";
  attempt[field] = Number(attempt[field] || 0) + 1;
  const count = attempt[field];
  appendSecurityEvent("login_attempt_failed", { uid: String(attempt.uid), stage: kind, count });
  if (count >= 5) {
    const uid = attempt.uid;
    cancelLoginAttempt(uid, "locked");
    void notifySecurityAdmins(`Five failed Telegram ${kind} attempts locked login for user ${uid}.`);
    throw new Error("Too many failed attempts. Start the account connection again.");
  }
  throw new Error(cleanAuthError(err));
}

async function submitLoginCode(attempt, code) {
  if (attempt.stage !== "code") return;
  const value = String(code || "").replace(/\D/g, "");
  if (!/^\d{3,10}$/.test(value)) return failLoginAttempt(attempt, "code", new Error("PHONE_CODE_INVALID"));
  try {
    const result = await attempt.client.invoke(new Api.auth.SignIn({
      phoneNumber: attempt.phone,
      phoneCodeHash: attempt.phoneCodeHash,
      phoneCode: value,
    }));
    const user = result?.user || result;
    await completeLogin(attempt, user);
  } catch (err) {
    const codeName = telegramErrorCode(err);
    if (codeName.includes("SESSION_PASSWORD_NEEDED")) {
      attempt.stage = "password";
      attempt.error = "";
      return;
    }
    attempt.error = cleanAuthError(err);
    return failLoginAttempt(attempt, "code", err);
  }
}

async function submitLoginPassword(attempt, password) {
  if (attempt.stage !== "password") return;
  const value = String(password || "");
  if (!value) return failLoginAttempt(attempt, "password", new Error("PASSWORD_HASH_INVALID"));
  let passwordError = null;
  try {
    const user = await attempt.client.signInWithPassword(
      { apiId: API_ID, apiHash: API_HASH },
      {
        password: async () => value,
        onError: async err => {
          passwordError = err;
          return true;
        },
      },
    );
    await completeLogin(attempt, user);
  } catch (err) {
    attempt.error = cleanAuthError(passwordError || err);
    return failLoginAttempt(attempt, "password", passwordError || err);
  }
}

function accessKeyboard(active) {
  const kb = new InlineKeyboard().text(active ? "🔑 Redeem another key" : "🔑 Redeem Key", "redeem_key");
  if (active) kb.row().text("⬅️ Back", "home");
  return kb;
}
async function showAccess(ctx, state, locked = false) {
  clearAwaiting(state);
  const text = hasAccess(state)
    ? `🔑 ACCESS\n\n✅ Active\nPlan: ${accessLabel(state)}\nExpires: ${formatAccessExpiry(state)}\n\nYou can redeem another key to extend your access.`
    : "🔐 TELEPILOT ACCESS\n\nAn access key is required to use TelePilot.\
\
Need a key? Message @noahxrp to get yours.";
  const opts = { reply_markup: accessKeyboard(hasAccess(state)) };
  try {
    if (ctx.callbackQuery?.message) await ctx.editMessageText(text, opts);
    else await ctx.reply(text, opts);
  } catch {
    await ctx.reply(text, opts);
  }
  if (locked) stopPostingLoop(state);
}
function mainKeyboard(state) {
  const kb = new InlineKeyboard()
    .text("👤 Account", "account").text("📝 Message", "message").row()
    .text("👥 Groups", "groups").text("⏱ Interval", "interval").row()
    .text("▶️ START", "start").text("⏹ STOP", "stop").row()
    .text("📊 Activity", "activity").text("🔑 Access", "access").row()
    .text("🔄 Refresh", "home");
  if (state && isAdmin(state.uid)) kb.row().text("🟣 ADMIN PANEL", "admin").primary();
  return kb;
}
function dashboard(state) {
  return [
    "✈️ TELEPILOT", "", state.posting ? "🟢 Running" : "⚪ Stopped", "",
    `👤 Posting as: ${accountLabel(state)}`,
    `🔑 Access: ${accessLabel(state)}`,
    `📝 Message: ${state.adMessage ? `✅ Set (${state.adMessage.length} chars)` : "❌ Not set"}`,
    `👥 Groups: ${state.groups.length}`,
    `⏱ Interval: ${formatInterval(state.intervalMinutes)}`,
    state.posting ? `⏳ Next post: ${formatUntil(state)}` : null,
  ].filter(Boolean).join("\n");
}
async function showHome(ctx, state) {
  clearAwaiting(state);
  if (!hasAccess(state)) return showAccess(ctx, state, true);
  const opts = { reply_markup: mainKeyboard(state) };
  try {
    if (ctx.callbackQuery?.message) await ctx.editMessageText(dashboard(state), opts);
    else await ctx.reply(dashboard(state), opts);
  } catch {
    await ctx.reply(dashboard(state), opts);
  }
}
async function editDashboard(chatId, messageId, state) {
  if (!hasAccess(state)) return false;
  try {
    await bot.api.editMessageText(chatId, messageId, dashboard(state), { reply_markup: mainKeyboard(state) });
    return true;
  } catch {
    return false;
  }
}

function normalizeTarget(input) {
  let v = String(input || "").trim().replace(/^https?:\/\/(www\.)?t\.me\//i, "");
  v = v.split(/[/?#]/)[0];
  if (!v) return null;
  if (/^-\d+$/.test(v)) return v;
  if (/^\d+$/.test(v)) return null;
  v = v.replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(v) ? `@${v}` : null;
}
function destinationLabel(destination) { return destination.username || destination.label || destination.id; }
function cleanDestinationError(err) {
  const code = telegramErrorCode(err);
  if (code.includes("BOT_WAS_KICKED") || code.includes("BOT WAS KICKED") || code.includes("KICKED FROM")) {
    return "TelePilot is banned or removed from that group. Unban @TelePilottBot, add it again, make it an admin, then retry.";
  }
  if (code.includes("CHAT_NOT_FOUND")) return "Telegram could not find that group/channel. Check the username or link.";
  if (code.includes("FORBIDDEN")) return "TelePilot cannot access that group/channel. Make sure @TelePilottBot is added and is an admin.";
  return err?.message || "TelePilot cannot access that destination yet.";
}
function personalDialogPeerId(dialog) {
  const entity = dialog?.entity;
  const raw = String(entity?.id ?? "").replace(/\D/g, "");
  if (!raw) return "";
  if (entity?.broadcast === true || entity?.megagroup === true || entity?.className === "Channel") return `-100${raw}`;
  return `-${raw}`;
}
async function resolveDestination(target, ownerUid) {
  const ownerState = ownerUid ? getState(ownerUid) : null;
  if (ownerState && hasPersonalSession(ownerState.uid)) {
    const client = await ensurePersonalClient(ownerState);
    if (!client) throw new Error("Reconnect your personal Telegram account first.");
    if (!String(target).startsWith("@")) {
      throw new Error("Personal-account setup currently needs a public @username or t.me link. Private groups can still be added with /addhere.");
    }

    const wanted = String(target).slice(1).toLowerCase();
    let dialogs;
    try { dialogs = await client.getDialogs({ limit: 500 }); }
    catch { throw new Error("TelePilot could not read your connected account's chats. Reconnect the account and try again."); }

    const dialog = dialogs.find(item => String(item?.entity?.username || "").toLowerCase() === wanted);
    if (!dialog) {
      throw new Error(`${accountLabel(ownerState)} is not joined to that group/channel. Join it with the connected account first, then retry.`);
    }

    const entity = dialog.entity;
    if (entity?.broadcast === true && entity?.creator !== true && entity?.adminRights?.postMessages !== true) {
      throw new Error(`${accountLabel(ownerState)} is joined to that channel but does not have permission to post. Give that account Post Messages permission first.`);
    }

    let chat = null;
    try { chat = await bot.api.getChat(`@${wanted}`); } catch {}
    if (chat && ["group", "supergroup", "channel"].includes(chat.type)) {
      return {
        id: String(chat.id),
        label: String(chat.title || chat.username || chat.id).slice(0, 120),
        type: chat.type,
        username: chat.username ? `@${chat.username}` : `@${wanted}`,
      };
    }

    const peerId = personalDialogPeerId(dialog);
    if (!peerId) throw new Error("TelePilot could not identify that destination from your connected account.");
    return {
      id: peerId,
      label: String(entity?.title || entity?.username || target).slice(0, 120),
      type: entity?.broadcast === true ? "channel" : entity?.megagroup === true ? "supergroup" : "group",
      username: `@${wanted}`,
    };
  }

  let chat;
  try { chat = await bot.api.getChat(target); }
  catch (err) { throw new Error(cleanDestinationError(err)); }
  if (!chat || !["group", "supergroup", "channel"].includes(chat.type)) {
    throw new Error("That destination is not a Telegram group or channel.");
  }
  let member;
  try { member = await bot.api.getChatMember(chat.id, BOT_USER_ID); }
  catch { throw new Error("Add @TelePilottBot to that group/channel first, then try again."); }
  if (member.status !== "administrator") throw new Error("Make @TelePilottBot an admin in that group/channel first.");
  if (chat.type === "channel" && member.can_post_messages !== true) {
    throw new Error("Give @TelePilottBot permission to post messages in that channel.");
  }
  if (ownerUid) {
    let ownerMember;
    try { ownerMember = await bot.api.getChatMember(chat.id, Number(ownerUid)); }
    catch { throw new Error("I could not verify that you are an admin of that destination."); }
    if (!["creator", "administrator"].includes(ownerMember.status)) {
      throw new Error("Only an admin of that group/channel can add it to their TelePilot profile.");
    }
  }
  return {
    id: String(chat.id),
    label: String(chat.title || chat.username || chat.id).slice(0, 120),
    type: chat.type,
    username: chat.username ? `@${chat.username}` : "",
  };
}
function stopPostingLoop(state) {
  state.posting = false;
  state.nextRunAt = null;
  if (state.postingTimer) clearTimeout(state.postingTimer);
  state.postingTimer = null;
}
async function resolvePersonalTarget(client, destination) {
  if (destination.username) return destination.username;
  const dialogs = await client.getDialogs({ limit: 500 });
  for (const dialog of dialogs) {
    const candidates = [
      dialog?.id,
      dialog?.entity?.id,
      dialog?.inputEntity?.chatId,
      dialog?.inputEntity?.channelId,
    ].filter(v => v !== undefined && v !== null).map(v => String(v));
    if (candidates.includes(String(destination.id))) return dialog;
  }
  throw new Error("This personal account could not resolve that private destination. Add a public username or reopen the group in Telegram and try again.");
}
function isFatalPersonalSessionError(err) {
  const code = telegramErrorCode(err);
  return code.includes("AUTH_KEY_UNREGISTERED")
    || code.includes("SESSION_REVOKED")
    || code.includes("SESSION_EXPIRED")
    || code.includes("AUTH_KEY_DUPLICATED")
    || code.includes("USER_DEACTIVATED");
}
async function sendCycleBody(state) {
  if (!state.posting || !hasAccess(state)) { stopPostingLoop(state); return; }
  const message = state.adMessage;
  const targets = [...state.groups];
  if (!message || !targets.length) { stopPostingLoop(state); return; }

  const personalClient = hasPersonalSession(state.uid) ? await ensurePersonalClient(state) : null;
  if (hasPersonalSession(state.uid) && !personalClient) {
    stopPostingLoop(state);
    await autoDeleteNotice(state.uid, "⚠️ Your personal Telegram session could not be restored. Reconnect the account.", 15000);
    return;
  }

  const formattingEntities = personalClient ? toMtprotoEntities(state.adEntities) : [];
  let success = 0;
  let failed = 0;
  for (const target of targets) {
    if (!state.posting || !hasAccess(state)) { stopPostingLoop(state); break; }
    try {
      if (personalClient) {
        const entity = await resolvePersonalTarget(personalClient, target);
        await personalClient.sendMessage(entity, {
          message,
          ...(formattingEntities.length ? { formattingEntities } : {}),
        });
      } else {
        await bot.api.sendMessage(target.id, message, state.adEntities.length ? { entities: state.adEntities } : {});
      }
      success++;
      state.totalSent++;
      if (state.posting) await new Promise(resolve => setTimeout(resolve, POST_GAP_MS));
    } catch (err) {
      failed++;
      console.error(`User ${state.uid} failed to post to ${target.id}:`, err?.errorMessage || err?.description || err?.message || err);
      if (personalClient && isFatalPersonalSessionError(err)) {
        stopPostingLoop(state);
        await autoDeleteNotice(state.uid, "⚠️ Your personal Telegram session is no longer authorized. Reconnect the account.", 15000);
        break;
      }
    }
  }
  state.lastRunAt = Date.now();
  state.lastCycleSuccess = success;
  state.lastCycleFailed = failed;
  saveState(state);
  logAdminEvent("post_cycle", { uid: String(state.uid), success, failed });
}
function runCycle(state) {
  if (state.cyclePromise) return state.cyclePromise;
  state.cyclePromise = sendCycleBody(state).finally(() => { state.cyclePromise = null; });
  return state.cyclePromise;
}
function scheduleNextCycle(state) {
  if (state.postingTimer) clearTimeout(state.postingTimer);
  state.postingTimer = null;
  if (!state.posting || !hasAccess(state)) { stopPostingLoop(state); return; }
  const delay = state.intervalMinutes * 60_000;
  state.nextRunAt = Date.now() + delay;
  state.postingTimer = setTimeout(async () => {
    state.postingTimer = null;
    state.nextRunAt = null;
    await runCycle(state);
    if (state.posting) scheduleNextCycle(state);
  }, delay);
}
function startPostingLoop(state) {
  if (state.posting || !hasAccess(state)) return;
  state.posting = true;
  state.nextRunAt = null;
  void (async () => {
    await runCycle(state);
    if (state.posting && !state.postingTimer) scheduleNextCycle(state);
  })();
}

function groupList(state) {
  if (!state.groups.length) return "No destinations added.";
  const visible = state.groups.slice(0, 20);
  const lines = visible.map((g, i) => `${i + 1}. ${destinationLabel(g)}`);
  if (state.groups.length > visible.length) {
    lines.push(`… and ${state.groups.length - visible.length} more. Use Remove to browse all destinations.`);
  }
  return lines.join("\n");
}
function groupsKeyboard(state) {
  const kb = new InlineKeyboard().text("➕ Add destination", "add_group");
  if (state.groups.length) kb.text("➖ Remove", "remove_group_menu");
  kb.row();
  if (state.groups.length) kb.text("🗑 Clear all", "clear_groups").row();
  return kb.text("⬅️ Back", "home");
}
async function showGroups(ctx, state) {
  const hint = hasPersonalSession(state.uid)
    ? "Public destinations use your connected personal account and do not require @TelePilottBot to be an admin. For private groups without a username, /addhere can still be used for setup."
    : "Add @TelePilottBot as an admin in each destination first. In a group, you can also send /addhere while you are a group admin.";
  await ctx.editMessageText(
    `👥 GROUPS & CHANNELS\n\n${groupList(state)}\n\n${hint}`,
    { reply_markup: groupsKeyboard(state) },
  );
}
async function showRemoveGroupPage(ctx, state, requestedPage = 0) {
  const pages = Math.max(1, Math.ceil(state.groups.length / REMOVE_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
  const start = page * REMOVE_PAGE_SIZE;
  const kb = new InlineKeyboard();
  state.groups.slice(start, start + REMOVE_PAGE_SIZE).forEach((g, offset) => {
    kb.text(`❌ ${destinationLabel(g).slice(0, 40)}`, `remove_group:${start + offset}:${page}`).row();
  });
  if (pages > 1) {
    if (page > 0) kb.text("◀️ Prev", `remove_group_menu:${page - 1}`);
    if (page < pages - 1) kb.text("Next ▶️", `remove_group_menu:${page + 1}`);
    kb.row();
  }
  kb.text("⬅️ Back", "groups");
  await ctx.editMessageText(
    `➖ REMOVE DESTINATION\n\nPage ${page + 1}/${pages}\nChoose a destination to remove:`,
    { reply_markup: kb },
  );
}

function htmlPage(token) {
  const safeToken = JSON.stringify(String(token));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>TelePilot Connect</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0e1621;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{width:min(440px,100%);background:#17212b;border:1px solid #293847;border-radius:22px;padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.35)}.logo{font-size:34px}.muted{color:#9dafbd;line-height:1.5}.status{background:#101923;border-radius:14px;padding:14px;margin:18px 0}input{width:100%;font-size:18px;padding:15px;border-radius:13px;border:1px solid #395064;background:#0f1a24;color:#fff;outline:none;margin:8px 0 12px}button{width:100%;border:0;border-radius:13px;padding:15px;font-size:17px;font-weight:700;background:#2aabee;color:#fff}button:disabled{opacity:.55}.error{color:#ff8c8c;margin-top:12px}.ok{color:#74dc9b}.hidden{display:none}.tiny{font-size:13px;color:#8497a6;margin-top:16px;line-height:1.4}</style>
</head>
<body><main class="card">
<div class="logo">✈️</div><h1>TelePilot Connect</h1>
<p class="muted">Finish connecting your personal Telegram account. Your login code and 2FA password are submitted directly to this secure TelePilot page and are not sent as bot chat messages.</p>
<div id="status" class="status">Checking login…</div>
<form id="codeForm" class="hidden"><label>Telegram login code</label><input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="12345"><button>Continue</button></form>
<form id="passwordForm" class="hidden"><label>Telegram 2FA password</label><input id="password" type="password" autocomplete="current-password" placeholder="Password"><button>Connect account</button></form>
<div id="error" class="error"></div>
<p class="tiny">This link expires automatically. TelePilot stores the resulting Telegram session, not the code or 2FA password.</p>
</main>
<script>
const token=${safeToken};
const statusEl=document.getElementById("status"), codeForm=document.getElementById("codeForm"), passwordForm=document.getElementById("passwordForm"), errorEl=document.getElementById("error");
function show(stage,data){
  codeForm.classList.toggle("hidden",stage!=="code");
  passwordForm.classList.toggle("hidden",stage!=="password");
  errorEl.textContent=data.error||"";
  if(stage==="code") statusEl.textContent=data.isCodeViaApp?"Telegram sent the code to your Telegram app. Enter it below.":"Telegram requested a login code. Enter the code you received below.";
  else if(stage==="password") statusEl.textContent="2-Step Verification is enabled. Enter your Telegram 2FA password.";
  else if(stage==="done"){statusEl.innerHTML='<span class="ok">✅ Account connected. You can return to Telegram.</span>';}
  else if(stage==="error") statusEl.textContent=data.error||"Login failed.";
  else statusEl.textContent="Preparing login…";
}
async function poll(){
  try{const r=await fetch("/auth/status?token="+encodeURIComponent(token),{cache:"no-store"});const d=await r.json();if(!r.ok)throw new Error(d.error||"This login link expired.");show(d.stage,d);if(!["done","error"].includes(d.stage))setTimeout(poll,900);}
  catch(e){errorEl.textContent=e.message;}
}
codeForm.addEventListener("submit",async e=>{e.preventDefault();errorEl.textContent="";const b=codeForm.querySelector("button");b.disabled=true;try{const r=await fetch("/auth/code",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token,code:document.getElementById("code").value})});const d=await r.json();if(!r.ok)throw new Error(d.error||"Code failed.");show(d.stage,d);}catch(e){errorEl.textContent=e.message;}finally{b.disabled=false;}});
passwordForm.addEventListener("submit",async e=>{e.preventDefault();errorEl.textContent="";const b=passwordForm.querySelector("button");b.disabled=true;try{const r=await fetch("/auth/password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token,password:document.getElementById("password").value})});document.getElementById("password").value="";const d=await r.json();if(!r.ok)throw new Error(d.error||"Password failed.");show(d.stage,d);}catch(e){errorEl.textContent=e.message;}finally{b.disabled=false;}});
poll();
</script></body></html>`;
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
async function readJsonBody(req, maxBytes = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

bot.use(async (ctx, next) => {
  if (ctx.from && ctx.chat?.type === "private") syncUserIdentity(ctx, getState(ctx.from.id));
  if (ctx.callbackQuery && ctx.chat && ctx.chat.type !== "private") {
    try { await ctx.answerCallbackQuery({ text: "Use TelePilot controls in a private chat." }); } catch {}
    return;
  }
  const uid = ctx.from?.id ? String(ctx.from.id) : "";
  if (uid && ctx.chat?.type === "private" && !isAdmin(uid)) {
    const state = getState(uid);
    const data = String(ctx.callbackQuery?.data || "");
    const text = String(ctx.message?.text || "");
    if (isUserFrozen(uid)) {
      stopPostingLoop(state);
      const allowed = new Set(["home", "access", "account", "account_disconnect", "activity", "stop"]);
      if (!allowed.has(data) && !/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
        const eventRate = takeRateLimit("frozen-block-log", uid, 1, 60_000);
        if (eventRate.ok) appendSecurityEvent("frozen_user_action_blocked", { uid, action: data || "message" });
        if (ctx.callbackQuery) {
          try { await ctx.answerCallbackQuery({ text: "This TelePilot account is frozen by an administrator.", show_alert: true }); } catch {}
        } else {
          await ctx.reply("🧊 This TelePilot account is currently frozen by an administrator.");
        }
        return;
      }
    }
    if (isSecurityLockdown()) {
      const blockedCallbacks = new Set(["redeem_key", "account_phone", "start", "start_confirm", "import_config"]);
      const blockedAwaiting = new Set(["license_key", "phone"]);
      if (blockedCallbacks.has(data) || (ctx.message?.text && blockedAwaiting.has(String(state.awaiting || "")))) {
        const eventRate = takeRateLimit("lockdown-block-log", uid, 1, 60_000);
        if (eventRate.ok) appendSecurityEvent("lockdown_action_blocked", { uid, action: data || state.awaiting || "message" });
        if (ctx.callbackQuery) {
          try { await ctx.answerCallbackQuery({ text: "TelePilot security lockdown is active. Try again later.", show_alert: true }); } catch {}
        } else {
          await ctx.reply("🛡 TelePilot security lockdown is active. This action is temporarily unavailable.");
        }
        return;
      }
    }
  }
  await next();
});

// ===== TELEPILOT ADMIN PANEL =====
const adminDrafts = new Map();

function listKnownUserIds() {
  const ids = new Set([...states.keys()]);
  try {
    for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d+$/.test(entry.name)) ids.add(entry.name);
    }
  } catch {}
  try {
    for (const key of loadKeyDb().keys) {
      if (/^\d+$/.test(String(key.redeemedBy || ""))) ids.add(String(key.redeemedBy));
    }
  } catch {}
  return [...ids].sort((a, b) => Number(a) - Number(b));
}
function getAdminSnapshot(uid) {
  return states.get(String(uid)) || createState(uid);
}
function formatAdminDate(ts, withTime = false) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return "—";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "—";
  return withTime
    ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : d.toISOString().slice(0, 10);
}
function formatAdminUserName(state) {
  if (state.telegramUsername) return `@${state.telegramUsername}`;
  const name = [state.telegramFirstName, state.telegramLastName].filter(Boolean).join(" ").trim();
  return name || String(state.uid);
}
function syncUserIdentity(ctx, state) {
  if (!ctx.from || !state) return;
  const now = Date.now();
  const username = String(ctx.from.username || "");
  const firstName = String(ctx.from.first_name || "");
  const lastName = String(ctx.from.last_name || "");
  let changed = false;
  if (state.telegramUsername !== username) { state.telegramUsername = username; changed = true; }
  if (state.telegramFirstName !== firstName) { state.telegramFirstName = firstName; changed = true; }
  if (state.telegramLastName !== lastName) { state.telegramLastName = lastName; changed = true; }
  if (!state.createdAt) { state.createdAt = now; changed = true; }
  if (!state.lastSeenAt || now - state.lastSeenAt >= 5 * 60_000) { state.lastSeenAt = now; changed = true; }
  if (changed) saveState(state);
}
function logAdminEvent(type, data = {}) {
  try {
    const entry = { ts: Date.now(), type: String(type), ...data };
    fs.appendFileSync(ADMIN_EVENT_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const stat = fs.statSync(ADMIN_EVENT_FILE);
    if (stat.size > ADMIN_EVENT_MAX_BYTES) {
      const raw = fs.readFileSync(ADMIN_EVENT_FILE);
      let trimmed = raw.subarray(Math.max(0, raw.length - Math.floor(ADMIN_EVENT_MAX_BYTES / 2)));
      const newline = trimmed.indexOf(0x0a);
      if (newline >= 0) trimmed = trimmed.subarray(newline + 1);
      fs.writeFileSync(ADMIN_EVENT_FILE, trimmed, { mode: 0o600 });
    }
  } catch (err) {
    console.warn("Could not write TelePilot admin event:", err?.message || err);
  }
}
function readAdminEvents(limit = 100) {
  try {
    if (!fs.existsSync(ADMIN_EVENT_FILE)) return [];
    const lines = fs.readFileSync(ADMIN_EVENT_FILE, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-Math.max(1, limit)).reverse().map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
function adminEventSummary(event) {
  const uid = event.uid ? ` • ${event.uid}` : "";
  switch (event.type) {
    case "key_generated": return `🔑 Key ${event.keyId || ""} generated (${event.duration || "?"})`;
    case "key_redeemed": return `✅ Key ${event.keyId || ""} redeemed${uid}`;
    case "key_revoked": return `🚫 Key ${event.keyId || ""} revoked${uid}`;
    case "post_cycle": return `✈️ ${event.success || 0} sent / ${event.failed || 0} failed${uid}`;
    case "posting_started": return `▶️ Posting started${uid}`;
    case "posting_stopped": return `⏹ Posting stopped${uid}`;
    case "posting_stopped_admin": return `⏹ Admin stopped posting${uid}`;
    case "posting_stopped_all": return `🛑 Admin stopped all posting (${event.count || 0})`;
    case "access_extended": return `➕ Access extended ${event.duration || ""}${uid}`;
    case "access_revoked": return `🔒 Access revoked${uid}`;
    case "access_restored": return `🔓 Access restored${uid}`;
    case "account_connected": return `👤 Personal account connected${uid}`;
    case "account_disconnected": return `🔌 Personal account disconnected${uid}`;
    case "user_reset": return `♻️ User configuration reset${uid}`;
    case "announcement_sent": return `📢 Announcement: ${event.sent || 0} sent / ${event.failed || 0} failed`;
    case "login_links_cancelled": return `🔐 Cancelled ${event.count || 0} login link(s)`;
    default: return `${event.type || "event"}${uid}`;
  }
}
function customerUserIds() {
  return listKnownUserIds().filter(id => !isAdmin(id));
}
function adminAccessStatus(state) {
  if (state.accessRevoked) return "🔴 Revoked";
  if (state.accessLifetime) return "🟣 Lifetime";
  if (Number(state.accessUntil || 0) > Date.now()) return "🟢 Active";
  if (state.accessUntil) return "⚪ Expired";
  return "⚪ Inactive";
}
function adminUserStatusIcon(state) {
  const live = states.get(String(state.uid));
  if (live?.posting) return "🟢";
  if (state.accessRevoked) return "🔴";
  if (hasAccess(state)) return "🟣";
  return "⚪";
}
async function adminRender(ctx, text, keyboard) {
  authorizeSensitiveKeyboard(ctx.from?.id, keyboard);
  const opts = { reply_markup: keyboard };
  if (ctx.callbackQuery?.message) {
    try { return await ctx.editMessageText(text, opts); }
    catch (err) {
      const msg = String(err?.description || err?.message || "").toLowerCase();
      if (msg.includes("message is not modified")) return;
    }
  }
  return ctx.reply(text, opts);
}
async function allowAdminCallback(ctx) {
  const uid = String(ctx.from?.id || "");
  if (!privateOnly(ctx) || !isAdmin(uid)) {
    appendSecurityEvent("unauthorized_admin_callback", {
      uid,
      action: String(ctx.callbackQuery?.data || "").slice(0, 100),
    });
    const noticeRate = takeRateLimit("unauthorized-admin-notice", uid || "unknown", 1, 5 * 60_000);
    if (noticeRate.ok) void notifySecurityAdmins(`Unauthorized admin-control attempt from Telegram user ${uid || "unknown"}.`);
    try { await ctx.answerCallbackQuery({ text: "Admin access only.", show_alert: true }); } catch {}
    return false;
  }
  const data = String(ctx.callbackQuery?.data || "");
  if (data.includes("_confirm") && !consumeSensitiveCallback(uid, data)) {
    appendSecurityEvent("expired_admin_confirmation", { uid, action: data.slice(0, 100) });
    try {
      await ctx.answerCallbackQuery({
        text: "This confirmation expired or was already used. Open the action again.",
        show_alert: true,
      });
    } catch {}
    return false;
  }
  try { await ctx.answerCallbackQuery(); } catch {}
  return true;
}

function adminMainKeyboard() {
  return new InlineKeyboard()
    .text("👥 Users", "admin_users:0").text("🔑 Keys", "admin_keys").row()
    .text("▶️ Active Posts", "admin_active:0").text("⏳ Expiring", "admin_expiring").row()
    .text("📊 Statistics", "admin_stats").text("📢 Announcement", "admin_announce").row()
    .text("🧾 Logs", "admin_logs:0").text("🔐 Security", "admin_security").row()
    .text("⬅️ Back", "home");
}
function adminDashboardText() {
  const ids = customerUserIds();
  const snapshots = ids.map(getAdminSnapshot);
  const keys = loadKeyDb().keys;
  const now = Date.now();
  const active = snapshots.filter(s => hasAccess(s)).length;
  const revoked = snapshots.filter(s => s.accessRevoked).length;
  const expired = snapshots.filter(s => !s.accessRevoked && !s.accessLifetime && s.accessUntil && s.accessUntil <= now).length;
  const running = [...states.values()].filter(s => s.posting && !isAdmin(s.uid)).length;
  const connected = ids.filter(hasPersonalSession).length;
  const unusedKeys = keys.filter(k => !k.revokedAt && !k.redeemedAt).length;
  const redeemedKeys = keys.filter(k => k.redeemedAt && !k.revokedAt).length;
  const revokedKeys = keys.filter(k => k.revokedAt).length;
  const totalSent = snapshots.reduce((sum, s) => sum + Number(s.totalSent || 0), 0);
  const recentFailures = snapshots
    .filter(s => s.lastRunAt && now - s.lastRunAt <= 86_400_000)
    .reduce((sum, s) => sum + Number(s.lastCycleFailed || 0), 0);
  return [
    "🟣 TELEPILOT ADMIN",
    "",
    "🟢 Service: Online",
    `⏱ Uptime: ${formatInterval(Math.max(1, Math.floor(process.uptime() / 60)))}`,
    "",
    `👥 Users: ${ids.length}`,
    `✅ Active access: ${active}`,
    `⚪ Expired: ${expired}`,
    `🔴 Revoked: ${revoked}`,
    `▶️ Posting now: ${running}`,
    `👤 Connected personal accounts: ${connected}`,
    "",
    `✈️ Total successful posts: ${totalSent}`,
    `⚠️ Recent failed posts: ${recentFailures}`,
    "",
    `🔑 Keys: ${unusedKeys} unused • ${redeemedKeys} redeemed • ${revokedKeys} revoked`,
  ].join("\n");
}
async function showAdmin(ctx) {
  return adminRender(ctx, adminDashboardText(), adminMainKeyboard());
}

async function showAdminUsers(ctx, requestedPage = 0) {
  const ids = customerUserIds();
  const pages = Math.max(1, Math.ceil(ids.length / ADMIN_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
  const start = page * ADMIN_PAGE_SIZE;
  const kb = new InlineKeyboard();
  for (const id of ids.slice(start, start + ADMIN_PAGE_SIZE)) {
    const state = getAdminSnapshot(id);
    kb.text(`${adminUserStatusIcon(state)} ${formatAdminUserName(state).slice(0, 34)}`, `admin_user:${id}:${page}`).row();
  }
  kb.text("🔎 Search", "admin_user_search").row();
  if (pages > 1) {
    if (page > 0) kb.text("◀️ Prev", `admin_users:${page - 1}`);
    if (page < pages - 1) kb.text("Next ▶️", `admin_users:${page + 1}`);
    kb.row();
  }
  kb.text("⬅️ Admin", "admin");
  return adminRender(ctx, `👥 USERS\n\nTotal: ${ids.length}\nPage ${page + 1}/${pages}\n\n🟢 posting • 🟣 active • 🔴 revoked • ⚪ inactive`, kb);
}
async function showAdminUser(ctx, uid, backPage = 0) {
  const id = String(uid);
  if (!customerUserIds().includes(id)) {
    return adminRender(ctx, "User not found.", new InlineKeyboard().text("⬅️ Users", `admin_users:${backPage}`));
  }
  const state = getAdminSnapshot(id);
  const live = states.get(id);
  const connected = hasPersonalSession(id);
  const sender = connected ? (state.personalUsername ? `@${state.personalUsername}` : "Personal account") : "TelePilot Bot";
  const text = [
    `👤 ${formatAdminUserName(state)}`,
    "",
    `Telegram ID: ${id}`,
    `Access: ${adminAccessStatus(state)}`,
    `Security: ${isUserFrozen(id) ? "🧊 Frozen" : "🟢 Normal"}`,
    `Expires: ${formatAccessExpiry(state)}`,
    `Key ID: ${state.accessKeyId || "—"}`,
    `Joined/first seen: ${formatAdminDate(state.createdAt)}`,
    `Last seen: ${formatAdminDate(state.lastSeenAt, true)}`,
    "",
    `Sender: ${sender}`,
    `Destinations: ${state.groups.length}`,
    `Interval: ${formatInterval(state.intervalMinutes)}`,
    `Posting: ${live?.posting ? "🟢 Running" : "⚪ Stopped"}`,
    `Next post: ${live?.posting ? formatUntil(live) : "—"}`,
    `Total sent: ${state.totalSent}`,
    `Last cycle: ${formatAgo(state.lastRunAt)}`,
    `Last result: ${state.lastRunAt ? `✅ ${state.lastCycleSuccess} • ❌ ${state.lastCycleFailed}` : "—"}`,
  ].join("\n");
  const kb = new InlineKeyboard()
    .text("➕ Extend Access", `admin_user_extend:${id}:${backPage}`)
    .text(state.accessRevoked ? "🔓 Restore" : "🔒 Revoke", state.accessRevoked ? `admin_user_restore:${id}:${backPage}` : `admin_user_revoke:${id}:${backPage}`).row();
  if (live?.posting) kb.text("⏹ Stop Posting", `admin_user_stop:${id}:${backPage}`).row();
  if (connected) kb.text("🔌 Disconnect Account", `admin_user_disconnect:${id}:${backPage}`).row();
  kb.text(isUserFrozen(id) ? "🟢 Unfreeze User" : "🧊 Freeze User", isUserFrozen(id) ? `admin_user_unfreeze:${id}:${backPage}` : `admin_user_freeze:${id}:${backPage}`).row();
  kb.text("♻️ Reset Configuration", `admin_user_reset:${id}:${backPage}`).row()
    .text("⬅️ Users", `admin_users:${backPage}`);
  return adminRender(ctx, text, kb);
}
function extendUserAccess(state, duration) {
  if (duration === "lifetime") {
    state.accessLifetime = true;
    state.accessUntil = null;
    state.accessRevoked = false;
  } else {
    const days = Number(duration);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Days must be between 1 and 3650.");
    if (!state.accessLifetime) {
      const base = Math.max(Date.now(), Number(state.accessUntil || 0));
      state.accessUntil = base + days * 86_400_000;
    }
    state.accessRevoked = false;
  }
  saveState(state);
}
async function disconnectPersonalAccount(state, actorUid = state.uid) {
  stopPostingLoop(state);
  cancelLoginAttempt(state.uid, "cancelled");
  let client = state.personalClient;
  if (!client && hasPersonalSession(state.uid)) {
    try { client = await ensurePersonalClient(state); } catch {}
  }
  state.personalClient = null;
  state.personalUsername = "";
  try { await client?.logOut(); } catch {}
  try { await client?.disconnect(); } catch {}
  removePersonalSession(state.uid);
  saveState(state);
  logAdminEvent("account_disconnected", { uid: String(state.uid), actorUid: String(actorUid) });
}
async function showAdminExtend(ctx, uid, backPage = 0) {
  const id = String(uid);
  const state = getAdminSnapshot(id);
  const kb = new InlineKeyboard()
    .text("+1 day", `admin_user_extend_do:${id}:1:${backPage}`).text("+7 days", `admin_user_extend_do:${id}:7:${backPage}`).row()
    .text("+30 days", `admin_user_extend_do:${id}:30:${backPage}`).text("+90 days", `admin_user_extend_do:${id}:90:${backPage}`).row()
    .text("+365 days", `admin_user_extend_do:${id}:365:${backPage}`).text("Lifetime", `admin_user_extend_do:${id}:lifetime:${backPage}`).row()
    .text("✏️ Custom days", `admin_user_extend_custom:${id}:${backPage}`).row()
    .text("⬅️ User", `admin_user:${id}:${backPage}`);
  return adminRender(ctx, `➕ EXTEND ACCESS\n\n${formatAdminUserName(state)}\nCurrent: ${adminAccessStatus(state)}\nExpires: ${formatAccessExpiry(state)}`, kb);
}

function adminKeysKeyboard() {
  const db = loadKeyDb();
  const unused = db.keys.filter(k => !k.revokedAt && !k.redeemedAt).length;
  const redeemed = db.keys.filter(k => k.redeemedAt && !k.revokedAt).length;
  const revoked = db.keys.filter(k => k.revokedAt).length;
  return new InlineKeyboard()
    .text("➕ Generate Key", "admin_key_generate").row()
    .text(`🟢 Unused (${unused})`, "admin_keylist:unused:0").text(`✅ Redeemed (${redeemed})`, "admin_keylist:redeemed:0").row()
    .text(`🚫 Revoked (${revoked})`, "admin_keylist:revoked:0").text("📚 All Keys", "admin_keylist:all:0").row()
    .text("⬅️ Admin", "admin");
}
async function showAdminKeys(ctx) {
  const db = loadKeyDb();
  return adminRender(ctx, `🔑 KEY MANAGEMENT\n\nTotal generated: ${db.keys.length}\nKeys are single-use. Full keys are stored only as SHA-256 hashes after generation.`, adminKeysKeyboard());
}
function keyStatus(record) {
  return record.revokedAt ? "🚫 Revoked" : record.redeemedAt ? "✅ Redeemed" : "🟢 Unused";
}
function keyPlan(record) { return record.lifetime ? "Lifetime" : `${record.durationDays} days`; }
async function showAdminKeyList(ctx, filter = "all", requestedPage = 0) {
  const valid = new Set(["all", "unused", "redeemed", "revoked"]);
  if (!valid.has(filter)) filter = "all";
  let rows = loadKeyDb().keys.slice().reverse();
  if (filter === "unused") rows = rows.filter(k => !k.revokedAt && !k.redeemedAt);
  if (filter === "redeemed") rows = rows.filter(k => k.redeemedAt && !k.revokedAt);
  if (filter === "revoked") rows = rows.filter(k => k.revokedAt);
  const pages = Math.max(1, Math.ceil(rows.length / ADMIN_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
  const start = page * ADMIN_PAGE_SIZE;
  const kb = new InlineKeyboard();
  for (const record of rows.slice(start, start + ADMIN_PAGE_SIZE)) {
    const icon = record.revokedAt ? "🚫" : record.redeemedAt ? "✅" : "🟢";
    kb.text(`${icon} ${record.id} • ${record.lifetime ? "life" : `${record.durationDays}d`}`, `admin_key:${record.id}:${filter}:${page}`).row();
  }
  if (pages > 1) {
    if (page > 0) kb.text("◀️ Prev", `admin_keylist:${filter}:${page - 1}`);
    if (page < pages - 1) kb.text("Next ▶️", `admin_keylist:${filter}:${page + 1}`);
    kb.row();
  }
  kb.text("⬅️ Keys", "admin_keys");
  return adminRender(ctx, `🔑 ${filter.toUpperCase()} KEYS\n\n${rows.length} key(s) • Page ${page + 1}/${pages}`, kb);
}
async function showAdminKeyDetail(ctx, keyId, filter = "all", page = 0) {
  const record = loadKeyDb().keys.find(k => String(k.id) === String(keyId));
  if (!record) return showAdminKeyList(ctx, filter, page);
  const text = [
    "🔑 KEY DETAILS",
    "",
    `ID: ${record.id}`,
    `Hint: ${record.hint}`,
    `Duration: ${keyPlan(record)}`,
    `Status: ${keyStatus(record)}`,
    `Created: ${formatAdminDate(record.createdAt, true)}`,
    `Redeemed: ${formatAdminDate(record.redeemedAt, true)}`,
    `Redeemed by: ${record.redeemedBy || "—"}`,
    `Revoked: ${formatAdminDate(record.revokedAt, true)}`,
    "",
    "The complete key cannot be recovered after generation because only its hash is stored.",
  ].join("\n");
  const kb = new InlineKeyboard();
  if (!record.revokedAt) kb.text("🚫 Revoke Key", `admin_key_revoke:${record.id}:${filter}:${page}`).row();
  kb.text("⬅️ Key List", `admin_keylist:${filter}:${page}`);
  return adminRender(ctx, text, kb);
}
async function generateAdminKey(ctx, duration) {
  const { key, record } = generateLicenseKey(duration);
  const durationLabel = duration === "lifetime" ? "Lifetime" : `${duration} days`;
  logAdminEvent("key_generated", { actorUid: String(ctx.from.id), keyId: record.id, duration: durationLabel });
  const kb = new InlineKeyboard()
    .copyText("📋 Copy key", key).row()
    .text("➕ Generate another", "admin_key_generate").row()
    .text("⬅️ Keys", "admin_keys");
  return adminRender(ctx, `🔑 NEW KEY\n\n${key}\n\nDuration: ${durationLabel}\nID: ${record.id}\nSingle use. This is the only place the full key will be shown.`, kb);
}

async function showAdminActive(ctx, requestedPage = 0) {
  const active = [...states.values()].filter(s => s.posting && !isAdmin(s.uid));
  const pages = Math.max(1, Math.ceil(active.length / ADMIN_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
  const start = page * ADMIN_PAGE_SIZE;
  const kb = new InlineKeyboard();
  for (const state of active.slice(start, start + ADMIN_PAGE_SIZE)) {
    kb.text(`🟢 ${formatAdminUserName(state).slice(0, 26)}`, `admin_user:${state.uid}:0`)
      .text("⏹", `admin_active_stop:${state.uid}:${page}`).row();
  }
  if (active.length) kb.text("🛑 Stop All", "admin_active_stop_all").row();
  if (pages > 1) {
    if (page > 0) kb.text("◀️ Prev", `admin_active:${page - 1}`);
    if (page < pages - 1) kb.text("Next ▶️", `admin_active:${page + 1}`);
    kb.row();
  }
  kb.text("⬅️ Admin", "admin");
  const text = active.length
    ? `▶️ ACTIVE POSTS\n\n${active.length} user(s) currently running.\nPage ${page + 1}/${pages}`
    : "▶️ ACTIVE POSTS\n\nNobody is currently posting.";
  return adminRender(ctx, text, kb);
}
function expiringUserIds(mode) {
  const now = Date.now();
  const ids = customerUserIds();
  if (mode === "expired") {
    return ids.filter(id => {
      const s = getAdminSnapshot(id);
      return !s.accessRevoked && !s.accessLifetime && !!s.accessUntil && s.accessUntil <= now;
    }).sort((a, b) => Number(getAdminSnapshot(b).accessUntil || 0) - Number(getAdminSnapshot(a).accessUntil || 0));
  }
  const days = Number(mode);
  const end = now + days * 86_400_000;
  return ids.filter(id => {
    const s = getAdminSnapshot(id);
    return !s.accessRevoked && !s.accessLifetime && s.accessUntil > now && s.accessUntil <= end;
  }).sort((a, b) => Number(getAdminSnapshot(a).accessUntil || 0) - Number(getAdminSnapshot(b).accessUntil || 0));
}
async function showAdminExpiringMenu(ctx) {
  const kb = new InlineKeyboard()
    .text("Today", "admin_expiring_list:1:0").text("Next 3 days", "admin_expiring_list:3:0").row()
    .text("Next 7 days", "admin_expiring_list:7:0").text("Expired", "admin_expiring_list:expired:0").row()
    .text("⬅️ Admin", "admin");
  return adminRender(ctx, "⏳ EXPIRING ACCESS\n\nChoose a window.", kb);
}
async function showAdminExpiringList(ctx, mode, requestedPage = 0) {
  const ids = expiringUserIds(mode);
  const pages = Math.max(1, Math.ceil(ids.length / ADMIN_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
  const start = page * ADMIN_PAGE_SIZE;
  const kb = new InlineKeyboard();
  for (const id of ids.slice(start, start + ADMIN_PAGE_SIZE)) {
    const s = getAdminSnapshot(id);
    kb.text(`${formatAdminUserName(s).slice(0, 25)} • ${formatAdminDate(s.accessUntil)}`, `admin_user:${id}:0`)
      .text("+30d", `admin_exp_extend:${id}:${mode}:${page}`).row();
  }
  if (pages > 1) {
    if (page > 0) kb.text("◀️ Prev", `admin_expiring_list:${mode}:${page - 1}`);
    if (page < pages - 1) kb.text("Next ▶️", `admin_expiring_list:${mode}:${page + 1}`);
    kb.row();
  }
  kb.text("⬅️ Windows", "admin_expiring");
  const label = mode === "expired" ? "Expired" : `Within ${mode} day${mode === "1" ? "" : "s"}`;
  return adminRender(ctx, `⏳ ${label.toUpperCase()}\n\n${ids.length} user(s) • Page ${page + 1}/${pages}`, kb);
}

async function showAdminStats(ctx) {
  const ids = customerUserIds();
  const snapshots = ids.map(getAdminSnapshot);
  const totalGroups = snapshots.reduce((sum, s) => sum + s.groups.length, 0);
  const totalSent = snapshots.reduce((sum, s) => sum + Number(s.totalSent || 0), 0);
  const now = Date.now();
  const recent = readAdminEvents(5000).filter(e => e.type === "post_cycle" && !isAdmin(e.uid) && now - Number(e.ts || 0) <= 86_400_000);
  const sent24 = recent.reduce((sum, e) => sum + Number(e.success || 0), 0);
  const failed24 = recent.reduce((sum, e) => sum + Number(e.failed || 0), 0);
  const keys = loadKeyDb().keys;
  const redeemed = keys.filter(k => k.redeemedAt).length;
  const text = [
    "📊 TELEPILOT STATISTICS",
    "",
    `Users: ${ids.length}`,
    `Active access: ${snapshots.filter(hasAccess).length}`,
    `Connected personal accounts: ${ids.filter(hasPersonalSession).length}`,
    `Currently posting: ${[...states.values()].filter(s => s.posting && !isAdmin(s.uid)).length}`,
    "",
    `Saved destinations: ${totalGroups}`,
    `Average destinations/user: ${ids.length ? (totalGroups / ids.length).toFixed(1) : "0.0"}`,
    `All-time successful posts: ${totalSent}`,
    `Last 24h cycles: ${recent.length}`,
    `Last 24h sent: ${sent24}`,
    `Last 24h failed: ${failed24}`,
    "",
    `Keys generated: ${keys.length}`,
    `Keys redeemed: ${redeemed}`,
    `Key redemption rate: ${keys.length ? Math.round(redeemed / keys.length * 100) : 0}%`,
  ].join("\n");
  return adminRender(ctx, text, new InlineKeyboard().text("🔄 Refresh", "admin_stats").row().text("⬅️ Admin", "admin"));
}
async function showAdminLogs(ctx, requestedPage = 0) {
  const events = readAdminEvents(160);
  const perPage = 8;
  const pages = Math.max(1, Math.ceil(events.length / perPage));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
  const start = page * perPage;
  const lines = events.slice(start, start + perPage).map(e => `${formatAdminDate(e.ts, true)}\n${adminEventSummary(e)}`);
  const kb = new InlineKeyboard();
  if (pages > 1) {
    if (page > 0) kb.text("◀️ Prev", `admin_logs:${page - 1}`);
    if (page < pages - 1) kb.text("Next ▶️", `admin_logs:${page + 1}`);
    kb.row();
  }
  kb.text("🔄 Refresh", `admin_logs:${page}`).row().text("⬅️ Admin", "admin");
  return adminRender(ctx, `🧾 ACTIVITY & AUDIT LOG\n\n${lines.length ? lines.join("\n\n") : "No events yet."}\n\nPage ${page + 1}/${pages}`, kb);
}

function announcementRecipients(mode) {
  const ids = customerUserIds();
  const now = Date.now();
  if (mode === "active") return ids.filter(id => hasAccess(getAdminSnapshot(id)));
  if (mode === "expiring") return ids.filter(id => {
    const s = getAdminSnapshot(id);
    return !s.accessRevoked && !s.accessLifetime && s.accessUntil > now && s.accessUntil <= now + 7 * 86_400_000;
  });
  return ids;
}
async function showAdminAnnouncement(ctx) {
  const all = announcementRecipients("all").length;
  const active = announcementRecipients("active").length;
  const expiring = announcementRecipients("expiring").length;
  const kb = new InlineKeyboard()
    .text(`👥 All users (${all})`, "admin_announce_target:all").row()
    .text(`✅ Active users (${active})`, "admin_announce_target:active").row()
    .text(`⏳ Expiring ≤7d (${expiring})`, "admin_announce_target:expiring").row()
    .text("⬅️ Admin", "admin");
  return adminRender(ctx, "📢 ANNOUNCEMENT\n\nChoose who should receive the message.", kb);
}
async function runAdminAnnouncement(adminUid, adminChatId, adminMessageId, draft) {
  const recipients = announcementRecipients(draft.mode);
  let sent = 0;
  let failed = 0;
  for (const uid of recipients) {
    try {
      await bot.api.sendMessage(uid, draft.text, draft.entities?.length ? { entities: draft.entities } : {});
      sent++;
    } catch { failed++; }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  logAdminEvent("announcement_sent", { actorUid: String(adminUid), audience: draft.mode, sent, failed });
  adminDrafts.delete(String(adminUid));
  try {
    await bot.api.editMessageText(adminChatId, adminMessageId, `📢 ANNOUNCEMENT COMPLETE\n\nAudience: ${draft.mode}\n✅ Sent: ${sent}\n❌ Failed: ${failed}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Announcements", "admin_announce").row().text("🟣 Admin", "admin").primary(),
    });
  } catch {
    try { await bot.api.sendMessage(adminChatId, `📢 Announcement complete. ${sent} sent, ${failed} failed.`); } catch {}
  }
}
async function showAdminSecurity(ctx) {
  const ids = customerUserIds();
  let eventBytes = 0;
  try { eventBytes = fs.existsSync(ADMIN_EVENT_FILE) ? fs.statSync(ADMIN_EVENT_FILE).size : 0; } catch {}
  const securityEvents = readSecurityEvents(100);
  const frozen = ids.filter(isUserFrozen).length;
  const text = [
    "🔐 SECURITY & ADMIN",
    "",
    `Security lockdown: ${isSecurityLockdown() ? "🛑 ACTIVE" : "🟢 Off"}`,
    `Frozen users: ${frozen}`,
    `Recent security events: ${securityEvents.length}`,
    "",
    `Admins: ${ADMIN_IDS.size}`,
    ...[...ADMIN_IDS].map(id => `• ${id}`),
    "",
    `Active login links: ${loginAttempts.size}`,
    `Stored personal sessions: ${ids.filter(hasPersonalSession).length}`,
    `Audit log size: ${(eventBytes / 1024).toFixed(1)} KB`,
    "",
    "Personal sessions use AES-256-GCM. New/used sessions are migrated to the Railway-held encryption key when possible.",
    "TelePilot never displays bot tokens, API hashes, login codes, 2FA passwords, encryption keys, raw sessions, or security secrets here.",
  ].join("\n");
  const kb = new InlineKeyboard();
  kb.text(isSecurityLockdown() ? "🟢 Disable Lockdown" : "🛑 Enable Lockdown", "admin_security_lockdown").row();
  kb.text("🧾 Security Events", "admin_security_events").row();
  if (loginAttempts.size) kb.text("✖️ Cancel Login Links", "admin_cancel_logins").row();
  kb.text("🔄 Refresh", "admin_security").row().text("⬅️ Admin", "admin");
  return adminRender(ctx, text, kb);
}
async function showAdminSecurityEvents(ctx) {
  const events = readSecurityEvents(8);
  const lines = events.map(event => {
    const when = formatAdminDate(event.ts, true);
    const details = [
      event.uid ? `user ${event.uid}` : "",
      event.actorUid ? `actor ${event.actorUid}` : "",
      event.action ? event.action : "",
    ].filter(Boolean).join(" • ");
    return `${when}\n${event.type}${details ? ` • ${details}` : ""}`;
  });
  return adminRender(
    ctx,
    `🧾 SECURITY EVENTS\n\n${lines.length ? lines.join("\n\n") : "No security events yet."}`,
    new InlineKeyboard().text("🔄 Refresh", "admin_security_events").row().text("⬅️ Security", "admin_security"),
  );
}

async function handleAdminAwaitingText(ctx, state) {
  const mode = state.awaiting;
  if (!String(mode || "").startsWith("admin_")) return false;
  const text = String(ctx.message?.text || "").trim();
  if (mode === "admin_user_search") {
    const normalized = text.replace(/^@/, "").toLowerCase();
    const ids = customerUserIds();
    let found = /^\d+$/.test(text) && ids.includes(text) ? text : null;
    if (!found && normalized) {
      found = ids.find(id => String(getAdminSnapshot(id).telegramUsername || "").toLowerCase() === normalized) || null;
    }
    clearAwaiting(state);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!found) {
      await ctx.reply("❌ User not found. Search by Telegram ID, or by a username TelePilot has seen since this admin update.");
      return true;
    }
    await showAdminUser(ctx, found, 0);
    return true;
  }
  if (mode === "admin_key_custom_days") {
    const days = Number(text);
    clearAwaiting(state);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      await ctx.reply("❌ Enter a whole number from 1 to 3650, or use Lifetime.");
      return true;
    }
    await generateAdminKey(ctx, days);
    return true;
  }
  if (mode === "admin_user_extend_custom") {
    const draft = adminDrafts.get(String(state.uid));
    const days = Number(text);
    clearAwaiting(state);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!draft?.targetUid || !Number.isInteger(days) || days < 1 || days > 3650) {
      adminDrafts.delete(String(state.uid));
      await ctx.reply("❌ Enter a whole number from 1 to 3650.");
      return true;
    }
    const target = getState(draft.targetUid);
    extendUserAccess(target, days);
    logAdminEvent("access_extended", { actorUid: String(state.uid), uid: String(target.uid), duration: `${days}d` });
    adminDrafts.delete(String(state.uid));
    await showAdminUser(ctx, target.uid, draft.backPage || 0);
    return true;
  }
  if (mode === "admin_announcement_text") {
    const draft = adminDrafts.get(String(state.uid));
    const promptChatId = state.awaitingPromptChatId || ctx.chat.id;
    const promptMessageId = state.awaitingPromptMessageId;
    clearAwaiting(state);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!draft || !text) {
      adminDrafts.delete(String(state.uid));
      await ctx.reply("❌ Announcement cancelled because the message was empty.");
      return true;
    }
    draft.text = ctx.message.text;
    draft.entities = sanitizeBotEntities(ctx.message.entities || []);
    adminDrafts.set(String(state.uid), draft);
    authorizeSensitiveCallback(state.uid, "admin_announce_confirm");
    try {
      await bot.api.editMessageText(promptChatId, promptMessageId, `📢 ANNOUNCEMENT READY\n\nAudience: ${draft.mode}\nRecipients: ${announcementRecipients(draft.mode).length}\nMessage length: ${draft.text.length} characters\n\nThe message you sent was deleted from this chat. Confirm below to send it.`, {
        reply_markup: new InlineKeyboard().text("✅ Send", "admin_announce_confirm").success().text("✖️ Cancel", "admin_announce").row().text("👁 Preview", "admin_announce_preview"),
      });
    } catch {
      await ctx.reply("Announcement ready.", { reply_markup: new InlineKeyboard().text("✅ Send", "admin_announce_confirm").success().text("✖️ Cancel", "admin_announce") });
    }
    return true;
  }
  return false;
}

bot.command("admin", async ctx => {
  if (!privateOnly(ctx) || !isAdmin(ctx.from?.id)) return;
  await showAdmin(ctx);
});
bot.callbackQuery("admin", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdmin(ctx);
});
bot.callbackQuery(/^admin_users:(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminUsers(ctx, Number(ctx.match[1]));
});
bot.callbackQuery("admin_user_search", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const state = stateFromCtx(ctx);
  state.awaiting = "admin_user_search";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  await ctx.editMessageText("🔎 SEARCH USERS\n\nSend a Telegram user ID or a known @username.", { reply_markup: new InlineKeyboard().text("⬅️ Cancel", "admin_users:0") });
});
bot.callbackQuery(/^admin_user:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminUser(ctx, ctx.match[1], Number(ctx.match[2]));
});
bot.callbackQuery(/^admin_user_extend:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminExtend(ctx, ctx.match[1], Number(ctx.match[2]));
});
bot.callbackQuery(/^admin_user_extend_do:(\d+):(\d+|lifetime):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getState(ctx.match[1]);
  const duration = ctx.match[2] === "lifetime" ? "lifetime" : Number(ctx.match[2]);
  extendUserAccess(target, duration);
  logAdminEvent("access_extended", { actorUid: String(ctx.from.id), uid: String(target.uid), duration: duration === "lifetime" ? "lifetime" : `${duration}d` });
  await showAdminUser(ctx, target.uid, Number(ctx.match[3]));
});
bot.callbackQuery(/^admin_user_extend_custom:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const state = stateFromCtx(ctx);
  state.awaiting = "admin_user_extend_custom";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  adminDrafts.set(String(state.uid), { targetUid: ctx.match[1], backPage: Number(ctx.match[2]) });
  await ctx.editMessageText("✏️ CUSTOM EXTENSION\n\nSend the number of days (1–3650).", { reply_markup: new InlineKeyboard().text("⬅️ Cancel", `admin_user:${ctx.match[1]}:${ctx.match[2]}`) });
});
bot.callbackQuery(/^admin_user_revoke:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getAdminSnapshot(ctx.match[1]);
  await adminRender(ctx, `🔒 REVOKE ACCESS\n\nRevoke TelePilot access for ${formatAdminUserName(target)}? Posting will be stopped immediately.`, new InlineKeyboard().text("🔒 Confirm Revoke", `admin_user_revoke_confirm:${ctx.match[1]}:${ctx.match[2]}`).danger().row().text("⬅️ Cancel", `admin_user:${ctx.match[1]}:${ctx.match[2]}`));
});
bot.callbackQuery(/^admin_user_revoke_confirm:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getState(ctx.match[1]);
  target.accessRevoked = true;
  stopPostingLoop(target);
  saveState(target);
  logAdminEvent("access_revoked", { actorUid: String(ctx.from.id), uid: String(target.uid) });
  await showAdminUser(ctx, target.uid, Number(ctx.match[2]));
});
bot.callbackQuery(/^admin_user_restore:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getState(ctx.match[1]);
  target.accessRevoked = false;
  saveState(target);
  logAdminEvent("access_restored", { actorUid: String(ctx.from.id), uid: String(target.uid) });
  await showAdminUser(ctx, target.uid, Number(ctx.match[2]));
});
bot.callbackQuery(/^admin_user_stop:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getState(ctx.match[1]);
  stopPostingLoop(target);
  logAdminEvent("posting_stopped_admin", { actorUid: String(ctx.from.id), uid: String(target.uid) });
  await showAdminUser(ctx, target.uid, Number(ctx.match[2]));
});
bot.callbackQuery(/^admin_user_disconnect:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getAdminSnapshot(ctx.match[1]);
  await adminRender(ctx, `🔌 DISCONNECT ACCOUNT\n\nDisconnect the stored personal Telegram account for ${formatAdminUserName(target)}?`, new InlineKeyboard().text("🔌 Confirm Disconnect", `admin_user_disconnect_confirm:${ctx.match[1]}:${ctx.match[2]}`).danger().row().text("⬅️ Cancel", `admin_user:${ctx.match[1]}:${ctx.match[2]}`));
});
bot.callbackQuery(/^admin_user_disconnect_confirm:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getState(ctx.match[1]);
  await disconnectPersonalAccount(target, ctx.from.id);
  await showAdminUser(ctx, target.uid, Number(ctx.match[2]));
});
bot.callbackQuery(/^admin_user_reset:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getAdminSnapshot(ctx.match[1]);
  await adminRender(ctx, `♻️ RESET CONFIGURATION\n\nClear ${formatAdminUserName(target)}'s saved message, destinations and interval settings? Access and the connected personal account will be kept.`, new InlineKeyboard().text("♻️ Confirm Reset", `admin_user_reset_confirm:${ctx.match[1]}:${ctx.match[2]}`).danger().row().text("⬅️ Cancel", `admin_user:${ctx.match[1]}:${ctx.match[2]}`));
});
bot.callbackQuery(/^admin_user_reset_confirm:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getState(ctx.match[1]);
  stopPostingLoop(target);
  target.adMessage = "";
  target.adEntities = [];
  target.groups = [];
  target.intervalMinutes = 30;
  target.lastRunAt = null;
  target.lastCycleSuccess = 0;
  target.lastCycleFailed = 0;
  saveState(target);
  logAdminEvent("user_reset", { actorUid: String(ctx.from.id), uid: String(target.uid) });
  await showAdminUser(ctx, target.uid, Number(ctx.match[2]));
});

bot.callbackQuery("admin_keys", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminKeys(ctx);
});
bot.callbackQuery("admin_key_generate", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const kb = new InlineKeyboard()
    .text("1 day", "admin_key_gen:1").text("3 days", "admin_key_gen:3").row()
    .text("7 days", "admin_key_gen:7").text("30 days", "admin_key_gen:30").row()
    .text("90 days", "admin_key_gen:90").text("365 days", "admin_key_gen:365").row()
    .text("Lifetime", "admin_key_gen:lifetime").text("✏️ Custom", "admin_key_custom").row()
    .text("⬅️ Keys", "admin_keys");
  await adminRender(ctx, "➕ GENERATE KEY\n\nChoose a duration.", kb);
});
bot.callbackQuery(/^admin_key_gen:(\d+|lifetime)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const duration = ctx.match[1] === "lifetime" ? "lifetime" : Number(ctx.match[1]);
  await generateAdminKey(ctx, duration);
});
bot.callbackQuery("admin_key_custom", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const state = stateFromCtx(ctx);
  state.awaiting = "admin_key_custom_days";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  await ctx.editMessageText("✏️ CUSTOM KEY\n\nSend the number of access days (1–3650).", { reply_markup: new InlineKeyboard().text("⬅️ Cancel", "admin_key_generate") });
});
bot.callbackQuery(/^admin_keylist:(all|unused|redeemed|revoked):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminKeyList(ctx, ctx.match[1], Number(ctx.match[2]));
});
bot.callbackQuery(/^admin_key:([a-f0-9]+):(all|unused|redeemed|revoked):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminKeyDetail(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3]));
});
bot.callbackQuery(/^admin_key_revoke:([a-f0-9]+):(all|unused|redeemed|revoked):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const record = loadKeyDb().keys.find(k => String(k.id) === String(ctx.match[1]));
  if (!record) return showAdminKeys(ctx);
  await adminRender(ctx, `🚫 REVOKE KEY\n\nRevoke key ${record.id}?${record.redeemedBy ? " If this is the user's current key, their access will also be revoked." : ""}`, new InlineKeyboard().text("🚫 Confirm Revoke", `admin_key_revoke_confirm:${record.id}:${ctx.match[2]}:${ctx.match[3]}`).danger().row().text("⬅️ Cancel", `admin_key:${record.id}:${ctx.match[2]}:${ctx.match[3]}`));
});
bot.callbackQuery(/^admin_key_revoke_confirm:([a-f0-9]+):(all|unused|redeemed|revoked):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const result = revokeKey(ctx.match[1]);
  if (result.ok) logAdminEvent("key_revoked", { actorUid: String(ctx.from.id), uid: result.record.redeemedBy || undefined, keyId: result.record.id });
  await showAdminKeyDetail(ctx, ctx.match[1], ctx.match[2], Number(ctx.match[3]));
});

bot.callbackQuery(/^admin_active:(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminActive(ctx, Number(ctx.match[1]));
});
bot.callbackQuery(/^admin_active_stop:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getState(ctx.match[1]);
  stopPostingLoop(target);
  logAdminEvent("posting_stopped_admin", { actorUid: String(ctx.from.id), uid: String(target.uid) });
  await showAdminActive(ctx, Number(ctx.match[2]));
});
bot.callbackQuery("admin_active_stop_all", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const count = [...states.values()].filter(s => s.posting && !isAdmin(s.uid)).length;
  await adminRender(ctx, `🛑 STOP ALL POSTING\n\nStop all ${count} currently running TelePilot posting loop(s)?`, new InlineKeyboard().text("🛑 Confirm Stop All", "admin_active_stop_all_confirm").danger().row().text("⬅️ Cancel", "admin_active:0"));
});
bot.callbackQuery("admin_active_stop_all_confirm", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  let count = 0;
  for (const state of states.values()) {
    if (!state.posting || isAdmin(state.uid)) continue;
    stopPostingLoop(state);
    count++;
  }
  logAdminEvent("posting_stopped_all", { actorUid: String(ctx.from.id), count });
  await showAdminActive(ctx, 0);
});

bot.callbackQuery("admin_expiring", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminExpiringMenu(ctx);
});
bot.callbackQuery(/^admin_expiring_list:(1|3|7|expired):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminExpiringList(ctx, ctx.match[1], Number(ctx.match[2]));
});
bot.callbackQuery(/^admin_exp_extend:(\d+):(1|3|7|expired):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getState(ctx.match[1]);
  extendUserAccess(target, 30);
  logAdminEvent("access_extended", { actorUid: String(ctx.from.id), uid: String(target.uid), duration: "30d" });
  await showAdminExpiringList(ctx, ctx.match[2], Number(ctx.match[3]));
});

bot.callbackQuery("admin_stats", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminStats(ctx);
});
bot.callbackQuery(/^admin_logs:(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminLogs(ctx, Number(ctx.match[1]));
});

bot.callbackQuery("admin_announce", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const state = stateFromCtx(ctx);
  clearAwaiting(state);
  adminDrafts.delete(String(state.uid));
  await showAdminAnnouncement(ctx);
});
bot.callbackQuery(/^admin_announce_target:(all|active|expiring)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const state = stateFromCtx(ctx);
  state.awaiting = "admin_announcement_text";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  adminDrafts.set(String(state.uid), { mode: ctx.match[1] });
  await ctx.editMessageText(`📢 NEW ANNOUNCEMENT\n\nAudience: ${ctx.match[1]} (${announcementRecipients(ctx.match[1]).length} users)\n\nSend the announcement message now. Telegram text formatting will be preserved.`, { reply_markup: new InlineKeyboard().text("⬅️ Cancel", "admin_announce") });
});
bot.callbackQuery("admin_announce_preview", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const draft = adminDrafts.get(String(ctx.from.id));
  if (!draft?.text) return showAdminAnnouncement(ctx);
  try { await ctx.reply(draft.text, draft.entities?.length ? { entities: draft.entities } : {}); } catch { await ctx.reply(draft.text); }
});
bot.callbackQuery("admin_announce_confirm", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const draft = adminDrafts.get(String(ctx.from.id));
  if (!draft?.text) return showAdminAnnouncement(ctx);
  const messageId = ctx.callbackQuery.message?.message_id;
  const chatId = ctx.chat.id;
  await ctx.editMessageText(`📢 SENDING ANNOUNCEMENT…\n\nAudience: ${draft.mode}\nRecipients: ${announcementRecipients(draft.mode).length}\n\nThis page will update when sending finishes.`);
  void runAdminAnnouncement(ctx.from.id, chatId, messageId, draft);
});

bot.callbackQuery(/^admin_user_freeze:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getAdminSnapshot(ctx.match[1]);
  await adminRender(
    ctx,
    `🧊 FREEZE USER\n\nFreeze ${formatAdminUserName(target)}? Posting will stop immediately and configuration, imports, reconnects and new posting starts will be blocked.`,
    new InlineKeyboard()
      .text("🧊 Confirm Freeze", `admin_user_freeze_confirm:${ctx.match[1]}:${ctx.match[2]}`).danger()
      .row().text("⬅️ Cancel", `admin_user:${ctx.match[1]}:${ctx.match[2]}`),
  );
});
bot.callbackQuery(/^admin_user_freeze_confirm:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getState(ctx.match[1]);
  stopPostingLoop(target);
  setUserFrozen(target.uid, true, ctx.from.id);
  await showAdminUser(ctx, target.uid, Number(ctx.match[2]));
});
bot.callbackQuery(/^admin_user_unfreeze:(\d+):(\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  setUserFrozen(ctx.match[1], false, ctx.from.id);
  await showAdminUser(ctx, ctx.match[1], Number(ctx.match[2]));
});

bot.callbackQuery("admin_security", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminSecurity(ctx);
});
bot.callbackQuery("admin_security_events", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminSecurityEvents(ctx);
});
bot.callbackQuery("admin_security_lockdown", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const enabling = !isSecurityLockdown();
  await adminRender(
    ctx,
    `${enabling ? "🛑 ENABLE" : "🟢 DISABLE"} SECURITY LOCKDOWN\n\n${enabling ? "New logins, key redemption, imports and new posting starts will be blocked for customers." : "Normal customer security-sensitive actions will be restored."}`,
    new InlineKeyboard()
      .text(enabling ? "🛑 Confirm Lockdown" : "🟢 Confirm Disable", "admin_security_lockdown_confirm").danger()
      .row().text("⬅️ Cancel", "admin_security"),
  );
});
bot.callbackQuery("admin_security_lockdown_confirm", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  setSecurityLockdown(!isSecurityLockdown(), ctx.from.id);
  await showAdminSecurity(ctx);
});

bot.callbackQuery("admin_cancel_logins", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const count = loginAttempts.size;
  await adminRender(ctx, `✖️ CANCEL LOGIN LINKS\n\nInvalidate all ${count} active personal-account login link(s)?`, new InlineKeyboard().text("✖️ Confirm", "admin_cancel_logins_confirm").danger().row().text("⬅️ Cancel", "admin_security"));
});
bot.callbackQuery("admin_cancel_logins_confirm", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const attempts = [...loginAttempts.values()];
  for (const attempt of attempts) cancelLoginAttempt(attempt.uid, "cancelled");
  logAdminEvent("login_links_cancelled", { actorUid: String(ctx.from.id), count: attempts.length });
  await showAdminSecurity(ctx);
});
// ===== END TELEPILOT ADMIN PANEL =====

bot.command("start", async ctx => {
  if (!privateOnly(ctx)) return;
  const state = stateFromCtx(ctx);
  if (!hasAccess(state)) return showAccess(ctx, state, true);
  await showHome(ctx, state);
});
bot.command("genkey", async ctx => {
  if (!privateOnly(ctx) || !isAdmin(ctx.from?.id)) return;
  const parts = String(ctx.message?.text || "").trim().split(/\s+/);
  const arg = parts[1]?.toLowerCase();
  const boundTo = parts[2] || null;
  let duration;
  if (arg === "lifetime") duration = "lifetime";
  else if (/^\d+$/.test(arg || "")) {
    const days = Number(arg);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return ctx.reply("Usage: /genkey 30 [TelegramID], /genkey 90 [TelegramID], or /genkey lifetime [TelegramID]");
    }
    duration = days;
  } else {
    return ctx.reply("Usage: /genkey 30 [TelegramID], /genkey 90 [TelegramID], or /genkey lifetime [TelegramID]");
  }
  if (boundTo && !/^\d+$/.test(boundTo)) return ctx.reply("The optional bound Telegram ID must be numeric.");
  const { key, record } = generateLicenseKey(duration, boundTo);
  logAdminEvent("key_generated", {
    actorUid: String(ctx.from.id),
    keyId: record.id,
    duration: duration === "lifetime" ? "lifetime" : `${duration}d`,
  });
  appendSecurityEvent("key_generated", { actorUid: String(ctx.from.id), keyId: record.id, bound: !!record.boundTo });
  await ctx.reply(
    `🔑 New ${duration === "lifetime" ? "lifetime" : `${duration}-day`} key\n\n${key}\n\nID: ${record.id}\n${record.boundTo ? `Bound to Telegram ID: ${record.boundTo}\n` : ""}Single use. The full key is shown only in this message.`,
    { reply_markup: new InlineKeyboard().copyText("📋 Copy key", key) },
  );
});

bot.command("keys", async ctx => {
  if (!privateOnly(ctx) || !isAdmin(ctx.from?.id)) return;
  const db = loadKeyDb();
  const rows = db.keys.slice(-25).reverse();
  if (!rows.length) return ctx.reply("No keys generated yet.");
  const activeUnused = db.keys.filter(k => !k.revokedAt && !k.redeemedAt).length;
  const redeemed = db.keys.filter(k => !!k.redeemedAt && !k.revokedAt).length;
  const text = rows.map(k => {
    const status = k.revokedAt ? "🚫 revoked" : k.redeemedAt ? "✅ redeemed" : "🟢 unused";
    const plan = k.lifetime ? "lifetime" : `${k.durationDays}d`;
    return `${k.id} • ${plan} • ${status} • ${k.hint}`;
  }).join("\n");
  await ctx.reply(`🔑 KEYS\n\nUnused: ${activeUnused}\nRedeemed: ${redeemed}\n\nLatest:\n${text}\n\nRevoke with /revoke <key or ID>`);
});
bot.command("revoke", async ctx => {
  if (!privateOnly(ctx) || !isAdmin(ctx.from?.id)) return;
  const arg = String(ctx.message?.text || "").trim().split(/\s+/).slice(1).join(" ");
  if (!arg) return ctx.reply("Usage: /revoke <key or key ID>");
  const result = revokeKey(arg);
  if (!result.ok) return ctx.reply(result.error);
  logAdminEvent("key_revoked", { actorUid: String(ctx.from.id), uid: result.record.redeemedBy || undefined, keyId: result.record.id });
  await ctx.reply(`🚫 Key ${result.record.id} revoked${result.record.redeemedBy ? ". The linked user's current access was revoked too." : "."}`);
});

bot.command("addhere", async ctx => {
  if (!ctx.from || !ctx.chat || !["group", "supergroup"].includes(ctx.chat.type)) return;
  const state = getState(ctx.from.id);
  if (!hasAccess(state)) return ctx.reply("Your TelePilot access is inactive. Redeem a key in private chat first.");

  let ownerMember;
  try { ownerMember = await bot.api.getChatMember(ctx.chat.id, ctx.from.id); }
  catch { return ctx.reply("I couldn't verify your group permissions."); }
  if (hasPersonalSession(state.uid)) {
    if (["left", "kicked"].includes(ownerMember.status)
      || (ownerMember.status === "restricted" && ownerMember.can_send_messages !== true)) {
      return ctx.reply("Your connected personal account does not currently have permission to post in this group.");
    }
  } else if (!["creator", "administrator"].includes(ownerMember.status)) {
    return ctx.reply("Only a group admin can link this group when using TelePilot Bot as the sender.");
  }

  if (!hasPersonalSession(state.uid)) {
    let botMember;
    try { botMember = await bot.api.getChatMember(ctx.chat.id, BOT_USER_ID); }
    catch { return ctx.reply("I couldn't verify TelePilot's permissions in this group."); }
    if (botMember.status !== "administrator") {
      return ctx.reply("Make @TelePilottBot an admin in this group first.");
    }
  }

  const destination = {
    id: String(ctx.chat.id),
    label: String(ctx.chat.title || ctx.chat.id).slice(0, 120),
    type: ctx.chat.type,
    username: ctx.chat.username ? `@${ctx.chat.username}` : "",
  };
  if (!state.groups.some(g => g.id === destination.id)) {
    state.groups.push(destination);
    saveState(state);
  }
  await ctx.reply(`✅ ${destinationLabel(destination)} added to your TelePilot profile.`);
});

bot.use(async (ctx, next) => {
  if (!privateOnly(ctx) || !ctx.from) return next();
  const state = getState(ctx.from.id);
  if (isAdmin(ctx.from.id) || hasAccess(state)) return next();
  const data = ctx.callbackQuery?.data;
  const text = ctx.message?.text || "";
  if (data === "redeem_key" || data === "access") return next();
  if (state.awaiting === "license_key" && ctx.message?.text) return next();
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return next();
  if (ctx.callbackQuery) {
    try { await ctx.answerCallbackQuery({ text: "Redeem an access key first.", show_alert: true }); } catch {}
    return showAccess(ctx, state, true);
  }
  return showAccess(ctx, state, true);
});

bot.callbackQuery("access", async ctx => {
  await ctx.answerCallbackQuery();
  await showAccess(ctx, stateFromCtx(ctx));
});
bot.callbackQuery("redeem_key", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  state.awaiting = "license_key";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  await ctx.editMessageText(
    "🔑 REDEEM KEY\n\nSend your TelePilot access key below.\
\
Need a key? Message @noahxrp to get yours.\n\nExample: TP-XXXXX-XXXXX-XXXXX-XXXXX",
    { reply_markup: new InlineKeyboard().text("⬅️ Cancel", "access") },
  );
});
bot.callbackQuery("home", async ctx => {
  await ctx.answerCallbackQuery();
  await showHome(ctx, stateFromCtx(ctx));
});

bot.callbackQuery("account", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  clearAwaiting(state);
  if (hasPersonalSession(state.uid)) {
    await ensurePersonalClient(state);
    return ctx.editMessageText(
      `👤 PERSONAL ACCOUNT\n\n✅ Connected${state.personalUsername ? ` as @${state.personalUsername}` : ""}\n\nTelePilot will post using this account while it is connected.`,
      {
        reply_markup: new InlineKeyboard()
          .text("🔌 Disconnect account", "account_disconnect")
          .row()
          .text("⬅️ Back", "home"),
      },
    );
  }
  return ctx.editMessageText(
    "👤 PERSONAL ACCOUNT\n\nConnect a personal Telegram account so scheduled posts are sent from that account instead of @TelePilottBot.\n\nYour phone number is deleted from the bot chat after use. Login code and 2FA are entered on the secure TelePilot page.",
    {
      reply_markup: new InlineKeyboard()
        .text("📱 Connect personal account", "account_phone")
        .row()
        .text("⬅️ Back", "home"),
    },
  );
});
bot.callbackQuery("account_phone", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  state.awaiting = "phone";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  await ctx.editMessageText(
    "📱 CONNECT ACCOUNT\n\nSend the phone number for the Telegram account you want to connect, including country code.\n\nExample: +37120000000",
    { reply_markup: new InlineKeyboard().text("⬅️ Cancel", "account") },
  );
});
bot.callbackQuery("account_disconnect", async ctx => {
  const state = stateFromCtx(ctx);
  await ctx.answerCallbackQuery({ text: "Disconnecting…" });
  await disconnectPersonalAccount(state, state.uid);
  await showHome(ctx, state);
});

bot.callbackQuery("message", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  clearAwaiting(state);
  const kb = new InlineKeyboard();
  if (state.adMessage) kb.text("👁 Preview", "message_preview").text("✏️ Change", "message_change").row();
  else kb.text("➕ Set message", "message_change").row();
  kb.text("⬅️ Back", "home");
  await ctx.editMessageText(
    `📝 AD MESSAGE\n\n${state.adMessage ? `✅ Saved • ${state.adMessage.length} characters` : "❌ No message set yet."}`,
    { reply_markup: kb },
  );
});
bot.callbackQuery("message_change", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  state.awaiting = "message";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  await ctx.editMessageText(
    "✏️ SET AD MESSAGE\n\nSend the message you want TelePilot to post. Telegram formatting is preserved.",
    { reply_markup: new InlineKeyboard().text("⬅️ Cancel", "message") },
  );
});
bot.callbackQuery("message_preview", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  const kb = new InlineKeyboard().text("✏️ Change", "message_change").row().text("⬅️ Back", "message");
  if (!state.adMessage) return ctx.editMessageText("No message set.", { reply_markup: kb });
  try {
    await ctx.editMessageText(state.adMessage, {
      reply_markup: kb,
      ...(state.adEntities.length ? { entities: state.adEntities } : {}),
    });
  } catch {
    await ctx.editMessageText(state.adMessage, { reply_markup: kb });
  }
});

bot.callbackQuery("groups", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  clearAwaiting(state);
  await showGroups(ctx, state);
});
bot.callbackQuery("add_group", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  state.awaiting = "group";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  const instructions = hasPersonalSession(state.uid)
    ? "➕ ADD DESTINATION\n\n1. Make sure your connected personal account is already in the group/channel.\n2. For channels, that account needs permission to post.\n3. Send the public @username or t.me link here.\n\n@TelePilottBot does not need to be an admin for public destinations in personal-account mode. For private groups without a public username, /addhere can still be used."
    : "➕ ADD DESTINATION\n\n1. Add @TelePilottBot as an admin in the group/channel.\n2. For channels, give it permission to post.\n3. Send the public @username or t.me link here.\n\nFor groups without a public username, send /addhere inside that group while you are an admin.";
  await ctx.editMessageText(
    instructions,
    { reply_markup: new InlineKeyboard().text("⬅️ Cancel", "groups") },
  );
});
bot.callbackQuery("remove_group_menu", async ctx => {
  await ctx.answerCallbackQuery();
  await showRemoveGroupPage(ctx, stateFromCtx(ctx), 0);
});
bot.callbackQuery(/^remove_group_menu:(\d+)$/, async ctx => {
  await ctx.answerCallbackQuery();
  await showRemoveGroupPage(ctx, stateFromCtx(ctx), Number(ctx.match[1]));
});
bot.callbackQuery(/^remove_group:(\d+):(\d+)$/, async ctx => {
  const state = stateFromCtx(ctx);
  const i = Number(ctx.match[1]);
  const page = Number(ctx.match[2]);
  if (!Number.isInteger(i) || i < 0 || i >= state.groups.length) {
    return ctx.answerCallbackQuery({ text: "That destination is no longer in your list." });
  }
  const [removed] = state.groups.splice(i, 1);
  if (state.posting && !state.groups.length) stopPostingLoop(state);
  saveState(state);
  await ctx.answerCallbackQuery({ text: `Removed ${destinationLabel(removed)}` });
  if (state.groups.length) await showRemoveGroupPage(ctx, state, page);
  else await showGroups(ctx, state);
});
bot.callbackQuery("clear_groups", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  authorizeSensitiveCallback(state.uid, "clear_groups_confirm");
  await ctx.editMessageText(
    `🗑 CLEAR DESTINATIONS\n\nRemove all ${state.groups.length} saved destinations?`,
    {
      reply_markup: new InlineKeyboard()
        .text("⚠️ Yes, clear all", "clear_groups_confirm")
        .row()
        .text("⬅️ Cancel", "groups"),
    },
  );
});
bot.callbackQuery("clear_groups_confirm", async ctx => {
  const state = stateFromCtx(ctx);
  if (!consumeSensitiveCallback(state.uid, "clear_groups_confirm")) return ctx.answerCallbackQuery({ text: "This confirmation expired. Open Clear all again.", show_alert: true });
  state.groups = [];
  stopPostingLoop(state);
  saveState(state);
  await ctx.answerCallbackQuery({ text: "Destinations cleared" });
  await showGroups(ctx, state);
});

bot.callbackQuery("interval", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  const kb = new InlineKeyboard()
    .text("1m", "i1").text("5m", "i5").text("10m", "i10").row()
    .text("15m", "i15").text("30m", "i30").text("45m", "i45").row()
    .text("1h", "i60").text("1h 30m", "i90").text("2h", "i120").row()
    .text("⬅️ Back", "home");
  await ctx.editMessageText(
    `⏱ INTERVAL\n\nCurrent: ${formatInterval(state.intervalMinutes)}\n\nChoose how often TelePilot should post.`,
    { reply_markup: kb },
  );
});
for (const minutes of INTERVAL_VALUES) {
  bot.callbackQuery(`i${minutes}`, async ctx => {
    const state = stateFromCtx(ctx);
    state.intervalMinutes = minutes;
    saveState(state);
    if (state.posting) scheduleNextCycle(state);
    await ctx.answerCallbackQuery({ text: `Set to ${formatInterval(minutes)}` });
    await showHome(ctx, state);
  });
}

bot.callbackQuery("activity", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  await ctx.editMessageText(
    [
      "📊 ACTIVITY",
      "",
      `Status: ${state.posting ? "🟢 Running" : "⚪ Stopped"}`,
      `Posting as: ${accountLabel(state)}`,
      `Total successful posts: ${state.totalSent}`,
      `Last cycle: ${formatAgo(state.lastRunAt)}`,
      `Last result: ${state.lastRunAt ? `✅ ${state.lastCycleSuccess} sent • ❌ ${state.lastCycleFailed} failed` : "No runs yet"}`,
      `Next cycle: ${state.posting ? formatUntil(state) : "—"}`,
    ].join("\n"),
    { reply_markup: new InlineKeyboard().text("🔄 Refresh", "activity").row().text("⬅️ Back", "home") },
  );
});
bot.callbackQuery("start", async ctx => {
  const state = stateFromCtx(ctx);
  if (!hasAccess(state)) return ctx.answerCallbackQuery({ text: "Your TelePilot access is inactive.", show_alert: true });
  if (state.posting) return ctx.answerCallbackQuery({ text: "TelePilot is already running." });
  if (!state.adMessage) return ctx.answerCallbackQuery({ text: "Set an ad message first.", show_alert: true });
  if (!state.groups.length) return ctx.answerCallbackQuery({ text: "Add at least one group/channel first.", show_alert: true });
  if (hasPersonalSession(state.uid) && !(await ensurePersonalClient(state))) {
    return ctx.answerCallbackQuery({ text: "Reconnect your personal Telegram account first.", show_alert: true });
  }
  await ctx.answerCallbackQuery();
  const sender = hasPersonalSession(state.uid)
    ? (state.personalUsername ? `@${state.personalUsername}` : "your personal account")
    : `@${botInfo.username}`;
  authorizeSensitiveCallback(state.uid, "start_confirm");
  await ctx.editMessageText(
    `▶️ START TELEPILOT\n\nPosting as: ${sender}\nDestinations: ${state.groups.length}\nInterval: ${formatInterval(state.intervalMinutes)}\n\nTelePilot will post once immediately, then continue on your selected interval.`,
    { reply_markup: new InlineKeyboard().text("▶️ Confirm start", "start_confirm").row().text("⬅️ Cancel", "home") },
  );
});
bot.callbackQuery("start_confirm", async ctx => {
  const state = stateFromCtx(ctx);
  if (!consumeSensitiveCallback(state.uid, "start_confirm")) return ctx.answerCallbackQuery({ text: "This confirmation expired. Open Start again.", show_alert: true });
  await ctx.answerCallbackQuery({ text: "Starting…" });
  if (!hasAccess(state) || !state.adMessage || !state.groups.length) return showHome(ctx, state);
  if (hasPersonalSession(state.uid) && !(await ensurePersonalClient(state))) return showHome(ctx, state);
  startPostingLoop(state);
  logAdminEvent("posting_started", { uid: String(state.uid) });
  await showHome(ctx, state);
});
bot.callbackQuery("stop", async ctx => {
  const state = stateFromCtx(ctx);
  const was = state.posting;
  if (was) {
    stopPostingLoop(state);
    logAdminEvent("posting_stopped", { uid: String(state.uid) });
  }
  await ctx.answerCallbackQuery({ text: was ? "TelePilot stopped" : "TelePilot is already stopped." });
  if (was) await showHome(ctx, state);
});

bot.on("message:text", async ctx => {
  if (!privateOnly(ctx)) return;
  const state = stateFromCtx(ctx);
  if (state && isAdmin(state.uid) && String(state.awaiting || "").startsWith("admin_")) {
    if (await handleAdminAwaitingText(ctx, state)) return;
  }
  if (!state?.awaiting) return;

  if (state.awaiting === "license_key") {
    const pm = state.awaitingPromptMessageId;
    const pc = state.awaitingPromptChatId || ctx.chat.id;
    const result = redeemLicenseKey(state, ctx.message.text);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!result.ok) {
      const n = await ctx.reply(`❌ ${result.error}\n\nSend a valid key or tap Cancel.`);
      setTimeout(() => void safeDelete(ctx.chat.id, n.message_id), 8000);
      return;
    }
    clearAwaiting(state);
    const plan = result.record.lifetime ? "Lifetime" : `${result.record.durationDays} days`;
    await autoDeleteNotice(ctx.chat.id, `✅ Key redeemed. ${plan} of TelePilot access activated.`, 8000);
    if (!(await editDashboard(pc, pm, state))) {
      await ctx.reply(dashboard(state), { reply_markup: mainKeyboard(state) });
    }
    return;
  }

  if (!hasAccess(state)) return showAccess(ctx, state, true);

  if (state.awaiting === "phone") {
    const phone = cleanPhone(ctx.message.text);
    const pm = state.awaitingPromptMessageId;
    const pc = state.awaitingPromptChatId || ctx.chat.id;
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!phone) {
      const n = await ctx.reply("❌ Send a valid phone number including country code, for example +37120000000.");
      setTimeout(() => void safeDelete(ctx.chat.id, n.message_id), 7000);
      return;
    }
    clearAwaiting(state);
    try {
      const login = await beginPersonalLogin(state.uid, phone);
      const delivery = login.isCodeViaApp
        ? "Telegram chose in-app delivery for the login code."
        : "Telegram requested a login code.";
      const text = `📩 LOGIN CODE REQUESTED\n\n${delivery}\n\nOpen the secure page below to enter the code and 2FA password if Telegram asks for it.`;
      const kb = new InlineKeyboard()
        .url("🔐 Enter login code securely", login.url)
        .row()
        .text("✖️ Cancel login", "account_cancel_login")
        .row()
        .text("⬅️ Back", "account");
      try { await bot.api.editMessageText(pc, pm, text, { reply_markup: kb }); }
      catch { await ctx.reply(text, { reply_markup: kb }); }
    } catch (err) {
      const n = await ctx.reply(`❌ ${err?.message || "Could not start Telegram login."}`);
      setTimeout(() => void safeDelete(ctx.chat.id, n.message_id), 10000);
      await showHome(ctx, state);
    }
    return;
  }

  if (state.awaiting === "message") {
    const pm = state.awaitingPromptMessageId;
    const pc = state.awaitingPromptChatId || ctx.chat.id;
    state.adMessage = ctx.message.text;
    state.adEntities = sanitizeBotEntities(ctx.message.entities || []);
    clearAwaiting(state);
    saveState(state);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!(await editDashboard(pc, pm, state))) {
      await ctx.reply(dashboard(state), { reply_markup: mainKeyboard(state) });
    }
    return;
  }

  if (state.awaiting === "group") {
    const target = normalizeTarget(ctx.message.text);
    if (!target) {
      const personalHint = hasPersonalSession(state.uid)
        ? "Send a public @username or t.me/username link. Private groups without a public username can still use /addhere."
        : "Send a public @username or t.me/username link. For private groups, use /addhere inside the group.";
      const n = await ctx.reply(`I couldn't read that. ${personalHint}`);
      setTimeout(() => void safeDelete(ctx.chat.id, n.message_id), 8000);
      return;
    }
    let destination;
    try { destination = await resolveDestination(target, state.uid); }
    catch (err) {
      const n = await ctx.reply(`❌ ${err?.message || "TelePilot cannot post there yet."}`);
      setTimeout(() => void safeDelete(ctx.chat.id, n.message_id), 10000);
      return;
    }
    const pm = state.awaitingPromptMessageId;
    const pc = state.awaitingPromptChatId || ctx.chat.id;
    if (!state.groups.some(g => g.id === destination.id)) state.groups.push(destination);
    clearAwaiting(state);
    saveState(state);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!(await editDashboard(pc, pm, state))) {
      await ctx.reply(dashboard(state), { reply_markup: mainKeyboard(state) });
    }
  }
});

bot.callbackQuery("account_cancel_login", async ctx => {
  const state = stateFromCtx(ctx);
  cancelLoginAttempt(state.uid, "cancelled");
  await ctx.answerCallbackQuery({ text: "Login cancelled" });
  await showHome(ctx, state);
});

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers?.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}
function connectCookie(token, maxAge = 600) {
  return `__Host-telepilot_connect=${encodeURIComponent(token || "")}; Path=/; Max-Age=${Math.max(0, maxAge)}; HttpOnly; Secure; SameSite=Strict`;
}
function authAttemptFromRequest(req, fallbackToken = "") {
  const cookieToken = readCookies(req)["__Host-telepilot_connect"] || "";
  return getAttemptByBrowserToken(cookieToken) || getAttemptByToken(fallbackToken);
}
function enforceHttpRate(req, res, scope, limit, windowMs) {
  const rate = takeRateLimit(scope, requestAddress(req), limit, windowMs);
  if (rate.ok) return true;
  res.setHeader("retry-after", String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
  sendJson(res, 429, { error: "Too many requests. Try again later." });
  return false;
}

const healthServer = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", PUBLIC_URL);

    if (req.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/health")) {
      return sendJson(res, 200, { ok: true, service: "TelePilot", mode: "key-plus-personal-account" });
    }

    if (req.method === "GET" && requestUrl.pathname === "/connect") {
      if (!enforceHttpRate(req, res, "http-connect", 30, 10 * 60_000)) return;
      const urlToken = requestUrl.searchParams.get("token") || "";
      if (urlToken) {
        const attempt = getAttemptByToken(urlToken);
        if (!attempt) {
          res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          return res.end("<h1>TelePilot link expired</h1><p>Return to the bot and start account connection again.</p>");
        }
        attempt.token = "";
        const browserToken = rotateBrowserToken(attempt);
        res.writeHead(303, {
          location: "/connect",
          "set-cookie": connectCookie(browserToken),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        return res.end();
      }
      const attempt = authAttemptFromRequest(req);
      if (!attempt) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end("<h1>TelePilot link expired</h1><p>Return to the bot and start account connection again.</p>");
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
      });
      return res.end(htmlPage(""));
    }

    if (req.method === "GET" && requestUrl.pathname === "/auth/status") {
      if (!enforceHttpRate(req, res, "http-auth-status", 900, 10 * 60_000)) return;
      const attempt = authAttemptFromRequest(req, requestUrl.searchParams.get("token") || "");
      if (!attempt) return sendJson(res, 410, { error: "This login link expired." });
      return sendJson(res, 200, {
        stage: attempt.stage,
        error: attempt.error || "",
        isCodeViaApp: attempt.isCodeViaApp,
      });
    }

    if (req.method === "POST" && requestUrl.pathname === "/auth/code") {
      if (!enforceHttpRate(req, res, "http-auth-code", 12, 10 * 60_000)) return;
      const body = await readJsonBody(req, 8_192);
      const attempt = authAttemptFromRequest(req, body.token);
      if (!attempt) return sendJson(res, 410, { error: "This login link expired." });
      const userRate = takeRateLimit("auth-code-user", attempt.uid, 8, 10 * 60_000);
      if (!userRate.ok) return sendJson(res, 429, { error: "Too many login attempts. Start the connection again later." });
      try {
        await submitLoginCode(attempt, body.code);
        if (attempt.stage === "password") res.setHeader("set-cookie", connectCookie(rotateBrowserToken(attempt)));
        if (attempt.stage === "done") res.setHeader("set-cookie", connectCookie("", 0));
        return sendJson(res, 200, { stage: attempt.stage, error: attempt.error || "" });
      } catch (err) {
        return sendJson(res, 400, { stage: attempt.stage, error: err?.message || "Login could not be completed." });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/auth/password") {
      if (!enforceHttpRate(req, res, "http-auth-password", 12, 10 * 60_000)) return;
      const body = await readJsonBody(req, 8_192);
      const attempt = authAttemptFromRequest(req, body.token);
      if (!attempt) return sendJson(res, 410, { error: "This login link expired." });
      const userRate = takeRateLimit("auth-password-user", attempt.uid, 8, 10 * 60_000);
      if (!userRate.ok) return sendJson(res, 429, { error: "Too many login attempts. Start the connection again later." });
      try {
        await submitLoginPassword(attempt, body.password);
        if (attempt.stage === "done") res.setHeader("set-cookie", connectCookie("", 0));
        return sendJson(res, 200, { stage: attempt.stage, error: attempt.error || "" });
      } catch (err) {
        return sendJson(res, 400, { stage: attempt.stage, error: err?.message || "Login could not be completed." });
      }
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.warn("HTTP request failed:", err?.message || err);
    return sendJson(res, 400, { error: "Bad request" });
  }
});

healthServer.listen(PORT, "0.0.0.0", () => console.log(`TelePilot web/health server listening on port ${PORT}`));

const loginSweep = setInterval(() => {
  const now = Date.now();
  for (const attempt of [...loginAttempts.values()]) {
    if (now - attempt.createdAt > LOGIN_TTL_MS) cancelLoginAttempt(attempt.uid, "expired");
  }
}, 60_000);
loginSweep.unref?.();

const idleSweep = setInterval(() => {
  const cutoff = Date.now() - IDLE_STATE_MS;
  for (const [key, state] of states) {
    if (state.posting || state.awaiting || state.cyclePromise || state.personalRestorePromise || state.lastTouchedAt > cutoff) continue;
    const client = state.personalClient;
    state.personalClient = null;
    states.delete(key);
    if (client) void client.disconnect().catch(() => {});
  }
}, 10 * 60_000);
idleSweep.unref?.();

bot.catch(err => console.error("Bot error:", err.error));
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`TelePilot shutting down (${signal})…`);
  clearInterval(loginSweep);
  clearInterval(idleSweep);
  try { bot.stop(); } catch {}
  for (const attempt of [...loginAttempts.values()]) cancelLoginAttempt(attempt.uid, "shutdown");
  for (const state of states.values()) {
    stopPostingLoop(state);
    try { await state.cyclePromise; } catch {}
    try { await state.personalClient?.disconnect(); } catch {}
  }
  await new Promise(resolve => healthServer.close(resolve));
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`TelePilot v0.5 personal-account mode starting with ${ADMIN_IDS.size} admin profile(s)…`);
await bot.start({ onStart: info => console.log(`Control bot running as @${info.username}`) });