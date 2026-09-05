import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bigInt from "big-integer";
import { Bot } from "grammy";
import { Api as MtApi, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { hasPersonalSessionFile, listUserIds, readAppSettings } from "./posting-engine-enhancements.js";
import { readV1, v1Stats, withForcedTemplate, writeV1 } from "./v1-engine.js";

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
  return new Date(now + Number(pro.schedule?.utcOffsetMinutes || 0) * 60_000);
}
function dateKey(date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`; }
function timeKey(date) { return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`; }
function sessionPath(uid) { return path.join(DATA_DIR, "users", String(uid), "personal-session.enc"); }

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

function decryptSession(uid) {
  const payload = JSON.parse(fs.readFileSync(sessionPath(uid), "utf8"));
  const key = fs.readFileSync(SESSION_KEY_FILE);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
}

async function openPersonalClient(uid) {
  const client = new TelegramClient(new StringSession(decryptSession(uid)), API_ID, API_HASH, { connectionRetries: 5, floodSleepThreshold: 60 });
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
  throw new Error(`Could not resolve ${destination?.label || destination?.id || "destination"}.`);
}

async function sendCycle(uid, settings, bot, templateId = "") {
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  if (!groups.length || !settings.adMessage) return;
  await withForcedTemplate(uid, templateId, async () => {
    if (!hasPersonalSessionFile(uid)) {
      for (const destination of groups) {
        try { await bot.api.sendMessage(destination.id, settings.adMessage, settings.adEntities?.length ? { entities: settings.adEntities } : {}); }
        catch (err) { console.warn(`TelePilot exact bot send failed ${uid}/${destination.id}:`, err?.description || err?.message || err); }
      }
      return;
    }
    let client;
    try {
      client = await openPersonalClient(uid);
      const formattingEntities = toMtEntities(settings.adEntities || []);
      for (const destination of groups) {
        try {
          const entity = await personalTarget(client, destination);
          await client.sendMessage(entity, { message: settings.adMessage, ...(formattingEntities.length ? { formattingEntities } : {}) });
        } catch (err) {
          console.warn(`TelePilot exact personal send failed ${uid}/${destination.id}:`, err?.errorMessage || err?.message || err);
        }
      }
    } finally { try { await client?.disconnect(); } catch {} }
  });
}

function dueRules(pro, now) {
  const local = localDate(pro, now);
  const key = `${dateKey(local)}|${timeKey(local)}`;
  const day = local.getUTCDay();
  return (pro.exactTimes || []).filter(rule => {
    if (rule?.enabled === false || String(rule?.time || "") !== timeKey(local)) return false;
    const days = Array.isArray(rule.days) ? rule.days.map(Number) : [0,1,2,3,4,5,6];
    return days.includes(day) && String(rule.lastRunKey || "") !== key;
  }).map(rule => ({ id: String(rule.id), templateId: String(rule.templateId || ""), key }));
}

async function processExact(uid, settings, bot, now) {
  const rules = dueRules(readV1(uid), now);
  for (const rule of rules) {
    try { await sendCycle(uid, settings, bot, rule.templateId); }
    finally {
      const latest = readV1(uid);
      const stored = latest.exactTimes.find(item => String(item.id) === rule.id);
      if (stored) stored.lastRunKey = rule.key;
      writeV1(uid, latest);
    }
  }
}

async function processOneTime(uid, settings, bot, now) {
  const due = (readV1(uid).oneTimeJobs || [])
    .filter(job => (!job.status || job.status === "pending") && Number(job.runAt || 0) > 0 && Number(job.runAt) <= now)
    .map(job => ({ id: String(job.id), templateId: String(job.templateId || "") }));
  for (const job of due) {
    let status = "done";
    let error = "";
    try { await sendCycle(uid, settings, bot, job.templateId); }
    catch (err) { status = "failed"; error = String(err?.message || err).slice(0, 180); }
    const latest = readV1(uid);
    const stored = latest.oneTimeJobs.find(item => String(item.id) === job.id);
    if (stored) { stored.status = status; stored.error = error; stored.completedAt = Date.now(); }
    writeV1(uid, latest);
  }
}

async function flushAlerts(uid, bot) {
  const current = readV1(uid);
  const alerts = (current.pendingAlerts || []).slice(0, 3);
  const sentIds = [];
  for (const alert of alerts) {
    try { await bot.api.sendMessage(uid, alert.text); sentIds.push(String(alert.id)); }
    catch { break; }
  }
  if (!sentIds.length) return;
  const latest = readV1(uid);
  latest.pendingAlerts = (latest.pendingAlerts || []).filter(alert => !sentIds.includes(String(alert.id)));
  writeV1(uid, latest);
}

