import fs from "node:fs";
import bigInt from "big-integer";
import { Api as MtApi } from "teleproto";
import {
  hasPersonalSessionFile,
  listUserIds,
  readAppSettings,
  readProSettings,
  renderDynamicMessage,
  scheduleAllowsNow,
  writeProSettings,
} from "./posting-engine-enhancements.js";

const CYCLE_STALE_MS = 10 * 60_000;
const HISTORY_LIMIT = 200;
const cycleRuntime = new Map();
const clientOwners = new WeakMap();
const forcedTemplateByUid = new Map();
let rawApiSendMessage = null;
let rawPersonalSendMessage = null;

function nowIsoDate(pro, now = new Date()) {
  const offset = Number(pro?.schedule?.utcOffsetMinutes || 0);
  const local = new Date(now.getTime() + offset * 60_000);
  return local.toISOString().slice(0, 10);
}

function destinationId(destination) {
  return String(destination?.id || destination?.username || destination?.label || "");
}

function destinationLabel(destination) {
  return String(destination?.username || destination?.label || destination?.id || "Destination");
}

function cloneEntity(entity) {
  if (!entity || typeof entity !== "object") return entity;
  const proto = Object.getPrototypeOf(entity);
  if (!proto || proto === Object.prototype) return { ...entity };
  return Object.assign(Object.create(proto), entity);
}

function adjustEntities(entities, start, oldLength, newLength) {
  const delta = newLength - oldLength;
  const oldEnd = start + oldLength;
  for (const entity of entities) {
    const entityStart = Number(entity.offset || 0);
    const entityEnd = entityStart + Number(entity.length || 0);
    if (entityStart >= oldEnd) entity.offset = entityStart + delta;
    else if (entityEnd > start && entityStart < oldEnd) {
      entity.length = Math.max(0, Number(entity.length || 0) + delta);
    }
  }
}

function replaceToken(text, entities, token, replacement) {
  let value = text;
  let from = 0;
  while (from < value.length) {
    const index = value.indexOf(token, from);
    if (index < 0) break;
    value = value.slice(0, index) + replacement + value.slice(index + token.length);
    adjustEntities(entities, index, token.length, replacement.length);
    from = index + replacement.length;
  }
  return value;
}

