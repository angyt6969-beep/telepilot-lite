import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import {
  hasPersonalSessionFile,
  listUserIds,
  readAppSettings,
} from "./posting-engine-enhancements.js";
import {
  queuePreview,
  readV1,
  v1Stats,
  writeV1,
} from "./v1-engine.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const KEY_FILE = path.join(DATA_DIR, "access-keys.json");
const pending = new Map();
let appTextHandler = null;
let appMessageChangeHandler = null;
let appStopHandler = null;
let appDisconnectHandler = null;
let genKeyHandler = null;
let revokeHandler = null;

function uidOf(ctx) { return ctx?.from?.id ? String(ctx.from.id) : ""; }
function destinationId(group) { return String(group?.id || group?.username || ""); }
function destinationLabel(group) { return String(group?.username || group?.label || group?.id || "Destination"); }

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}

function isAdmin(uid) {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) if (/^\d+$/.test(part)) ids.add(part);
  }
  const persisted = readJson(ADMIN_FILE, {});
  for (const value of Array.isArray(persisted.adminIds) ? persisted.adminIds : []) ids.add(String(value));
  return ids.has(String(uid));
}

function fmtDateTime(ms) {
  if (!Number(ms || 0)) return "—";
  return new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function fmtAgo(ms) {
  if (!Number(ms || 0)) return "Never";
  const diff = Math.max(0, Date.now() - Number(ms));
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function daysLabel(days) {
  const set = new Set((days || []).map(Number));
  if (set.size === 7) return "Every day";
  if ([1,2,3,4,5].every(day => set.has(day)) && set.size === 5) return "Weekdays";
  if (set.has(0) && set.has(6) && set.size === 2) return "Weekends";
  const names = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  return names.filter((_, index) => set.has(index)).join(", ") || "No days";
}

function parseDays(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "daily" || raw === "everyday" || raw === "all") return [0,1,2,3,4,5,6];
  if (raw === "weekdays") return [1,2,3,4,5];
  if (raw === "weekends" || raw === "weekend") return [0,6];
  const map = new Map([
    ["sun",0],["sunday",0],["mon",1],["monday",1],["tue",2],["tues",2],["tuesday",2],
    ["wed",3],["wednesday",3],["thu",4],["thur",4],["thursday",4],["fri",5],["friday",5],
    ["sat",6],["saturday",6],
  ]);
  const out = [];
  for (const part of raw.split(/[\s,;/]+/)) if (map.has(part) && !out.includes(map.get(part))) out.push(map.get(part));
  return out.sort();
}

function localToUtcMs(date, time, offsetMinutes) {
  const match = `${date} ${time}`.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const values = match.slice(1).map(Number);
  const [year, month, day, hour, minute] = values;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return 0;
  return Date.UTC(year, month - 1, day, hour, minute) - Number(offsetMinutes || 0) * 60_000;
}

function fakeCallbackContext(ctx, data) {
  const fake = Object.create(ctx);
  Object.defineProperty(fake, "update", {
    configurable: true,
    value: {
      callback_query: {
        id: `telepilot-v1-${Date.now()}`,
        from: ctx.from,
        chat_instance: "telepilot-v1",
        data,
        message: {
          message_id: ctx?.callbackQuery?.message?.message_id || 0,
          chat: ctx.chat,
          date: Math.floor(Date.now() / 1000),
          text: "",
        },
      },
    },
  });
  Object.defineProperty(fake, "answerCallbackQuery", { configurable: true, value: async () => undefined });
  Object.defineProperty(fake, "editMessageText", { configurable: true, value: async () => undefined });
  return fake;
}

function fakeTextContext(ctx, text, entities = []) {
  const fake = Object.create(ctx);
  Object.defineProperty(fake, "update", {
    configurable: true,
    value: {
      message: {
        message_id: 2_100_000_000,
        date: Math.floor(Date.now() / 1000),
        chat: ctx.chat,
        from: ctx.from,
        text,
        entities,
      },
    },
  });
  return fake;
}

function fakeCommandContext(ctx, text) {
  const fake = Object.create(ctx);
  Object.defineProperty(fake, "update", {
    configurable: true,
    value: {
      message: {
        message_id: 2_100_000_001,
        date: Math.floor(Date.now() / 1000),
        chat: ctx.chat,
        from: ctx.from,
        text,
        entities: [],
      },
    },
  });
  return fake;
}

async function applyMessage(ctx, text, entities = []) {
  if (!appMessageChangeHandler || !appTextHandler) throw new Error("Message editor is not ready.");
  await appMessageChangeHandler(fakeCallbackContext(ctx, "message_change"), async () => undefined);
  await appTextHandler(fakeTextContext(ctx, text, entities), async () => undefined);
}

async function showPowerTools(ctx) {
  const uid = uidOf(ctx);
  const pro = readV1(uid);
  const kb = new InlineKeyboard()
    .text("🔄 Message rotation", "v1_rotation").text("🕒 Exact times", "v1_exact").row()
    .text("📅 Dates & limits", "v1_limits").text("🧭 Posting queue", "v1_queue").row()
    .text("📁 Folders", "v1_folders").text("🎯 Overrides", "v1_overrides").row()
    .text("🔎 Search", "v1_search").text("✨ Variables", "v1_variables").row()
    .text("📊 Statistics", "v1_stats").text("🔔 Notifications", "v1_notifications").row()
    .text("🩺 Sender health", "v1_session").text("📦 Backup", "v1_backup").row()
    .text("🛑 Emergency stop", "v1_emergency").row()
    .text("❓ Tutorial", "tutorial_restart").text("🆕 What's new", "v1_changelog").row();
  if (pro.draftBackup?.message) kb.text("↩ Restore previous message", "v1_restore_draft").row();
  if (isAdmin(uid)) kb.text("🛡 User management", "v1_admin_users").row();
  kb.text("⬅️ Tools", "tools");
  await ctx.editMessageText([
    "⚡ TelePilot Power Tools",
    `Rotation — ${pro.rotation.mode}`,
    `Exact schedules — ${(pro.exactTimes || []).filter(rule => rule.enabled !== false).length}`,
    `One-time posts — ${(pro.oneTimeJobs || []).filter(job => !job.status || job.status === "pending").length}`,
    "",
    "Advanced controls stay here so the main dashboard remains simple.",
  ].join("\n"), { reply_markup: kb });
}

async function showRotation(ctx) {
  const uid = uidOf(ctx);
  const pro = readV1(uid);
  const usable = (pro.templates || []).filter(template => template.message && (!template.expiresAt || template.expiresAt > Date.now()));
  const modeLabel = pro.rotation.mode === "cycle" ? "Cycle in order" : pro.rotation.mode === "random" ? "Random template" : "Off";
  const kb = new InlineKeyboard()
    .text(pro.rotation.mode === "off" ? "✓ Off" : "Off", "v1_rotation:off")
    .text(pro.rotation.mode === "cycle" ? "✓ Cycle" : "Cycle", "v1_rotation:cycle")
    .text(pro.rotation.mode === "random" ? "✓ Random" : "Random", "v1_rotation:random").row()
    .text("⭐ Template favorites", "v1_template_pins").row()
    .text("⬅️ Power Tools", "v1_tools");
  await ctx.editMessageText([
    "🔄 Message rotation",
    `Mode — ${modeLabel}`,
    `Available templates — ${usable.length}`,
    "",
    "Cycle — uses the next saved template each posting cycle.",
    "Random — picks one saved template for each cycle.",
    "Destination overrides always take priority over rotation.",
  ].join("\n"), { reply_markup: kb });
}

async function showExact(ctx) {
  const uid = uidOf(ctx);
  const pro = readV1(uid);
  const kb = new InlineKeyboard();
  (pro.exactTimes || []).slice(0, 12).forEach((rule, index) => {
    kb.text(`${rule.enabled === false ? "○" : "✅"} ${rule.time} · ${daysLabel(rule.days)}`.slice(0, 48), `v1_exact_toggle:${index}`).text("🗑", `v1_exact_del:${index}`).row();
  });
  kb.text("＋ Add exact time", "v1_exact_add").text("＋ One-time post", "v1_once_add").row()
    .text("⬅️ Power Tools", "v1_tools");
  await ctx.editMessageText([
    "🕒 Exact-time scheduling",
    `Recurring exact times — ${(pro.exactTimes || []).length}`,
    `Pending one-time posts — ${(pro.oneTimeJobs || []).filter(job => !job.status || job.status === "pending").length}`,
    "",
    "Exact schedules run in addition to the normal interval scheduler.",
    `Timezone — UTC${Number(pro.schedule?.utcOffsetMinutes || 0) >= 0 ? "+" : ""}${(Number(pro.schedule?.utcOffsetMinutes || 0) / 60).toFixed(Number(pro.schedule?.utcOffsetMinutes || 0) % 60 ? 2 : 0)}`,
  ].join("\n"), { reply_markup: kb });
}

async function showLimits(ctx) {
  const uid = uidOf(ctx);
  const pro = readV1(uid);
  const range = pro.dateRange.enabled ? `${pro.dateRange.start || "…"} → ${pro.dateRange.end || "…"}` : "Disabled";
  const limit = pro.postLimit.enabled ? `${pro.postLimit.sent}/${pro.postLimit.max} successful sends` : "Disabled";
  const expiry = pro.activeMessageExpiresAt ? fmtDateTime(pro.activeMessageExpiresAt) : "Disabled";
  const kb = new InlineKeyboard()
    .text("Set start/end dates", "v1_date_range").text("Clear dates", "v1_date_clear").row()
    .text("Set message expiry", "v1_expiry_set").text("Clear expiry", "v1_expiry_clear").row()
    .text("Set post limit", "v1_limit_set").text("Reset / disable", "v1_limit_clear").row()
    .text("⬅️ Power Tools", "v1_tools");
  await ctx.editMessageText([
    "📅 Dates & limits",
    `Active dates — ${range}`,
    `Message expires — ${expiry}`,
    `Post limit — ${limit}`,
    "",
    "These rules apply to interval, exact-time and one-time sends.",
  ].join("\n"), { reply_markup: kb });
}

async function showQueue(ctx) {
  const uid = uidOf(ctx);
  const settings = readAppSettings(uid);
  const items = queuePreview(uid);
  const lines = [
    "🧭 Posting queue",
    "",
    `Interval — every ${Number(settings.intervalMinutes || 30)} min when LIVE`,
  ];
  if (!items.length) lines.push("Upcoming exact jobs — none");
  else {
    lines.push("Upcoming scheduled jobs:");
    items.forEach((item, index) => lines.push(`${index + 1}. ${fmtDateTime(item.runAt)} — ${item.label}`));
  }
  lines.push("", "The LIVE dashboard remains the source of truth for the next interval cycle.");
  await ctx.editMessageText(lines.join("\n"), { reply_markup: new InlineKeyboard().text("↻ Refresh", "v1_queue").row().text("⬅️ Power Tools", "v1_tools") });
}

function folderNames(pro) {
  return [...new Set(Object.values(pro.destinationFolders || {}).map(value => String(value).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function showFolders(ctx) {
  const uid = uidOf(ctx);
  const settings = readAppSettings(uid);
  const pro = readV1(uid);
  const folders = folderNames(pro);
  const disabled = new Set((pro.disabledFolders || []).map(String));
  const kb = new InlineKeyboard();
  folders.slice(0, 12).forEach((name, index) => {
    const count = (settings.groups || []).filter(group => pro.destinationFolders[destinationId(group)] === name).length;
    kb.text(`${disabled.has(name) ? "○" : "✅"} ${name} · ${count}`.slice(0, 42), `v1_folder_toggle:${index}`).row();
  });
  kb.text("Assign destination", "v1_folder_assign_menu").row().text("⬅️ Power Tools", "v1_tools");
  await ctx.editMessageText([
    "📁 Destination folders",
    `Folders — ${folders.length}`,
    "",
    folders.length ? "Tap a folder to enable/disable every destination inside it." : "No folders yet. Assign a destination to create one.",
  ].join("\n"), { reply_markup: kb });
}

async function showFolderAssignMenu(ctx) {
  const settings = readAppSettings(uidOf(ctx));
  const kb = new InlineKeyboard();
  (settings.groups || []).slice(0, 25).forEach((group, index) => kb.text(destinationLabel(group).slice(0, 40), `v1_folder_assign:${index}`).row());
  kb.text("⬅️ Folders", "v1_folders");
  await ctx.editMessageText("📁 Assign destination folder\n\nChoose a destination, then type a folder name.", { reply_markup: kb });
}

async function showOverrides(ctx) {
  const uid = uidOf(ctx);
  const settings = readAppSettings(uid);
  const pro = readV1(uid);
  const kb = new InlineKeyboard();
  (settings.groups || []).slice(0, 25).forEach((group, index) => {
    const template = (pro.templates || []).find(item => String(item.id) === String(pro.destinationOverrides[destinationId(group)] || ""));
    kb.text(`${template ? "🎯" : "○"} ${destinationLabel(group)}`.slice(0, 42), `v1_override_dest:${index}`).row();
  });
  kb.text("⬅️ Power Tools", "v1_tools");
  await ctx.editMessageText([
    "🎯 Destination message overrides",
    "",
    "Choose a destination and assign one saved template specifically to it.",
    "That template overrides the default message and rotation for that destination only.",
  ].join("\n"), { reply_markup: kb });
}

async function showOverrideTemplates(ctx, destinationIndex) {
  const uid = uidOf(ctx);
  const settings = readAppSettings(uid);
  const pro = readV1(uid);
  const group = settings.groups?.[destinationIndex];
  if (!group) return ctx.answerCallbackQuery({ text: "Destination not found." });
  const kb = new InlineKeyboard().text("Use default / rotation", `v1_override_set:${destinationIndex}:default`).row();
  (pro.templates || []).filter(template => template.message).slice(0, 15).forEach(template => kb.text(String(template.name || "Template").slice(0, 38), `v1_override_set:${destinationIndex}:${template.id}`).row());
  kb.text("⬅️ Overrides", "v1_overrides");
  await ctx.editMessageText(`🎯 Destination override\nDestination — ${destinationLabel(group)}\n\nChoose the message template for this destination.`, { reply_markup: kb });
}

async function showVariables(ctx) {
  const uid = uidOf(ctx);
  const pro = readV1(uid);
  const entries = Object.entries(pro.customVariables || {});
  const lines = ["✨ Custom variables", `Saved — ${entries.length}`, "", "Use a saved value inside messages like {promo} or {link}."];
  entries.slice(0, 12).forEach(([key, value]) => lines.push(`{${key}} — ${String(value).slice(0, 70)}`));
  const kb = new InlineKeyboard().text("＋ Add / update", "v1_variable_add").text("Remove", "v1_variable_remove").row().text("⬅️ Power Tools", "v1_tools");
  await ctx.editMessageText(lines.join("\n"), { reply_markup: kb });
}

async function showSearch(ctx) {
  await ctx.editMessageText([
    "🔎 Search TelePilot",
    "",
    "Search saved destinations or templates without scrolling through long lists.",
  ].join("\n"), { reply_markup: new InlineKeyboard().text("Search destinations", "v1_search_dest").text("Search templates", "v1_search_tpl").row().text("⬅️ Power Tools", "v1_tools") });
}

async function showTemplatePins(ctx) {
  const uid = uidOf(ctx);
  const pro = readV1(uid);
  const ordered = [...(pro.templates || [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(a.name).localeCompare(String(b.name)));
  const kb = new InlineKeyboard();
  ordered.slice(0, 20).forEach(template => kb.text(`${template.pinned ? "⭐" : "☆"} ${String(template.name || "Template").slice(0, 32)}`, `v1_pin:${template.id}`).row());
  kb.text("⬅️ Rotation", "v1_rotation");
  await ctx.editMessageText("⭐ Template favorites\n\nPinned templates appear first in TelePilot search and management screens.", { reply_markup: kb });
}

async function showStats(ctx) {
  const uid = uidOf(ctx);
  const stats = v1Stats(uid);
  const pro = readV1(uid);
  const failures = Object.values(pro.destinationFailures || {}).filter(item => Number(item.count || 0) > 0).length;
  await ctx.editMessageText([
    "📊 TelePilot statistics",
    "",
    `Today sent — ${stats.today.sent}`,
    `Today failed — ${stats.today.failed}`,
    `Today skipped — ${stats.today.skipped}`,
    "",
    `7 days sent — ${stats.week.sent}`,
    `7 days failed — ${stats.week.failed}`,
    `7 days skipped — ${stats.week.skipped}`,
    "",
    `Destinations with recorded issues — ${failures}`,
  ].join("\n"), { reply_markup: new InlineKeyboard().text("Failure handling", "v1_failures").text("Posting history", "history").row().text("⬅️ Power Tools", "v1_tools") });
}

async function showFailures(ctx) {
  const uid = uidOf(ctx);
  const pro = readV1(uid);
  const rows = Object.entries(pro.destinationFailures || {}).sort((a, b) => Number(b[1]?.lastAt || 0) - Number(a[1]?.lastAt || 0));
  const settings = readAppSettings(uid);
  const lines = [
    "🩺 Automatic failure handling",
    `Auto-disable after — ${pro.autoDisableFailures} permanent failures`,
    "",
    "Transient Telegram/network errors are retried once. Repeated permission/removal errors can automatically disable a destination.",
  ];
  rows.slice(0, 8).forEach(([id, info]) => {
    const group = (settings.groups || []).find(item => destinationId(item) === id);
    lines.push(`${destinationLabel(group || { id })} — ${Number(info.count || 0)} failure(s) — ${String(info.lastError || "").slice(0, 80)}`);
  });
  const kb = new InlineKeyboard().text("2 failures", "v1_fail_threshold:2").text("3 failures", "v1_fail_threshold:3").text("5 failures", "v1_fail_threshold:5").row().text("Reset failure records", "v1_fail_reset").row().text("⬅️ Statistics", "v1_stats");
  await ctx.editMessageText(lines.join("\n"), { reply_markup: kb });
}

async function showNotifications(ctx) {
  const uid = uidOf(ctx);
  const pro = readV1(uid);
  const kb = new InlineKeyboard()
    .text(pro.notificationMode === "all" ? "✓ All" : "All", "v1_notify:all")
    .text(pro.notificationMode === "important" ? "✓ Important" : "Important", "v1_notify:important")
    .text(pro.notificationMode === "silent" ? "✓ Silent" : "Silent", "v1_notify:silent").row()
    .text(pro.weeklyRecap.enabled ? "Disable weekly recap" : "Enable weekly recap", "v1_weekly_toggle").row()
    .text("⬅️ Power Tools", "v1_tools");
  await ctx.editMessageText([
    "🔔 Notifications",
    `Mode — ${pro.notificationMode}`,
    `Weekly recap — ${pro.weeklyRecap.enabled ? "Enabled" : "Disabled"}`,
    "",
    "Important — session/access/automatic-disable alerts only.",
    "All — also includes individual posting failure alerts.",
    "Silent — TelePilot keeps history but sends no proactive alerts.",
  ].join("\n"), { reply_markup: kb });
}

async function showSession(ctx) {
  const uid = uidOf(ctx);
  const settings = readAppSettings(uid);
  const pro = readV1(uid);
  const connected = hasPersonalSessionFile(uid);
  const label = connected ? (settings.personalUsername ? `@${settings.personalUsername}` : "Personal account") : "TelePilot Bot";
  const kb = new InlineKeyboard();
  if (connected) kb.text("Open Sender", "account").text("Disconnect", "account_disconnect").row();
  else kb.text("Connect personal account", "account").row();
  kb.text("⬅️ Power Tools", "v1_tools");
  await ctx.editMessageText([
    "🩺 Sender health",
    `Sender — ${label}`,
    `Session file — ${connected ? "Present" : "Not connected"}`,
    `Health — ${connected ? pro.sessionHealth.status : "Bot sender"}`,
    `Last verified — ${connected ? fmtAgo(pro.sessionHealth.lastCheckedAt) : "—"}`,
    ...(pro.sessionHealth.lastError ? [`Last issue — ${pro.sessionHealth.lastError}`] : []),
    "",
    "Reconnecting a personal sender does not delete messages, templates, destinations or schedules.",
  ].join("\n"), { reply_markup: kb });
}

async function showBackup(ctx) {
  await ctx.editMessageText([
    "📦 Backup & restore",
    "",
    "Export saves your posting configuration, templates, public destinations and scheduling settings.",
    "",
    "Telegram login sessions, phone numbers, 2FA details and access keys are never included in a backup.",
  ].join("\n"), { reply_markup: new InlineKeyboard().text("Export backup", "export_config").text("Import backup", "import_config").row().text("⬅️ Power Tools", "v1_tools") });
}

async function showChangelog(ctx) {
  const uid = uidOf(ctx);
  const pro = readV1(uid);
  pro.changelogSeen = "1.0.0";
  writeV1(uid, pro);
  await ctx.editMessageText([
    "🆕 What's new in TelePilot 1.0",
    "",
    "• First-time guided tutorial",
    "• Exact-time + one-time scheduling",
    "• Message rotation and random templates",
    "• Destination folders and message overrides",
    "• Search + favorite templates",
    "• Custom {variables}",
    "• Start/end dates, message expiry and post limits",
    "• Automatic destination failure handling",
    "• Daily/weekly statistics and optional recap",
    "• Posting queue, sender health and access reminders",
    "• Emergency stop and quieter notification modes",
    "• Owner user/key management shortcuts",
  ].join("\n"), { reply_markup: new InlineKeyboard().text("❓ Tutorial", "tutorial_restart").row().text("⬅️ Power Tools", "v1_tools") });
}

async function showAdminUsers(ctx) {
  const uid = uidOf(ctx);
  if (!isAdmin(uid)) return ctx.answerCallbackQuery({ text: "Owner only.", show_alert: true });
  const users = listUserIds();
  const kb = new InlineKeyboard();
  users.slice(0, 20).forEach(userId => {
    const settings = readAppSettings(userId);
    const active = settings.accessLifetime || Number(settings.accessUntil || 0) > Date.now();
    const name = settings.personalUsername ? `@${settings.personalUsername}` : `ID ${userId}`;
    kb.text(`${active ? "✅" : "○"} ${name}`.slice(0, 40), `v1_admin_user:${userId}`).row();
  });
  kb.text("Generate 7d key", "v1_genkey:7").text("30d", "v1_genkey:30").text("90d", "v1_genkey:90").row()
    .text("Generate lifetime key", "v1_genkey:lifetime").row()
    .text("⬅️ Power Tools", "v1_tools");
  await ctx.editMessageText(`🛡 TelePilot user management\nProfiles — ${users.length}\n\nChoose a user for access/session details, or generate a new access key.`, { reply_markup: kb });
}

async function showAdminUser(ctx, targetUid) {
  if (!isAdmin(uidOf(ctx))) return ctx.answerCallbackQuery({ text: "Owner only.", show_alert: true });
  const settings = readAppSettings(targetUid);
  const pro = readV1(targetUid);
  const access = settings.accessLifetime ? "Lifetime" : settings.accessRevoked ? "Revoked" : Number(settings.accessUntil || 0) > Date.now() ? `Until ${fmtDateTime(settings.accessUntil)}` : "Inactive";
  const kb = new InlineKeyboard();
  if (settings.accessKeyId) kb.text("Revoke current key", `v1_admin_revoke:${targetUid}`).row();
  kb.text("⬅️ Users", "v1_admin_users");
  await ctx.editMessageText([
    "🛡 User details",
    `Telegram ID — ${targetUid}`,
    `Personal sender — ${settings.personalUsername ? `@${settings.personalUsername}` : "No"}`,
    `Access — ${access}`,
    `Destinations — ${(settings.groups || []).length}`,
    `Templates — ${(pro.templates || []).length}`,
    `Last session check — ${fmtAgo(pro.sessionHealth?.lastCheckedAt)}`,
  ].join("\n"), { reply_markup: kb });
}

async function handlePendingText(ctx) {
  const uid = uidOf(ctx);
  const task = pending.get(uid);
  if (!task) return false;
  pending.delete(uid);
  const value = String(ctx.message?.text || "").trim();
  try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch {}
  const pro = readV1(uid);

  if (task.type === "exact") {
    const match = value.match(/^(\d{2}:\d{2})(?:\s+(.+))?$/);
    const days = match ? parseDays(match[2] || "all") : [];
    if (!match || !/^([01]\d|2[0-3]):[0-5]\d$/.test(match[1]) || !days.length) {
      await ctx.api.editMessageText(ctx.chat.id, task.messageId, "🕒 Add exact time\n\n❌ Use a format like:\n09:00\n09:00 weekdays\n18:30 Mon,Wed,Fri", { reply_markup: new InlineKeyboard().text("Try again", "v1_exact_add").row().text("⬅️ Exact times", "v1_exact") });
      return true;
    }
    pro.exactTimes.push({ id: crypto.randomBytes(4).toString("hex"), time: match[1], days, enabled: true, templateId: "", lastRunKey: "" });
    pro.exactTimes = pro.exactTimes.slice(-12);
    writeV1(uid, pro);
    await ctx.api.editMessageText(ctx.chat.id, task.messageId, `🕒 Exact-time scheduling\n\n✅ Added ${match[1]} — ${daysLabel(days)}.`, { reply_markup: new InlineKeyboard().text("Open exact times", "v1_exact") });
    return true;
  }

  if (task.type === "once") {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
    const runAt = match ? localToUtcMs(match[1], match[2], pro.schedule?.utcOffsetMinutes || 0) : 0;
    if (!runAt || runAt <= Date.now()) {
      await ctx.api.editMessageText(ctx.chat.id, task.messageId, "🕒 One-time post\n\n❌ Send a future local date/time like:\n2026-09-08 18:00", { reply_markup: new InlineKeyboard().text("Try again", "v1_once_add").row().text("⬅️ Exact times", "v1_exact") });
      return true;
    }
    pro.oneTimeJobs.push({ id: crypto.randomBytes(4).toString("hex"), runAt, templateId: "", status: "pending", createdAt: Date.now() });
    pro.oneTimeJobs = pro.oneTimeJobs.slice(-30);
    writeV1(uid, pro);
    await ctx.api.editMessageText(ctx.chat.id, task.messageId, `🕒 One-time post\n\n✅ Scheduled for ${value} in your configured timezone.`, { reply_markup: new InlineKeyboard().text("View queue", "v1_queue").row().text("⬅️ Exact times", "v1_exact") });
    return true;
  }

  if (task.type === "date_range") {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})\s+(?:to|→|-)\s+(\d{4}-\d{2}-\d{2})$/i);
    if (!match || match[2] < match[1]) {
      await ctx.api.editMessageText(ctx.chat.id, task.messageId, "📅 Active dates\n\n❌ Use: 2026-09-08 to 2026-09-30", { reply_markup: new InlineKeyboard().text("Try again", "v1_date_range").row().text("⬅️ Limits", "v1_limits") });
      return true;
    }
    pro.dateRange = { enabled: true, start: match[1], end: match[2] };
    writeV1(uid, pro);
    await ctx.api.editMessageText(ctx.chat.id, task.messageId, `📅 Active dates\n\n✅ ${match[1]} → ${match[2]}`, { reply_markup: new InlineKeyboard().text("⬅️ Limits", "v1_limits") });
    return true;
  }

  if (task.type === "expiry") {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
    const expiresAt = match ? localToUtcMs(match[1], match[2], pro.schedule?.utcOffsetMinutes || 0) : 0;
    if (!expiresAt || expiresAt <= Date.now()) {
      await ctx.api.editMessageText(ctx.chat.id, task.messageId, "📅 Message expiry\n\n❌ Use a future local date/time like 2026-09-30 22:00.", { reply_markup: new InlineKeyboard().text("Try again", "v1_expiry_set").row().text("⬅️ Limits", "v1_limits") });
      return true;
    }
    pro.activeMessageExpiresAt = expiresAt;
    writeV1(uid, pro);
    await ctx.api.editMessageText(ctx.chat.id, task.messageId, `📅 Message expiry\n\n✅ Active message will stop after ${value}.`, { reply_markup: new InlineKeyboard().text("⬅️ Limits", "v1_limits") });
    return true;
  }

  if (task.type === "post_limit") {
    const max = Number(value);
    if (!Number.isInteger(max) || max < 1 || max > 100000) {
      await ctx.api.editMessageText(ctx.chat.id, task.messageId, "📅 Post limit\n\n❌ Send a whole number from 1 to 100000.", { reply_markup: new InlineKeyboard().text("Try again", "v1_limit_set").row().text("⬅️ Limits", "v1_limits") });
      return true;
    }
    pro.postLimit = { enabled: true, max, sent: 0 };
    writeV1(uid, pro);
    await ctx.api.editMessageText(ctx.chat.id, task.messageId, `📅 Post limit\n\n✅ TelePilot will stop after ${max} successful destination sends.`, { reply_markup: new InlineKeyboard().text("⬅️ Limits", "v1_limits") });
    return true;
  }

  if (task.type === "variable") {
    const split = value.indexOf("=");
    const name = split > 0 ? value.slice(0, split).trim().replace(/[^A-Za-z0-9_]/g, "").slice(0, 32) : "";
    const variableValue = split > 0 ? value.slice(split + 1).trim().slice(0, 500) : "";
    if (!name || !variableValue) {
      await ctx.api.editMessageText(ctx.chat.id, task.messageId, "✨ Custom variables\n\n❌ Send name=value, for example:\npromo=SUMMER20", { reply_markup: new InlineKeyboard().text("Try again", "v1_variable_add").row().text("⬅️ Variables", "v1_variables") });
      return true;
    }
    pro.customVariables[name] = variableValue;
    writeV1(uid, pro);
    await ctx.api.editMessageText(ctx.chat.id, task.messageId, `✨ Custom variables\n\n✅ {${name}} saved.`, { reply_markup: new InlineKeyboard().text("⬅️ Variables", "v1_variables") });
    return true;
  }

  if (task.type === "variable_remove") {
    const name = value.replace(/[{}]/g, "").trim();
    if (!Object.prototype.hasOwnProperty.call(pro.customVariables, name)) {
      await ctx.api.editMessageText(ctx.chat.id, task.messageId, "✨ Custom variables\n\n❌ That variable was not found.", { reply_markup: new InlineKeyboard().text("⬅️ Variables", "v1_variables") });
      return true;
    }
    delete pro.customVariables[name];
    writeV1(uid, pro);
    await ctx.api.editMessageText(ctx.chat.id, task.messageId, `✨ Custom variables\n\n✅ {${name}} removed.`, { reply_markup: new InlineKeyboard().text("⬅️ Variables", "v1_variables") });
    return true;
  }

  if (task.type === "folder_assign") {
    const settings = readAppSettings(uid);
    const group = settings.groups?.[task.index];
    if (!group) return true;
    const folder = value.toLowerCase() === "none" ? "" : value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 24);
    if (folder) pro.destinationFolders[destinationId(group)] = folder;
    else delete pro.destinationFolders[destinationId(group)];
    writeV1(uid, pro);
    await ctx.api.editMessageText(ctx.chat.id, task.messageId, `📁 Destination folders\n\n✅ ${destinationLabel(group)} — ${folder || "No folder"}`, { reply_markup: new InlineKeyboard().text("⬅️ Folders", "v1_folders") });
    return true;
  }

  if (task.type === "search_dest") {
    const settings = readAppSettings(uid);
    const query = value.toLowerCase();
    const matches = (settings.groups || []).map((group, index) => ({ group, index })).filter(item => destinationLabel(item.group).toLowerCase().includes(query)).slice(0, 15);
    const kb = new InlineKeyboard();
    matches.forEach(item => kb.text(destinationLabel(item.group).slice(0, 40), `v1_folder_assign:${item.index}`).row());
    kb.text("⬅️ Search", "v1_search");
    await ctx.api.editMessageText(ctx.chat.id, task.messageId, `🔎 Destination search\nQuery — ${value}\nResults — ${matches.length}\n\nTap a result to manage its folder.`, { reply_markup: kb });
    return true;
  }

  if (task.type === "search_tpl") {
    const query = value.toLowerCase();
    const matches = (pro.templates || []).filter(template => String(template.name || "").toLowerCase().includes(query) || String(template.message || "").toLowerCase().includes(query)).sort((a,b) => Number(b.pinned) - Number(a.pinned)).slice(0, 15);
    const kb = new InlineKeyboard();
    matches.forEach(template => kb.text(`${template.pinned ? "⭐ " : ""}${String(template.name || "Template").slice(0, 34)}`, `tpl_load:${template.id}`).row());
    kb.text("⬅️ Search", "v1_search");
    await ctx.api.editMessageText(ctx.chat.id, task.messageId, `🔎 Template search\nQuery — ${value}\nResults — ${matches.length}`, { reply_markup: kb });
    return true;
  }

  return false;
}

function registerHandlers(bot) {
  bot.callbackQuery("v1_tools", async ctx => { await ctx.answerCallbackQuery(); await showPowerTools(ctx); });
  bot.callbackQuery("v1_rotation", async ctx => { await ctx.answerCallbackQuery(); await showRotation(ctx); });
  bot.callbackQuery(/^v1_rotation:(off|cycle|random)$/, async ctx => {
    const uid = uidOf(ctx); const pro = readV1(uid); pro.rotation.mode = ctx.match[1]; pro.rotation.index = 0; writeV1(uid, pro);
    await ctx.answerCallbackQuery({ text: `Rotation — ${ctx.match[1]}` }); await showRotation(ctx);
  });
  bot.callbackQuery("v1_template_pins", async ctx => { await ctx.answerCallbackQuery(); await showTemplatePins(ctx); });
  bot.callbackQuery(/^v1_pin:([a-f0-9]+)$/, async ctx => {
    const uid = uidOf(ctx); const pro = readV1(uid); const template = pro.templates.find(item => String(item.id) === ctx.match[1]);
    if (!template) return ctx.answerCallbackQuery({ text: "Template not found." });
    template.pinned = !template.pinned; writeV1(uid, pro); await ctx.answerCallbackQuery({ text: template.pinned ? "Pinned" : "Unpinned" }); await showTemplatePins(ctx);
  });

  bot.callbackQuery("v1_exact", async ctx => { await ctx.answerCallbackQuery(); await showExact(ctx); });
  bot.callbackQuery("v1_exact_add", async ctx => {
    const uid = uidOf(ctx); await ctx.answerCallbackQuery(); pending.set(uid, { type: "exact", messageId: ctx.callbackQuery.message?.message_id });
    await ctx.editMessageText("🕒 Add exact time\n\nSend:\n09:00\n09:00 weekdays\n18:30 Mon,Wed,Fri\n\nThe configured Schedule timezone is used.", { reply_markup: new InlineKeyboard().text("Cancel", "v1_exact") });
  });
  bot.callbackQuery(/^v1_exact_toggle:(\d+)$/, async ctx => {
    const uid = uidOf(ctx); const pro = readV1(uid); const rule = pro.exactTimes?.[Number(ctx.match[1])];
    if (!rule) return ctx.answerCallbackQuery({ text: "Schedule not found." });
    rule.enabled = rule.enabled === false; writeV1(uid, pro); await ctx.answerCallbackQuery({ text: rule.enabled ? "Enabled" : "Disabled" }); await showExact(ctx);
  });
  bot.callbackQuery(/^v1_exact_del:(\d+)$/, async ctx => {
    const uid = uidOf(ctx); const pro = readV1(uid); pro.exactTimes.splice(Number(ctx.match[1]), 1); writeV1(uid, pro); await ctx.answerCallbackQuery({ text: "Exact time removed" }); await showExact(ctx);
  });
  bot.callbackQuery("v1_once_add", async ctx => {
    const uid = uidOf(ctx); await ctx.answerCallbackQuery(); pending.set(uid, { type: "once", messageId: ctx.callbackQuery.message?.message_id });
    await ctx.editMessageText("🕒 One-time post\n\nSend the local date and time:\n2026-09-08 18:00\n\nTelePilot uses the timezone configured in Advanced Schedule.", { reply_markup: new InlineKeyboard().text("Cancel", "v1_exact") });
  });

  bot.callbackQuery("v1_limits", async ctx => { await ctx.answerCallbackQuery(); await showLimits(ctx); });
  bot.callbackQuery("v1_date_range", async ctx => {
    const uid = uidOf(ctx); await ctx.answerCallbackQuery(); pending.set(uid, { type: "date_range", messageId: ctx.callbackQuery.message?.message_id });
    await ctx.editMessageText("📅 Active dates\n\nSend a range like:\n2026-09-08 to 2026-09-30", { reply_markup: new InlineKeyboard().text("Cancel", "v1_limits") });
  });
  bot.callbackQuery("v1_date_clear", async ctx => { const uid = uidOf(ctx); const pro = readV1(uid); pro.dateRange = { enabled: false, start: "", end: "" }; writeV1(uid, pro); await ctx.answerCallbackQuery({ text: "Date range cleared" }); await showLimits(ctx); });
  bot.callbackQuery("v1_expiry_set", async ctx => { const uid = uidOf(ctx); await ctx.answerCallbackQuery(); pending.set(uid, { type: "expiry", messageId: ctx.callbackQuery.message?.message_id }); await ctx.editMessageText("📅 Message expiry\n\nSend a future local date/time:\n2026-09-30 22:00", { reply_markup: new InlineKeyboard().text("Cancel", "v1_limits") }); });
  bot.callbackQuery("v1_expiry_clear", async ctx => { const uid = uidOf(ctx); const pro = readV1(uid); pro.activeMessageExpiresAt = 0; writeV1(uid, pro); await ctx.answerCallbackQuery({ text: "Message expiry cleared" }); await showLimits(ctx); });
  bot.callbackQuery("v1_limit_set", async ctx => { const uid = uidOf(ctx); await ctx.answerCallbackQuery(); pending.set(uid, { type: "post_limit", messageId: ctx.callbackQuery.message?.message_id }); await ctx.editMessageText("📅 Post limit\n\nSend the maximum number of successful destination sends, for example 20.", { reply_markup: new InlineKeyboard().text("Cancel", "v1_limits") }); });
  bot.callbackQuery("v1_limit_clear", async ctx => { const uid = uidOf(ctx); const pro = readV1(uid); pro.postLimit = { enabled: false, max: 0, sent: 0 }; writeV1(uid, pro); await ctx.answerCallbackQuery({ text: "Post limit reset" }); await showLimits(ctx); });

  bot.callbackQuery("v1_queue", async ctx => { await ctx.answerCallbackQuery(); await showQueue(ctx); });
  bot.callbackQuery("v1_folders", async ctx => { await ctx.answerCallbackQuery(); await showFolders(ctx); });
  bot.callbackQuery("v1_folder_assign_menu", async ctx => { await ctx.answerCallbackQuery(); await showFolderAssignMenu(ctx); });
  bot.callbackQuery(/^v1_folder_assign:(\d+)$/, async ctx => {
    const uid = uidOf(ctx); const settings = readAppSettings(uid); const group = settings.groups?.[Number(ctx.match[1])];
    if (!group) return ctx.answerCallbackQuery({ text: "Destination not found." });
    await ctx.answerCallbackQuery(); pending.set(uid, { type: "folder_assign", index: Number(ctx.match[1]), messageId: ctx.callbackQuery.message?.message_id });
    await ctx.editMessageText(`📁 Assign destination folder\nDestination — ${destinationLabel(group)}\n\nSend a folder name, or send none to remove its folder.`, { reply_markup: new InlineKeyboard().text("Cancel", "v1_folders") });
  });
  bot.callbackQuery(/^v1_folder_toggle:(\d+)$/, async ctx => {
    const uid = uidOf(ctx); const pro = readV1(uid); const names = folderNames(pro); const name = names[Number(ctx.match[1])];
    if (!name) return ctx.answerCallbackQuery({ text: "Folder not found." });
    const set = new Set((pro.disabledFolders || []).map(String)); if (set.has(name)) set.delete(name); else set.add(name); pro.disabledFolders = [...set]; writeV1(uid, pro);
    await ctx.answerCallbackQuery({ text: set.has(name) ? "Folder disabled" : "Folder enabled" }); await showFolders(ctx);
  });

  bot.callbackQuery("v1_overrides", async ctx => { await ctx.answerCallbackQuery(); await showOverrides(ctx); });
  bot.callbackQuery(/^v1_override_dest:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); await showOverrideTemplates(ctx, Number(ctx.match[1])); });
  bot.callbackQuery(/^v1_override_set:(\d+):([a-f0-9]+|default)$/, async ctx => {
    const uid = uidOf(ctx); const settings = readAppSettings(uid); const group = settings.groups?.[Number(ctx.match[1])];
    if (!group) return ctx.answerCallbackQuery({ text: "Destination not found." });
    const pro = readV1(uid); if (ctx.match[2] === "default") delete pro.destinationOverrides[destinationId(group)]; else pro.destinationOverrides[destinationId(group)] = ctx.match[2]; writeV1(uid, pro);
    await ctx.answerCallbackQuery({ text: ctx.match[2] === "default" ? "Using default message" : "Override saved" }); await showOverrides(ctx);
  });

  bot.callbackQuery("v1_variables", async ctx => { await ctx.answerCallbackQuery(); await showVariables(ctx); });
  bot.callbackQuery("v1_variable_add", async ctx => { const uid = uidOf(ctx); await ctx.answerCallbackQuery(); pending.set(uid, { type: "variable", messageId: ctx.callbackQuery.message?.message_id }); await ctx.editMessageText("✨ Add custom variable\n\nSend name=value\nExample:\npromo=SUMMER20\n\nThen use {promo} in a posting message.", { reply_markup: new InlineKeyboard().text("Cancel", "v1_variables") }); });
  bot.callbackQuery("v1_variable_remove", async ctx => { const uid = uidOf(ctx); await ctx.answerCallbackQuery(); pending.set(uid, { type: "variable_remove", messageId: ctx.callbackQuery.message?.message_id }); await ctx.editMessageText("✨ Remove variable\n\nSend the variable name, for example promo.", { reply_markup: new InlineKeyboard().text("Cancel", "v1_variables") }); });

  bot.callbackQuery("v1_search", async ctx => { await ctx.answerCallbackQuery(); await showSearch(ctx); });
  bot.callbackQuery("v1_search_dest", async ctx => { const uid = uidOf(ctx); await ctx.answerCallbackQuery(); pending.set(uid, { type: "search_dest", messageId: ctx.callbackQuery.message?.message_id }); await ctx.editMessageText("🔎 Search destinations\n\nSend part of a group/channel name or @username.", { reply_markup: new InlineKeyboard().text("Cancel", "v1_search") }); });
  bot.callbackQuery("v1_search_tpl", async ctx => { const uid = uidOf(ctx); await ctx.answerCallbackQuery(); pending.set(uid, { type: "search_tpl", messageId: ctx.callbackQuery.message?.message_id }); await ctx.editMessageText("🔎 Search templates\n\nSend part of the template name or message text.", { reply_markup: new InlineKeyboard().text("Cancel", "v1_search") }); });

  bot.callbackQuery("v1_stats", async ctx => { await ctx.answerCallbackQuery(); await showStats(ctx); });
  bot.callbackQuery("v1_failures", async ctx => { await ctx.answerCallbackQuery(); await showFailures(ctx); });
  bot.callbackQuery(/^v1_fail_threshold:(2|3|5)$/, async ctx => { const uid = uidOf(ctx); const pro = readV1(uid); pro.autoDisableFailures = Number(ctx.match[1]); writeV1(uid, pro); await ctx.answerCallbackQuery({ text: `Threshold — ${ctx.match[1]}` }); await showFailures(ctx); });
  bot.callbackQuery("v1_fail_reset", async ctx => { const uid = uidOf(ctx); const pro = readV1(uid); pro.destinationFailures = {}; writeV1(uid, pro); await ctx.answerCallbackQuery({ text: "Failure records reset" }); await showFailures(ctx); });

  bot.callbackQuery("v1_notifications", async ctx => { await ctx.answerCallbackQuery(); await showNotifications(ctx); });
  bot.callbackQuery(/^v1_notify:(all|important|silent)$/, async ctx => { const uid = uidOf(ctx); const pro = readV1(uid); pro.notificationMode = ctx.match[1]; writeV1(uid, pro); await ctx.answerCallbackQuery({ text: `Notifications — ${ctx.match[1]}` }); await showNotifications(ctx); });
  bot.callbackQuery("v1_weekly_toggle", async ctx => { const uid = uidOf(ctx); const pro = readV1(uid); pro.weeklyRecap.enabled = !pro.weeklyRecap.enabled; writeV1(uid, pro); await ctx.answerCallbackQuery({ text: pro.weeklyRecap.enabled ? "Weekly recap enabled" : "Weekly recap disabled" }); await showNotifications(ctx); });

  bot.callbackQuery("v1_session", async ctx => { await ctx.answerCallbackQuery(); await showSession(ctx); });
  bot.callbackQuery("v1_backup", async ctx => { await ctx.answerCallbackQuery(); await showBackup(ctx); });
  bot.callbackQuery("v1_changelog", async ctx => { await ctx.answerCallbackQuery(); await showChangelog(ctx); });

  bot.callbackQuery("v1_emergency", async ctx => {
    const uid = uidOf(ctx); const pro = readV1(uid); pro.paused = true; pro.skipNext = false; writeV1(uid, pro);
    await ctx.answerCallbackQuery({ text: "All TelePilot posting paused", show_alert: true });
    if (typeof appStopHandler === "function") { try { await appStopHandler(fakeCallbackContext(ctx, "stop"), async () => undefined); } catch {} }
    await ctx.editMessageText("🛑 Emergency stop\n\nAll TelePilot posting rules are paused for this profile.\n\nYour messages, destinations and schedules are still saved.", { reply_markup: new InlineKeyboard().text("Resume in Tools", "tools").row().text("⬅️ Dashboard", "home") });
  });

  bot.callbackQuery("v1_restore_draft", async ctx => {
    const uid = uidOf(ctx); const pro = readV1(uid); if (!pro.draftBackup?.message) return ctx.answerCallbackQuery({ text: "No previous message saved." });
    await ctx.answerCallbackQuery({ text: "Restoring previous message…" }); await applyMessage(ctx, pro.draftBackup.message, pro.draftBackup.entities || []);
  });

  bot.callbackQuery("v1_admin_users", async ctx => { await ctx.answerCallbackQuery(); await showAdminUsers(ctx); });
  bot.callbackQuery(/^v1_admin_user:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); await showAdminUser(ctx, ctx.match[1]); });
  bot.callbackQuery(/^v1_genkey:(7|30|90|lifetime)$/, async ctx => {
    if (!isAdmin(uidOf(ctx)) || typeof genKeyHandler !== "function") return ctx.answerCallbackQuery({ text: "Owner key generator unavailable.", show_alert: true });
    await ctx.answerCallbackQuery({ text: "Generating key…" });
    await genKeyHandler(fakeCommandContext(ctx, `/genkey ${ctx.match[1]}`), async () => undefined);
  });
  bot.callbackQuery(/^v1_admin_revoke:(\d+)$/, async ctx => {
    if (!isAdmin(uidOf(ctx)) || typeof revokeHandler !== "function") return ctx.answerCallbackQuery({ text: "Owner revoke tool unavailable.", show_alert: true });
    const settings = readAppSettings(ctx.match[1]);
    if (!settings.accessKeyId) return ctx.answerCallbackQuery({ text: "No linked key found." });
    await ctx.answerCallbackQuery({ text: "Revoking…" });
    await revokeHandler(fakeCommandContext(ctx, `/revoke ${settings.accessKeyId}`), async () => undefined);
    await showAdminUser(ctx, ctx.match[1]);
  });
}

