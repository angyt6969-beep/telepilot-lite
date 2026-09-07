import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  readAppSettings,
  writeAppSettings,
} from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const PAGE_SIZE = 8;

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function destinationsStatePath(uid) { return path.join(userDir(uid), "destinations-v2.json"); }
function joinQueuePath(uid) { return path.join(userDir(uid), "destination-join-v1.json"); }
function cleanupQueuePath(uid) { return path.join(userDir(uid), "destination-preparation-v1.json"); }

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
function inline(text, callback_data) { return { text, callback_data }; }
function rowsKeyboard(rows) { return { inline_keyboard: rows.filter(row => Array.isArray(row) && row.length) }; }
function token(value) { return crypto.createHash("sha1").update(String(value || "")).digest("base64url").slice(0, 11); }
function groupLabel(group) { return String(group?.username || group?.label || group?.id || "Destination"); }
function groupStatus(group) {
  if (group?.topicRequired === true && !Number(group?.topicId || 0)) return "topic";
  const rows = Object.values(group?.accountJoin || {});
  if (!rows.length) return "unchecked";
  if (rows.some(row => row?.status === "ready")) return "ready";
  if (rows.some(row => row?.status === "not_member")) return "not_member";
  return "issue";
}
function statusIcon(status) {
  return status === "ready" ? "✅" : status === "topic" ? "💬" : status === "not_member" ? "↗️" : status === "unchecked" ? "◌" : "⚠️";
}
function savedGroups(uid) {
  const groups = readAppSettings(uid).groups;
  return Array.isArray(groups) ? groups : [];
}

function buildRich(parts) {
  let text = "";
  const entities = [];
  for (const part of parts) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    const value = String(part?.text || "");
    const offset = text.length;
    text += value;
    if (value && ["bold", "italic"].includes(part?.type)) {
      entities.push({ type: part.type, offset, length: value.length });
    }
  }
  return { text, entities };
}

function manageScreen(uid, page = 0) {
  const groups = savedGroups(uid);
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const current = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const slice = groups.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const rows = slice.map(group => [
    inline(`${statusIcon(groupStatus(group))} ${groupLabel(group).slice(0, 38)}`, `d2_manage_item:${token(group.id)}:${current}`),
  ]);

  if (pages > 1) {
    const nav = [];
    if (current > 0) nav.push(inline("Previous", `d2_manage:${current - 1}`));
    nav.push(inline(`${current + 1}/${pages}`, "d2_noop"));
    if (current < pages - 1) nav.push(inline("Next", `d2_manage:${current + 1}`));
    rows.push(nav);
  }

  if (groups.length) rows.push([inline("🗑 Delete all", "d4_delete_all_confirm")]);
  rows.push([inline("← Destination Hub", "v1_destinations_v13")]);

  const rich = buildRich([
    "🗑 ",
    { text: "Manage destinations", type: "bold" },
    "\n\n",
    `Saved: ${groups.length}`,
    "\n\n",
    { text: groups.length ? "Choose a destination to manage it — or delete every saved destination at once." : "No destinations are saved yet — add destinations from the Destination Hub when you are ready.", type: "italic" },
  ]);
  return { ...rich, rows };
}

function confirmScreen(uid) {
  const total = savedGroups(uid).length;
  if (!total) return manageScreen(uid, 0);
  const rich = buildRich([
    "🗑 ",
    { text: "Delete all destinations", type: "bold" },
    "\n\n",
    `Saved destinations: ${total}`,
    "\n",
    "Telegram changes: none",
    "\n\n",
    { text: "This clears TelePilot’s saved destination list — it does not leave groups, unmute chats, or unarchive anything in Telegram.", type: "italic" },
    "\n\n",
    { text: "This action cannot be undone in TelePilot.", type: "bold" },
  ]);
  return {
    ...rich,
    rows: [
      [inline(`🗑 Delete all ${total}`, "d4_delete_all_execute")],
      [inline("← Cancel", "d2_manage:0")],
    ],
  };
}