export function ensureV1(pro) {
  const value = pro && typeof pro === "object" ? pro : {};
  if (!value.rotation || typeof value.rotation !== "object") value.rotation = {};
  value.rotation.mode = ["off", "cycle", "random"].includes(value.rotation.mode) ? value.rotation.mode : "off";
  value.rotation.index = Math.max(0, Number(value.rotation.index || 0));

  if (!value.destinationOverrides || typeof value.destinationOverrides !== "object" || Array.isArray(value.destinationOverrides)) value.destinationOverrides = {};
  if (!value.destinationFolders || typeof value.destinationFolders !== "object" || Array.isArray(value.destinationFolders)) value.destinationFolders = {};
  if (!Array.isArray(value.disabledFolders)) value.disabledFolders = [];
  if (!value.customVariables || typeof value.customVariables !== "object" || Array.isArray(value.customVariables)) value.customVariables = {};

  if (!value.dateRange || typeof value.dateRange !== "object") value.dateRange = {};
  value.dateRange.enabled = value.dateRange.enabled === true;
  value.dateRange.start = typeof value.dateRange.start === "string" ? value.dateRange.start : "";
  value.dateRange.end = typeof value.dateRange.end === "string" ? value.dateRange.end : "";

  value.activeMessageExpiresAt = Number(value.activeMessageExpiresAt || 0) || 0;
  if (!value.postLimit || typeof value.postLimit !== "object") value.postLimit = {};
  value.postLimit.enabled = value.postLimit.enabled === true;
  value.postLimit.max = Math.max(0, Number(value.postLimit.max || 0));
  value.postLimit.sent = Math.max(0, Number(value.postLimit.sent || 0));

  value.notificationMode = ["all", "important", "silent"].includes(value.notificationMode) ? value.notificationMode : "important";
  value.autoDisableFailures = Math.min(10, Math.max(2, Number(value.autoDisableFailures || 3)));
  if (!value.destinationFailures || typeof value.destinationFailures !== "object" || Array.isArray(value.destinationFailures)) value.destinationFailures = {};
  if (!Array.isArray(value.pendingAlerts)) value.pendingAlerts = [];

  if (!Array.isArray(value.exactTimes)) value.exactTimes = [];
  if (!Array.isArray(value.oneTimeJobs)) value.oneTimeJobs = [];
  if (!value.weeklyRecap || typeof value.weeklyRecap !== "object") value.weeklyRecap = {};
  value.weeklyRecap.enabled = value.weeklyRecap.enabled === true;
  value.weeklyRecap.day = Number.isInteger(Number(value.weeklyRecap.day)) ? Number(value.weeklyRecap.day) : 0;
  value.weeklyRecap.hour = Number.isInteger(Number(value.weeklyRecap.hour)) ? Number(value.weeklyRecap.hour) : 18;
  value.weeklyRecap.lastKey = typeof value.weeklyRecap.lastKey === "string" ? value.weeklyRecap.lastKey : "";

  if (!value.sessionHealth || typeof value.sessionHealth !== "object") value.sessionHealth = {};
  value.sessionHealth.status = typeof value.sessionHealth.status === "string" ? value.sessionHealth.status : "unknown";
  value.sessionHealth.lastCheckedAt = Number(value.sessionHealth.lastCheckedAt || 0) || 0;
  value.sessionHealth.firstSeenAt = Number(value.sessionHealth.firstSeenAt || 0) || 0;
  value.sessionHealth.lastError = typeof value.sessionHealth.lastError === "string" ? value.sessionHealth.lastError : "";

  if (!value.reminders || typeof value.reminders !== "object") value.reminders = {};
  if (!value.draftBackup || typeof value.draftBackup !== "object") value.draftBackup = null;
  value.changelogSeen = typeof value.changelogSeen === "string" ? value.changelogSeen : "";

  value.templates = Array.isArray(value.templates) ? value.templates.map(template => ({
    ...template,
    pinned: template?.pinned === true,
    expiresAt: Number(template?.expiresAt || 0) || 0,
  })) : [];

  return value;
}

export function readV1(uid) {
  return ensureV1(readProSettings(uid));
}

export function writeV1(uid, pro) {
  return ensureV1(writeProSettings(uid, ensureV1(pro)));
}

function eligibleTemplates(pro, now = Date.now()) {
  return (pro.templates || []).filter(template => template?.message && (!Number(template.expiresAt || 0) || Number(template.expiresAt) > now));
}

function findTemplate(pro, id) {
  if (!id) return null;
  const template = (pro.templates || []).find(item => String(item.id) === String(id));
  if (!template?.message) return null;
  if (Number(template.expiresAt || 0) && Number(template.expiresAt) <= Date.now()) return null;
  return template;
}

function chooseCycleTemplate(uid, pro, cycle) {
  if (cycle.rotationResolved) return cycle.rotationTemplateId || "";
  cycle.rotationResolved = true;
  const forced = forcedTemplateByUid.get(String(uid));
  if (forced) {
    cycle.rotationTemplateId = String(forced);
    return cycle.rotationTemplateId;
  }

  const templates = eligibleTemplates(pro);
  if (!templates.length || pro.rotation.mode === "off") return "";
  if (pro.rotation.mode === "random") {
    cycle.rotationTemplateId = String(templates[Math.floor(Math.random() * templates.length)].id);
    return cycle.rotationTemplateId;
  }

  const index = Number(pro.rotation.index || 0) % templates.length;
  cycle.rotationTemplateId = String(templates[index].id);
  pro.rotation.index = (index + 1) % templates.length;
  writeV1(uid, pro);
  return cycle.rotationTemplateId;
}

