import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import { effectiveAccountIds, listAccounts, usesBotSender } from "./account-store.js";
import { destinationAccountReady } from "./destination-automation.js";
import { readAppSettings, writeAppSettings } from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";
import { readQolState, writeQolState } from "./qol-store.js";
import { readV1, writeV1 } from "./v1-engine.js";

function uidOf(ctx) { return String(ctx?.from?.id || ""); }
function inline(text, callback_data) { return { text, callback_data }; }
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
function hasCallback(other, callbackData) {
  return (other?.reply_markup?.inline_keyboard || []).flat().some(button => button?.callback_data === callbackData);
}
function insertBeforeDashboard(other, row) {
  const next = copyMarkup(other) || { reply_markup: { inline_keyboard: [] } };
  next.reply_markup ||= { inline_keyboard: [] };
  next.reply_markup.inline_keyboard ||= [];
  const index = next.reply_markup.inline_keyboard.findIndex(buttonRow => buttonRow.some(button => button?.callback_data === "v1_dashboard_v13"));
  if (index >= 0) next.reply_markup.inline_keyboard.splice(index, 0, row);
  else next.reply_markup.inline_keyboard.push(row);
  return next;
}
function transformTutorial(text, other) {
  let value = String(text || "");
  if (value.startsWith("👋 Welcome to TelePilot")) {
    value = value.replace(
      "The main app is organized into Home, Posting Setup, Accounts, Destinations and Settings.",
      "The main app is organized into Dashboard, Posting Setup, Activity, Accounts, Destinations and Settings.",
    );
  }
  if (value.startsWith("👀 Step 5 of 5 — Preview")) {
    value = value.replace(
      "Starting from Home is now one tap",
      "Starting from the Dashboard is now one tap",
    );
  }
  if (value.startsWith("✅ Access activated")) {
    value = value.replace(
      "We will configure Accounts → Destinations → Posting Setup → Preview.",
      "We will configure Accounts → Destinations/Addlists → Posting Setup → Preview, then use Activity to monitor it.",
    );
  }
  return { text: value, other };
}
function transform(text, other) {
  let result = transformTutorial(text, other);
  const value = String(result.text || "");
  if (value.startsWith("📝 Posting Setup") && !hasCallback(result.other, "v1_send_once_v13")) {
    result.other = insertBeforeDashboard(result.other, [inline("⚡ Send Once", "v1_send_once_v13"), inline("🕒 Schedule Once", "v1_once_add")]);
  }
  if (value.startsWith("📁 Destinations") && !hasCallback(result.other, "v1_dest_browse_v13")) {
    result.other = insertBeforeDashboard(result.other, [inline("📋 Browse", "v1_dest_browse_v13")]);
  }
  if (value.startsWith("🕘 Import History") && !hasCallback(result.other, "v1_import_undo_v13")) {
    result.other = insertBeforeDashboard(result.other, [inline("↩ Undo Latest Import", "v1_import_undo_v13")]);
  }
  return result;
}
function latestUndoableImport(uid) {
  const qol = readQolState(uid);
  return [...qol.importHistory].reverse().find(row => !row?.undoneAt && Array.isArray(row?.destinationIds) && row.destinationIds.length) || null;
}
function importLabel(row) {
  return String(row?.source || "latest import").slice(0, 80);
}
function removeImportedDestinations(uid, importId) {
  const qol = readQolState(uid);
  const row = qol.importHistory.find(item => String(item?.id || "") === String(importId || ""));
  if (!row || row.undoneAt || !Array.isArray(row.destinationIds) || !row.destinationIds.length) return { ok: false, removed: 0 };
  const ids = new Set(row.destinationIds.map(String));
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const nextGroups = groups.filter(group => !ids.has(String(group?.id || "")));
  const removed = groups.length - nextGroups.length;
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups: nextGroups });
  row.undoneAt = Date.now();
  row.undoneRemoved = removed;
  writeQolState(uid, qol);
  try { syncUserGroups(uid); } catch {}
  return { ok: true, removed };
}
function readyDestinationCount(uid) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const pro = readV1(uid);
  const disabled = new Set((pro.disabledDestinationIds || []).map(String));
  let ready = 0;
  for (const group of settings.groups || []) {
    if (disabled.has(String(group?.id || ""))) continue;
    if (group?.topicRequired === true && !Number(group?.topicId || 0)) continue;
    if (usesBotSender(settings, group, accounts)) { ready++; continue; }
    const ids = effectiveAccountIds(settings, group, accounts);
    if (ids.some(accountId => destinationAccountReady(group, accountId))) ready++;
  }
  return ready;
}
function queueSendOnce(uid) {
  const settings = readAppSettings(uid);
  const pro = readV1(uid);
  if (!String(settings.adMessage || "").trim()) return { ok: false, error: "Set a message first." };
  const ready = readyDestinationCount(uid);
  if (!ready) return { ok: false, error: "No destination is ready. Fix destination issues first." };
  if (pro.paused === true) return { ok: false, error: "Posting is paused. Resume it from Activity before sending once." };
  const recent = (pro.oneTimeJobs || []).find(job => job?.quickSend === true && (!job.status || job.status === "pending") && Number(job.createdAt || 0) > Date.now() - 30_000);
  if (recent) return { ok: false, queued: true, error: "A Send Once job is already queued." };
  pro.oneTimeJobs ||= [];
  pro.oneTimeJobs.push({
    id: `quick_${crypto.randomBytes(5).toString("hex")}`,
    runAt: Date.now(),
    templateId: "",
    status: "pending",
    createdAt: Date.now(),
    nextAttemptAt: 0,
    delivered: [],
    attempts: 0,
    quickSend: true,
  });
  writeV1(uid, pro);
  return { ok: true, ready };
}
function registerCallbacks(bot) {
  bot.callbackQuery("v1_send_once_v13", async ctx => {
    const uid = uidOf(ctx);
    const result = queueSendOnce(uid);
    await ctx.answerCallbackQuery({
      text: result.ok ? `Queued for ${result.ready} ready destination${result.ready === 1 ? "" : "s"}.` : result.error,
      show_alert: !result.ok && !result.queued,
    });
    if (!result.ok) return;
    await ctx.editMessageText([
      "⚡ Send Once queued",
      "",
      `Ready destinations  ${result.ready}`,
      "",
      "The one-time worker will send this setup on its next scheduler tick (normally within about 30 seconds). It does not turn interval posting on.",
      "",
      "Open Activity to watch the result.",
    ].join("\n"), {
      reply_markup: new InlineKeyboard()
        .text("📊 Activity", "v1_activity_v13")
        .row()
        .text("📝 Posting Setup", "v1_posting_setup_v13"),
    });
  });
  bot.callbackQuery("v1_import_undo_v13", async ctx => {
    const uid = uidOf(ctx);
    const row = latestUndoableImport(uid);
    if (!row) return ctx.answerCallbackQuery({ text: "There is no import available to undo.", show_alert: true });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText([
      "↩ Undo Latest Import",
      "",
      `Import  ${importLabel(row)}`,
      `Destinations added  ${row.destinationIds.length}`,
      "",
      "This removes only destinations that were newly added by that import. Existing destinations and duplicate matches are left alone.",
      "",
      "This is destructive, so it requires this one confirmation.",
    ].join("\n"), {
      reply_markup: new InlineKeyboard()
        .text("⚠️ Confirm Undo", `v1_import_undo_confirm_v13:${row.id}`)
        .row()
        .text("🕘 Cancel", "v1_import_history_v13"),
    });
  });
  bot.callbackQuery(/^v1_import_undo_confirm_v13:([A-Za-z0-9_-]+)$/, async ctx => {
    const uid = uidOf(ctx);
    const result = removeImportedDestinations(uid, ctx.match[1]);
    await ctx.answerCallbackQuery({ text: result.ok ? `Removed ${result.removed} imported destination${result.removed === 1 ? "" : "s"}` : "That import can no longer be undone.", show_alert: !result.ok });
    const qol = readQolState(uid);
    const rows = qol.importHistory.slice(-12).reverse();
    const history = rows.length ? rows.map(row => {
      const date = new Date(Number(row.at || 0)).toISOString().replace("T", " ").slice(0, 16);
      const undone = row.undoneAt ? ` · undone (${Number(row.undoneRemoved || 0)} removed)` : "";
      return `• ${date} UTC · ${row.source}\n  +${row.added} added · ${row.duplicates} duplicate · ${row.attention} attention · ${row.failed} failed${undone}`;
    }).join("\n\n") : "No v1.3 imports yet.";
    await ctx.editMessageText(["🕘 Import History", "", history, "", "Import history never removes anything unless you explicitly confirm Undo."].join("\n"), {
      reply_markup: new InlineKeyboard()
        .text("↩ Undo Latest Import", "v1_import_undo_v13").row()
        .text("📁 Destinations", "v1_destinations_v13"),
    });
  });
}

export function installUxV13PolishNavigation(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotUxV13PolishBotInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for TelePilot v1.3 polish");
  Object.defineProperty(BotClass.prototype, "__telepilotUxV13PolishBotInstalled", { value: true });
  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotUxV13PolishHandlersRegistered) {
      Object.defineProperty(this, "__telepilotUxV13PolishHandlersRegistered", { value: true });
      registerCallbacks(this);
    }
    return originalStart.apply(this, args);
  };
}

export function installUxV13Polish(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotUxV13PolishApiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for TelePilot v1.3 polish");
  Object.defineProperty(ApiClass.prototype, "__telepilotUxV13PolishApiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = transform(text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = transform(text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
}
