import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import {
  appendSecurityEvent,
  consumeConfirmationToken,
  issueConfirmationToken,
  redactSecrets,
  takeRateLimit,
} from "./security-core.js";
import {
  hasPersonalSessionFile,
  readAppSettings,
  readProSettings,
} from "./posting-engine-enhancements.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const CASE_FILE = path.join(DATA_DIR, "support-cases.json");
const DELETED_FILE = path.join(DATA_DIR, "deleted-users.json");
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const KEY_FILE = path.join(DATA_DIR, "access-keys.json");
const SUPPORT_USERNAME = String(process.env.TELEPILOT_SUPPORT_USERNAME || "noahxrp").replace(/^@+/, "");
const SUPPORT_URL = `https://t.me/${SUPPORT_USERNAME}`;
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
const VERSION = "1.0.0";
const PAGE_SIZE = 8;

const awaiting = new Map();
let appStopHandler = null;
let appDisconnectHandler = null;

function uidOf(ctx) { return ctx?.from?.id ? String(ctx.from.id) : ""; }
function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function adminIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) if (/^\d+$/.test(part)) ids.add(part);
  }
  const persisted = readJson(ADMIN_FILE, {});
  for (const value of Array.isArray(persisted?.adminIds) ? persisted.adminIds : []) {
    if (/^\d+$/.test(String(value))) ids.add(String(value));
  }
  return ids;
}
function isAdmin(uid) { return adminIds().has(String(uid)); }

function loadCases() {
  const db = readJson(CASE_FILE, { version: 1, cases: [] });
  return { version: 1, cases: Array.isArray(db?.cases) ? db.cases : [] };
}
function saveCases(db) {
  db.cases = (db.cases || []).slice(-1000);
  writeJsonAtomic(CASE_FILE, { version: 1, cases: db.cases });
}

function deletedHash(uid) {
  return crypto.createHash("sha256").update(`telepilot-deleted-user:${String(uid)}`).digest("hex");
}
function loadDeleted() {
  const db = readJson(DELETED_FILE, { version: 1, users: {} });
  return { version: 1, users: db?.users && typeof db.users === "object" && !Array.isArray(db.users) ? db.users : {} };
}
function isDeleted(uid) { return !!loadDeleted().users[deletedHash(uid)]; }
function markDeleted(uid, caseId) {
  const db = loadDeleted();
  db.users[deletedHash(uid)] = { deletedAt: Date.now(), caseId: String(caseId || "") };
  writeJsonAtomic(DELETED_FILE, db);
}

function randomCaseId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (let i = 0; i < 7; i++) value += alphabet[crypto.randomInt(0, alphabet.length)];
  return `TP-SUP-${value}`;
}

function categoryLabel(category) {
  return ({
    login: "Account / login",
    posting: "Posting problem",
    access: "Access / key",
    security: "Security concern",
    privacy: "Privacy / data request",
    other: "Other",
    data_deletion: "Data deletion",
  })[category] || "Support";
}

function safeDiagnostic(uid) {
  const settings = readAppSettings(uid);
  const pro = readProSettings(uid);
  const now = Date.now();
  const access = settings?.accessRevoked
    ? "revoked"
    : settings?.accessLifetime
      ? "lifetime"
      : Number(settings?.accessUntil || 0) > now ? "active" : "inactive";
  return {
    version: VERSION,
    sender: hasPersonalSessionFile(uid) ? "personal" : "bot",
    destinations: Array.isArray(settings?.groups) ? settings.groups.length : 0,
    intervalMinutes: Number(settings?.intervalMinutes || 0) || null,
    access,
    paused: pro?.paused === true,
    templates: Array.isArray(pro?.templates) ? pro.templates.length : 0,
    lastCycleSuccess: Number(settings?.lastCycleSuccess || 0),
    lastCycleFailed: Number(settings?.lastCycleFailed || 0),
  };
}