function selectContent(uid, settings, pro, destination, cycle, originalText, originalEntities) {
  const overrideId = pro.destinationOverrides?.[destinationId(destination)];
  const override = findTemplate(pro, overrideId);
  if (override) return { text: String(override.message), entities: Array.isArray(override.entities) ? override.entities : [], templateId: String(override.id) };

  const rotationId = chooseCycleTemplate(uid, pro, cycle);
  const rotated = findTemplate(pro, rotationId);
  if (rotated) return { text: String(rotated.message), entities: Array.isArray(rotated.entities) ? rotated.entities : [], templateId: String(rotated.id) };

  return { text: String(originalText || settings.adMessage || ""), entities: Array.isArray(originalEntities) ? originalEntities : [], templateId: "" };
}

function renderV1(content, pro, destination, sender) {
  const rendered = renderDynamicMessage(content.text, content.entities, { pro, destination, sender });
  let text = String(rendered.text || "");
  const entities = Array.isArray(rendered.entities) ? rendered.entities.map(cloneEntity) : [];
  for (const [rawName, rawValue] of Object.entries(pro.customVariables || {})) {
    const name = String(rawName || "").trim().replace(/[^A-Za-z0-9_]/g, "").slice(0, 32);
    if (!name) continue;
    text = replaceToken(text, entities, `{${name}}`, String(rawValue ?? "").slice(0, 500));
  }
  return { text, entities: entities.filter(entity => Number(entity?.length || 0) > 0) };
}

function beginCycle(uid, settings, pro, destination) {
  const key = String(uid);
  const id = destinationId(destination);
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  let cycle = cycleRuntime.get(key);
  const stale = cycle && Date.now() - cycle.startedAt > CYCLE_STALE_MS;
  if (!cycle || stale || cycle.seen.has(id) || cycle.seen.size >= Math.max(1, groups.length)) {
    cycle = {
      startedAt: Date.now(),
      seen: new Set(),
      index: 0,
      skip: pro.skipNext === true,
      rotationResolved: false,
      rotationTemplateId: "",
    };
    if (pro.skipNext) {
      pro.skipNext = false;
      writeV1(uid, pro);
    }
    cycleRuntime.set(key, cycle);
  }
  cycle.seen.add(id);
  cycle.index += 1;
  return cycle;
}

function dateRangeAllows(pro) {
  if (!pro.dateRange?.enabled) return true;
  const date = nowIsoDate(pro);
  if (pro.dateRange.start && date < pro.dateRange.start) return false;
  if (pro.dateRange.end && date > pro.dateRange.end) return false;
  return true;
}

function folderIsDisabled(pro, destination) {
  const folder = String(pro.destinationFolders?.[destinationId(destination)] || "");
  return !!folder && (pro.disabledFolders || []).map(String).includes(folder);
}

function skipReason(pro, cycle, destination) {
  if (pro.paused) return "paused";
  if (cycle.skip) return "skip-next";
  if ((pro.disabledDestinationIds || []).map(String).includes(destinationId(destination))) return "disabled";
  if (folderIsDisabled(pro, destination)) return "folder-disabled";
  if (!scheduleAllowsNow(pro)) return "outside-schedule";
  if (!dateRangeAllows(pro)) return "outside-date-range";
  if (Number(pro.activeMessageExpiresAt || 0) && Date.now() >= Number(pro.activeMessageExpiresAt)) return "message-expired";
  if (pro.postLimit?.enabled && Number(pro.postLimit.max || 0) > 0 && Number(pro.postLimit.sent || 0) >= Number(pro.postLimit.max)) return "post-limit";
  return "";
}

function errorText(err) {
  return String(err?.description || err?.errorMessage || err?.message || err || "Unknown error").slice(0, 220);
}

