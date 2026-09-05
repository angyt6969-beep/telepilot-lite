import fs from "node:fs";

function assertContains(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Security migration could not find ${label}`);
}

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`Security migration could not find ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`Security migration found multiple ${label} matches`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Security migration could not find start of ${label}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Security migration could not find end of ${label}`);
  return source.slice(0, start) + replacement.trimEnd() + "\n\n" + source.slice(end);
}

function patchApp(source) {
  if (source.includes("TELEPILOT_SECURITY_PACK_V1")) return source;

  source = replaceOnce(
    source,
    'import { StringSession } from "teleproto/sessions/index.js";\n',
    'import { StringSession } from "teleproto/sessions/index.js";\nimport {\n  appendSecurityEvent,\n  getExternalSessionKey,\n  isSecurityLockdown,\n  isUserFrozen,\n  legacyLicenseHash,\n  licenseRecordMatches,\n  normalizeLicenseKey,\n  readSecurityEvents,\n  requestAddress,\n  resetRateLimit,\n  secureLicenseHash,\n  setSecurityLockdown,\n  setUserFrozen,\n  takeRateLimit,\n  installConsoleRedaction,\n} from "./security-core.js";\n',
    "app security import",
  );

  source = replaceOnce(
    source,
    'const loginAttempts = new Map();\n',
    `const loginAttempts = new Map();

// TELEPILOT_SECURITY_PACK_V1
installConsoleRedaction();
const sensitiveCallbacks = new Map();

function sensitiveCallbackKey(uid, data) { return \`${"${String(uid || \"\")}"}:\${String(data || "")}\`; }
function authorizeSensitiveCallback(uid, data, ttlMs = 120_000) {
  if (!uid || !data) return;
  sensitiveCallbacks.set(sensitiveCallbackKey(uid, data), Date.now() + Math.min(300_000, Math.max(10_000, Number(ttlMs || 120_000))));
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
    try { await bot.api.sendMessage(Number(id), \`🛡 TelePilot Security\\n\\n\${message}\`); } catch {}
  }
}
function rateLimitMessage(result) {
  const seconds = Math.max(1, Math.ceil(Number(result?.retryAfterMs || 0) / 1000));
  return \`Too many attempts. Try again in about \${seconds < 60 ? `${"${seconds}"} seconds` : `${"${Math.ceil(seconds / 60)} minutes`}\`.\`;
}
`,
    "security helper insertion",
  );

  source = replaceSection(
    source,
    "function loadKeyDb() {",
    "function getSessionEncryptionKey() {",
    `function loadKeyDb() {
  const db = readJson(KEY_FILE, { version: 2, keys: [] });
  return { version: 2, keys: Array.isArray(db.keys) ? db.keys : [] };
}
function saveKeyDb(db) { writeJsonAtomic(KEY_FILE, { version: 2, keys: db.keys }); }
function normalizeKey(value) { return normalizeLicenseKey(value); }
function hashKey(value, version = 2) { return Number(version) >= 2 ? secureLicenseHash(value) : legacyLicenseHash(value); }
function randomKeySegment(length = 5) {
  let out = "";
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  return out;
}
function generateLicenseKey(duration, boundTo = null) {
  const db = loadKeyDb();
  const boundUid = boundTo == null || boundTo === "" ? null : String(boundTo);
  if (boundUid && !/^\\d+$/.test(boundUid)) throw new Error("Bound Telegram ID must be numeric");
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = \`TP-\${randomKeySegment()}-\${randomKeySegment()}-\${randomKeySegment()}-\${randomKeySegment()}\`;
    const keyHash = hashKey(key, 2);
    if (db.keys.some(item => item.hash === keyHash)) continue;
    const record = {
      id: crypto.randomBytes(5).toString("hex"),
      hash: keyHash,
      hashVersion: 2,
      hint: \`\${key.slice(0, 8)}-•••••-•••••-•••••\`,
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
    void notifySecurityAdmins(\`Repeated access-key attempts were blocked for Telegram user \${uid}.\`);
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
    appendSecurityEvent("key_redeem_failed", { uid, reason: record?.boundTo && String(record.boundTo) !== uid ? "bound_mismatch" : "unusable" });
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
  logAdminEvent("key_redeemed", { uid, keyId: record.id, duration: record.lifetime ? "lifetime" : \`\${record.durationDays}d\` });
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
}`,
    "license key subsystem",
  );

  source = replaceSection(
    source,
    "function getSessionEncryptionKey() {",
    "const bot = new Bot(BOT_TOKEN);",
    `const EXTERNAL_SESSION_ENCRYPTION_KEY = getExternalSessionKey();
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
    throw new Error(\`Could not initialize personal session encryption key: \${err?.message || err}\`);
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
  const temp = \`\${file}.\${process.pid}.\${Date.now()}.tmp\`;
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
}`,
    "session encryption subsystem",
  );

  source = replaceOnce(
    source,
    '  logAdminEvent("account_connected", { uid: String(state.uid) });\n',
    '  logAdminEvent("account_connected", { uid: String(state.uid) });\n  appendSecurityEvent("account_connected", { uid: String(state.uid) });\n  void notifySecurityAdmins(`A personal Telegram account was connected for user ${state.uid}.`);\n',
    "account-connected security event",
  );

  source = replaceSection(
    source,
    "async function beginPersonalLogin(uid, phone) {",
    "function accessKeyboard(active) {",
    `async function beginPersonalLogin(uid, phone) {
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
      url: \`\${PUBLIC_URL.replace(/\\/+$/, "")}/connect?token=\${encodeURIComponent(token)}\`,
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
    void notifySecurityAdmins(\`Five failed Telegram \${kind} attempts locked login for user \${uid}.\`);
    throw new Error("Too many failed attempts. Start the account connection again.");
  }
  throw new Error(cleanAuthError(err));
}

async function submitLoginCode(attempt, code) {
  if (attempt.stage !== "code") return;
  const value = String(code || "").replace(/\\D/g, "");
  if (!/^\\d{3,10}$/.test(value)) {
    return failLoginAttempt(attempt, "code", new Error("PHONE_CODE_INVALID"));
  }
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
}`,
    "personal login subsystem",
  );

  const middlewareStart = 'bot.use(async (ctx, next) => {\n  if (ctx.from && ctx.chat?.type === "private") syncUserIdentity(ctx, getState(ctx.from.id));';
  assertContains(source, middlewareStart, "base security middleware");
  source = replaceSection(
    source,
    middlewareStart,
    "// ===== TELEPILOT ADMIN PANEL =====",
    `bot.use(async (ctx, next) => {
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
      if (!allowed.has(data) && !/^\\/start(?:@\\w+)?(?:\\s|$)/i.test(text)) {
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
});`,
    "base security middleware",
  );

  source = replaceSection(
    source,
    "async function adminRender(ctx, text, keyboard) {",
    "function adminMainKeyboard() {",
    `async function adminRender(ctx, text, keyboard) {
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
    appendSecurityEvent("unauthorized_admin_callback", { uid, action: String(ctx.callbackQuery?.data || "").slice(0, 100) });
    const noticeRate = takeRateLimit("unauthorized-admin-notice", uid || "unknown", 1, 5 * 60_000);
    if (noticeRate.ok) void notifySecurityAdmins(\`Unauthorized admin-control attempt from Telegram user \${uid || "unknown"}.\`);
    try { await ctx.answerCallbackQuery({ text: "Admin access only.", show_alert: true }); } catch {}
    return false;
  }
  const data = String(ctx.callbackQuery?.data || "");
  if (data.includes("_confirm") && !consumeSensitiveCallback(uid, data)) {
    appendSecurityEvent("expired_admin_confirmation", { uid, action: data.slice(0, 100) });
    try { await ctx.answerCallbackQuery({ text: "This confirmation expired or was already used. Open the action again.", show_alert: true }); } catch {}
    return false;
  }
  try { await ctx.answerCallbackQuery(); } catch {}
  return true;
}`,
    "admin authorization subsystem",
  );

  source = replaceOnce(
    source,
    '    `Access: ${adminAccessStatus(state)}`,\n',
    '    `Access: ${adminAccessStatus(state)}`,\n    `Security: ${isUserFrozen(id) ? "🧊 Frozen" : "🟢 Normal"}`,\n',
    "admin user security status",
  );
  source = replaceOnce(
    source,
    '  if (connected) kb.text("🔌 Disconnect Account", `admin_user_disconnect:${id}:${backPage}`).row();\n  kb.text("♻️ Reset Configuration", `admin_user_reset:${id}:${backPage}`).row()\n',
    '  if (connected) kb.text("🔌 Disconnect Account", `admin_user_disconnect:${id}:${backPage}`).row();\n  kb.text(isUserFrozen(id) ? "🟢 Unfreeze User" : "🧊 Freeze User", isUserFrozen(id) ? `admin_user_unfreeze:${id}:${backPage}` : `admin_user_freeze:${id}:${backPage}`).row();\n  kb.text("♻️ Reset Configuration", `admin_user_reset:${id}:${backPage}`).row()\n',
    "admin freeze button",
  );

  source = replaceSection(
    source,
    "async function showAdminSecurity(ctx) {",
    "async function handleAdminAwaitingText(ctx, state) {",
    `async function showAdminSecurity(ctx) {
  const ids = customerUserIds();
  let eventBytes = 0;
  try { eventBytes = fs.existsSync(ADMIN_EVENT_FILE) ? fs.statSync(ADMIN_EVENT_FILE).size : 0; } catch {}
  const securityEvents = readSecurityEvents(100);
  const frozen = ids.filter(isUserFrozen).length;
  const text = [
    "🔐 SECURITY & ADMIN",
    "",
    \`Security lockdown: \${isSecurityLockdown() ? "🛑 ACTIVE" : "🟢 Off"}\`,
    \`Frozen users: \${frozen}\`,
    \`Recent security events: \${securityEvents.length}\`,
    "",
    \`Admins: \${ADMIN_IDS.size}\`,
    ...[...ADMIN_IDS].map(id => \`• \${id}\`),
    "",
    \`Active login links: \${loginAttempts.size}\`,
    \`Stored personal sessions: \${ids.filter(hasPersonalSession).length}\`,
    \`Audit log size: \${(eventBytes / 1024).toFixed(1)} KB\`,
    "",
    "Personal sessions use AES-256-GCM. New/used sessions are migrated to the Railway-held encryption key when possible.",
    "TelePilot never displays bot tokens, API hashes, login codes, 2FA passwords, encryption keys, raw sessions, or security secrets here.",
  ].join("\\n");
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
    const details = [event.uid ? \`user \${event.uid}\` : "", event.actorUid ? \`actor \${event.actorUid}\` : "", event.action ? event.action : ""].filter(Boolean).join(" • ");
    return \`\${when}\\n\${event.type}\${details ? ` • ${"${details}"}` : ""}\`;
  });
  return adminRender(ctx, \`🧾 SECURITY EVENTS\\n\\n\${lines.length ? lines.join("\\n\\n") : "No security events yet."}\`, new InlineKeyboard().text("🔄 Refresh", "admin_security_events").row().text("⬅️ Security", "admin_security"));
}

async function handleAdminAwaitingText(ctx, state) {`,
    "admin security page",
  );

  source = replaceOnce(
    source,
    '    adminDrafts.set(String(state.uid), draft);\n    try {\n',
    '    adminDrafts.set(String(state.uid), draft);\n    authorizeSensitiveCallback(state.uid, "admin_announce_confirm");\n    try {\n',
    "announcement confirmation authorization",
  );

  source = replaceOnce(
    source,
    'bot.callbackQuery("admin_security", async ctx => {\n',
    `bot.callbackQuery(/^admin_user_freeze:(\\d+):(\\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getAdminSnapshot(ctx.match[1]);
  await adminRender(ctx, \`🧊 FREEZE USER\\n\\nFreeze \${formatAdminUserName(target)}? Posting will stop immediately and configuration, imports, reconnects and new posting starts will be blocked.\`, new InlineKeyboard().text("🧊 Confirm Freeze", \`admin_user_freeze_confirm:\${ctx.match[1]}:\${ctx.match[2]}\`).danger().row().text("⬅️ Cancel", \`admin_user:\${ctx.match[1]}:\${ctx.match[2]}\`));
});
bot.callbackQuery(/^admin_user_freeze_confirm:(\\d+):(\\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const target = getState(ctx.match[1]);
  stopPostingLoop(target);
  setUserFrozen(target.uid, true, ctx.from.id);
  await showAdminUser(ctx, target.uid, Number(ctx.match[2]));
});
bot.callbackQuery(/^admin_user_unfreeze:(\\d+):(\\d+)$/, async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  setUserFrozen(ctx.match[1], false, ctx.from.id);
  await showAdminUser(ctx, ctx.match[1], Number(ctx.match[2]));
});

bot.callbackQuery("admin_security", async ctx => {
`,
    "freeze handlers insertion",
  );

  source = replaceOnce(
    source,
    'bot.callbackQuery("admin_cancel_logins", async ctx => {\n',
    `bot.callbackQuery("admin_security_events", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  await showAdminSecurityEvents(ctx);
});
bot.callbackQuery("admin_security_lockdown", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  const enabling = !isSecurityLockdown();
  await adminRender(ctx, \`\${enabling ? "🛑 ENABLE" : "🟢 DISABLE"} SECURITY LOCKDOWN\\n\\n\${enabling ? "New logins, key redemption, imports and new posting starts will be blocked for customers." : "Normal customer security-sensitive actions will be restored."}\`, new InlineKeyboard().text(enabling ? "🛑 Confirm Lockdown" : "🟢 Confirm Disable", "admin_security_lockdown_confirm").danger().row().text("⬅️ Cancel", "admin_security"));
});
bot.callbackQuery("admin_security_lockdown_confirm", async ctx => {
  if (!(await allowAdminCallback(ctx))) return;
  setSecurityLockdown(!isSecurityLockdown(), ctx.from.id);
  await showAdminSecurity(ctx);
});

bot.callbackQuery("admin_cancel_logins", async ctx => {
`,
    "lockdown handlers insertion",
  );

  source = replaceSection(
    source,
    'bot.command("genkey", async ctx => {',
    'bot.command("keys", async ctx => {',
    `bot.command("genkey", async ctx => {
  if (!privateOnly(ctx) || !isAdmin(ctx.from?.id)) return;
  const parts = String(ctx.message?.text || "").trim().split(/\\s+/);
  const arg = parts[1]?.toLowerCase();
  const boundTo = parts[2] || null;
  let duration;
  if (arg === "lifetime") duration = "lifetime";
  else if (/^\\d+$/.test(arg || "")) {
    const days = Number(arg);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return ctx.reply("Usage: /genkey 30 [TelegramID], /genkey 90 [TelegramID], or /genkey lifetime [TelegramID]");
    }
    duration = days;
  } else {
    return ctx.reply("Usage: /genkey 30 [TelegramID], /genkey 90 [TelegramID], or /genkey lifetime [TelegramID]");
  }
  if (boundTo && !/^\\d+$/.test(boundTo)) return ctx.reply("The optional bound Telegram ID must be numeric.");
  const { key, record } = generateLicenseKey(duration, boundTo);
  logAdminEvent("key_generated", { actorUid: String(ctx.from.id), keyId: record.id, duration: duration === "lifetime" ? "lifetime" : \`\${duration}d\` });
  appendSecurityEvent("key_generated", { actorUid: String(ctx.from.id), keyId: record.id, bound: !!record.boundTo });
  await ctx.reply(\`🔑 New \${duration === "lifetime" ? "lifetime" : `${"${duration}"}-day`} key\\n\\n\${key}\\n\\nID: \${record.id}\\n\${record.boundTo ? `Bound to Telegram ID: ${"${record.boundTo}"}\\n` : ""}Single use. The full key is shown only in this message.\`, {
    reply_markup: new InlineKeyboard().copyText("📋 Copy key", key),
  });
});`,
    "genkey command",
  );

  source = replaceOnce(
    source,
    '  await ctx.editMessageText(\n    `▶️ START TELEPILOT\\n\\nPosting as: ${sender}\\nDestinations: ${state.groups.length}\\nInterval: ${formatInterval(state.intervalMinutes)}\\n\\nTelePilot will post once immediately, then continue on your selected interval.`,\n',
    '  authorizeSensitiveCallback(state.uid, "start_confirm");\n  await ctx.editMessageText(\n    `▶️ START TELEPILOT\\n\\nPosting as: ${sender}\\nDestinations: ${state.groups.length}\\nInterval: ${formatInterval(state.intervalMinutes)}\\n\\nTelePilot will post once immediately, then continue on your selected interval.`,\n',
    "posting start authorization",
  );
  source = replaceOnce(
    source,
    'bot.callbackQuery("start_confirm", async ctx => {\n  const state = stateFromCtx(ctx);\n  await ctx.answerCallbackQuery({ text: "Starting…" });\n',
    'bot.callbackQuery("start_confirm", async ctx => {\n  const state = stateFromCtx(ctx);\n  if (!consumeSensitiveCallback(state.uid, "start_confirm")) return ctx.answerCallbackQuery({ text: "This confirmation expired. Open Start again.", show_alert: true });\n  await ctx.answerCallbackQuery({ text: "Starting…" });\n',
    "posting start replay protection",
  );
  source = replaceOnce(
    source,
    'bot.callbackQuery("clear_groups", async ctx => {\n  await ctx.answerCallbackQuery();\n  const state = stateFromCtx(ctx);\n',
    'bot.callbackQuery("clear_groups", async ctx => {\n  await ctx.answerCallbackQuery();\n  const state = stateFromCtx(ctx);\n  authorizeSensitiveCallback(state.uid, "clear_groups_confirm");\n',
    "clear-groups authorization",
  );
  source = replaceOnce(
    source,
    'bot.callbackQuery("clear_groups_confirm", async ctx => {\n  const state = stateFromCtx(ctx);\n  state.groups = [];\n',
    'bot.callbackQuery("clear_groups_confirm", async ctx => {\n  const state = stateFromCtx(ctx);\n  if (!consumeSensitiveCallback(state.uid, "clear_groups_confirm")) return ctx.answerCallbackQuery({ text: "This confirmation expired. Open Clear all again.", show_alert: true });\n  state.groups = [];\n',
    "clear-groups replay protection",
  );

  source = replaceSection(
    source,
    "const healthServer = http.createServer(async (req, res) => {",
    'healthServer.listen(PORT, "0.0.0.0", () => console.log(`TelePilot web/health server listening on port ${PORT}`));',
    `function readCookies(req) {
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
  return \`__Host-telepilot_connect=\${encodeURIComponent(token || "")}; Path=/; Max-Age=\${Math.max(0, maxAge)}; HttpOnly; Secure; SameSite=Strict\`;
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
});`,
    "HTTP authentication server",
  );

  return source;
}

function patchProControls(source) {
  if (source.includes("TELEPILOT_SECURITY_PACK_V1")) return source;

  source = replaceOnce(
    source,
    '} from "./posting-engine-enhancements.js";\n',
    `} from "./posting-engine-enhancements.js";
import {
  appendSecurityEvent,
  assertSafeObject,
  consumeConfirmationToken,
  getExternalSessionKey,
  isSecurityLockdown,
  isUserFrozen,
  issueConfirmationToken,
  signBackupPayload,
  verifyBackupSignature,
} from "./security-core.js";

// TELEPILOT_SECURITY_PACK_V1
`,
    "pro security import",
  );

  source = replaceSection(
    source,
    "async function openPersonalClient(uid) {",
    "function toMtprotoEntities(entities = []) {",
    `async function openPersonalClient(uid) {
  const payload = fs.readFileSync(sessionPath(uid), "utf8");
  const parsed = JSON.parse(payload);
  let key = null;
  if (parsed?.v === 2 && parsed?.keyVersion === "env") key = getExternalSessionKey();
  else {
    try {
      const legacy = fs.readFileSync(SESSION_KEY_FILE);
      if (legacy.length === 32) key = legacy;
    } catch {}
  }
  if (!key) throw new Error("Personal-session encryption key is unavailable.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const session = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5, floodSleepThreshold: 60 });
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Personal account session is no longer authorized.");
  return client;
}`,
    "pro personal-session reader",
  );

  source = replaceSection(
    source,
    "function safeExport(uid) {",
    "async function showAdmin(ctx) {",
    `const IMPORT_INTERVALS = new Set([1, 5, 10, 15, 30, 45, 60, 90, 120]);
const BACKUP_MAX_BYTES = 256 * 1024;
function safeEntity(entity, textLength) {
  const allowed = new Set(["bold", "italic", "underline", "strikethrough", "spoiler", "blockquote", "expandable_blockquote", "code", "pre", "text_link", "custom_emoji"]);
  if (!entity || !allowed.has(entity.type)) return null;
  const offset = Number(entity.offset); const length = Number(entity.length);
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || offset + length > textLength) return null;
  const out = { type: entity.type, offset, length };
  if (entity.type === "text_link" && typeof entity.url === "string" && entity.url.length <= 2048) out.url = entity.url;
  if (entity.type === "pre" && typeof entity.language === "string") out.language = entity.language.slice(0, 64);
  if (entity.type === "custom_emoji" && /^\\d+$/.test(String(entity.custom_emoji_id || ""))) out.custom_emoji_id = String(entity.custom_emoji_id);
  return out;
}
function safeEntities(entities, textLength) {
  return (Array.isArray(entities) ? entities : []).slice(0, 200).map(item => safeEntity(item, textLength)).filter(Boolean);
}
function safeSchedule(value, fallback) {
  const source = value && typeof value === "object" ? value : {};
  const schedule = { ...fallback };
  if (typeof source.enabled === "boolean") schedule.enabled = source.enabled;
  if (Array.isArray(source.days)) {
    const days = [...new Set(source.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
    if (days.length) schedule.days = days;
  }
  if (/^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(String(source.start || ""))) schedule.start = source.start;
  if (/^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(String(source.end || ""))) schedule.end = source.end;
  const offset = Number(source.utcOffsetMinutes);
  if (Number.isInteger(offset) && offset >= -840 && offset <= 840) schedule.utcOffsetMinutes = offset;
  return schedule;
}
function backupPayload(uid) {
  const settings = readAppSettings(uid);
  const pro = readProSettings(uid);
  const text = String(settings.adMessage || "").slice(0, 4096);
  return {
    kind: "TelePilotConfig",
    version: 2,
    ownerUid: String(uid),
    exportedAt: new Date().toISOString(),
    message: { text, entities: safeEntities(settings.adEntities, text.length) },
    destinations: (settings.groups || []).filter(group => /^@[A-Za-z0-9_]{5,32}$/.test(String(group.username || ""))).slice(0, 1000).map(group => ({
      label: String(group.label || "").slice(0, 120), type: String(group.type || "").slice(0, 24), username: String(group.username),
    })),
    intervalMinutes: IMPORT_INTERVALS.has(Number(settings.intervalMinutes)) ? Number(settings.intervalMinutes) : 30,
    pro: {
      placeholders: pro.placeholders === true,
      staggerSeconds: [0, 2, 5, 10, 20].includes(Number(pro.staggerSeconds)) ? Number(pro.staggerSeconds) : 0,
      schedule: safeSchedule(pro.schedule, defaultProSettings().schedule),
      templates: (pro.templates || []).slice(0, 20).map(template => {
        const message = String(template.message || "").slice(0, 4096);
        return { name: sanitizeName(template.name), message, entities: safeEntities(template.entities, message.length), createdAt: Number(template.createdAt || Date.now()) };
      }),
    },
  };
}
function safeExport(uid) {
  const payload = backupPayload(uid);
  return { ...payload, signature: signBackupPayload(payload) };
}
function validateSignedImport(uid, parsed) {
  assertSafeObject(parsed, { maxDepth: 20, maxNodes: 6000 });
  if (parsed?.kind !== "TelePilotConfig" || Number(parsed?.version) !== 2) throw new Error("This backup uses an unsupported format. Create a fresh TelePilot export first.");
  if (String(parsed.ownerUid || "") !== String(uid)) throw new Error("This signed backup belongs to a different Telegram account.");
  const { signature, ...payload } = parsed;
  if (!/^[a-f0-9]{64}$/i.test(String(signature || "")) || !verifyBackupSignature(payload, signature)) throw new Error("Backup signature is invalid or the file was modified.");
  const messageText = String(payload.message?.text || "");
  if (Buffer.byteLength(messageText, "utf8") > 16_384 || messageText.length > 4096) throw new Error("Backup message is too large.");
  const intervalMinutes = Number(payload.intervalMinutes);
  if (!IMPORT_INTERVALS.has(intervalMinutes)) throw new Error("Backup interval is invalid.");
  const destinations = (Array.isArray(payload.destinations) ? payload.destinations : []).slice(0, 1000).map(item => ({
    username: String(item?.username || ""), label: String(item?.label || "").slice(0, 120), type: String(item?.type || "").slice(0, 24),
  }));
  if (destinations.some(item => !/^@[A-Za-z0-9_]{5,32}$/.test(item.username))) throw new Error("Backup contains an invalid destination.");
  const currentPro = readProSettings(uid);
  const templates = (Array.isArray(payload.pro?.templates) ? payload.pro.templates : []).slice(0, 20).map((template, index) => {
    const message = String(template?.message || "");
    if (message.length > 4096) throw new Error("Backup contains an oversized template.");
    return {
      id: crypto.randomBytes(4).toString("hex"),
      name: sanitizeName(template?.name, \`Template \${index + 1}\`),
      message,
      entities: safeEntities(template?.entities, message.length),
      createdAt: Date.now(),
    };
  });
  return {
    message: { text: messageText, entities: safeEntities(payload.message?.entities, messageText.length) },
    destinations,
    intervalMinutes,
    pro: {
      placeholders: payload.pro?.placeholders === true,
      staggerSeconds: [0, 2, 5, 10, 20].includes(Number(payload.pro?.staggerSeconds)) ? Number(payload.pro.staggerSeconds) : 0,
      schedule: safeSchedule(payload.pro?.schedule, currentPro.schedule),
      templates,
    },
  };
}
function savePreImportBackup(uid) {
  const file = path.join(userDir(uid), "pre-import-backup.json");
  fs.mkdirSync(userDir(uid), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(safeExport(uid), null, 2), { mode: 0o600 });
}`,
    "signed backup subsystem",
  );

  source = replaceSection(
    source,
    '  bot.callbackQuery("export_config", async ctx => {',
    '  bot.callbackQuery("admin_panel", async ctx => {',
    `  bot.callbackQuery("export_config", async ctx => {
    const uid = uidOf(ctx); await ctx.answerCallbackQuery({ text: "Preparing signed backup…" });
    const buffer = Buffer.from(JSON.stringify(safeExport(uid), null, 2), "utf8");
    await ctx.replyWithDocument(new InputFile(buffer, "telepilot-backup.json"), { caption: "📦 Signed TelePilot backup\\n\\nSessions, access keys, access status, admin data and login credentials are never included." });
    appendSecurityEvent("backup_exported", { uid });
  });
  bot.callbackQuery("import_config", async ctx => {
    const uid = uidOf(ctx);
    if (isSecurityLockdown() || isUserFrozen(uid)) return ctx.answerCallbackQuery({ text: "Import is temporarily disabled by TelePilot security.", show_alert: true });
    await ctx.answerCallbackQuery();
    proAwaiting.set(uid, { type: "import", messageId: ctx.callbackQuery.message?.message_id });
    await ctx.editMessageText("📥 Restore signed backup\\n\\nSend a TelePilot backup JSON file. The signature and every supported field will be validated before anything changes.", { reply_markup: new InlineKeyboard().text("Cancel", "tools") });
  });
  bot.callbackQuery(/^import_config_confirm:([A-Za-z0-9_-]+)$/, async ctx => {
    const uid = uidOf(ctx);
    const pending = proAwaiting.get(uid);
    if (!consumeConfirmationToken(ctx.match[1], uid, "import", uid) || pending?.type !== "import_confirm") {
      return ctx.answerCallbackQuery({ text: "This restore confirmation expired or was already used.", show_alert: true });
    }
    if (isSecurityLockdown() || isUserFrozen(uid)) return ctx.answerCallbackQuery({ text: "Import is temporarily disabled by TelePilot security.", show_alert: true });
    proAwaiting.delete(uid);
    await ctx.answerCallbackQuery({ text: "Restoring…" });
    try {
      savePreImportBackup(uid);
      const config = pending.config;
      const importedPro = readProSettings(uid);
      importedPro.schedule = config.pro.schedule;
      importedPro.placeholders = config.pro.placeholders;
      importedPro.staggerSeconds = config.pro.staggerSeconds;
      importedPro.templates = config.pro.templates;
      writeProSettings(uid, importedPro);
      if (config.message.text) await applyMessage(ctx, config.message.text, config.message.entities);
      await applyInterval(ctx, config.intervalMinutes);
      let added = 0;
      for (const destination of config.destinations) {
        try { await applyDestination(ctx, destination.username); added++; } catch {}
      }
      appendSecurityEvent("backup_imported", { uid, destinations: added });
      await ctx.editMessageText(\`📥 Restore complete\\n\\n✅ Signed backup verified\\n✅ Message/settings restored\\n✅ \${added} public destination\${added === 1 ? "" : "s"} processed\\n\\nA signed pre-import rollback backup was saved server-side.\`, { reply_markup: new InlineKeyboard().text("⬅️ Dashboard", "home") });
    } catch (err) {
      appendSecurityEvent("backup_import_failed", { uid, reason: String(err?.message || err).slice(0, 120) });
      await ctx.editMessageText(\`📥 Restore backup\\n\\n❌ \${String(err?.message || "Restore failed").slice(0, 180)}\`, { reply_markup: new InlineKeyboard().text("Try again", "import_config").row().text("⬅️ Tools", "tools") });
    }
  });`,
    "backup handlers",
  );

  const importStart = '    if (pending?.type === "import" && ctx.message.document) {';
  const importEnd = '    await saveIncomingMedia(ctx);';
  source = replaceSection(
    source,
    importStart,
    importEnd,
    `    if (pending?.type === "import" && ctx.message.document) {
      try {
        if (Number(ctx.message.document.file_size || 0) > BACKUP_MAX_BYTES) throw new Error("Backup file is too large.");
        const file = await ctx.api.getFile(ctx.message.document.file_id);
        if (!file.file_path) throw new Error("Telegram did not provide the file.");
        const response = await fetch(\`https://api.telegram.org/file/bot\${BOT_TOKEN}/\${file.file_path}\`);
        if (!response.ok) throw new Error("Could not download backup file.");
        const raw = await response.text();
        if (Buffer.byteLength(raw, "utf8") > BACKUP_MAX_BYTES) throw new Error("Backup file is too large.");
        const parsed = JSON.parse(raw);
        const config = validateSignedImport(uid, parsed);
        const token = issueConfirmationToken(uid, "import", uid, 120_000);
        proAwaiting.set(uid, { type: "import_confirm", messageId: pending.messageId, config });
        try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch {}
        await ctx.api.editMessageText(ctx.chat.id, pending.messageId, [
          "📥 BACKUP VERIFIED",
          "",
          \`Message: \${config.message.text ? `${"${config.message.text.length}"} characters` : "not set"}\`,
          \`Public destinations: \${config.destinations.length}\`,
          \`Templates: \${config.pro.templates.length}\`,
          \`Interval: \${config.intervalMinutes} min\`,
          "",
          "TelePilot will make a rollback backup before applying this restore.",
        ].join("\\n"), { reply_markup: new InlineKeyboard().text("✅ Restore", \`import_config_confirm:\${token}\`).success().row().text("✖️ Cancel", "tools") });
      } catch (err) {
        proAwaiting.delete(uid);
        appendSecurityEvent("backup_import_rejected", { uid, reason: String(err?.message || err).slice(0, 120) });
        await ctx.api.editMessageText(ctx.chat.id, pending.messageId, \`📥 Restore backup\\n\\n❌ \${String(err?.message || err).slice(0, 180)}\`, { reply_markup: new InlineKeyboard().text("Try again", "import_config").row().text("⬅️ Tools", "tools") });
      }
      return;
    }`,
    "backup document parser",
  );

  return source;
}

let app = fs.readFileSync("app.js", "utf8");
let pro = fs.readFileSync("pro-controls.js", "utf8");
app = patchApp(app);
pro = patchProControls(pro);
fs.writeFileSync("app.js", app);
fs.writeFileSync("pro-controls.js", pro);
console.log("TelePilot Security Pack migration applied or already present.");