function createCase(ctx, category, message) {
  const uid = uidOf(ctx);
  const limit = takeRateLimit("support-case", uid, 5, 60 * 60_000);
  if (!limit.ok) return { ok: false, error: "Too many support cases were opened recently. Please try again later." };
  const db = loadCases();
  let id = randomCaseId();
  while (db.cases.some(item => item.id === id)) id = randomCaseId();
  const now = Date.now();
  const item = {
    id,
    uid,
    username: String(ctx?.from?.username || "").slice(0, 64),
    category,
    message: redactSecrets(String(message || "")).slice(0, 3000),
    status: "open",
    createdAt: now,
    updatedAt: now,
    diagnostic: safeDiagnostic(uid),
    replies: [],
  };
  db.cases.push(item);
  saveCases(db);
  appendSecurityEvent("support_case_created", { uid, caseId: id, category });
  return { ok: true, item };
}

function findCase(id) {
  return loadCases().cases.find(item => item.id === String(id || "")) || null;
}

function updateCase(id, updater) {
  const db = loadCases();
  const item = db.cases.find(candidate => candidate.id === String(id || ""));
  if (!item) return null;
  updater(item);
  item.updatedAt = Date.now();
  saveCases(db);
  return item;
}

function formatDate(ts) {
  try { return new Date(Number(ts)).toISOString().replace("T", " ").slice(0, 16) + " UTC"; }
  catch { return "—"; }
}

async function editOrReply(ctx, text, keyboard) {
  const other = { reply_markup: keyboard };
  if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(text, other); } catch {}
  }
  return ctx.reply(text, other);
}

function legalButton(kb, label, pathName) {
  if (PUBLIC_URL) kb.url(label, `${PUBLIC_URL}${pathName}`);
  return kb;
}

async function showSupport(ctx) {
  const uid = uidOf(ctx);
  const kb = new InlineKeyboard()
    .text("📱 Account / login", "support_new:login").text("📤 Posting", "support_new:posting").row()
    .text("🪪 Access / key", "support_new:access").text("🛡 Security", "support_new:security").row()
    .text("🔐 Privacy / data", "support_new:privacy").text("💬 Other", "support_new:other").row()
    .text("📋 My cases", "support_mine").row();
  legalButton(kb, "Privacy", "/privacy");
  legalButton(kb, "Terms", "/terms");
  if (PUBLIC_URL) kb.row();
  kb.url(`Message @${SUPPORT_USERNAME}`, SUPPORT_URL).row()
    .text("🗑 Request data deletion", "support_delete");
  if (!isDeleted(uid)) kb.row().text("⬅️ Tools", "tools");
  return editOrReply(ctx, [
    "💬 TelePilot Support",
    "",
    "Choose what you need help with. TelePilot creates a case ID and attaches only safe diagnostic information.",
    "",
    "Never send a Telegram login code, 2FA password, raw Telegram session, bot token or full access key.",
    "",
    `Direct support — @${SUPPORT_USERNAME}`,
  ].join("\n"), kb);
}

async function showDeleted(ctx) {
  const kb = new InlineKeyboard().text("💬 Support", "support").row().url(`@${SUPPORT_USERNAME}`, SUPPORT_URL);
  return editOrReply(ctx, [
    "TelePilot account data deleted",
    "",
    "The TelePilot configuration associated with this account has been removed. A minimal security marker may remain to preserve deletion state and service integrity.",
    "",
    "If you believe this was a mistake, contact support.",
  ].join("\n"), kb);
}

async function beginCase(ctx, category) {
  const uid = uidOf(ctx);
  if (!uid) return;
  awaiting.set(uid, { type: "new_case", category, startedAt: Date.now() });
  const kb = new InlineKeyboard().text("Cancel", "support");
  return editOrReply(ctx, [
    `💬 ${categoryLabel(category)}`,
    "",
    "Send one message describing what happened and what you expected to happen.",
    "",
    "Do not include login codes, 2FA passwords, raw sessions, bot/API secrets or full access keys.",
  ].join("\n"), kb);
}

async function notifyAdmins(api, item) {
  const d = item.diagnostic || {};
  const text = [
    "💬 New TelePilot support case",
    "",
    `${item.id} • ${categoryLabel(item.category)}`,
    `User — ${item.username ? `@${item.username}` : item.uid}`,
    `Sender — ${d.sender || "—"}`,
    `Destinations — ${d.destinations ?? "—"}`,
    `Access — ${d.access || "—"}`,
    "",
    String(item.message || "").slice(0, 900),
  ].join("\n");
  const kb = new InlineKeyboard().text("Open case", `support_admin_case:${item.id}`);
  for (const adminId of adminIds()) {
    try { await api.sendMessage(Number(adminId), text, { reply_markup: kb }); } catch {}
  }
}

