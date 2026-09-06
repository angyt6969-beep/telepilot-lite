import fs from "node:fs";
import path from "node:path";
import { hasAnyAccount } from "./account-store.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const HISTORY_LIMIT = 500;

function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function settingsPath(uid) { return path.join(userDir(uid), "settings.json"); }
function proPath(uid) { return path.join(userDir(uid), "pro-settings.json"); }

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

export function defaultProSettings() {
  return {
    version: 2,
    paused: false,
    skipNext: false,
    placeholders: true,
    staggerSeconds: 0,
    disabledDestinationIds: [],
    schedule: { enabled: false, days: [0,1,2,3,4,5,6], start: "00:00", end: "23:59", utcOffsetMinutes: 0 },
    media: null,
    templates: [],
    history: [],
  };
}
export function readProSettings(uid) {
  const base = defaultProSettings();
  const saved = readJson(proPath(uid), {});
  return {
    ...base,
    ...saved,
    disabledDestinationIds: Array.isArray(saved.disabledDestinationIds) ? [...new Set(saved.disabledDestinationIds.map(String))] : [],
    templates: Array.isArray(saved.templates) ? saved.templates : [],
    history: Array.isArray(saved.history) ? saved.history.slice(-HISTORY_LIMIT) : [],
    schedule: { ...base.schedule, ...(saved.schedule || {}) },
  };
}
export function writeProSettings(uid, value) {
  const normalized = { ...defaultProSettings(), ...(value || {}), version: 2 };
  normalized.schedule = { ...defaultProSettings().schedule, ...(value?.schedule || {}) };
  normalized.disabledDestinationIds = [...new Set((Array.isArray(normalized.disabledDestinationIds) ? normalized.disabledDestinationIds : []).map(String))];
  normalized.history = Array.isArray(normalized.history) ? normalized.history.slice(-HISTORY_LIMIT) : [];
  writeJsonAtomic(proPath(uid), normalized);
  return normalized;
}
export function readAppSettings(uid) { return readJson(settingsPath(uid), {}); }
export function writeAppSettings(uid, value) { writeJsonAtomic(settingsPath(uid), value || {}); return value; }
export function listUserIds() {
  try {
    return fs.readdirSync(USERS_DIR, { withFileTypes: true })
      .filter(item => item.isDirectory() && /^\d+$/.test(item.name))
      .map(item => item.name);
  } catch { return []; }
}
export function hasPersonalSessionFile(uid) { return hasAnyAccount(uid); }

function destinationLabel(destination) { return String(destination?.username || destination?.label || destination?.id || "Destination"); }
function parseClock(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]), m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}
export function scheduleAllowsNow(pro, now = new Date()) {
  if (!pro?.schedule?.enabled) return true;
  const offset = Number(pro.schedule.utcOffsetMinutes || 0);
  const local = new Date(now.getTime() + offset * 60_000);
  const days = Array.isArray(pro.schedule.days) ? pro.schedule.days.map(Number) : [];
  if (!days.includes(local.getUTCDay())) return false;
  const start = parseClock(pro.schedule.start), end = parseClock(pro.schedule.end);
  if (start === null || end === null || start === end) return true;
  const current = local.getUTCHours() * 60 + local.getUTCMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}
function localDateParts(pro, now = new Date()) {
  const local = new Date(now.getTime() + Number(pro?.schedule?.utcOffsetMinutes || 0) * 60_000);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth()+1).padStart(2,"0"), dd = String(local.getUTCDate()).padStart(2,"0");
  const hh = String(local.getUTCHours()).padStart(2,"0"), min = String(local.getUTCMinutes()).padStart(2,"0");
  return { date:`${yyyy}-${mm}-${dd}`, time:`${hh}:${min}`, datetime:`${yyyy}-${mm}-${dd} ${hh}:${min}` };
}
function cloneEntity(entity) {
  if (!entity || typeof entity !== "object") return entity;
  const proto = Object.getPrototypeOf(entity);
  return !proto || proto === Object.prototype ? { ...entity } : Object.assign(Object.create(proto), entity);
}
function adjustEntities(entities, start, oldLength, newLength) {
  const delta = newLength - oldLength, oldEnd = start + oldLength;
  for (const entity of entities) {
    const eStart = Number(entity.offset || 0), eEnd = eStart + Number(entity.length || 0);
    if (eStart >= oldEnd) entity.offset = eStart + delta;
    else if (eEnd > start && eStart < oldEnd) entity.length = Math.max(0, Number(entity.length || 0) + delta);
  }
}
export function renderDynamicMessage(text, entities, context) {
  let value = String(text || "");
  const out = Array.isArray(entities) ? entities.map(cloneEntity) : [];
  if (!context?.pro?.placeholders) return { text: value === "\u2063" ? "" : value, entities: out };
  const parts = localDateParts(context.pro);
  const replacements = new Map([
    ["{date}", parts.date], ["{time}", parts.time], ["{datetime}", parts.datetime],
    ["{destination}", destinationLabel(context.destination)], ["{sender}", String(context.sender || "TelePilot")],
  ]);
  for (const [token, replacement] of replacements) {
    let from = 0;
    while (from < value.length) {
      const index = value.indexOf(token, from);
      if (index < 0) break;
      value = value.slice(0,index) + replacement + value.slice(index + token.length);
      adjustEntities(out, index, token.length, replacement.length);
      from = index + replacement.length;
    }
  }
  return { text: value === "\u2063" ? "" : value, entities: out.filter(entity => Number(entity?.length || 0) > 0) };
}

