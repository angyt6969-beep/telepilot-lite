import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bigInt from "big-integer";
import { InlineKeyboard, InputFile } from "grammy";
import { Api as MtApi, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import {
  defaultProSettings,
  hasPersonalSessionFile,
  listUserIds,
  readAppSettings,
  readProSettings,
  renderDynamicMessage,
  scheduleAllowsNow,
  writeProSettings,
} from "./posting-engine-enhancements.js";
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

const DATA_DIR = process.env.DATA_DIR || "/data";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const SESSION_KEY_FILE = path.join(DATA_DIR, ".personal-session-key");
const KEY_FILE = path.join(DATA_DIR, "access-keys.json");
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const MEDIA_LIMIT = 20 * 1024 * 1024;

const proAwaiting = new Map();
const messageEditorUsers = new Set();
let appTextHandler = null;
let appMessageChangeHandler = null;
let appAddGroupHandler = null;
let appStartConfirmHandler = null;
let appStopHandler = null;
const intervalHandlers = new Map();

function uidOf(ctx) { return ctx?.from?.id ? String(ctx.from.id) : ""; }
function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function settingsPath(uid) { return path.join(userDir(uid), "settings.json"); }
function sessionPath(uid) { return path.join(userDir(uid), "personal-session.enc"); }

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}

function sanitizeName(value, fallback = "Template") {
  const clean = String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 40);
  return clean || fallback;
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