async function handleSupportText(ctx, pending) {
  const uid = uidOf(ctx);
  const text = String(ctx.message?.text || "").trim();
  awaiting.delete(uid);
  if (!text) return ctx.reply("Please send a text description, or open /support to cancel.");

  if (pending.type === "new_case") {
    const result = createCase(ctx, pending.category, text);
    if (!result.ok) return ctx.reply(result.error);
    await notifyAdmins(ctx.api, result.item);
    return ctx.reply([
      "✅ Support case created",
      "",
      `Case ID — ${result.item.id}`,
      `Category — ${categoryLabel(result.item.category)}`,
      "",
      "Keep the case ID if you contact support directly.",
    ].join("\n"), { reply_markup: new InlineKeyboard().text("💬 Support", "support").url(`@${SUPPORT_USERNAME}`, SUPPORT_URL) });
  }

  if (pending.type === "admin_reply") {
    if (!isAdmin(uid)) return ctx.reply("Admin access required.");
    const item = findCase(pending.caseId);
    if (!item || !/^\d+$/.test(String(item.uid || ""))) return ctx.reply("That support case is no longer replyable.");
    const reply = redactSecrets(text).slice(0, 2500);
    try {
      await ctx.api.sendMessage(Number(item.uid), [
        "💬 TelePilot Support",
        `Case — ${item.id}`,
        "",
        reply,
        "",
        `Need anything else? Open /support or message @${SUPPORT_USERNAME}.`,
      ].join("\n"));
    } catch {
      return ctx.reply("Could not deliver that reply to the user.");
    }
    updateCase(item.id, current => {
      current.replies = Array.isArray(current.replies) ? current.replies : [];
      current.replies.push({ at: Date.now(), by: uid, message: reply });
      current.replies = current.replies.slice(-20);
    });
    return ctx.reply(`✅ Reply sent for ${item.id}.`, { reply_markup: new InlineKeyboard().text("Open case", `support_admin_case:${item.id}`) });
  }
}

async function showMyCases(ctx) {
  const uid = uidOf(ctx);
  const items = loadCases().cases.filter(item => String(item.uid) === uid).slice(-8).reverse();
  const lines = items.length
    ? items.map(item => `${item.status === "resolved" ? "✅" : "🟢"} ${item.id} • ${categoryLabel(item.category)} • ${item.status}`)
    : ["No support cases yet."];
  const kb = new InlineKeyboard().text("⬅️ Support", "support");
  return editOrReply(ctx, ["📋 My support cases", "", ...lines].join("\n"), kb);
}

async function showAdminCases(ctx, filter = "open", page = 0) {
  if (!isAdmin(uidOf(ctx))) return;
  const all = loadCases().cases.filter(item => filter === "all" ? true : item.status === filter).reverse();
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const current = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const slice = all.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (const item of slice) kb.text(`${item.status === "resolved" ? "✅" : "💬"} ${item.id}`, `support_admin_case:${item.id}`).row();
  kb.text("Open", "support_admin_filter:open:0").text("Resolved", "support_admin_filter:resolved:0").text("All", "support_admin_filter:all:0").row();
  if (pages > 1) {
    if (current > 0) kb.text("◀ Prev", `support_admin_filter:${filter}:${current - 1}`);
    if (current < pages - 1) kb.text("Next ▶", `support_admin_filter:${filter}:${current + 1}`);
    kb.row();
  }
  kb.text("⬅️ Admin", "admin");
  return editOrReply(ctx, [
    "💬 SUPPORT CASES",
    `${all.length} ${filter} case(s) • Page ${current + 1}/${pages}`,
    "",
    slice.length ? "Choose a case." : "No cases in this view.",
  ].join("\n"), kb);
}