async function accessReminder(uid, settings, bot, now) {
  if (isAdmin(uid) || settings.accessLifetime || settings.accessRevoked || !settings.accessUntil) return;
  const remaining = Number(settings.accessUntil) - now;
  if (remaining <= 0 || remaining > 3 * 86_400_000) return;
  const pro = readV1(uid);
  const days = Math.max(1, Math.ceil(remaining / 86_400_000));
  const key = `${dateKey(localDate(pro, now))}|${days}`;
  if (pro.reminders?.lastAccessKey === key) return;
  try { await bot.api.sendMessage(uid, `💎 TelePilot Access\n\nYour access expires in ${days} day${days === 1 ? "" : "s"}.\n\nYour saved setup remains on TelePilot if you renew later.`); }
  catch { return; }
  const latest = readV1(uid);
  latest.reminders.lastAccessKey = key;
  writeV1(uid, latest);
}

function currentWeekKey(local) {
  const copy = new Date(local.getTime());
  copy.setUTCDate(copy.getUTCDate() - copy.getUTCDay());
  return dateKey(copy);
}

async function weeklyRecap(uid, bot, now) {
  const pro = readV1(uid);
  if (!pro.weeklyRecap?.enabled) return;
  const local = localDate(pro, now);
  if (local.getUTCDay() !== Number(pro.weeklyRecap.day || 0) || local.getUTCHours() !== Number(pro.weeklyRecap.hour || 18)) return;
  const key = currentWeekKey(local);
  if (pro.weeklyRecap.lastKey === key) return;
  const stats = v1Stats(uid, now).week;
  if (stats.sent || stats.failed || stats.skipped) {
    try {
      await bot.api.sendMessage(uid, ["📊 Weekly TelePilot recap", "", `Sent — ${stats.sent}`, `Failed — ${stats.failed}`, `Skipped — ${stats.skipped}`, "", "Open Activity → Posting history for details."].join("\n"));
    } catch { return; }
  }
  const latest = readV1(uid);
  latest.weeklyRecap.lastKey = key;
  writeV1(uid, latest);
}

async function sessionHealth(uid, bot, now) {
  if (!hasPersonalSessionFile(uid)) return;
  const current = readV1(uid);
  if (Number(current.sessionHealth?.lastCheckedAt || 0) > now - SESSION_CHECK_MS) return;
  const wasHealthy = current.sessionHealth?.status === "connected";
  let client;
  let status = "connected";
  let error = "";
  try { client = await openPersonalClient(uid); }
  catch (err) { status = "needs-reconnect"; error = String(err?.message || err).slice(0, 180); }
  finally { try { await client?.disconnect(); } catch {} }

  const latest = readV1(uid);
  latest.sessionHealth.status = status;
  latest.sessionHealth.lastError = error;
  latest.sessionHealth.lastCheckedAt = now;
  if (!latest.sessionHealth.firstSeenAt) latest.sessionHealth.firstSeenAt = now;
  writeV1(uid, latest);

  if (status !== "connected" && wasHealthy && latest.notificationMode !== "silent") {
    try { await bot.api.sendMessage(uid, "⚠️ TelePilot Sender\n\nYour connected Telegram session needs attention. Open Sender and reconnect it.\n\nMessages, destinations and schedules remain saved."); } catch {}
  }
}

async function tick(bot) {
  if (ticking) return;
  ticking = true;
  const now = Date.now();
  try {
    for (const uid of listUserIds()) {
      const settings = readAppSettings(uid);
      try { await flushAlerts(uid, bot); } catch {}
      try { await sessionHealth(uid, bot, now); } catch {}
      try { await accessReminder(uid, settings, bot, now); } catch {}
      const pro = readV1(uid);
      if (!hasAccess(uid, settings) || pro.paused) continue;
      try { await processExact(uid, settings, bot, now); } catch (err) { console.warn(`Exact scheduler error ${uid}:`, err?.message || err); }
      try { await processOneTime(uid, settings, bot, now); } catch (err) { console.warn(`One-time scheduler error ${uid}:`, err?.message || err); }
      try { await weeklyRecap(uid, bot, now); } catch {}
    }
  } finally { ticking = false; }
}

export function startV1Worker() {
  if (!BOT_TOKEN || !API_ID || !API_HASH) {
    console.warn("TelePilot v1 worker disabled: missing Telegram credentials");
    return null;
  }
  const bot = new Bot(BOT_TOKEN);
  const run = () => void tick(bot).catch(err => console.error("TelePilot v1 worker failed:", err?.message || err));
  const initial = setTimeout(run, 15_000);
  const timer = setInterval(run, TICK_MS);
  initial.unref?.(); timer.unref?.();
  console.log("TelePilot v1 exact-time worker enabled");
  return timer;
}