function isRetryable(err) {
  const code = Number(err?.error_code || 0);
  const text = errorText(err).toUpperCase();
  return code === 429 || code >= 500 || ["TIMEOUT", "TIMED OUT", "ECONNRESET", "EAI_AGAIN", "RPC_CALL_FAIL", "INTERNAL", "SERVER_ERROR", "FLOOD_WAIT"].some(token => text.includes(token));
}

function retryDelay(err) {
  const retryAfter = Number(err?.parameters?.retry_after || 0);
  if (retryAfter > 0 && retryAfter <= 60) return retryAfter * 1000;
  const match = errorText(err).toUpperCase().match(/FLOOD_WAIT_?(\d+)/);
  if (match && Number(match[1]) <= 60) return Number(match[1]) * 1000;
  return 1200;
}

async function withRetry(fn) {
  try { return await fn(); }
  catch (err) {
    if (!isRetryable(err)) throw err;
    await new Promise(resolve => setTimeout(resolve, retryDelay(err)));
    return fn();
  }
}

function permanentFailure(err) {
  const text = errorText(err).toUpperCase();
  return [
    "CHAT_WRITE_FORBIDDEN", "CHAT_ADMIN_REQUIRED", "USER_BANNED_IN_CHANNEL",
    "CHANNEL_PRIVATE", "BOT_WAS_KICKED", "FORBIDDEN", "NOT PARTICIPANT",
    "USER_NOT_PARTICIPANT", "CHAT_SEND_PLAIN_FORBIDDEN",
  ].some(token => text.includes(token));
}

function queueAlert(pro, level, text) {
  if (pro.notificationMode === "silent") return;
  if (pro.notificationMode === "important" && level !== "important") return;
  pro.pendingAlerts.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, ts: Date.now(), level, text: String(text).slice(0, 700) });
  pro.pendingAlerts = pro.pendingAlerts.slice(-20);
}

function appendHistory(pro, item) {
  pro.history = Array.isArray(pro.history) ? pro.history : [];
  pro.history.push({ ts: Date.now(), ...item });
  pro.history = pro.history.slice(-HISTORY_LIMIT);
}

function recordSkipped(uid, destination, sender, reason) {
  const pro = readV1(uid);
  appendHistory(pro, { destination: destinationLabel(destination), destinationId: destinationId(destination), status: "skipped", reason, sender });
  writeV1(uid, pro);
}

function recordSuccess(uid, destination, sender, templateId = "") {
  const pro = readV1(uid);
  appendHistory(pro, { destination: destinationLabel(destination), destinationId: destinationId(destination), status: "sent", sender, templateId });
  if (pro.postLimit?.enabled) pro.postLimit.sent = Number(pro.postLimit.sent || 0) + 1;
  delete pro.destinationFailures[destinationId(destination)];
  writeV1(uid, pro);
}

function recordFailure(uid, destination, sender, err) {
  const pro = readV1(uid);
  const id = destinationId(destination);
  const old = pro.destinationFailures[id] || { count: 0 };
  const next = {
    count: Number(old.count || 0) + 1,
    lastAt: Date.now(),
    lastError: errorText(err),
    autoDisabledAt: Number(old.autoDisabledAt || 0) || 0,
  };
  pro.destinationFailures[id] = next;
  appendHistory(pro, { destination: destinationLabel(destination), destinationId: id, status: "failed", error: next.lastError, sender });

  if (permanentFailure(err) && next.count >= Number(pro.autoDisableFailures || 3) && !next.autoDisabledAt) {
    next.autoDisabledAt = Date.now();
    if (!(pro.disabledDestinationIds || []).map(String).includes(id)) pro.disabledDestinationIds.push(id);
    queueAlert(pro, "important", `⚠️ ${destinationLabel(destination)} was automatically disabled after ${next.count} posting failures.\n\nLast error — ${next.lastError}`);
  } else {
    queueAlert(pro, "all", `⚠️ Post failed in ${destinationLabel(destination)}\n${next.lastError}`);
  }
  writeV1(uid, pro);
}

