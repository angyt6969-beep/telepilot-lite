from pathlib import Path

P = Path("app.js")
source = P.read_text()
MARKER = "TELEPILOT_SECURITY_PACK_V1"


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def replace_section(text, start, end, replacement, label):
    a = text.find(start)
    if a < 0:
        raise RuntimeError(f"{label}: start marker not found")
    b = text.find(end, a + len(start))
    if b < 0:
        raise RuntimeError(f"{label}: end marker not found")
    return text[:a] + replacement.rstrip() + "\n\n" + text[b:]


if MARKER in source:
    print("app.js security migration already applied")
    raise SystemExit(0)

source = replace_once(
    source,
    'import { StringSession } from "teleproto/sessions/index.js";\n',
    r'''import { StringSession } from "teleproto/sessions/index.js";
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
''',
    "security imports",
)

source = replace_once(
    source,
    'const loginAttempts = new Map();\n',
    r'''const loginAttempts = new Map();

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
''',
    "security helpers",
)

source = replace_section(
    source,
    "function loadKeyDb() {",
    "function getSessionEncryptionKey() {",
    r'''function loadKeyDb() {
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
}''',
    "license subsystem",
)

source = replace_section(
    source,
    "function getSessionEncryptionKey() {",
    "const bot = new Bot(BOT_TOKEN);",
    r'''const EXTERNAL_SESSION_ENCRYPTION_KEY = getExternalSessionKey();
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
}''',
    "session encryption subsystem",
)

source = replace_once(
    source,
    '  logAdminEvent("account_connected", { uid: String(state.uid) });\n',
    r'''  logAdminEvent("account_connected", { uid: String(state.uid) });
  appendSecurityEvent("account_connected", { uid: String(state.uid) });
  void notifySecurityAdmins(`A personal Telegram account was connected for user ${state.uid}.`);
''',
    "connected account security event",
)

source = replace_section(
    source,
    "async function beginPersonalLogin(uid, phone) {",
    "function accessKeyboard(active) {",
    r'''async function beginPersonalLogin(uid, phone) {
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
}''',
    "login subsystem",
)

middleware_start = '''bot.use(async (ctx, next) => {
  if (ctx.from && ctx.chat?.type === "private") syncUserIdentity(ctx, getState(ctx.from.id));'''
source = replace_section(
    source,
    middleware_start,
    "// ===== TELEPILOT ADMIN PANEL =====",
    r'''bot.use(async (ctx, next) => {
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
});''',
    "base middleware",
)

source = replace_section(
    source,
    "async function adminRender(ctx, text, keyboard) {",
    "function adminMainKeyboard() {",
    r'''async function adminRender(ctx, text, keyboard) {
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
}''',
    "admin authorization",
)

source = replace_once(
    source,
    '    `Access: ${adminAccessStatus(state)}`,\n',
    '    `Access: ${adminAccessStatus(state)}`,\n    `Security: ${isUserFrozen(id) ? "🧊 Frozen" : "🟢 Normal"}`,\n',
    "admin user security status",
)
source = replace_once(
    source,
    '  if (connected) kb.text("🔌 Disconnect Account", `admin_user_disconnect:${id}:${backPage}`).row();\n  kb.text("♻️ Reset Configuration", `admin_user_reset:${id}:${backPage}`).row()\n',
    '  if (connected) kb.text("🔌 Disconnect Account", `admin_user_disconnect:${id}:${backPage}`).row();\n  kb.text(isUserFrozen(id) ? "🟢 Unfreeze User" : "🧊 Freeze User", isUserFrozen(id) ? `admin_user_unfreeze:${id}:${backPage}` : `admin_user_freeze:${id}:${backPage}`).row();\n  kb.text("♻️ Reset Configuration", `admin_user_reset:${id}:${backPage}`).row()\n',
    "freeze button",
)

source = replace_section(
    source,
    "async function showAdminSecurity(ctx) {",
    "async function handleAdminAwaitingText(ctx, state) {",
    r'''async function showAdminSecurity(ctx) {
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

async function handleAdminAwaitingText(ctx, state) {''',
    "security admin page",
)

