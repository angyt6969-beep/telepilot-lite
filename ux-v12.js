import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard } from "grammy";
import { listAccounts, senderSummary } from "./account-store.js";
import { readAppSettings } from "./posting-engine-enhancements.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function adminIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) if (/^\d+$/.test(part)) ids.add(part);
  }
  const saved = readJson(ADMIN_FILE, {});
  for (const id of Array.isArray(saved?.adminIds) ? saved.adminIds : []) if (/^\d+$/.test(String(id))) ids.add(String(id));
  return ids;
}
function isAdmin(uid) { return adminIds().has(String(uid)); }
function cb(text, callback_data) { return { text, callback_data }; }
function lineValue(text, prefix) {
  const line = String(text || "").split("\n").find(value => value.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}
function replaceKeyboard(other, rows) { return { ...(other || {}), reply_markup: { inline_keyboard: rows } }; }
function copyMarkup(other) {
  if (!other?.reply_markup?.inline_keyboard) return other;
  return {
    ...(other || {}),
    reply_markup: {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    },
  };
}
function relabelNavigation(other, callbackData, text) {
  const next = copyMarkup(other);
  for (const row of next?.reply_markup?.inline_keyboard || []) {
    for (const button of row) if (button.callback_data === callbackData) button.text = text;
  }
  return next;
}
function rerouteBack(other, fromCallback, toCallback, text) {
  const next = copyMarkup(other);
  for (const row of next?.reply_markup?.inline_keyboard || []) {
    for (const button of row) {
      if (button.callback_data === fromCallback && /back|dashboard|home/i.test(String(button.text || ""))) {
        button.callback_data = toCallback;
        button.text = text;
      }
    }
  }
  return next;
}

function transformHome(text, other) {
  const live = text.includes("● LIVE") || text.includes("Autoposting active");
  const sender = lineValue(text, "Sender  ") || "TelePilot Bot";
  const message = lineValue(text, "Message  ") || "Not set";
  const destinationsRaw = lineValue(text, "Destinations  ") || "0";
  const timing = lineValue(text, "Schedule  ") || "30 min";
  const next = lineValue(text, "Next post  ");
  const destinations = Number.parseInt(destinationsRaw, 10) || 0;
  const messageReady = !/not set/i.test(message);
  const ready = messageReady && destinations > 0;
  const status = live ? "● LIVE" : ready ? "● READY" : "○ SETUP";
  const nextStep = !messageReady
    ? "Open Posting Setup to create your message."
    : !destinations
      ? "Add at least one destination to continue."
      : "Ready to start posting.";
  const rows = [
    [cb("▶ Start", "start"), cb("⏹ Stop", "stop")],
    [cb("⌂ Home", "home"), cb("🧩 Posting Setup", "posting_setup")],
    [cb("👤 Accounts", "account"), cb("📍 Destinations", "groups")],
    [cb("⚙️ Settings", "settings_v12")],
  ];
  if ((other?.reply_markup?.inline_keyboard || []).flat().some(button => button.callback_data === "admin")) {
    rows.push([{ text: "🟣 ADMIN PANEL", callback_data: "admin", style: "primary" }]);
  }
  return {
    text: [
      "✈️ TelePilot",
      status,
      "",
      `Sender  ${sender}`,
      `Post  ${message}`,
      `Destinations  ${destinations}`,
      `Timing  ${timing}`,
      live && next ? `Next post  ${next}` : null,
      "",
      live ? "Posting is running. Changes are saved for the next cycle." : nextStep,
    ].filter(Boolean).join("\n"),
    other: replaceKeyboard(other, rows),
  };
}

function normalizeDestinationNav(text, other) {
  let next = relabelNavigation(other, "home", "← Home");
  next = relabelNavigation(next, "groups", "← Destinations");
  return { text, other: next };
}
function transformSectionBack(text, other) {
  let next = rerouteBack(other, "home", "posting_setup", "← Posting Setup");
  next = relabelNavigation(next, "posting_setup", "← Posting Setup");
  return { text, other: next };
}

function transform(text, other) {
  const value = String(text || "");
  if (value.startsWith("✈️ TelePilot") && (value.includes("Sender  ") || value.includes("Autoposting active"))) return transformHome(value, other);
  if (value.startsWith("🧩 Posting Setup")) {
    const uid = lineValue(value, "__uid:");
    const clean = value.split("\n").filter(line => !line.startsWith("__uid:")).join("\n");
    const rows = [
      [cb("📝 Message", "message"), cb("⏱ Timing", "interval")],
      [cb("👀 Smart Preview", "v1_preview")],
      [cb("⚡ Advanced", "v1_tools")],
      [cb("← Home", "home")],
    ];
    return { text: clean, other: replaceKeyboard(other, rows) };
  }
  if (value.startsWith("⚙️ Settings")) {
    const clean = value.split("\n").filter(line => !line.startsWith("__uid:")).join("\n");
    const rows = [
      [cb("🔑 Access", "access"), cb("📊 Activity", "activity")],
      [cb("💬 Support", "support"), cb("❓ Tutorial", "tutorial_restart")],
      [cb("← Home", "home")],
    ];
    return { text: clean, other: replaceKeyboard(other, rows) };
  }
  if (value.startsWith("📝 Message") || value.startsWith("⏱ Schedule") || value.startsWith("👁 Smart preview")) return transformSectionBack(value, other);
  if (value.startsWith("📍 Add destination")) {
    const next = relabelNavigation(other, "groups", "← Destinations");
    return {
      text: [
        "📍 Add destinations",
        "",
        "Paste one or many Telegram destinations, one per line.",
        "",
        "Supported: @usernames, public links, private t.me/+ invites and t.me/addlist/... shared folders.",
        "With a selected personal sender, TelePilot joins missing chats automatically. Forum groups ask you to choose the exact posting topic.",
        "Join requests and verification-required groups stay Pending until Telegram allows posting.",
        "",
        "TelePilot Bot destinations still require the bot to be added with posting permission."
      ].join("\n"),
      other: next,
    };
  }
  if (value.startsWith("📍 Destinations") || value.startsWith("💬 Choose posting topics") || value.startsWith("⏳ Pending & verification")) return normalizeDestinationNav(value, other);
  return { text: value, other };
}

function setupSummary(uid) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const sender = senderSummary(settings, accounts);
  const message = String(settings.adMessage || "").trim();
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const timing = Number(settings.intervalMinutes || 30);
  const unresolved = groups.filter(group => group.topicRequired === true && !Number(group.topicId || 0)).length;
  return [
    "🧩 Posting Setup",
    "",
    `Sender  ${sender}`,
    `Message  ${message ? `Ready · ${message.length} chars` : "Not set"}`,
    `Destinations  ${groups.length}${unresolved ? ` · ${unresolved} need a topic` : ""}`,
    `Timing  every ${timing} min`,
    "",
    "The essentials stay here. Less common controls are under Advanced.",
    `__uid:${uid}`,
  ].join("\n");
}
function settingsSummary(uid) {
  const settings = readAppSettings(uid);
  const access = settings.accessRevoked === true
    ? "Revoked"
    : settings.accessLifetime === true
      ? "Lifetime"
      : Number(settings.accessUntil || 0) > Date.now()
        ? "Active"
        : "Inactive";
  return [
    "⚙️ Settings",
    "",
    `Access  ${access}`,
    "",
    "Support, activity and tutorial controls are kept here so the main screen stays focused on posting.",
    `__uid:${uid}`,
  ].join("\n");
}
async function editOrReply(ctx, text, keyboard) {
  const opts = { reply_markup: keyboard || new InlineKeyboard().text("← Home", "home") };
  if (ctx.callbackQuery?.message) {
    try { return await ctx.editMessageText(text, opts); } catch {}
  }
  return ctx.reply(text, opts);
}
function registerHandlers(bot) {
  bot.callbackQuery("posting_setup", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    await editOrReply(ctx, setupSummary(uid), new InlineKeyboard().text("placeholder", "home"));
  });
  bot.callbackQuery("settings_v12", async ctx => {
    await ctx.answerCallbackQuery();
    const uid = String(ctx.from?.id || "");
    await editOrReply(ctx, settingsSummary(uid), new InlineKeyboard().text("placeholder", "home"));
  });
}
export function installUxNavigation(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotUxV12BotInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for TelePilot v1.2 navigation");
  Object.defineProperty(BotClass.prototype, "__telepilotUxV12BotInstalled", { value: true });
  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotUxV12HandlersRegistered) {
      Object.defineProperty(this, "__telepilotUxV12HandlersRegistered", { value: true });
      registerHandlers(this);
    }
    return originalStart.apply(this, args);
  };
}
export function installUxV12(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotUxV12ApiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for TelePilot v1.2 UX");
  Object.defineProperty(ApiClass.prototype, "__telepilotUxV12ApiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = transform(text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = transform(text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
}