function fakeResult(rendered) {
  return { id: 0, message_id: 0, message: rendered?.text || "", text: rendered?.text || "" };
}

function findBotScheduledUser(chatId, text) {
  const chat = String(chatId);
  for (const uid of listUserIds()) {
    if (hasPersonalSessionFile(uid)) continue;
    const settings = readAppSettings(uid);
    if (String(settings.adMessage || "") !== String(text || "")) continue;
    if ((settings.groups || []).some(group => String(group.id) === chat)) return { uid, settings };
  }
  return null;
}

function normalizeCandidates(entity) {
  const values = [entity, entity?.id, entity?.username, entity?.entity?.id, entity?.entity?.username, entity?.inputEntity?.chatId, entity?.inputEntity?.channelId];
  return values.filter(value => value !== undefined && value !== null).map(value => String(value).toLowerCase());
}

function matchDestination(settings, entity) {
  const candidates = normalizeCandidates(entity);
  for (const group of settings.groups || []) {
    const id = String(group.id || "").toLowerCase();
    const username = String(group.username || "").toLowerCase();
    const raw = id.replace(/^-100/, "").replace(/^-/, "");
    if (candidates.includes(id) || (username && (candidates.includes(username) || candidates.includes(username.replace(/^@/, ""))))) return group;
    if (raw && candidates.some(value => value.replace(/\D/g, "") === raw)) return group;
  }
  return null;
}

function findUidByUsername(username) {
  const wanted = String(username || "").replace(/^@/, "").toLowerCase();
  if (!wanted) return "";
  for (const uid of listUserIds()) {
    const settings = readAppSettings(uid);
    if (String(settings.personalUsername || "").replace(/^@/, "").toLowerCase() === wanted) return uid;
  }
  return "";
}

function toMtEntities(entities = []) {
  const out = [];
  for (const entity of entities) {
    if (!entity || typeof entity !== "object") continue;
    if (entity.className || entity.CONSTRUCTOR_ID) {
      out.push(entity);
      continue;
    }
    const base = { offset: Number(entity.offset || 0), length: Number(entity.length || 0) };
    try {
      if (entity.type === "bold") out.push(new MtApi.MessageEntityBold(base));
      else if (entity.type === "italic") out.push(new MtApi.MessageEntityItalic(base));
      else if (entity.type === "underline") out.push(new MtApi.MessageEntityUnderline(base));
      else if (entity.type === "strikethrough") out.push(new MtApi.MessageEntityStrike(base));
      else if (entity.type === "spoiler") out.push(new MtApi.MessageEntitySpoiler(base));
      else if (entity.type === "code") out.push(new MtApi.MessageEntityCode(base));
      else if (entity.type === "pre") out.push(new MtApi.MessageEntityPre({ ...base, language: entity.language || "" }));
      else if (entity.type === "text_link") out.push(new MtApi.MessageEntityTextUrl({ ...base, url: entity.url || "" }));
      else if (entity.type === "custom_emoji" && /^\d+$/.test(String(entity.custom_emoji_id || ""))) out.push(new MtApi.MessageEntityCustomEmoji({ ...base, documentId: bigInt(entity.custom_emoji_id) }));
    } catch {}
  }
  return out;
}

async function sendBotMedia(api, chatId, media, rendered) {
  const options = {
    ...(rendered.text ? { caption: rendered.text } : {}),
    ...(rendered.entities.length ? { caption_entities: rendered.entities } : {}),
  };
  if (rendered.text.length > 1024) {
    if (media.kind === "photo") await api.sendPhoto(chatId, media.fileId, {});
    else if (media.kind === "video") await api.sendVideo(chatId, media.fileId, {});
    else if (media.kind === "animation") await api.sendAnimation(chatId, media.fileId, {});
    else await api.sendDocument(chatId, media.fileId, {});
    return rawApiSendMessage.call(api, chatId, rendered.text || "\u2063", rendered.entities.length ? { entities: rendered.entities } : {});
  }
  if (media.kind === "photo") return api.sendPhoto(chatId, media.fileId, options);
  if (media.kind === "video") return api.sendVideo(chatId, media.fileId, { ...options, supports_streaming: true });
  if (media.kind === "animation") return api.sendAnimation(chatId, media.fileId, options);
  return api.sendDocument(chatId, media.fileId, options);
}

