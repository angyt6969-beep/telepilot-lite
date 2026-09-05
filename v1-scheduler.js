import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bigInt from "big-integer";
import { Bot } from "grammy";
import { Api as MtApi, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import {
  hasPersonalSessionFile,
  listUserIds,
  readAppSettings,
} from "./posting-engine-enhancements.js";
import {
  readV1,
  v1Stats,
  withForcedTemplate,
  writeV1,
} from "./v1-engine.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const SESSION_KEY_FILE = path.join(DATA_DIR, ".personal-session-key");
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const TICK_MS = 30_000;
const SESSION_CHECK_MS = 6 * 60 * 60_000;
let ticking = false;

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

function hasAccess(uid, settings) {
  if (isAdmin(uid)) return true;
  if (settings?.accessRevoked) return false;
  if (settings?.accessLifetime) return true;
  return Number(settings?.accessUntil || 0) > Date.now();
}

function localDate(pro, now = Date.now()) {
  const offset = Number(pro.schedule?.utcOffsetMinutes || 0);
  return new Date(now + offset * 60_000);
}

function dateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function timeKey(date) {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function toMtEntities(entities = []) {
  const out = [];
  for (const entity of entities) {
    const base = { offset: Number(entity?.offset || 0), length: Number(entity?.length || 0) };
    try {
      if (entity?.type === "bold") out.push(new MtApi.MessageEntityBold(base));
      else if (entity?.type === "italic") out.push(new MtApi.MessageEntityItalic(base));
      else if (entity?.type === "underline") out.push(new MtApi.MessageEntityUnderline(base));
      else if (entity?.type === "strikethrough") out.push(new MtApi.MessageEntityStrike(base));
      else if (entity?.type === "spoiler") out.push(new MtApi.MessageEntitySpoiler(base));
      else if (entity?.type === "code") out.push(new MtApi.MessageEntityCode(base));
      else if (entity?.type === "pre") out.push(new MtApi.MessageEntityPre({ ...base, language: entity.language || "" }));
      else if (entity?.type === "text_link") out.push(new MtApi.MessageEntityTextUrl({ ...base, url: entity.url || "" }));
      else if (entity?.type === "custom_emoji" && /^\d+$/.test(String(entity.custom_emoji_id || ""))) out.push(new MtApi.MessageEntityCustomEmoji({ ...base, documentId: bigInt(entity.custom_emoji_id) }));
    } catch {}
  }
  return out;
}

function sessionPath(uid) { return path.join(DATA_DIR, "users", String(uid), "personal-session.enc"); }

function decryptSession(uid) {
  const payload = JSON.parse(fs.readFileSync(sessionPath(uid), "utf8"));
  const key = fs.readFileSync(SESSION_KEY_FILE);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function openPersonalClient(uid) {
  const client = new TelegramClient(new StringSession(decryptSession(uid)), API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Personal account session is no longer authorized.");
  try { await client.getMe(); } catch {}
  return client;
}

async function personalTarget(client, destination) {
  if (destination?.username) return destination.username;
  const wanted = String(destination?.id || "").replace(/^-100/, "").replace(/^-/, "");
  const dialogs = await client.getDialogs({ limit: 500 });
  for (const dialog of dialogs) {
    const ids = [dialog?.id, dialog?.entity?.id, dialog?.inputEntity?.chatId, dialog?.inputEntity?.channelId]
      .filter(value => value !== undefined && value !== null)
      .map(value => String(value).replace(/\D/g, ""));
    if (wanted && ids.includes(wanted)) return dialog;
  }
  throw new Error(`Could not resolve ${destination?.label || destination?.id || "destination"} from the connected account.`);
}

async function sendCycle(uid, settings, schedulerBot, forcedTemplateId = "") {
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  if (!groups.length || !settings.adMessage) return { attempted: 0 };

  return withForcedTemplate(uid, forcedTemplateId, async () => {
    if (!hasPersonalSessionFile(uid)) {
      for (const destination of groups) {
        try {
          await schedulerBot.api.sendMessage(destination.id, settings.adMessage, Array.isArray(settings.adEntities) && settings.adEntities.length ? { entities: settings.adEntities } : {});
        } catch (err) {
          console.warn(`Exact scheduler bot send failed for ${uid}/${destination.id}:`, err?.description || err?.message || err);
        }
      }
      return { attempted: groups.length };
    }

    let client;
    try {
      client = await openPersonalClient(uid);
      const formattingEntities = toMtEntities(settings.adEntities || []);
      for (const destination of groups) {
        try {
          const entity = await personalTarget(client, destination);
          await client.sendMessage(entity, {
            message: settings.adMessage,
            ...(formattingEntities.length ? { formattingEntities } : {}),
          });
        } catch (err) {
          console.warn(`Exact scheduler personal send failed for ${uid}/${destination.id}:`, err?.errorMessage || err?.message || err);
        }
      }
      return { attempted: groups.length };
    } finally {
      try { await client?.disconnect(); } catch {}
    }
  });
}

function dueExactRules(pro, now = Date.now()) {
  const local = localDate(pro, now);
  const today = dateKey(local);
  const clock = timeKey(local);
  const day = local.getUTCDay();
  return (pro.exactTimes || []).filter(rule => {
    if (rule?.enabled === false || String(rule?.time || "") !== clock) return false;
    const days = Array.isArray(rule.days) ? rule.days.map(Number) : [0,1,2,3,4,5,6];
    if (!days.includes(day)) return false;
    return String(rule.lastRunKey || "") !== `${today}|${clock}`;
  });
}

async function processExact(uid, settings, pro, schedulerBot, now) {
  const rules = dueExactRules(pro, now);
  if (!rules.length) return false;
  const local = localDate(pro, now);
  const key = `${dateKey(local)}|${timeKey(local)}`;
  for (const rule of rules) {
    try { await sendCycle(uid, settings, schedulerBot, String(rule.templateId || "")); }
    finally { rule.lastRunKey = key; }
  }
  writeV1(uid, pro);
  return true;
}

async function processOneTime(uid, settings, pro, schedulerBot, now) {
  let changed = false;
  for (const job of pro.oneTimeJobs || []) {
    if (job.status && job.status !== "pending") continue;
    const runAt = Number(job.runAt || 0);
    if (!runAt || runAt > now) continue;
    try {
      await sendCycle(uid, settings, schedulerBot, String(job.templateId || ""));
      job.status = "done";
      job.completedAt = Date.now();
    } catch (err) {
      job.status = "failed";
      job.completedAt = Date.now();
      job.error = String(err?.message || err).slice(0, 180);
    }
    changed = true;
  }
  if (changed) writeV1(uid, pro);
}

async function flushAlerts(uid, pro, schedulerBot) {
  if (!Array.isArray(pro.pendingAlerts) || !pro.pendingAlerts.length) return;
  const alerts = pro.pendingAlerts.slice(0, 3);
  let sent = 0;
  for (const alert of alerts) {
    try {
      await schedulerBot.api.sendMessage(uid, alert.text);
      sent++;
    } catch { break; }
  }
  if (sent) {
    pro.pendingAlerts.splice(0, sent);
    writeV1(uid, pro);
  }
}

async function maybeAccessReminder(uid, settings, pro, schedulerBot, now) {
  if (isAdmin(uid) || settings.accessLifetime || settings.accessRevoked || !settings.accessUntil) return;
  const remaining = Number(settings.accessUntil) - now;
  if (remaining <= 0 || remaining > 3 * 86_400_000) return;
  const days = Math.max(1, Math.ceil(remaining / 86_400_000));
  const key = `${dateKey(localDate(pro, now))}|${days}`;
  if (pro.reminders?.lastAccessKey === key) return;
  try {
    await schedulerBot.api.sendMessage(uid, `💎 TelePilot Access\n\nYour access expires in ${days} day${days === 1 ? "" : "s"}.\n\nYour posting setup and saved templates stay on TelePilot even if you renew later.`);
    pro.reminders.lastAccessKey = key;
    writeV1(uid, pro);
  } catch {}
}

function weekKey(local) {
  const copy = new Date(local.getTime());
  const day = copy.getUTCDay();
  copy.setUTCDate(copy.getUTCDate() - day);
  return dateKey(copy);
}

async function maybeWeeklyRecap(uid, pro, schedulerBot, now) {
  if (!pro.weeklyRecap?.enabled) return;
  const local = localDate(pro, now);
  if (local.getUTCDay() !== Number(pro.weeklyRecap.day || 0)) return;
  if (local.getUTCHours() !== Number(pro.weeklyRecap.hour || 18)) return;
  const key = weekKey(local);
  if (pro.weeklyRecap.lastKey === key) return;
  const stats = v1Stats(uid, now).week;
  if (stats.sent || stats.failed || stats.skipped) {
    try {
      await schedulerBot.api.sendMessage(uid, [
        "📊 Weekly TelePilot recap",
        "",
        `Sent — ${stats.sent}`,
        `Failed — ${stats.failed}`,
        `Skipped — ${stats.skipped}`,
        "",
        "Open Activity → Posting history for details.",
      ].join("\n"));
    } catch { return; }
  }
  pro.weeklyRecap.lastKey = key;
  writeV1(uid, pro);
}

async function maybeSessionHealth(uid, pro, schedulerBot, now) {
  if (!hasPersonalSessionFile(uid)) return;
  if (Number(pro.sessionHealth?.lastCheckedAt || 0) > now - SESSION_CHECK_MS) return;
  let client;
  try {
    client = await openPersonalClient(uid);
    pro.sessionHealth.status = "connected";
    pro.sessionHealth.lastError = "";
    if (!pro.sessionHealth.firstSeenAt) pro.sessionHealth.firstSeenAt = now;
  } catch (err) {
    const wasHealthy = pro.sessionHealth.status === "connected";
    pro.sessionHealth.status = "needs-reconnect";
    pro.sessionHealth.lastError = String(err?.message || err).slice(0, 180);
    if (wasHealthy && pro.notificationMode !== "silent") {
      try { await schedulerBot.api.sendMessage(uid, "⚠️ TelePilot Sender\n\nYour connected Telegram session needs attention. Open Sender and reconnect your personal account.\n\nYour messages, destinations and schedules are still saved."); } catch {}
    }
  } finally {
    pro.sessionHealth.lastCheckedAt = now;
    writeV1(uid, pro);
    try { await client?.disconnect(); } catch {}
  }
}

async function tick(schedulerBot) {
  if (ticking) return;
  ticking = true;
  const now = Date.now();
  try {
    for (const uid of listUserIds()) {
      const settings = readAppSettings(uid);
      const pro = readV1(uid);
      try { await flushAlerts(uid, pro, schedulerBot); } catch {}
      try { await maybeSessionHealth(uid, pro, schedulerBot, now); } catch {}
      try { await maybeAccessReminder(uid, settings, pro, schedulerBot, now); } catch {}
      if (!hasAccess(uid, settings) || pro.paused) continue;
      try { await processExact(uid, settings, pro, schedulerBot, now); } catch (err) { console.warn(`Exact schedule error for ${uid}:`, err?.message || err); }
      try { await processOneTime(uid, settings, pro, schedulerBot, now); } catch (err) { console.warn(`One-time schedule error for ${uid}:`, err?.message || err); }
      try { await maybeWeeklyRecap(uid, pro, schedulerBot, now); } catch {}
    }
  } finally {
    ticking = false;
  }
}

export function startV1Scheduler() {
  if (!BOT_TOKEN || !API_ID || !API_HASH) {
    console.warn("TelePilot v1 scheduler disabled: missing Telegram credentials");
    return null;
  }
  const schedulerBot = new Bot(BOT_TOKEN);
  const run = () => void tick(schedulerBot).catch(err => console.error("TelePilot v1 scheduler tick failed:", err?.message || err));
  const initial = setTimeout(run, 15_000);
  const timer = setInterval(run, TICK_MS);
  initial.unref?.();
  timer.unref?.();
  console.log("TelePilot v1 exact-time scheduler enabled");
  return timer;
}