export function errorText(err) {
  return String(err?.description || err?.errorMessage || err?.message || err || "Unknown error").slice(0, 220);
}
export function floodWaitSeconds(err) {
  const direct = Number(err?.seconds || err?.retryAfter || err?.parameters?.retry_after || 0);
  if (Number.isFinite(direct) && direct > 0) return Math.ceil(direct);
  const match = errorText(err).toUpperCase().match(/FLOOD_WAIT_?(\d+)/);
  return match ? Number(match[1]) : 0;
}
export function retryDelayMs(err, attempt = 0) {
  const flood = floodWaitSeconds(err);
  if (flood > 0) return (flood + 1) * 1000;
  return Math.min(30_000, 1200 * (2 ** Math.max(0, Number(attempt) || 0)) + Math.floor(Math.random() * 300));
}
export function isRetryable(err) {
  const code = Number(err?.error_code || 0);
  const text = errorText(err).toUpperCase();
  if (code === 429 || code >= 500) return true;
  return ["TIMEOUT","TIMED OUT","ECONNRESET","ECONNREFUSED","EAI_AGAIN","ETIMEDOUT","RPC_CALL_FAIL","INTERNAL","SERVER_ERROR","FLOOD_WAIT","PERSISTENTTIMESTAMPOUTDATED"].some(token => text.includes(token));
}
export async function withRetry(fn, maxRetries = 3) {
  let last;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(attempt); }
    catch (err) {
      last = err;
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs(err, attempt)));
    }
  }
  throw last;
}
export function isPermanentDestinationError(err) {
  const text = errorText(err).toUpperCase();
  return [
    "CHAT_WRITE_FORBIDDEN","CHAT_ADMIN_REQUIRED","USER_BANNED_IN_CHANNEL","CHANNEL_PRIVATE",
    "BOT_WAS_KICKED","USER_NOT_PARTICIPANT","CHAT_SEND_PLAIN_FORBIDDEN","CHAT_SEND_MEDIA_FORBIDDEN",
    "CHAT_SEND_PHOTOS_FORBIDDEN","CHAT_SEND_VIDEOS_FORBIDDEN",
  ].some(token => text.includes(token));
}
export function isFatalSessionError(err) {
  const text = errorText(err).toUpperCase();
  return ["AUTH_KEY_UNREGISTERED","SESSION_REVOKED","SESSION_EXPIRED","AUTH_KEY_DUPLICATED","USER_DEACTIVATED","SESSION IS NO LONGER AUTHORIZED","NO LONGER AUTHORIZED"].some(token => text.includes(token));
}

export function installPostingEngineEnhancements(ApiClass, TelegramClientClass) {
  // TelePilot 1.1: scheduled-send ownership is now supplied explicitly through
  // AsyncLocalStorage by v1-engine. Never infer a customer from message text/chat ID.
  if (ApiClass?.prototype && !ApiClass.prototype.__telepilotPostingEngineInstalled) {
    Object.defineProperty(ApiClass.prototype, "__telepilotPostingEngineInstalled", { value: true });
  }
  if (TelegramClientClass?.prototype && !TelegramClientClass.prototype.__telepilotPostingEngineInstalled) {
    const originalSendMessage = TelegramClientClass.prototype.sendMessage;
    Object.defineProperty(TelegramClientClass.prototype, "__telepilotPostingEngineInstalled", { value: true });
    if (!TelegramClientClass.prototype.__telepilotOriginalSendMessage) {
      Object.defineProperty(TelegramClientClass.prototype, "__telepilotOriginalSendMessage", { value: originalSendMessage });
    }
  }
}
