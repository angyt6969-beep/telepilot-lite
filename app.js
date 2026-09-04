import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import bigInt from "big-integer";
import { Bot, InlineKeyboard } from "grammy";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
const INTERVAL_VALUES = [1, 5, 10, 15, 30, 45, 60, 90, 120];
const MAX_GROUPS = 100;
const REMOVE_PAGE_SIZE = 8;
const POST_GAP_MS = 1500;
const IDLE_STATE_MS = 30 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const KEY_FILE = path.join(DATA_DIR, "access-keys.json");
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const LEGACY_SETTINGS_FILE = path.join(DATA_DIR, "telepilot-settings.json");
const SESSION_KEY_FILE = path.join(DATA_DIR, ".personal-session-key");

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!API_ID) throw new Error("Missing API_ID");
if (!API_HASH) throw new Error("Missing API_HASH");
if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL/RAILWAY_PUBLIC_DOMAIN");

fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_DIR = path.join(DATA_DIR, "users");
fs.mkdirSync(USERS_DIR, { recursive: true });
const states = new Map();
const loginAttempts = new Map();

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
    if (out.length >= MAX_GROUPS) break;
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
  const db = readJson(KEY_FILE, { version: 1, keys: [] });
  return { version: 1, keys: Array.isArray(db.keys) ? db.keys : [] };
}
function saveKeyDb(db) { writeJsonAtomic(KEY_FILE, { version: 1, keys: db.keys }); }
function normalizeKey(value) { return String(value || "").trim().toUpperCase().replace(/\s+/g, ""); }
function hashKey(value) { return crypto.createHash("sha256").update(normalizeKey(value)).digest("hex"); }
function randomKeySegment(length = 4) {
  let out = "";
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  return out;
}
function generateLicenseKey(duration) {
  const db = loadKeyDb();
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = `TP-${randomKeySegment()}-${randomKeySegment()}-${randomKeySegment()}`;
    const keyHash = hashKey(key);
    if (db.keys.some(item => item.hash === keyHash)) continue;
    const record = {
      id: crypto.randomBytes(4).toString("hex"),
      hash: keyHash,
      hint: `${key.slice(0, 7)}-••••-••••`,
      durationDays: duration === "lifetime" ? null : duration,
      lifetime: duration === "lifetime",
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
  const normalized = normalizeKey(rawKey);
  if (!/^TP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalized)) {
    return { ok: false, error: "That key format is invalid." };
  }
  const db = loadKeyDb();
  const record = db.keys.find(item => item.hash === hashKey(normalized));
  if (!record || record.revokedAt) return { ok: false, error: "That key is invalid or has been revoked." };
  if (record.redeemedAt) return { ok: false, error: "That key has already been redeemed." };
  record.redeemedAt = Date.now();
  record.redeemedBy = String(state.uid);
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
  return { ok: true, record };
}
function revokeKey(identifier) {
  const value = normalizeKey(identifier);
  const db = loadKeyDb();
  const record = /^TP-/.test(value)
    ? db.keys.find(item => item.hash === hashKey(value))
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

function getSessionEncryptionKey() {
  try {
    if (fs.existsSync(SESSION_KEY_FILE)) {
      const raw = fs.readFileSync(SESSION_KEY_FILE);
      if (raw.length === 32) return raw;
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(SESSION_KEY_FILE, key, { mode: 0o600 });
    return key;
  } catch (err) {
    throw new Error(`Could not initialize personal session encryption key: ${err?.message || err}`);
  }
}
const SESSION_ENCRYPTION_KEY = getSessionEncryptionKey();

function encryptSession(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SESSION_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}
function decryptSession(payload) {
  const parsed = JSON.parse(payload);
  if (parsed?.v !== 1) throw new Error("Unsupported session format");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    SESSION_ENCRYPTION_KEY,
    Buffer.from(parsed.iv, "base64"),
  );
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
  return decryptSession(fs.readFileSync(personalSessionFile(uid), "utf8"));
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
    phone,
    client,
    stage: "starting",
    error: "",
    createdAt: Date.now(),
    phoneCodeHash: "",
    isCodeViaApp: false,
  };
  loginAttempts.set(String(uid), attempt);
  try {
    await client.connect();
    const sent = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    attempt.phoneCodeHash = sent.phoneCodeHash;
    attempt.isCodeViaApp = sent.isCodeViaApp === true;
    attempt.stage = "code";
    return {
      url: `${PUBLIC_URL.replace(/\/+$/, "")}/connect?token=${encodeURIComponent(token)}`,
      isCodeViaApp: attempt.isCodeViaApp,
    };
  } catch (err) {
    attempt.error = cleanAuthError(err);
    attempt.stage = "error";
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

async function submitLoginCode(attempt, code) {
  if (attempt.stage !== "code") return;
  const value = String(code || "").replace(/\D/g, "");
  if (!/^\d{3,10}$/.test(value)) throw new Error("Enter the numeric Telegram login code.");
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
    throw new Error(attempt.error);
  }
}

async function submitLoginPassword(attempt, password) {
  if (attempt.stage !== "password") return;
  const value = String(password || "");
  if (!value) throw new Error("Enter your Telegram 2FA password.");
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
    throw new Error(attempt.error);
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
    : "🔐 TELEPILOT ACCESS\n\nRedeem a valid access key to use TelePilot.";
  const opts = { reply_markup: accessKeyboard(hasAccess(state)) };
  try {
    if (ctx.callbackQuery?.message) await ctx.editMessageText(text, opts);
    else await ctx.reply(text, opts);
  } catch {
    await ctx.reply(text, opts);
  }
  if (locked) stopPostingLoop(state);
}
function mainKeyboard() {
  return new InlineKeyboard()
    .text("👤 Account", "account").text("📝 Message", "message").row()
    .text("👥 Groups", "groups").text("⏱ Interval", "interval").row()
    .text("▶️ START", "start").text("⏹ STOP", "stop").row()
    .text("📊 Activity", "activity").text("🔑 Access", "access").row()
    .text("🔄 Refresh", "home");
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
  const opts = { reply_markup: mainKeyboard() };
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
    await bot.api.editMessageText(chatId, messageId, dashboard(state), { reply_markup: mainKeyboard() });
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
async function resolveDestination(target, ownerUid) {
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
  return state.groups.length
    ? state.groups.map((g, i) => `${i + 1}. ${destinationLabel(g)}`).join("\n")
    : "No destinations added.";
}
function groupsKeyboard(state) {
  const kb = new InlineKeyboard().text("➕ Add destination", "add_group");
  if (state.groups.length) kb.text("➖ Remove", "remove_group_menu");
  kb.row();
  if (state.groups.length) kb.text("🗑 Clear all", "clear_groups").row();
  return kb.text("⬅️ Back", "home");
}
async function showGroups(ctx, state) {
  await ctx.editMessageText(
    `👥 GROUPS & CHANNELS\n\n${groupList(state)}\n\nAdd @TelePilottBot as an admin in each destination first. In a group, you can also send /addhere while you are a group admin.`,
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
  if (ctx.callbackQuery && ctx.chat && ctx.chat.type !== "private") {
    try { await ctx.answerCallbackQuery({ text: "Use TelePilot controls in a private chat." }); } catch {}
    return;
  }
  await next();
});

bot.command("start", async ctx => {
  if (!privateOnly(ctx)) return;
  const state = stateFromCtx(ctx);
  if (!hasAccess(state)) return showAccess(ctx, state, true);
  await showHome(ctx, state);
});
bot.command("genkey", async ctx => {
  if (!privateOnly(ctx) || !isAdmin(ctx.from?.id)) return;
  const arg = String(ctx.message?.text || "").trim().split(/\s+/)[1]?.toLowerCase();
  let duration;
  if (arg === "lifetime") duration = "lifetime";
  else if (/^\d+$/.test(arg || "")) {
    const days = Number(arg);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return ctx.reply("Usage: /genkey 30, /genkey 90, or /genkey lifetime");
    }
    duration = days;
  } else {
    return ctx.reply("Usage: /genkey 30, /genkey 90, or /genkey lifetime");
  }
  const { key, record } = generateLicenseKey(duration);
  await ctx.reply(`🔑 New ${duration === "lifetime" ? "lifetime" : `${duration}-day`} key\n\n${key}\n\nID: ${record.id}\nSingle use. The full key is shown only in this message.`);
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
  await ctx.reply(`🚫 Key ${result.record.id} revoked${result.record.redeemedBy ? ". The linked user's current access was revoked too." : "."}`);
});

bot.command("addhere", async ctx => {
  if (!ctx.from || !ctx.chat || !["group", "supergroup"].includes(ctx.chat.type)) return;
  const state = getState(ctx.from.id);
  if (!hasAccess(state)) return ctx.reply("Your TelePilot access is inactive. Redeem a key in private chat first.");

  let ownerMember;
  try { ownerMember = await bot.api.getChatMember(ctx.chat.id, ctx.from.id); }
  catch { return ctx.reply("I couldn't verify your group permissions."); }
  if (!["creator", "administrator"].includes(ownerMember.status)) {
    return ctx.reply("Only a group admin can link this group to their TelePilot profile.");
  }

  let botMember;
  try { botMember = await bot.api.getChatMember(ctx.chat.id, BOT_USER_ID); }
  catch { return ctx.reply("I couldn't verify TelePilot's permissions in this group."); }
  if (botMember.status !== "administrator") {
    return ctx.reply("Make @TelePilottBot an admin in this group first.");
  }

  const destination = {
    id: String(ctx.chat.id),
    label: String(ctx.chat.title || ctx.chat.id).slice(0, 120),
    type: ctx.chat.type,
    username: ctx.chat.username ? `@${ctx.chat.username}` : "",
  };
  if (!state.groups.some(g => g.id === destination.id)) {
    if (state.groups.length >= MAX_GROUPS) return ctx.reply(`You reached the ${MAX_GROUPS}-destination limit.`);
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
    "🔑 REDEEM KEY\n\nSend your TelePilot access key.\n\nExample: TP-XXXX-XXXX-XXXX",
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
  stopPostingLoop(state);
  cancelLoginAttempt(state.uid, "cancelled");
  const client = state.personalClient;
  state.personalClient = null;
  state.personalUsername = "";
  try { await client?.logOut(); } catch {}
  try { await client?.disconnect(); } catch {}
  removePersonalSession(state.uid);
  saveState(state);
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
  if (state.groups.length >= MAX_GROUPS) {
    return ctx.editMessageText(
      `👥 GROUPS & CHANNELS\n\nYou reached the ${MAX_GROUPS}-destination limit.`,
      { reply_markup: new InlineKeyboard().text("➖ Remove", "remove_group_menu").row().text("⬅️ Back", "groups") },
    );
  }
  state.awaiting = "group";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  await ctx.editMessageText(
    "➕ ADD DESTINATION\n\n1. Add @TelePilottBot as an admin in the group/channel.\n2. For channels, give it permission to post.\n3. Send the public @username or t.me link here.\n\nFor groups without a public username, send /addhere inside that group while you are an admin.",
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
  await ctx.editMessageText(
    `▶️ START TELEPILOT\n\nPosting as: ${sender}\nDestinations: ${state.groups.length}\nInterval: ${formatInterval(state.intervalMinutes)}\n\nTelePilot will post once immediately, then continue on your selected interval.`,
    { reply_markup: new InlineKeyboard().text("▶️ Confirm start", "start_confirm").row().text("⬅️ Cancel", "home") },
  );
});
bot.callbackQuery("start_confirm", async ctx => {
  const state = stateFromCtx(ctx);
  await ctx.answerCallbackQuery({ text: "Starting…" });
  if (!hasAccess(state) || !state.adMessage || !state.groups.length) return showHome(ctx, state);
  if (hasPersonalSession(state.uid) && !(await ensurePersonalClient(state))) return showHome(ctx, state);
  startPostingLoop(state);
  await showHome(ctx, state);
});
bot.callbackQuery("stop", async ctx => {
  const state = stateFromCtx(ctx);
  const was = state.posting;
  if (was) stopPostingLoop(state);
  await ctx.answerCallbackQuery({ text: was ? "TelePilot stopped" : "TelePilot is already stopped." });
  if (was) await showHome(ctx, state);
});

bot.on("message:text", async ctx => {
  if (!privateOnly(ctx)) return;
  const state = stateFromCtx(ctx);
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
      await ctx.reply(dashboard(state), { reply_markup: mainKeyboard() });
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
      await ctx.reply(dashboard(state), { reply_markup: mainKeyboard() });
    }
    return;
  }

  if (state.awaiting === "group") {
    const target = normalizeTarget(ctx.message.text);
    if (!target) {
      const n = await ctx.reply("I couldn't read that. Send a public @username or t.me/username link. For private groups, use /addhere inside the group.");
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
    if (state.groups.length >= MAX_GROUPS && !state.groups.some(g => g.id === destination.id)) {
      clearAwaiting(state);
      await safeDelete(ctx.chat.id, ctx.message.message_id);
      await autoDeleteNotice(ctx.chat.id, `You reached the ${MAX_GROUPS}-destination limit.`);
      return showHome(ctx, state);
    }
    const pm = state.awaitingPromptMessageId;
    const pc = state.awaitingPromptChatId || ctx.chat.id;
    if (!state.groups.some(g => g.id === destination.id)) state.groups.push(destination);
    clearAwaiting(state);
    saveState(state);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!(await editDashboard(pc, pm, state))) {
      await ctx.reply(dashboard(state), { reply_markup: mainKeyboard() });
    }
  }
});

bot.callbackQuery("account_cancel_login", async ctx => {
  const state = stateFromCtx(ctx);
  cancelLoginAttempt(state.uid, "cancelled");
  await ctx.answerCallbackQuery({ text: "Login cancelled" });
  await showHome(ctx, state);
});

const healthServer = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", PUBLIC_URL);

    if (req.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/health")) {
      return sendJson(res, 200, { ok: true, service: "TelePilot", mode: "key-plus-personal-account" });
    }

    if (req.method === "GET" && requestUrl.pathname === "/connect") {
      const token = requestUrl.searchParams.get("token") || "";
      const attempt = getAttemptByToken(token);
      if (!attempt) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end("<h1>TelePilot link expired</h1><p>Return to the bot and start account connection again.</p>");
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      return res.end(htmlPage(token));
    }

    if (req.method === "GET" && requestUrl.pathname === "/auth/status") {
      const attempt = getAttemptByToken(requestUrl.searchParams.get("token") || "");
      if (!attempt) return sendJson(res, 410, { error: "This login link expired." });
      return sendJson(res, 200, {
        stage: attempt.stage,
        error: attempt.error || "",
        isCodeViaApp: attempt.isCodeViaApp,
      });
    }

    if (req.method === "POST" && requestUrl.pathname === "/auth/code") {
      const body = await readJsonBody(req);
      const attempt = getAttemptByToken(body.token);
      if (!attempt) return sendJson(res, 410, { error: "This login link expired." });
      try {
        await submitLoginCode(attempt, body.code);
        return sendJson(res, 200, { stage: attempt.stage, error: attempt.error || "" });
      } catch (err) {
        return sendJson(res, 400, { stage: attempt.stage, error: err?.message || "Login code failed." });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/auth/password") {
      const body = await readJsonBody(req);
      const attempt = getAttemptByToken(body.token);
      if (!attempt) return sendJson(res, 410, { error: "This login link expired." });
      try {
        await submitLoginPassword(attempt, body.password);
        return sendJson(res, 200, { stage: attempt.stage, error: attempt.error || "" });
      } catch (err) {
        return sendJson(res, 400, { stage: attempt.stage, error: err?.message || "2FA failed." });
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