source = replace_once(
    source,
    '    adminDrafts.set(String(state.uid), draft);\n    try {\n',
    '    adminDrafts.set(String(state.uid), draft);\n    authorizeSensitiveCallback(state.uid, "admin_announce_confirm");\n    try {\n',
    "announcement replay authorization",
)

source = replace_once(
    source,
    'bot.callbackQuery("admin_security", async ctx => {\n',
    r'''bot.callbackQuery(/^admin_user_freeze:(\d+):(\d+)$/, async ctx => {
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
''',
    "freeze handlers",
)

source = replace_once(
    source,
    'bot.callbackQuery("admin_cancel_logins", async ctx => {\n',
    r'''bot.callbackQuery("admin_security_events", async ctx => {
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
''',
    "lockdown handlers",
)

source = replace_section(
    source,
    'bot.command("genkey", async ctx => {',
    'bot.command("keys", async ctx => {',
    r'''bot.command("genkey", async ctx => {
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
});''',
    "genkey command",
)

source = replace_once(
    source,
    '  await ctx.editMessageText(\n    `▶️ START TELEPILOT\\n\\nPosting as: ${sender}\\nDestinations: ${state.groups.length}\\nInterval: ${formatInterval(state.intervalMinutes)}\\n\\nTelePilot will post once immediately, then continue on your selected interval.`,\n',
    '  authorizeSensitiveCallback(state.uid, "start_confirm");\n  await ctx.editMessageText(\n    `▶️ START TELEPILOT\\n\\nPosting as: ${sender}\\nDestinations: ${state.groups.length}\\nInterval: ${formatInterval(state.intervalMinutes)}\\n\\nTelePilot will post once immediately, then continue on your selected interval.`,\n',
    "start confirmation authorization",
)
source = replace_once(
    source,
    'bot.callbackQuery("start_confirm", async ctx => {\n  const state = stateFromCtx(ctx);\n  await ctx.answerCallbackQuery({ text: "Starting…" });\n',
    'bot.callbackQuery("start_confirm", async ctx => {\n  const state = stateFromCtx(ctx);\n  if (!consumeSensitiveCallback(state.uid, "start_confirm")) return ctx.answerCallbackQuery({ text: "This confirmation expired. Open Start again.", show_alert: true });\n  await ctx.answerCallbackQuery({ text: "Starting…" });\n',
    "start replay protection",
)
source = replace_once(
    source,
    'bot.callbackQuery("clear_groups", async ctx => {\n  await ctx.answerCallbackQuery();\n  const state = stateFromCtx(ctx);\n',
    'bot.callbackQuery("clear_groups", async ctx => {\n  await ctx.answerCallbackQuery();\n  const state = stateFromCtx(ctx);\n  authorizeSensitiveCallback(state.uid, "clear_groups_confirm");\n',
    "clear authorization",
)
source = replace_once(
    source,
    'bot.callbackQuery("clear_groups_confirm", async ctx => {\n  const state = stateFromCtx(ctx);\n  state.groups = [];\n',
    'bot.callbackQuery("clear_groups_confirm", async ctx => {\n  const state = stateFromCtx(ctx);\n  if (!consumeSensitiveCallback(state.uid, "clear_groups_confirm")) return ctx.answerCallbackQuery({ text: "This confirmation expired. Open Clear all again.", show_alert: true });\n  state.groups = [];\n',
    "clear replay protection",
)

source = replace_section(
    source,
    "const healthServer = http.createServer(async (req, res) => {",
    'healthServer.listen(PORT, "0.0.0.0", () => console.log(`TelePilot web/health server listening on port ${PORT}`));',
    r'''function readCookies(req) {
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
  const cookieToken = readCookies(req).__Host-telepilot_connect || "";
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
});''',
    "HTTP auth server",
)

P.write_text(source)
print("app.js security migration applied")