function formatOffset(minutes) {
  const value = Number(minutes || 0);
  const sign = value >= 0 ? "+" : "-";
  const abs = Math.abs(value);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function parseOffset(value) {
  const match = String(value || "").trim().match(/^([+-])(\d{1,2}):?(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return match[1] === "-" ? -total : total;
}

function daysLabel(days) {
  const set = new Set((days || []).map(Number));
  if (set.size === 7) return "Every day";
  if ([1, 2, 3, 4, 5].every(day => set.has(day)) && set.size === 5) return "Weekdays";
  if (set.has(0) && set.has(6) && set.size === 2) return "Weekends";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return names.filter((_, i) => set.has(i)).join(", ") || "No days";
}

function destinationLabel(group) { return String(group?.username || group?.label || group?.id || "Destination"); }
function destinationId(group) { return String(group?.id || group?.username || ""); }

function fakeCallbackContext(ctx, data, messageId) {
  const fake = Object.create(ctx);
  Object.defineProperty(fake, "update", {
    configurable: true,
    value: {
      callback_query: {
        id: "telepilot-pro",
        from: ctx.from,
        chat_instance: "telepilot-pro",
        data,
        message: {
          message_id: messageId || ctx?.callbackQuery?.message?.message_id || 0,
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
        message_id: 2_000_000_000,
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

async function applyMessage(ctx, text, entities = []) {
  if (!appMessageChangeHandler || !appTextHandler) throw new Error("Message editor is not ready yet.");
  const messageId = ctx?.callbackQuery?.message?.message_id || ctx?.message?.message_id || 0;
  await appMessageChangeHandler(fakeCallbackContext(ctx, "message_change", messageId), async () => undefined);
  await appTextHandler(fakeTextContext(ctx, text, entities), async () => undefined);
}

async function applyDestination(ctx, target) {
  if (!appAddGroupHandler || !appTextHandler) throw new Error("Destination editor is not ready yet.");
  const messageId = ctx?.callbackQuery?.message?.message_id || ctx?.message?.message_id || 0;
  await appAddGroupHandler(fakeCallbackContext(ctx, "add_group", messageId), async () => undefined);
  await appTextHandler(fakeTextContext(ctx, target, []), async () => undefined);
}

async function applyInterval(ctx, minutes) {
  const handler = intervalHandlers.get(Number(minutes));
  if (!handler) return false;
  const fake = fakeCallbackContext(ctx, `i${minutes}`, ctx?.callbackQuery?.message?.message_id || 0);
  await handler(fake, async () => undefined);
  return true;
}

function templateKeyboard(pro) {
  const kb = new InlineKeyboard();
  pro.templates.slice(0, 12).forEach(template => {
    kb.text(`📝 ${String(template.name).slice(0, 28)}`, `tpl_load:${template.id}`).row();
  });
  kb.text("＋ Save current", "tpl_save").text("Manage", "tpl_manage").row();
  kb.text("⬅️ Tools", "tools");
  return kb;
}

async function showTemplates(ctx) {
  const uid = uidOf(ctx);
  const pro = readProSettings(uid);
  const text = [
    "📝 Templates",
    `Saved — ${pro.templates.length}`,
    "",
    pro.templates.length
      ? "Choose a template to make it the active posting message."
      : "Save your current message as a reusable template.",
  ].join("\n");
  await ctx.editMessageText(text, { reply_markup: templateKeyboard(pro) });
}

async function showTemplateManager(ctx) {
  const uid = uidOf(ctx);
  const pro = readProSettings(uid);
  const kb = new InlineKeyboard();
  pro.templates.slice(0, 10).forEach(template => {
    kb.text(`📄 ${String(template.name).slice(0, 20)}`, `tpl_dup:${template.id}`)
      .text("🗑", `tpl_del:${template.id}`).row();
  });
  kb.text("⬅️ Templates", "templates");
  await ctx.editMessageText(
    ["📝 Manage templates", "", "Tap a template name to duplicate it, or 🗑 to delete it."].join("\n"),
    { reply_markup: kb },
  );
}

async function showAdvancedSchedule(ctx) {
  const uid = uidOf(ctx);
  const pro = readProSettings(uid);
  const s = pro.schedule;
  const status = s.enabled ? (scheduleAllowsNow(pro) ? "✅ Active now" : "🌙 Outside posting window") : "○ Disabled";
  const kb = new InlineKeyboard()
    .text(s.enabled ? "Disable window" : "Enable window", "sched_toggle").row()
    .text("Every day", "sched_days:all").text("Weekdays", "sched_days:weekdays").text("Weekend", "sched_days:weekends").row()
    .text("24/7", "sched_hours:all").text("09–22", "sched_hours:day").text("09–18", "sched_hours:work").row()
    .text("Set timezone", "sched_timezone").row()
    .text("⬅️ Tools", "tools");
  await ctx.editMessageText(
    [
      "📆 Advanced schedule",
      status,
      "",
      `Days — ${daysLabel(s.days)}`,
      `Hours — ${s.start}–${s.end}`,
      `Timezone — UTC${formatOffset(s.utcOffsetMinutes)}`,
      "",
      "Outside this window, scheduled cycles are skipped automatically and resume on the next allowed cycle.",
    ].join("\n"),
    { reply_markup: kb },
  );
}

async function showStagger(ctx) {
  const uid = uidOf(ctx);
  const pro = readProSettings(uid);
  const kb = new InlineKeyboard()
    .text("0s", "stagger:0").text("2s", "stagger:2").text("5s", "stagger:5").row()
    .text("10s", "stagger:10").text("20s", "stagger:20").row()
    .text("⬅️ Tools", "tools");
  await ctx.editMessageText(
    [
      "⏱ Destination spacing",
      `Extra delay — ${Number(pro.staggerSeconds || 0)}s`,
      "",
      "Adds a small delay between destinations on top of TelePilot's built-in safety gap.",
    ].join("\n"),
    { reply_markup: kb },
  );
}

async function showPlaceholders(ctx) {
  const uid = uidOf(ctx);
  const pro = readProSettings(uid);
  const kb = new InlineKeyboard()
    .text(pro.placeholders ? "Disable placeholders" : "Enable placeholders", "placeholders_toggle").row()
    .text("⬅️ Tools", "tools");
  await ctx.editMessageText(
    [
      "✨ Dynamic placeholders",
      `Status — ${pro.placeholders ? "Enabled" : "Disabled"}`,
      "",
      "{date} — local date",
      "{time} — local time",
      "{datetime} — date and time",
      "{destination} — destination name",
      "{sender} — active sender",
      "",
      "Timezone follows the Advanced Schedule timezone setting.",
    ].join("\n"),
    { reply_markup: kb },
  );
}

async function showDestinationToggles(ctx) {
  const uid = uidOf(ctx);
  const settings = readAppSettings(uid);
  const pro = readProSettings(uid);
  const disabled = new Set(pro.disabledDestinationIds.map(String));
  const kb = new InlineKeyboard();
  (settings.groups || []).slice(0, 30).forEach((group, index) => {
    const off = disabled.has(destinationId(group));
    kb.text(`${off ? "○" : "✅"} ${destinationLabel(group).slice(0, 30)}`, `dest_toggle:${index}`).row();
  });
  kb.text("⬅️ Destinations", "groups");
  await ctx.editMessageText(
    [
      "📁 Destination switches",
      "",
      settings.groups?.length ? "Tap a destination to enable or disable it without deleting it." : "No destinations saved yet.",
    ].join("\n"),
    { reply_markup: kb },
  );
}

async function openPersonalClient(uid) {
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
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Personal account session is no longer authorized.");
  return client;
}

function toMtprotoEntities(entities = []) {
  const out = [];
  for (const e of entities) {
    const base = { offset: Number(e.offset), length: Number(e.length) };
    try {
      if (e.type === "bold") out.push(new MtApi.MessageEntityBold(base));
      else if (e.type === "italic") out.push(new MtApi.MessageEntityItalic(base));
      else if (e.type === "underline") out.push(new MtApi.MessageEntityUnderline(base));
      else if (e.type === "strikethrough") out.push(new MtApi.MessageEntityStrike(base));
      else if (e.type === "spoiler") out.push(new MtApi.MessageEntitySpoiler(base));
      else if (e.type === "code") out.push(new MtApi.MessageEntityCode(base));
      else if (e.type === "pre") out.push(new MtApi.MessageEntityPre({ ...base, language: e.language || "" }));
      else if (e.type === "text_link") out.push(new MtApi.MessageEntityTextUrl({ ...base, url: e.url || "" }));
      else if (e.type === "custom_emoji" && /^\d+$/.test(e.custom_emoji_id || "")) {
        out.push(new MtApi.MessageEntityCustomEmoji({ ...base, documentId: bigInt(e.custom_emoji_id) }));
      }
    } catch {}
  }
  return out;
}

async function sendTest(ctx) {
  const uid = uidOf(ctx);
  const settings = readAppSettings(uid);
  const pro = readProSettings(uid);
  if (!settings.adMessage) return ctx.answerCallbackQuery({ text: "Create a message first.", show_alert: true });
  const destination = { id: String(ctx.chat.id), label: "Test preview", username: "" };
  const sender = settings.personalUsername ? `@${settings.personalUsername}` : "TelePilot Bot";
  const rendered = renderDynamicMessage(settings.adMessage, settings.adEntities || [], { pro, destination, sender });
  await ctx.answerCallbackQuery({ text: "Sending test…" });

  if (hasPersonalSessionFile(uid)) {
    let client;
    try {
      client = await openPersonalClient(uid);
      const mtEntities = toMtprotoEntities(rendered.entities);
      if (pro.media?.localPath && fs.existsSync(pro.media.localPath)) {
        await client.sendFile("me", {
          file: pro.media.localPath,
          caption: rendered.text,
          ...(mtEntities.length ? { formattingEntities: mtEntities } : {}),
          forceDocument: pro.media.kind === "document",
          supportsStreaming: pro.media.kind === "video",
        });
      } else {
        await client.sendMessage("me", { message: rendered.text || "\u2063", ...(mtEntities.length ? { formattingEntities: mtEntities } : {}) });
      }
      await ctx.reply("✅ Test sent to your connected account's Saved Messages.");
    } finally {
      try { await client?.disconnect(); } catch {}
    }
    return;
  }

  if (pro.media?.fileId) {
    const options = { ...(rendered.text ? { caption: rendered.text } : {}), ...(rendered.entities.length ? { caption_entities: rendered.entities } : {}) };
    if (pro.media.kind === "photo") await ctx.api.sendPhoto(ctx.chat.id, pro.media.fileId, options);
    else if (pro.media.kind === "video") await ctx.api.sendVideo(ctx.chat.id, pro.media.fileId, { ...options, supports_streaming: true });
    else if (pro.media.kind === "animation") await ctx.api.sendAnimation(ctx.chat.id, pro.media.fileId, options);
    else await ctx.api.sendDocument(ctx.chat.id, pro.media.fileId, options);
  } else {
    await ctx.api.sendMessage(ctx.chat.id, rendered.text || "\u2063", rendered.entities.length ? { entities: rendered.entities } : {});
  }
}

async function checkDestinationHealth(ctx) {
  const uid = uidOf(ctx);
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  if (!groups.length) return ctx.editMessageText("🩺 Destination health\n\nNo destinations saved yet.", { reply_markup: new InlineKeyboard().text("⬅️ Destinations", "groups") });
  await ctx.answerCallbackQuery({ text: "Checking…" });
  const lines = ["🩺 Destination health", ""];

  if (hasPersonalSessionFile(uid)) {
    let client;
    try {
      client = await openPersonalClient(uid);
      const dialogs = await client.getDialogs({ limit: 500 });
      for (const group of groups.slice(0, 30)) {
        let dialog = null;
        if (group.username) dialog = dialogs.find(item => String(item?.entity?.username || "").toLowerCase() === String(group.username).replace(/^@/, "").toLowerCase());
        if (!dialog) {
          const raw = String(group.id || "").replace(/^-100/, "").replace(/^-/, "");
          dialog = dialogs.find(item => String(item?.entity?.id || "").replace(/\D/g, "") === raw);
        }
        if (!dialog) lines.push(`❌ ${destinationLabel(group)} — not joined`);
        else if (dialog.entity?.broadcast === true && dialog.entity?.creator !== true && dialog.entity?.adminRights?.postMessages !== true) {
          lines.push(`⚠️ ${destinationLabel(group)} — cannot post`);
        } else lines.push(`✅ ${destinationLabel(group)} — ready`);
      }
    } catch (err) {
      lines.push(`❌ Could not check personal account — ${String(err?.message || err).slice(0, 100)}`);
    } finally {
      try { await client?.disconnect(); } catch {}
    }
  } else {
    const botInfo = await ctx.api.getMe();
    for (const group of groups.slice(0, 30)) {
      try {
        const member = await ctx.api.getChatMember(group.id, botInfo.id);
        const channel = group.type === "channel";
        const ready = member.status === "administrator" && (!channel || member.can_post_messages === true);
        lines.push(`${ready ? "✅" : "⚠️"} ${destinationLabel(group)} — ${ready ? "ready" : "permissions needed"}`);
      } catch {
        lines.push(`❌ ${destinationLabel(group)} — inaccessible`);
      }
    }
  }

  await ctx.editMessageText(lines.join("\n"), { reply_markup: new InlineKeyboard().text("↻ Check again", "dest_health").row().text("⬅️ Destinations", "groups") });
}

async function showHistory(ctx) {
  const uid = uidOf(ctx);
  const pro = readProSettings(uid);
  const recent = pro.history.slice(-15).reverse();
  const lines = ["📜 Posting history", ""];
  if (!recent.length) lines.push("No enhanced posting history yet.");
  else {
    for (const item of recent) {
      const time = new Date(item.ts).toISOString().slice(11, 16);
      const icon = item.status === "sent" ? "✅" : item.status === "failed" ? "❌" : "⏭";
      const extra = item.status === "skipped" ? ` — ${item.reason}` : item.status === "failed" ? ` — ${item.error || "failed"}` : "";
      lines.push(`${icon} ${time} — ${item.destination}${extra}`.slice(0, 180));
    }
  }
  await ctx.editMessageText(lines.join("\n"), { reply_markup: new InlineKeyboard().text("↻ Refresh", "history").row().text("⬅️ Tools", "tools") });
}

const IMPORT_INTERVALS = new Set([1, 5, 10, 15, 30, 45, 60, 90, 120]);
const BACKUP_MAX_BYTES = 256 * 1024;
function safeEntity(entity, textLength) {
  const allowed = new Set([
    "bold", "italic", "underline", "strikethrough", "spoiler", "blockquote",
    "expandable_blockquote", "code", "pre", "text_link", "custom_emoji",
  ]);
  if (!entity || !allowed.has(entity.type)) return null;
  const offset = Number(entity.offset);
  const length = Number(entity.length);
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || offset + length > textLength) return null;
  const out = { type: entity.type, offset, length };
  if (entity.type === "text_link" && typeof entity.url === "string" && entity.url.length <= 2048) out.url = entity.url;
  if (entity.type === "pre" && typeof entity.language === "string") out.language = entity.language.slice(0, 64);
  if (entity.type === "custom_emoji" && /^\d+$/.test(String(entity.custom_emoji_id || ""))) out.custom_emoji_id = String(entity.custom_emoji_id);
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
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(source.start || ""))) schedule.start = source.start;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(source.end || ""))) schedule.end = source.end;
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
    destinations: (settings.groups || [])
      .filter(group => /^@[A-Za-z0-9_]{5,32}$/.test(String(group.username || "")))
      .slice(0, 1000)
      .map(group => ({
        label: String(group.label || "").slice(0, 120),
        type: String(group.type || "").slice(0, 24),
        username: String(group.username),
      })),
    intervalMinutes: IMPORT_INTERVALS.has(Number(settings.intervalMinutes)) ? Number(settings.intervalMinutes) : 30,
    pro: {
      placeholders: pro.placeholders === true,
      staggerSeconds: [0, 2, 5, 10, 20].includes(Number(pro.staggerSeconds)) ? Number(pro.staggerSeconds) : 0,
      schedule: safeSchedule(pro.schedule, defaultProSettings().schedule),
      templates: (pro.templates || []).slice(0, 20).map(template => {
        const message = String(template.message || "").slice(0, 4096);
        return {
          name: sanitizeName(template.name),
          message,
          entities: safeEntities(template.entities, message.length),
          createdAt: Number(template.createdAt || Date.now()),
        };
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
  if (parsed?.kind !== "TelePilotConfig" || Number(parsed?.version) !== 2) {
    throw new Error("This backup uses an unsupported format. Create a fresh TelePilot export first.");
  }
  if (String(parsed.ownerUid || "") !== String(uid)) {
    throw new Error("This signed backup belongs to a different Telegram account.");
  }
  const { signature, ...payload } = parsed;
  if (!/^[a-f0-9]{64}$/i.test(String(signature || "")) || !verifyBackupSignature(payload, signature)) {
    throw new Error("Backup signature is invalid or the file was modified.");
  }
  const messageText = String(payload.message?.text || "");
  if (Buffer.byteLength(messageText, "utf8") > 16_384 || messageText.length > 4096) throw new Error("Backup message is too large.");
  const intervalMinutes = Number(payload.intervalMinutes);
  if (!IMPORT_INTERVALS.has(intervalMinutes)) throw new Error("Backup interval is invalid.");
  const destinations = (Array.isArray(payload.destinations) ? payload.destinations : []).slice(0, 1000).map(item => ({
    username: String(item?.username || ""),
    label: String(item?.label || "").slice(0, 120),
    type: String(item?.type || "").slice(0, 24),
  }));
  if (destinations.some(item => !/^@[A-Za-z0-9_]{5,32}$/.test(item.username))) throw new Error("Backup contains an invalid destination.");
  const currentPro = readProSettings(uid);
  const templates = (Array.isArray(payload.pro?.templates) ? payload.pro.templates : []).slice(0, 20).map((template, index) => {
    const message = String(template?.message || "");
    if (message.length > 4096) throw new Error("Backup contains an oversized template.");
    return {
      id: crypto.randomBytes(4).toString("hex"),
      name: sanitizeName(template?.name, `Template ${index + 1}`),
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
}

async function showAdmin(ctx) {
  const uid = uidOf(ctx);
  if (!isAdmin(uid)) return ctx.answerCallbackQuery({ text: "Owner only.", show_alert: true });
  const users = listUserIds();
  const now = Date.now();
  let active = 0;
  let personal = 0;
  for (const userId of users) {
    const settings = readAppSettings(userId);
    if (settings.accessLifetime === true || Number(settings.accessUntil || 0) > now) active++;
    if (hasPersonalSessionFile(userId)) personal++;
  }
  const keyDb = readJson(KEY_FILE, { keys: [] });
  const keys = Array.isArray(keyDb.keys) ? keyDb.keys : [];
  const unused = keys.filter(key => !key.revokedAt && !key.redeemedAt).length;
  const redeemed = keys.filter(key => key.redeemedAt && !key.revokedAt).length;
  await ctx.editMessageText(
    [
      "🛡 TelePilot Admin",
      "",
      `Profiles — ${users.length}`,
      `Active access — ${active}`,
      `Personal senders — ${personal}`,
      `Unused keys — ${unused}`,
      `Redeemed keys — ${redeemed}`,
    ].join("\n"),
    { reply_markup: new InlineKeyboard().text("↻ Refresh", "admin_panel").row().text("⬅️ Tools", "tools") },
  );
}

async function showTools(ctx) {
  const uid = uidOf(ctx);
  const pro = readProSettings(uid);
  const kb = new InlineKeyboard()
    .text("🧪 Test send", "test_send").text("📝 Templates", "templates").row()
    .text("📆 Advanced schedule", "advanced_schedule").text("⏱ Spacing", "stagger_menu").row()
    .text("🩺 Health", "dest_health").text("📜 History", "history").row()
    .text("✨ Placeholders", "placeholders").text("📦 Export", "export_config").row()
    .text(pro.paused ? "▶ Resume" : "⏸ Pause", "posting_pause").text("⏭ Skip next", "posting_skip").row()
    .text("📥 Import", "import_config");
  if (isAdmin(uid)) kb.text("🛡 Admin", "admin_panel");
  kb.row().text("⬅️ Dashboard", "home");
  await ctx.editMessageText(
    [
      "⚙️ TelePilot Tools",
      `Posting — ${pro.paused ? "Paused" : "Active when LIVE"}`,
      `Next cycle — ${pro.skipNext ? "Will be skipped" : "Normal"}`,
      "",
      "Extra controls for posting, schedules, templates and diagnostics.",
    ].join("\n"),
    { reply_markup: kb },
  );
}

function mediaInfo(message) {
  if (message?.photo?.length) {
    const file = message.photo[message.photo.length - 1];
    return { kind: "photo", fileId: file.file_id, fileUniqueId: file.file_unique_id, size: Number(file.file_size || 0), name: `${file.file_unique_id || "photo"}.jpg` };
  }
  for (const kind of ["video", "animation", "document"]) {
    const file = message?.[kind];
    if (!file) continue;
    return {
      kind,
      fileId: file.file_id,
      fileUniqueId: file.file_unique_id,
      size: Number(file.file_size || 0),
      name: String(file.file_name || `${file.file_unique_id || kind}${kind === "video" ? ".mp4" : ""}`).replace(/[^A-Za-z0-9._-]+/g, "_"),
      mimeType: file.mime_type || "",
    };
  }
  return null;
}

async function saveIncomingMedia(ctx) {
  const uid = uidOf(ctx);
  if (!messageEditorUsers.has(uid)) return;
  const info = mediaInfo(ctx.message);
  if (!info) return;
  if (info.size > MEDIA_LIMIT) {
    return ctx.reply("❌ Media is over 20 MB. TelePilot currently keeps the 20 MB limit so the same saved post works with both bot and personal-account senders.");
  }

  let localPath = "";
  try {
    const file = await ctx.api.getFile(info.fileId);
    if (!file.file_path) throw new Error("Telegram did not provide a file path.");
    const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mediaDir = path.join(userDir(uid), "media");
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    localPath = path.join(mediaDir, info.name || `media-${Date.now()}`);
    fs.writeFileSync(localPath, buffer, { mode: 0o600 });
  } catch (err) {
    return ctx.reply(`❌ Could not save that media: ${String(err?.message || err).slice(0, 120)}`);
  }

  const pro = readProSettings(uid);
  if (pro.media?.localPath && pro.media.localPath !== localPath) {
    try { fs.rmSync(pro.media.localPath, { force: true }); } catch {}
  }
  pro.media = { ...info, localPath };
  writeProSettings(uid, pro);

  const caption = String(ctx.message.caption || "");
  const entities = Array.isArray(ctx.message.caption_entities) ? ctx.message.caption_entities : [];
  await applyMessage(ctx, caption || "\u2063", entities);
  messageEditorUsers.delete(uid);
  try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch {}
  await ctx.reply(`✅ ${info.kind[0].toUpperCase() + info.kind.slice(1)} saved with your posting message.`);
}

async function handleProText(ctx) {
  const uid = uidOf(ctx);
  const pending = proAwaiting.get(uid);
  if (!pending) return false;
  proAwaiting.delete(uid);
  const value = String(ctx.message?.text || "").trim();
  try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch {}

  if (pending.type === "template_name") {
    const settings = readAppSettings(uid);
    if (!settings.adMessage) {
      await ctx.api.editMessageText(ctx.chat.id, pending.messageId, "📝 Templates\n\nCreate a message before saving a template.");
      return true;
    }
    const pro = readProSettings(uid);
    pro.templates.push({ id: crypto.randomBytes(4).toString("hex"), name: sanitizeName(value, `Template ${pro.templates.length + 1}`), message: settings.adMessage, entities: settings.adEntities || [], createdAt: Date.now() });
    pro.templates = pro.templates.slice(-20);
    writeProSettings(uid, pro);
    await ctx.api.editMessageText(ctx.chat.id, pending.messageId, "📝 Templates\n\n✅ Template saved.", { reply_markup: new InlineKeyboard().text("Open templates", "templates").row().text("⬅️ Dashboard", "home") });
    return true;
  }

  if (pending.type === "timezone") {
    const offset = parseOffset(value);
    const pro = readProSettings(uid);
    if (offset === null) {
      await ctx.api.editMessageText(ctx.chat.id, pending.messageId, "📆 Advanced schedule\n\n❌ Invalid timezone offset. Use a value like +03:00 or -05:00.", { reply_markup: new InlineKeyboard().text("Try again", "sched_timezone").row().text("⬅️ Schedule", "advanced_schedule") });
      return true;
    }
    pro.schedule.utcOffsetMinutes = offset;
    writeProSettings(uid, pro);
    await ctx.api.editMessageText(ctx.chat.id, pending.messageId, `📆 Advanced schedule\n\n✅ Timezone set to UTC${formatOffset(offset)}.`, { reply_markup: new InlineKeyboard().text("Open schedule", "advanced_schedule") });
    return true;
  }

  return false;
}

function registerHandlers(bot) {
  bot.callbackQuery("tools", async ctx => { await ctx.answerCallbackQuery(); await showTools(ctx); });
  bot.callbackQuery("templates", async ctx => { await ctx.answerCallbackQuery(); await showTemplates(ctx); });
  bot.callbackQuery("tpl_manage", async ctx => { await ctx.answerCallbackQuery(); await showTemplateManager(ctx); });
  bot.callbackQuery("tpl_save", async ctx => {
    const uid = uidOf(ctx);
    const settings = readAppSettings(uid);
    if (!settings.adMessage) return ctx.answerCallbackQuery({ text: "Create a message first.", show_alert: true });
    await ctx.answerCallbackQuery();
    proAwaiting.set(uid, { type: "template_name", messageId: ctx.callbackQuery.message?.message_id });
    await ctx.editMessageText("📝 Save template\n\nSend a short name for this template.", { reply_markup: new InlineKeyboard().text("Cancel", "templates") });
  });
  bot.callbackQuery(/^tpl_load:([a-f0-9]+)$/, async ctx => {
    const uid = uidOf(ctx);
    const pro = readProSettings(uid);
    const template = pro.templates.find(item => item.id === ctx.match[1]);
    if (!template) return ctx.answerCallbackQuery({ text: "Template not found." });
    await ctx.answerCallbackQuery({ text: "Template loaded" });
    await applyMessage(ctx, template.message, template.entities || []);
  });
  bot.callbackQuery(/^tpl_del:([a-f0-9]+)$/, async ctx => {
    const uid = uidOf(ctx);
    const pro = readProSettings(uid);
    pro.templates = pro.templates.filter(item => item.id !== ctx.match[1]);
    writeProSettings(uid, pro);
    await ctx.answerCallbackQuery({ text: "Template deleted" });
    await showTemplateManager(ctx);
  });
  bot.callbackQuery(/^tpl_dup:([a-f0-9]+)$/, async ctx => {
    const uid = uidOf(ctx);
    const pro = readProSettings(uid);
    const source = pro.templates.find(item => item.id === ctx.match[1]);
    if (!source) return ctx.answerCallbackQuery({ text: "Template not found." });
    pro.templates.push({ ...source, id: crypto.randomBytes(4).toString("hex"), name: `${source.name} copy`.slice(0, 40), createdAt: Date.now() });
    pro.templates = pro.templates.slice(-20);
    writeProSettings(uid, pro);
    await ctx.answerCallbackQuery({ text: "Template duplicated" });
    await showTemplateManager(ctx);
  });

  bot.callbackQuery("advanced_schedule", async ctx => { await ctx.answerCallbackQuery(); await showAdvancedSchedule(ctx); });
  bot.callbackQuery("sched_toggle", async ctx => {
    const uid = uidOf(ctx); const pro = readProSettings(uid); pro.schedule.enabled = !pro.schedule.enabled; writeProSettings(uid, pro);
    await ctx.answerCallbackQuery({ text: pro.schedule.enabled ? "Posting window enabled" : "Posting window disabled" }); await showAdvancedSchedule(ctx);
  });
  bot.callbackQuery(/^sched_days:(all|weekdays|weekends)$/, async ctx => {
    const uid = uidOf(ctx); const pro = readProSettings(uid);
    pro.schedule.days = ctx.match[1] === "all" ? [0,1,2,3,4,5,6] : ctx.match[1] === "weekdays" ? [1,2,3,4,5] : [0,6];
    writeProSettings(uid, pro); await ctx.answerCallbackQuery({ text: "Days updated" }); await showAdvancedSchedule(ctx);
  });
  bot.callbackQuery(/^sched_hours:(all|day|work)$/, async ctx => {
    const uid = uidOf(ctx); const pro = readProSettings(uid);
    if (ctx.match[1] === "all") { pro.schedule.start = "00:00"; pro.schedule.end = "00:00"; }
    else if (ctx.match[1] === "day") { pro.schedule.start = "09:00"; pro.schedule.end = "22:00"; }
    else { pro.schedule.start = "09:00"; pro.schedule.end = "18:00"; }
    writeProSettings(uid, pro); await ctx.answerCallbackQuery({ text: "Hours updated" }); await showAdvancedSchedule(ctx);
  });
  bot.callbackQuery("sched_timezone", async ctx => {
    const uid = uidOf(ctx); await ctx.answerCallbackQuery(); proAwaiting.set(uid, { type: "timezone", messageId: ctx.callbackQuery.message?.message_id });
    await ctx.editMessageText("📆 Set timezone\n\nSend your UTC offset, for example +03:00, +01:00 or -05:00.\n\nThis is used for posting windows and {time}/{date} placeholders.", { reply_markup: new InlineKeyboard().text("Cancel", "advanced_schedule") });
  });

  bot.callbackQuery("stagger_menu", async ctx => { await ctx.answerCallbackQuery(); await showStagger(ctx); });
  bot.callbackQuery(/^stagger:(0|2|5|10|20)$/, async ctx => {
    const uid = uidOf(ctx); const pro = readProSettings(uid); pro.staggerSeconds = Number(ctx.match[1]); writeProSettings(uid, pro);
    await ctx.answerCallbackQuery({ text: `Extra spacing set to ${ctx.match[1]}s` }); await showStagger(ctx);
  });

  bot.callbackQuery("placeholders", async ctx => { await ctx.answerCallbackQuery(); await showPlaceholders(ctx); });
  bot.callbackQuery("placeholders_toggle", async ctx => {
    const uid = uidOf(ctx); const pro = readProSettings(uid); pro.placeholders = !pro.placeholders; writeProSettings(uid, pro);
    await ctx.answerCallbackQuery({ text: pro.placeholders ? "Placeholders enabled" : "Placeholders disabled" }); await showPlaceholders(ctx);
  });

  bot.callbackQuery("posting_pause", async ctx => {
    const uid = uidOf(ctx); const pro = readProSettings(uid); pro.paused = !pro.paused; writeProSettings(uid, pro);
    await ctx.answerCallbackQuery({ text: pro.paused ? "Posting paused" : "Posting resumed" }); await showTools(ctx);
  });
  bot.callbackQuery("posting_skip", async ctx => {
    const uid = uidOf(ctx); const pro = readProSettings(uid); pro.skipNext = true; writeProSettings(uid, pro);
    await ctx.answerCallbackQuery({ text: "Next posting cycle will be skipped" }); await showTools(ctx);
  });

  bot.callbackQuery("dest_switches", async ctx => { await ctx.answerCallbackQuery(); await showDestinationToggles(ctx); });
  bot.callbackQuery(/^dest_toggle:(\d+)$/, async ctx => {
    const uid = uidOf(ctx); const settings = readAppSettings(uid); const group = settings.groups?.[Number(ctx.match[1])];
    if (!group) return ctx.answerCallbackQuery({ text: "Destination not found." });
    const pro = readProSettings(uid); const id = destinationId(group); const set = new Set(pro.disabledDestinationIds.map(String));
    if (set.has(id)) set.delete(id); else set.add(id); pro.disabledDestinationIds = [...set]; writeProSettings(uid, pro);
    await ctx.answerCallbackQuery({ text: set.has(id) ? "Destination disabled" : "Destination enabled" }); await showDestinationToggles(ctx);
  });
  bot.callbackQuery("dest_health", async ctx => checkDestinationHealth(ctx));
  bot.callbackQuery("history", async ctx => { await ctx.answerCallbackQuery(); await showHistory(ctx); });
  bot.callbackQuery("test_send", async ctx => sendTest(ctx));

  bot.callbackQuery("export_config", async ctx => {
    const uid = uidOf(ctx);
    await ctx.answerCallbackQuery({ text: "Preparing signed backup…" });
    const buffer = Buffer.from(JSON.stringify(safeExport(uid), null, 2), "utf8");
    await ctx.replyWithDocument(new InputFile(buffer, "telepilot-backup.json"), {
      caption: "📦 Signed TelePilot backup\n\nSessions, access keys, access status, admin data and login credentials are never included.",
    });
    appendSecurityEvent("backup_exported", { uid });
  });
  bot.callbackQuery("import_config", async ctx => {
    const uid = uidOf(ctx);
    if (isSecurityLockdown() || isUserFrozen(uid)) {
      return ctx.answerCallbackQuery({ text: "Import is temporarily disabled by TelePilot security.", show_alert: true });
    }
    await ctx.answerCallbackQuery();
    proAwaiting.set(uid, { type: "import", messageId: ctx.callbackQuery.message?.message_id });
    await ctx.editMessageText(
      "📥 Restore signed backup\n\nSend a TelePilot backup JSON file. The signature and every supported field will be validated before anything changes.",
      { reply_markup: new InlineKeyboard().text("Cancel", "tools") },
    );
  });
  bot.callbackQuery(/^import_config_confirm:([A-Za-z0-9_-]+)$/, async ctx => {
    const uid = uidOf(ctx);
    const pending = proAwaiting.get(uid);
    if (!consumeConfirmationToken(ctx.match[1], uid, "import", uid) || pending?.type !== "import_confirm") {
      return ctx.answerCallbackQuery({ text: "This restore confirmation expired or was already used.", show_alert: true });
    }
    if (isSecurityLockdown() || isUserFrozen(uid)) {
      return ctx.answerCallbackQuery({ text: "Import is temporarily disabled by TelePilot security.", show_alert: true });
    }
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
      await ctx.editMessageText(
        `📥 Restore complete\n\n✅ Signed backup verified\n✅ Message/settings restored\n✅ ${added} public destination${added === 1 ? "" : "s"} processed\n\nA signed pre-import rollback backup was saved server-side.`,
        { reply_markup: new InlineKeyboard().text("⬅️ Dashboard", "home") },
      );
    } catch (err) {
      appendSecurityEvent("backup_import_failed", { uid, reason: String(err?.message || err).slice(0, 120) });
      await ctx.editMessageText(
        `📥 Restore backup\n\n❌ ${String(err?.message || "Restore failed").slice(0, 180)}`,
        { reply_markup: new InlineKeyboard().text("Try again", "import_config").row().text("⬅️ Tools", "tools") },
      );
    }
  });

  bot.callbackQuery("admin_panel", async ctx => { await ctx.answerCallbackQuery(); await showAdmin(ctx); });

  bot.on(["message:photo", "message:video", "message:animation", "message:document"], async ctx => {
    const uid = uidOf(ctx);
    const pending = proAwaiting.get(uid);
    if (pending?.type === "import" && ctx.message.document) {
      try {
        if (Number(ctx.message.document.file_size || 0) > BACKUP_MAX_BYTES) throw new Error("Backup file is too large.");
        const file = await ctx.api.getFile(ctx.message.document.file_id);
        if (!file.file_path) throw new Error("Telegram did not provide the file.");
        const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
        if (!response.ok) throw new Error("Could not download backup file.");
        const raw = await response.text();
        if (Buffer.byteLength(raw, "utf8") > BACKUP_MAX_BYTES) throw new Error("Backup file is too large.");
        const parsed = JSON.parse(raw);
        const config = validateSignedImport(uid, parsed);
        const token = issueConfirmationToken(uid, "import", uid, 120_000);
        proAwaiting.set(uid, { type: "import_confirm", messageId: pending.messageId, config });
        try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch {}
        await ctx.api.editMessageText(
          ctx.chat.id,
          pending.messageId,
          [
            "📥 BACKUP VERIFIED",
            "",
            `Message: ${config.message.text ? `${config.message.text.length} characters` : "not set"}`,
            `Public destinations: ${config.destinations.length}`,
            `Templates: ${config.pro.templates.length}`,
            `Interval: ${config.intervalMinutes} min`,
            "",
            "TelePilot will make a rollback backup before applying this restore.",
          ].join("\n"),
          { reply_markup: new InlineKeyboard().text("✅ Restore", `import_config_confirm:${token}`).success().row().text("✖️ Cancel", "tools") },
        );
      } catch (err) {
        proAwaiting.delete(uid);
        appendSecurityEvent("backup_import_rejected", { uid, reason: String(err?.message || err).slice(0, 120) });
        await ctx.api.editMessageText(
          ctx.chat.id,
          pending.messageId,
          `📥 Restore backup\n\n❌ ${String(err?.message || err).slice(0, 180)}`,
          { reply_markup: new InlineKeyboard().text("Try again", "import_config").row().text("⬅️ Tools", "tools") },
        );
      }
      return;
    }

    await saveIncomingMedia(ctx);
  });
}

export function installProControls(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotProControlsInstalled) return;
  const originalCallbackQuery = BotClass.prototype.callbackQuery;
  const originalOn = BotClass.prototype.on;
  const originalStart = BotClass.prototype.start;
  if (typeof originalCallbackQuery !== "function" || typeof originalOn !== "function" || typeof originalStart !== "function") {
    throw new Error("Unsupported grammY Bot shape for TelePilot pro controls");
  }
  Object.defineProperty(BotClass.prototype, "__telepilotProControlsInstalled", { value: true });

  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    for (const handler of middleware) {
      if (typeof handler !== "function") continue;
      if (trigger === "message_change") appMessageChangeHandler = handler;
      else if (trigger === "add_group") appAddGroupHandler = handler;
      else if (trigger === "start_confirm") appStartConfirmHandler = handler;
      else if (trigger === "stop") appStopHandler = handler;
      else if (typeof trigger === "string" && /^i\d+$/.test(trigger)) intervalHandlers.set(Number(trigger.slice(1)), handler);
    }

    if (trigger === "message_change") {
      middleware = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
        const uid = uidOf(ctx); if (uid) messageEditorUsers.add(uid); return handler.call(this, ctx, next);
      });
    } else if (typeof trigger === "string" && ["home", "message", "tools", "templates"].includes(trigger)) {
      middleware = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
        const uid = uidOf(ctx); if (uid && trigger !== "message") messageEditorUsers.delete(uid); return handler.call(this, ctx, next);
      });
    }
    return originalCallbackQuery.call(this, trigger, ...middleware);
  };

  BotClass.prototype.on = function(filter, ...middleware) {
    if (filter !== "message:text") return originalOn.call(this, filter, ...middleware);
    for (const handler of middleware) if (typeof handler === "function") appTextHandler = handler;
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const uid = uidOf(ctx);
      if (uid && proAwaiting.has(uid)) return handleProText(ctx);
      if (uid && messageEditorUsers.has(uid)) {
        const pro = readProSettings(uid);
        if (pro.media?.localPath) { try { fs.rmSync(pro.media.localPath, { force: true }); } catch {} }
        pro.media = null;
        writeProSettings(uid, pro);
        messageEditorUsers.delete(uid);
      }
      return handler.call(this, ctx, next);
    });
    return originalOn.call(this, filter, ...wrapped);
  };

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotProHandlersRegistered) {
      Object.defineProperty(this, "__telepilotProHandlersRegistered", { value: true });
      registerHandlers(this);
    }
    return originalStart.apply(this, args);
  };
}
