import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard } from "grammy";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const REFERRAL_FILE = path.join(DATA_DIR, "referrals.json");

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

function normalizeDb(raw) {
  return {
    version: 1,
    seen: raw?.seen && typeof raw.seen === "object" ? { ...raw.seen } : {},
    attributions: raw?.attributions && typeof raw.attributions === "object" ? { ...raw.attributions } : {},
  };
}

export function readReferralDb() {
  return normalizeDb(readJson(REFERRAL_FILE, {}));
}

function userExistedBeforeReferralFeature(uid) {
  const dir = path.join(USERS_DIR, String(uid));
  if (!fs.existsSync(dir)) return false;
  try { return fs.readdirSync(dir).length > 0; }
  catch { return true; }
}

export function parseReferralPayload(text) {
  const match = String(text || "").trim().match(/^\/start(?:@\w+)?\s+ref_(\d+)$/i);
  return match ? match[1] : "";
}

export function recordStart(uid, startText, now = Date.now(), options = {}) {
  const referredUid = String(uid || "");
  if (!/^\d+$/.test(referredUid)) return { credited: false, reason: "invalid_user" };

  const db = options.db ? normalizeDb(options.db) : readReferralDb();
  const persist = options.persist !== false;
  const existed = typeof options.existed === "boolean"
    ? options.existed
    : userExistedBeforeReferralFeature(referredUid);
  const alreadySeen = Boolean(db.seen[referredUid]);
  const inviterUid = parseReferralPayload(startText);

  if (!alreadySeen) db.seen[referredUid] = now;

  let result = { credited: false, reason: alreadySeen || existed ? "not_new" : "no_referral" };
  if (!alreadySeen && !existed && inviterUid) {
    if (inviterUid === referredUid) {
      result = { credited: false, reason: "self_referral" };
    } else if (db.attributions[referredUid]) {
      result = { credited: false, reason: "already_attributed" };
    } else {
      const inviterExists = Boolean(db.seen[inviterUid]) || userExistedBeforeReferralFeature(inviterUid);
      if (!inviterExists && options.allowUnknownInviter !== true) {
        result = { credited: false, reason: "unknown_inviter" };
      } else {
        db.attributions[referredUid] = { inviterUid, attributedAt: now };
        result = { credited: true, reason: "credited", inviterUid, referredUid };
      }
    }
  }

  if (persist) writeJsonAtomic(REFERRAL_FILE, db);
  return { ...result, db };
}

export function referralCount(uid, db = readReferralDb()) {
  const inviterUid = String(uid || "");
  return Object.values(db.attributions || {}).filter(row => String(row?.inviterUid || "") === inviterUid).length;
}

export function inviterFor(uid, db = readReferralDb()) {
  return String(db.attributions?.[String(uid)]?.inviterUid || "");
}

function referralText(uid, count) {
  return [
    "🔥 Referrals",
    "",
    "Invite friends — your personal link tracks successful referrals automatically.",
    "",
    `Successful referrals: ${count}`,
    "Tracking: One referral per new TelePilot user",
    "",
    "Share your link below. Self-referrals and repeat attribution are ignored.",
  ].join("\n");
}

function italicEntity(text) {
  const line = "Invite friends — your personal link tracks successful referrals automatically.";
  const offset = text.indexOf(line);
  return offset >= 0 ? [{ type: "italic", offset, length: line.length }] : [];
}

async function showReferral(ctx) {
  const uid = String(ctx.from?.id || "");
  const username = String(ctx.me?.username || "").replace(/^@/, "");
  if (!uid || !username) {
    await ctx.answerCallbackQuery?.({ text: "Could not build your referral link right now.", show_alert: true }).catch?.(() => {});
    return;
  }
  const link = `https://t.me/${username}?start=ref_${uid}`;
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Join me on TelePilot")}`;
  const count = referralCount(uid);
  const text = referralText(uid, count);
  const keyboard = new InlineKeyboard()
    .copyText("📋 Copy link", link)
    .url("📤 Share", share)
    .row()
    .text("🔄 Refresh", "referrals")
    .row()
    .text("⬅️ Dashboard", "v1_dashboard_v13");
  const other = { reply_markup: keyboard, entities: italicEntity(text) };
  try { await ctx.editMessageText(text, other); }
  catch { await ctx.reply(text, other); }
}

function addReferralButton(text, other) {
  if (!String(text || "").startsWith("✈️ TelePilot") || !other?.reply_markup?.inline_keyboard) return other;
  const rows = other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button })));
  if (rows.some(row => row.some(button => button?.callback_data === "referrals"))) return other;
  const adminIndex = rows.findIndex(row => row.some(button => String(button?.callback_data || "").startsWith("admin")));
  const row = [{ text: "🔥 Referrals", callback_data: "referrals" }];
  rows.splice(adminIndex >= 0 ? adminIndex : rows.length, 0, row);
  return { ...other, reply_markup: { ...other.reply_markup, inline_keyboard: rows } };
}

export function installReferralSystem(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotReferralSystemInstalled) return false;
  const originalCommand = BotClass.prototype.command;
  const originalStart = BotClass.prototype.start;
  if (typeof originalCommand !== "function" || typeof originalStart !== "function") {
    throw new Error("Unsupported grammY Bot shape for referral system");
  }
  Object.defineProperty(BotClass.prototype, "__telepilotReferralSystemInstalled", { value: true });

  BotClass.prototype.command = function(command, ...middleware) {
    const isStart = command === "start" || (Array.isArray(command) && command.includes("start"));
    if (isStart) {
      middleware = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
        if (ctx?.chat?.type === "private" && ctx?.from?.id) {
          try { recordStart(ctx.from.id, ctx.message?.text || ""); }
          catch (err) { console.warn("Referral attribution failed:", err?.message || err); }
        }
        return handler.call(this, ctx, next);
      });
    }
    return originalCommand.call(this, command, ...middleware);
  };

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotReferralHandlersInstalled) {
      Object.defineProperty(this, "__telepilotReferralHandlersInstalled", { value: true });
      this.callbackQuery("referrals", async ctx => {
        try { await ctx.answerCallbackQuery(); } catch {}
        await showReferral(ctx);
      });
    }
    return originalStart.apply(this, args);
  };
  return true;
}

export function installReferralUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotReferralUiInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for referral UI");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotReferralUiInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    return originalSendMessage.call(this, chatId, text, addReferralButton(text, other), ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    return originalEditMessageText.call(this, chatId, messageId, text, addReferralButton(text, other), ...rest);
  };
  return true;
}

export const __test = { addReferralButton, normalizeDb, referralText, userExistedBeforeReferralFeature };
