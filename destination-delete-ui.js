import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readAppSettings, writeAppSettings } from "./posting-engine-enhancements.js";
import { reloadUserState, syncUserGroups } from "./runtime-hooks.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const DELETE_PAGE_SIZE = 8;
const DELETE_CONFIRM_TTL_MS = 2 * 60_000;
const deleteAllConfirmations = new Map();

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function automationPath(uid) { return path.join(userDir(uid), "destination-automation.json"); }
function archiveQueuePath(uid) { return path.join(userDir(uid), "archive-mute-queue.json"); }
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
function token(value) { return crypto.createHash("sha1").update(String(value || "")).digest("base64url").slice(0, 11); }
function destinationLabel(group) {
  const base = String(group?.username || group?.label || group?.id || "Destination");
  return group?.topicTitle ? `${base} → ${group.topicTitle}` : base;
}
function cleanDestinationQueues(uid, destinationId = "") {
  const id = String(destinationId || "");
  const automation = readJson(automationPath(uid), {});
  if (id) {
    automation.topicQueue = (Array.isArray(automation.topicQueue) ? automation.topicQueue : []).filter(row => String(row?.destinationId || "") !== id);
    automation.routingQueue = (Array.isArray(automation.routingQueue) ? automation.routingQueue : []).filter(row => String(row?.destinationId || "") !== id);
  } else {
    automation.topicQueue = [];
    automation.unresolvedInvites = [];
    automation.routingQueue = [];
    automation.joinQueue = [];
    automation.joinCooldowns = {};
  }
  writeJsonAtomic(automationPath(uid), automation);

  const archive = readJson(archiveQueuePath(uid), {});
  if (id) {
    archive.pending = (Array.isArray(archive.pending) ? archive.pending : []).filter(row => String(row?.destinationId || "") !== id);
  } else {
    archive.scanAccounts = [];
    archive.pending = [];
    archive.cooldowns = {};
  }
  writeJsonAtomic(archiveQueuePath(uid), archive);
}
function saveGroups(uid, groups) {
  const settings = readAppSettings(uid);
  const next = {
    ...settings,
    groups,
    ...(groups.length ? {} : { postingEnabled: false, nextRunAt: null }),
  };
  writeAppSettings(uid, next);
  if (groups.length) syncUserGroups(uid);
  else reloadUserState(uid);
  return next;
}
function deleteOne(uid, destinationToken) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const index = groups.findIndex(group => token(group?.id) === String(destinationToken));
  if (index < 0) return null;
  const removed = groups[index];
  const remaining = groups.filter((_, current) => current !== index);
  cleanDestinationQueues(uid, removed.id);
  saveGroups(uid, remaining);
  return { removed, remaining };
}
function deleteAll(uid) {
  cleanDestinationQueues(uid);
  saveGroups(uid, []);
  return true;
}

async function showDeleteMenu(ctx) {
  const uid = String(ctx.from?.id || "");
  const count = (readAppSettings(uid).groups || []).length;
  await ctx.editMessageText(
    [
      "🗑 Delete Groups",
      "",
      `Saved destinations  ${count}`,
      "",
      "Delete manually lets you choose individual groups.",
      "Delete all removes every saved destination and cancels pending auto-joins.",
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🗑 Delete manually", callback_data: "v1_delete_manual_v13:0" }],
          [{ text: "⚠️ Delete all", callback_data: "v1_delete_all_v13" }],
          [{ text: "📁 Destinations", callback_data: "v1_destinations_v13" }],
        ],
      },
    },
  );
}
async function showManualDelete(ctx, requestedPage = 0) {
  const uid = String(ctx.from?.id || "");
  const groups = readAppSettings(uid).groups || [];
  if (!groups.length) {
    return ctx.editMessageText("🗑 Delete Groups\n\nNo saved destinations remain.", {
      reply_markup: { inline_keyboard: [[{ text: "📁 Destinations", callback_data: "v1_destinations_v13" }]] },
    });
  }
  const pages = Math.max(1, Math.ceil(groups.length / DELETE_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
  const start = page * DELETE_PAGE_SIZE;
  const rows = groups.slice(start, start + DELETE_PAGE_SIZE).map(group => ([{
    text: `✖ ${destinationLabel(group).slice(0, 42)}`,
    callback_data: `v1_delete_one_v13:${token(group.id)}:${page}`,
  }]));
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: "◀ Prev", callback_data: `v1_delete_manual_v13:${page - 1}` });
    if (page < pages - 1) nav.push({ text: "Next ▶", callback_data: `v1_delete_manual_v13:${page + 1}` });
    if (nav.length) rows.push(nav);
  }
  rows.push([{ text: "🗑 Delete Groups", callback_data: "v1_delete_groups_v13" }]);
  rows.push([{ text: "📁 Destinations", callback_data: "v1_destinations_v13" }]);
  await ctx.editMessageText([
    "🗑 Delete manually",
    "",
    "Tap a destination to remove it immediately.",
    "",
    `Page ${page + 1}/${pages} · ${groups.length} saved`,
  ].join("\n"), { reply_markup: { inline_keyboard: rows } });
}