async function sendPersonalMedia(client, entity, media, rendered) {
  if (!media.localPath || !fs.existsSync(media.localPath)) return rawPersonalSendMessage.call(client, entity, { message: rendered.text || "\u2063", formattingEntities: toMtEntities(rendered.entities) });
  return client.sendFile(entity, {
    file: media.localPath,
    caption: rendered.text,
    ...(rendered.entities.length ? { formattingEntities: toMtEntities(rendered.entities) } : {}),
    forceDocument: media.kind === "document",
    supportsStreaming: media.kind === "video",
  });
}

export function prepareV1Engine(ApiClass, TelegramClientClass) {
  if (!rawApiSendMessage) rawApiSendMessage = ApiClass?.prototype?.sendMessage || null;
  if (!rawPersonalSendMessage) rawPersonalSendMessage = TelegramClientClass?.prototype?.sendMessage || null;
}

export function withForcedTemplate(uid, templateId, fn) {
  const key = String(uid);
  if (templateId) forcedTemplateByUid.set(key, String(templateId));
  return Promise.resolve().then(fn).finally(() => forcedTemplateByUid.delete(key));
}

export function installV1Engine(ApiClass, TelegramClientClass) {
  if (!rawApiSendMessage || !rawPersonalSendMessage) prepareV1Engine(ApiClass, TelegramClientClass);

  if (ApiClass?.prototype && !ApiClass.prototype.__telepilotV1EngineInstalled) {
    const currentSendMessage = ApiClass.prototype.sendMessage;
    Object.defineProperty(ApiClass.prototype, "__telepilotV1EngineInstalled", { value: true });
    ApiClass.prototype.sendMessage = async function(chatId, text, other, ...rest) {
      const found = findBotScheduledUser(chatId, text);
      if (!found) return currentSendMessage.call(this, chatId, text, other, ...rest);
      const { uid, settings } = found;
      const destination = (settings.groups || []).find(group => String(group.id) === String(chatId));
      if (!destination) return currentSendMessage.call(this, chatId, text, other, ...rest);
      const pro = readV1(uid);
      const cycle = beginCycle(uid, settings, pro, destination);
      const sender = "TelePilot Bot";
      const content = selectContent(uid, settings, pro, destination, cycle, text, other?.entities || []);
      const rendered = renderV1(content, pro, destination, sender);
      const reason = skipReason(pro, cycle, destination);
      if (reason) {
        recordSkipped(uid, destination, sender, reason);
        return fakeResult(rendered);
      }
      if (cycle.index > 1 && Number(pro.staggerSeconds || 0) > 0) await new Promise(resolve => setTimeout(resolve, Number(pro.staggerSeconds) * 1000));
      try {
        const result = await withRetry(() => pro.media?.fileId
          ? sendBotMedia(this, chatId, pro.media, rendered)
          : rawApiSendMessage.call(this, chatId, rendered.text || "\u2063", { ...(other || {}), ...(rendered.entities.length ? { entities: rendered.entities } : { entities: undefined }) }, ...rest));
        recordSuccess(uid, destination, sender, content.templateId);
        return result;
      } catch (err) {
        recordFailure(uid, destination, sender, err);
        throw err;
      }
    };
  }

  if (TelegramClientClass?.prototype && !TelegramClientClass.prototype.__telepilotV1EngineInstalled) {
    const currentSendMessage = TelegramClientClass.prototype.sendMessage;
    const currentGetMe = TelegramClientClass.prototype.getMe;
    Object.defineProperty(TelegramClientClass.prototype, "__telepilotV1EngineInstalled", { value: true });

    TelegramClientClass.prototype.getMe = async function(...args) {
      const me = await currentGetMe.apply(this, args);
      const uid = findUidByUsername(me?.username || "");
      if (uid) clientOwners.set(this, uid);
      return me;
    };

    TelegramClientClass.prototype.sendMessage = async function(entity, params = {}, ...rest) {
      let uid = clientOwners.get(this) || "";
      if (!uid) {
        try {
          const me = await currentGetMe.call(this);
          uid = findUidByUsername(me?.username || "");
          if (uid) clientOwners.set(this, uid);
        } catch {}
      }
      const settings = uid ? readAppSettings(uid) : null;
      const message = String(params?.message || "");
      if (!uid || !settings || String(settings.adMessage || "") !== message) return currentSendMessage.call(this, entity, params, ...rest);
      const destination = matchDestination(settings, entity);
      if (!destination) return currentSendMessage.call(this, entity, params, ...rest);

      const pro = readV1(uid);
      const cycle = beginCycle(uid, settings, pro, destination);
      const sender = settings.personalUsername ? `@${settings.personalUsername}` : "Personal account";
      const content = selectContent(uid, settings, pro, destination, cycle, message, params?.formattingEntities || []);
      const rendered = renderV1(content, pro, destination, sender);
      const reason = skipReason(pro, cycle, destination);
      if (reason) {
        recordSkipped(uid, destination, sender, reason);
        return fakeResult(rendered);
      }
      if (cycle.index > 1 && Number(pro.staggerSeconds || 0) > 0) await new Promise(resolve => setTimeout(resolve, Number(pro.staggerSeconds) * 1000));
      try {
        const result = await withRetry(() => pro.media
          ? sendPersonalMedia(this, entity, pro.media, rendered)
          : rawPersonalSendMessage.call(this, entity, { ...params, message: rendered.text || "\u2063", formattingEntities: toMtEntities(rendered.entities) }, ...rest));
        recordSuccess(uid, destination, sender, content.templateId);
        return result;
      } catch (err) {
        recordFailure(uid, destination, sender, err);
        throw err;
      }
    };
  }
}