function pendingJoinCount(raw) {
  return Object.values(raw?.tasks || {}).filter(task => ["pending", "request_pending"].includes(String(task?.status || ""))).length;
}
function pendingCleanupCount(raw) {
  return Object.values(raw?.tasks || {}).filter(task => task?.mute?.status === "pending" || task?.archive?.status === "pending").length;
}
function clearAutomationFiles(uid) {
  const joinFile = joinQueuePath(uid);
  const cleanupFile = cleanupQueuePath(uid);
  const joinState = readJson(joinFile, {});
  const cleanupState = readJson(cleanupFile, {});
  const result = {
    pendingJoins: pendingJoinCount(joinState),
    pendingCleanup: pendingCleanupCount(cleanupState),
    joinRecords: Object.keys(joinState?.tasks || {}).length,
    cleanupRecords: Object.keys(cleanupState?.tasks || {}).length,
  };
  try { fs.rmSync(joinFile, { force: true }); } catch {}
  try { fs.rmSync(cleanupFile, { force: true }); } catch {}
  return result;
}
function clearDestinationReview(uid) {
  const file = destinationsStatePath(uid);
  if (!fs.existsSync(file)) return;
  const state = readJson(file, {});
  writeJsonAtomic(file, {
    ...state,
    pendingInput: null,
    review: null,
    lastScan: null,
  });
}
function clearSavedDestinations(uid) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const removed = groups.length;
  writeAppSettings(uid, {
    ...settings,
    version: Math.max(5, Number(settings.version || 0)),
    groups: [],
  });
  syncUserGroups(uid);
  clearDestinationReview(uid);
  const queues = clearAutomationFiles(uid);
  return { removed, ...queues };
}

function successScreen(result) {
  const rich = buildRich([
    "✅ ",
    { text: "Destinations cleared", type: "bold" },
    "\n\n",
    `Removed: ${Number(result?.removed || 0)}`,
    "\n",
    `Pending joins cancelled: ${Number(result?.pendingJoins || 0)}`,
    "\n",
    `Pending cleanup cancelled: ${Number(result?.pendingCleanup || 0)}`,
    "\n\n",
    { text: "Telegram was left unchanged — only TelePilot’s saved destination data and queued destination work were cleared.", type: "italic" },
  ]);
  return {
    ...rich,
    rows: [
      [inline("＋ Add destinations", "d2_add")],
      [inline("← Destination Hub", "v1_destinations_v13")],
    ],
  };
}

async function editOrReply(ctx, screen) {
  const options = { reply_markup: rowsKeyboard(screen.rows || []) };
  if (Array.isArray(screen.entities) && screen.entities.length) options.entities = screen.entities;
  try { return await ctx.editMessageText(screen.text, options); }
  catch { return ctx.reply(screen.text, options); }
}

export function installDestinationDeleteAll(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotDestinationDeleteAllInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for destination delete-all");
  Object.defineProperty(BotClass.prototype, "__telepilotDestinationDeleteAllInstalled", { value: true });

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotDestinationDeleteAllHandlers) {
      Object.defineProperty(this, "__telepilotDestinationDeleteAllHandlers", { value: true });

      // Register this d2_manage handler before Destinations v2 registers its legacy
      // manage renderer. Individual destination actions still remain owned by v2.
      this.callbackQuery(/^d2_manage:(\d+)$/, async ctx => {
        await ctx.answerCallbackQuery();
        await editOrReply(ctx, manageScreen(String(ctx.from?.id || ""), Number(ctx.match[1])));
      });

      this.callbackQuery("d4_delete_all_confirm", async ctx => {
        await ctx.answerCallbackQuery();
        await editOrReply(ctx, confirmScreen(String(ctx.from?.id || "")));
      });

      this.callbackQuery("d4_delete_all_execute", async ctx => {
        const uid = String(ctx.from?.id || "");
        const result = clearSavedDestinations(uid);
        await ctx.answerCallbackQuery({ text: result.removed ? `Deleted ${result.removed} destinations` : "No destinations to delete" });
        await editOrReply(ctx, result.removed ? successScreen(result) : manageScreen(uid, 0));
        console.log(`TelePilot delete-all destinations completed for ${uid}: removed=${result.removed}, pendingJoins=${result.pendingJoins}, pendingCleanup=${result.pendingCleanup}`);
      });
    }
    return originalStart.apply(this, args);
  };

  console.log("TelePilot destination delete-all control enabled");
}

export const __test = {
  buildRich,
  clearAutomationFiles,
  pendingJoinCount,
  pendingCleanupCount,
  statusIcon,
  token,
};