export function installDestinationDeleteControls(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotDestinationDeleteControlsInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for destination delete controls");

  Object.defineProperty(BotClass.prototype, "__telepilotDestinationDeleteControlsInstalled", { value: true });
  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotDestinationDeleteHandlersRegistered) {
      Object.defineProperty(this, "__telepilotDestinationDeleteHandlersRegistered", { value: true });
      this.callbackQuery("v1_delete_groups_v13", async ctx => {
        await ctx.answerCallbackQuery();
        await showDeleteMenu(ctx);
      });
      this.callbackQuery(/^v1_delete_manual_v13:(\d+)$/, async ctx => {
        await ctx.answerCallbackQuery();
        await showManualDelete(ctx, Number(ctx.match?.[1] || 0));
      });
      this.callbackQuery(/^v1_delete_one_v13:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {
        const uid = String(ctx.from?.id || "");
        const result = deleteOne(uid, String(ctx.match?.[1] || ""));
        if (!result) return ctx.answerCallbackQuery({ text: "That destination is no longer saved.", show_alert: true });
        await ctx.answerCallbackQuery({ text: `Deleted ${destinationLabel(result.removed).slice(0, 80)}` });
        if (result.remaining.length) await showManualDelete(ctx, Number(ctx.match?.[2] || 0));
        else await ctx.editMessageText("🗑 Delete Groups\n\nAll saved destinations have been removed.", {
          reply_markup: { inline_keyboard: [[{ text: "📁 Destinations", callback_data: "v1_destinations_v13" }]] },
        });
      });
      this.callbackQuery("v1_delete_all_v13", async ctx => {
        const uid = String(ctx.from?.id || "");
        const count = (readAppSettings(uid).groups || []).length;
        deleteAllConfirmations.set(uid, Date.now() + DELETE_CONFIRM_TTL_MS);
        await ctx.answerCallbackQuery();
        await ctx.editMessageText([
          "⚠️ Delete all groups?",
          "",
          `This will remove all ${count} saved destinations, stop posting if necessary, and cancel queued auto-joins/archive tasks.",
          "",
          "This cannot be undone.",
        ].join("\n"), {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⚠️ Yes, delete all", callback_data: "v1_delete_all_confirm_v13" }],
              [{ text: "Cancel", callback_data: "v1_delete_groups_v13" }],
            ],
          },
        });
      });
      this.callbackQuery("v1_delete_all_confirm_v13", async ctx => {
        const uid = String(ctx.from?.id || "");
        const expires = Number(deleteAllConfirmations.get(uid) || 0);
        deleteAllConfirmations.delete(uid);
        if (expires <= Date.now()) {
          return ctx.answerCallbackQuery({ text: "This confirmation expired. Open Delete all again.", show_alert: true });
        }
        deleteAll(uid);
        await ctx.answerCallbackQuery({ text: "All destinations deleted" });
        await ctx.editMessageText("🗑 Delete Groups\n\nAll saved destinations and pending auto-join tasks were removed.", {
          reply_markup: { inline_keyboard: [[{ text: "📁 Destinations", callback_data: "v1_destinations_v13" }]] },
        });
      });
    }
    return originalStart.apply(this, args);
  };
}

function cloneMarkup(other) {
  if (!other?.reply_markup?.inline_keyboard) return other;
  return {
    ...(other || {}),
    reply_markup: {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    },
  };
}

function addDeleteGroupsButton(text, other) {
  if (!String(text || "").startsWith("📁 Destinations")) return other;
  const next = cloneMarkup(other) || { reply_markup: { inline_keyboard: [] } };
  const rows = next.reply_markup.inline_keyboard || [];
  if (rows.some(row => row.some(button => button.callback_data === "v1_delete_groups_v13"))) return next;

  const deleteRow = [{ text: "🗑 Delete Groups", callback_data: "v1_delete_groups_v13" }];
  const dashboardIndex = rows.findIndex(row => row.some(button => button.callback_data === "v1_dashboard_v13"));
  if (dashboardIndex >= 0) rows.splice(dashboardIndex, 0, deleteRow);
  else rows.push(deleteRow);
  next.reply_markup.inline_keyboard = rows;
  return next;
}

export function installDestinationDeleteUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotDestinationDeleteUiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for destination delete UI");
  }

  Object.defineProperty(ApiClass.prototype, "__telepilotDestinationDeleteUiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    return originalSendMessage.call(this, chatId, text, addDeleteGroupsButton(text, other), ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    return originalEditMessageText.call(this, chatId, messageId, text, addDeleteGroupsButton(text, other), ...rest);
  };
}