async function showAdminCase(ctx, id) {
  if (!isAdmin(uidOf(ctx))) return;
  const item = findCase(id);
  if (!item) return showAdminCases(ctx, "open", 0);
  const d = item.diagnostic || {};
  const kb = new InlineKeyboard();
  if (item.status !== "resolved" && /^\d+$/.test(String(item.uid || ""))) kb.text("💬 Reply", `support_admin_reply:${item.id}`).text("✅ Resolve", `support_admin_resolve:${item.id}`).row();
  if (item.category === "data_deletion" && item.status !== "resolved" && /^\d+$/.test(String(item.uid || ""))) kb.text("🗑 Process data deletion", `support_admin_delete:${item.id}`).row();
  if (/^\d+$/.test(String(item.uid || ""))) kb.text("👤 View user", `admin_user:${item.uid}:0`).row();
  kb.text("⬅️ Support cases", "support_admin");
  return editOrReply(ctx, [
    "💬 SUPPORT CASE",
    item.id,
    "",
    `Status — ${item.status}`,
    `Category — ${categoryLabel(item.category)}`,
    `User — ${item.username ? `@${item.username}` : item.uid || "deleted"}`,
    `Created — ${formatDate(item.createdAt)}`,
    "",
    `Version — ${d.version || "—"}`,
    `Sender — ${d.sender || "—"}`,
    `Destinations — ${d.destinations ?? "—"}`,
    `Interval — ${d.intervalMinutes ? `${d.intervalMinutes} min` : "—"}`,
    `Access — ${d.access || "—"}`,
    `Templates — ${d.templates ?? "—"}`,
    `Last cycle — ${d.lastCycleSuccess ?? 0} sent / ${d.lastCycleFailed ?? 0} failed`,
    "",
    "Report:",
    String(item.message || "—"),
  ].join("\n"), kb);
}

function fakeTargetContext(ctx, targetUid, data) {
  const fake = Object.create(ctx);
  Object.defineProperty(fake, "update", {
    configurable: true,
    value: {
      callback_query: {
        id: "telepilot-support-maintenance",
        from: { id: Number(targetUid), is_bot: false, first_name: "TelePilot User" },
        chat_instance: "telepilot-support-maintenance",
        data,
        message: {
          message_id: ctx?.callbackQuery?.message?.message_id || 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(targetUid), type: "private" },
        },
      },
    },
  });
  Object.defineProperty(fake, "answerCallbackQuery", { configurable: true, value: async () => undefined });
  Object.defineProperty(fake, "editMessageText", { configurable: true, value: async () => undefined });
  Object.defineProperty(fake, "reply", { configurable: true, value: async () => undefined });
  return fake;
}

function scrubKeyIdentity(uid) {
  const db = readJson(KEY_FILE, { version: 2, keys: [] });
  if (!Array.isArray(db.keys)) return;
  let changed = false;
  for (const key of db.keys) {
    if (String(key?.redeemedBy || "") === String(uid)) { key.redeemedBy = null; changed = true; }
    if (String(key?.boundTo || "") === String(uid)) { key.boundTo = null; changed = true; }
  }
  if (changed) writeJsonAtomic(KEY_FILE, db);
}

async function processDeletion(ctx, item) {
  const adminUid = uidOf(ctx);
  const targetUid = String(item?.uid || "");
  if (!isAdmin(adminUid) || !/^\d+$/.test(targetUid)) throw new Error("Invalid deletion target");
  if (isAdmin(targetUid)) throw new Error("Admin profiles cannot be deleted through support controls");

  try {
    if (typeof appStopHandler === "function") await appStopHandler(fakeTargetContext(ctx, targetUid, "stop"), async () => undefined);
  } catch {}
  try {
    if (typeof appDisconnectHandler === "function") await appDisconnectHandler(fakeTargetContext(ctx, targetUid, "account_disconnect"), async () => undefined);
  } catch {}

  try {
    await ctx.api.sendMessage(Number(targetUid), [
      "✅ TelePilot data deletion completed",
      "",
      "Your stored TelePilot configuration and personal-account session have been removed. Limited security/audit records may remain where necessary for service integrity.",
      "",
      `Questions — @${SUPPORT_USERNAME}`,
    ].join("\n"), { reply_markup: new InlineKeyboard().url(`@${SUPPORT_USERNAME}`, SUPPORT_URL) });
  } catch {}

  scrubKeyIdentity(targetUid);
  try { fs.rmSync(userDir(targetUid), { recursive: true, force: true }); } catch {}
  markDeleted(targetUid, item.id);

  const db = loadCases();
  for (const current of db.cases) {
    if (String(current.uid || "") !== targetUid) continue;
    current.uid = "";
    current.username = "";
    current.message = current.id === item.id ? "User-requested data deletion completed." : "Support report content removed after user data deletion.";
    current.diagnostic = {};
    current.replies = [];
    current.status = "resolved";
    current.deletedAt = Date.now();
    current.updatedAt = Date.now();
  }
  saveCases(db);
  appendSecurityEvent("user_data_deleted", { actorUid: adminUid, caseId: item.id });
}