export function installV1Controls(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotV1ControlsInstalled) return;
  const originalCommand = BotClass.prototype.command;
  const originalCallbackQuery = BotClass.prototype.callbackQuery;
  const originalOn = BotClass.prototype.on;
  const originalStart = BotClass.prototype.start;
  if (typeof originalCommand !== "function" || typeof originalCallbackQuery !== "function" || typeof originalOn !== "function" || typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for TelePilot v1 controls");
  Object.defineProperty(BotClass.prototype, "__telepilotV1ControlsInstalled", { value: true });

  BotClass.prototype.command = function(command, ...middleware) {
    for (const handler of middleware) {
      if (typeof handler !== "function") continue;
      if (command === "genkey") genKeyHandler = handler;
      else if (command === "revoke") revokeHandler = handler;
    }
    return originalCommand.call(this, command, ...middleware);
  };

  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    for (const handler of middleware) {
      if (typeof handler !== "function") continue;
      if (trigger === "message_change") appMessageChangeHandler = handler;
      else if (trigger === "stop") appStopHandler = handler;
      else if (trigger === "account_disconnect") appDisconnectHandler = handler;
    }
    if (trigger === "message_change") {
      middleware = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
        const uid = uidOf(ctx);
        if (uid) {
          const settings = readAppSettings(uid);
          if (settings.adMessage) {
            const pro = readV1(uid);
            pro.draftBackup = { message: settings.adMessage, entities: settings.adEntities || [], savedAt: Date.now() };
            writeV1(uid, pro);
          }
        }
        return handler.call(this, ctx, next);
      });
    }
    return originalCallbackQuery.call(this, trigger, ...middleware);
  };

  BotClass.prototype.on = function(filter, ...middleware) {
    if (filter !== "message:text") return originalOn.call(this, filter, ...middleware);
    for (const handler of middleware) if (typeof handler === "function") appTextHandler = handler;
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const uid = uidOf(ctx);
      if (uid && pending.has(uid)) return handlePendingText(ctx);
      return handler.call(this, ctx, next);
    });
    return originalOn.call(this, filter, ...wrapped);
  };

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotV1HandlersRegistered) {
      Object.defineProperty(this, "__telepilotV1HandlersRegistered", { value: true });
      registerHandlers(this);
    }
    return originalStart.apply(this, args);
  };
}