export function v1Stats(uid, now = Date.now()) {
  const pro = readV1(uid);
  const history = pro.history || [];
  const day = 86_400_000;
  const summarize = since => {
    const rows = history.filter(item => Number(item.ts || 0) >= since);
    return {
      sent: rows.filter(item => item.status === "sent").length,
      failed: rows.filter(item => item.status === "failed").length,
      skipped: rows.filter(item => item.status === "skipped").length,
    };
  };
  return { today: summarize(now - day), week: summarize(now - 7 * day), total: summarize(0) };
}

export function queuePreview(uid, now = Date.now()) {
  const pro = readV1(uid);
  const offset = Number(pro.schedule?.utcOffsetMinutes || 0);
  const items = [];
  for (const job of pro.oneTimeJobs || []) {
    if (job.status && job.status !== "pending") continue;
    const runAt = Number(job.runAt || 0);
    if (runAt >= now) items.push({ runAt, label: "One-time post" });
  }
  const localNow = new Date(now + offset * 60_000);
  for (const rule of pro.exactTimes || []) {
    if (rule.enabled === false || !/^\d{2}:\d{2}$/.test(String(rule.time || ""))) continue;
    const [h, m] = String(rule.time).split(":").map(Number);
    for (let add = 0; add < 8; add++) {
      const local = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + add, h, m));
      const day = local.getUTCDay();
      const days = Array.isArray(rule.days) ? rule.days.map(Number) : [0,1,2,3,4,5,6];
      if (!days.includes(day)) continue;
      const runAt = local.getTime() - offset * 60_000;
      if (runAt >= now) { items.push({ runAt, label: `Exact — ${rule.time}` }); break; }
    }
  }
  return items.sort((a, b) => a.runAt - b.runAt).slice(0, 6);
}