function supportIntent(ctx) {
  const uid = uidOf(ctx);
  if (uid && awaiting.has(uid)) return true;
  const data = String(ctx?.callbackQuery?.data || "");
  if (data === "support" || data.startsWith("support_")) return true;
  const text = String(ctx?.message?.text || "");
  return /^\/(?:support|privacy|terms)(?:@\w+)?(?:\s|$)/i.test(text);
}

function ensurePrivate(ctx) { return ctx?.chat?.type === "private" && !!ctx?.from; }

export function installSupportCenter(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotSupportInstalled) return;
  const baseUse = BotClass.prototype.use;
  const baseOn = BotClass.prototype.on;
  const baseCommand = BotClass.prototype.command;
  const baseCallbackQuery = BotClass.prototype.callbackQuery;
  const baseStart = BotClass.prototype.start;
  if (![baseUse, baseOn, baseCommand, baseCallbackQuery, baseStart].every(fn => typeof fn === "function")) {
    throw new Error("Unsupported grammY Bot shape for TelePilot support center");
  }
  Object.defineProperty(BotClass.prototype, "__telepilotSupportInstalled", { value: true });

  BotClass.prototype.use = function(...middleware) {
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const uid = uidOf(ctx);
      if (supportIntent(ctx) || (uid && isDeleted(uid))) return next();
      return handler.call(this, ctx, next);
    });
    return baseUse.call(this, ...wrapped);
  };

  BotClass.prototype.on = function(filter, ...middleware) {
    if (filter !== "message:text") return baseOn.call(this, filter, ...middleware);
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const uid = uidOf(ctx);
      const pending = uid ? awaiting.get(uid) : null;
      if (pending && ensurePrivate(ctx)) return handleSupportText(ctx, pending);
      if (uid && isDeleted(uid) && ensurePrivate(ctx)) return showDeleted(ctx);
      return handler.call(this, ctx, next);
    });
    return baseOn.call(this, filter, ...wrapped);
  };

  BotClass.prototype.command = function(command, ...middleware) {
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const uid = uidOf(ctx);
      if (uid && isDeleted(uid) && command !== "support") return showDeleted(ctx);
      return handler.call(this, ctx, next);
    });
    return baseCommand.call(this, command, ...wrapped);
  };

  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    for (const handler of middleware) {
      if (typeof handler !== "function") continue;
      if (trigger === "stop") appStopHandler = handler;
      if (trigger === "account_disconnect") appDisconnectHandler = handler;
    }
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const uid = uidOf(ctx);
      if (uid && isDeleted(uid)) return showDeleted(ctx);
      return handler.call(this, ctx, next);
    });
    return baseCallbackQuery.call(this, trigger, ...wrapped);
  };

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotSupportHandlersRegistered) {
      Object.defineProperty(this, "__telepilotSupportHandlersRegistered", { value: true });
      const bot = this;

      baseCommand.call(bot, "support", async ctx => {
        if (!ensurePrivate(ctx)) return;
        return showSupport(ctx);
      });
      baseCommand.call(bot, "privacy", async ctx => {
        if (!ensurePrivate(ctx)) return;
        const kb = new InlineKeyboard();
        if (PUBLIC_URL) kb.url("Privacy Policy", `${PUBLIC_URL}/privacy`);
        kb.row().text("💬 Support", "support");
        return ctx.reply("TelePilot Privacy Policy", { reply_markup: kb });
      });
      baseCommand.call(bot, "terms", async ctx => {
        if (!ensurePrivate(ctx)) return;
        const kb = new InlineKeyboard();
        if (PUBLIC_URL) kb.url("Terms of Service", `${PUBLIC_URL}/terms`);
        kb.row().text("💬 Support", "support");
        return ctx.reply("TelePilot Terms of Service", { reply_markup: kb });
      });

      baseCallbackQuery.call(bot, "support", async ctx => {
        if (!ensurePrivate(ctx)) return;
        try { await ctx.answerCallbackQuery(); } catch {}
        awaiting.delete(uidOf(ctx));
        return showSupport(ctx);
      });
      baseCallbackQuery.call(bot, /^support_new:(login|posting|access|security|privacy|other)$/, async ctx => {
        if (!ensurePrivate(ctx)) return;
        try { await ctx.answerCallbackQuery(); } catch {}
        return beginCase(ctx, String(ctx.match?.[1] || "other"));
      });
      baseCallbackQuery.call(bot, "support_mine", async ctx => {
        if (!ensurePrivate(ctx)) return;
        try { await ctx.answerCallbackQuery(); } catch {}
        return showMyCases(ctx);
      });
      baseCallbackQuery.call(bot, "support_delete", async ctx => {
        if (!ensurePrivate(ctx)) return;
        try { await ctx.answerCallbackQuery(); } catch {}
        if (isAdmin(uidOf(ctx))) return editOrReply(ctx, "Admin profiles cannot be deleted through the self-service deletion flow.", new InlineKeyboard().text("⬅️ Support", "support"));
        const existing = loadCases().cases.find(item => String(item.uid) === uidOf(ctx) && item.category === "data_deletion" && item.status === "open");
        if (existing) return editOrReply(ctx, `A deletion request is already open.\n\nCase — ${existing.id}`, new InlineKeyboard().text("⬅️ Support", "support"));
        const kb = new InlineKeyboard().text("Request deletion", "support_delete_confirm").row().text("Cancel", "support");
        return editOrReply(ctx, [
          "🗑 Request TelePilot data deletion",
          "",
          "This requests removal of your stored TelePilot configuration and encrypted personal-account session. Your posting will be stopped and the connected TelePilot session will be disconnected when the request is processed.",
          "",
          "Limited security/audit records may remain where reasonably necessary for service integrity.",
          "",
          "The request is reviewed before destructive deletion is performed.",
        ].join("\n"), kb);
      });
      baseCallbackQuery.call(bot, "support_delete_confirm", async ctx => {
        if (!ensurePrivate(ctx) || isAdmin(uidOf(ctx))) return;
        try { await ctx.answerCallbackQuery(); } catch {}
        const result = createCase(ctx, "data_deletion", "User requested deletion of stored TelePilot account data.");
        if (!result.ok) return editOrReply(ctx, result.error, new InlineKeyboard().text("⬅️ Support", "support"));
        await notifyAdmins(ctx.api, result.item);
        return editOrReply(ctx, [
          "✅ Data deletion request created",
          "",
          `Case — ${result.item.id}`,
          "",
          "TelePilot support will review the request before destructive deletion is processed.",
        ].join("\n"), new InlineKeyboard().text("⬅️ Support", "support").url(`@${SUPPORT_USERNAME}`, SUPPORT_URL));
      });

      baseCallbackQuery.call(bot, "support_admin", async ctx => {
        if (!ensurePrivate(ctx) || !isAdmin(uidOf(ctx))) return;
        try { await ctx.answerCallbackQuery(); } catch {}
        return showAdminCases(ctx, "open", 0);
      });
      baseCallbackQuery.call(bot, /^support_admin_filter:(open|resolved|all):(\d+)$/, async ctx => {
        if (!ensurePrivate(ctx) || !isAdmin(uidOf(ctx))) return;
        try { await ctx.answerCallbackQuery(); } catch {}
        return showAdminCases(ctx, String(ctx.match?.[1] || "open"), Number(ctx.match?.[2] || 0));
      });
      baseCallbackQuery.call(bot, /^support_admin_case:(TP-SUP-[A-Z2-9]+)$/, async ctx => {
        if (!ensurePrivate(ctx) || !isAdmin(uidOf(ctx))) return;
        try { await ctx.answerCallbackQuery(); } catch {}
        return showAdminCase(ctx, String(ctx.match?.[1] || ""));
      });
      baseCallbackQuery.call(bot, /^support_admin_reply:(TP-SUP-[A-Z2-9]+)$/, async ctx => {
        if (!ensurePrivate(ctx) || !isAdmin(uidOf(ctx))) return;
        const id = String(ctx.match?.[1] || "");
        const item = findCase(id);
        if (!item || !/^\d+$/.test(String(item.uid || ""))) return ctx.answerCallbackQuery({ text: "Case is not replyable.", show_alert: true });
        awaiting.set(uidOf(ctx), { type: "admin_reply", caseId: id, startedAt: Date.now() });
        try { await ctx.answerCallbackQuery(); } catch {}
        return editOrReply(ctx, `💬 Reply to ${id}\n\nSend one message to the user. Secrets will be redacted before delivery.`, new InlineKeyboard().text("Cancel", `support_admin_case:${id}`));
      });
      baseCallbackQuery.call(bot, /^support_admin_resolve:(TP-SUP-[A-Z2-9]+)$/, async ctx => {
        if (!ensurePrivate(ctx) || !isAdmin(uidOf(ctx))) return;
        const id = String(ctx.match?.[1] || "");
        updateCase(id, item => { item.status = "resolved"; item.resolvedAt = Date.now(); item.resolvedBy = uidOf(ctx); });
        try { await ctx.answerCallbackQuery({ text: "Resolved" }); } catch {}
        return showAdminCase(ctx, id);
      });
      baseCallbackQuery.call(bot, /^support_admin_delete:(TP-SUP-[A-Z2-9]+)$/, async ctx => {
        if (!ensurePrivate(ctx) || !isAdmin(uidOf(ctx))) return;
        const id = String(ctx.match?.[1] || "");
        const item = findCase(id);
        if (!item || item.category !== "data_deletion" || !/^\d+$/.test(String(item.uid || ""))) return ctx.answerCallbackQuery({ text: "Deletion request is not available.", show_alert: true });
        const token = issueConfirmationToken(uidOf(ctx), "support_delete_user", id, 120_000);
        try { await ctx.answerCallbackQuery(); } catch {}
        const kb = new InlineKeyboard().text("🗑 Confirm permanent deletion", `support_admin_delete_final:${id}:${token}`).row().text("Cancel", `support_admin_case:${id}`);
        return editOrReply(ctx, [
          "🗑 CONFIRM USER DATA DELETION",
          "",
          `Case — ${id}`,
          `User — ${item.username ? `@${item.username}` : item.uid}`,
          "",
          "This stops posting, disconnects the stored personal-account session, removes the user's TelePilot directory, removes their ID from key ownership fields and removes report contents from support cases.",
          "",
          "This cannot be undone from TelePilot.",
        ].join("\n"), kb);
      });
      baseCallbackQuery.call(bot, /^support_admin_delete_final:(TP-SUP-[A-Z2-9]+):([A-Za-z0-9_-]+)$/, async ctx => {
        if (!ensurePrivate(ctx) || !isAdmin(uidOf(ctx))) return;
        const id = String(ctx.match?.[1] || "");
        const token = String(ctx.match?.[2] || "");
        if (!consumeConfirmationToken(token, uidOf(ctx), "support_delete_user", id)) return ctx.answerCallbackQuery({ text: "This confirmation expired or was already used.", show_alert: true });
        const item = findCase(id);
        if (!item || item.category !== "data_deletion") return ctx.answerCallbackQuery({ text: "Deletion request not found.", show_alert: true });
        try {
          await processDeletion(ctx, item);
          try { await ctx.answerCallbackQuery({ text: "User data deleted" }); } catch {}
          return showAdminCases(ctx, "open", 0);
        } catch (err) {
          appendSecurityEvent("user_data_delete_failed", { actorUid: uidOf(ctx), caseId: id, reason: String(err?.message || err).slice(0, 120) });
          return ctx.answerCallbackQuery({ text: "Deletion failed. No success was recorded.", show_alert: true });
        }
      });
    }
    return baseStart.apply(this, args);
  };
}
