import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const HISTORY_LIMIT = 200;
const cycleRuntime = new Map();
const clientOwners = new WeakMap();

function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function settingsPath(uid) { return path.join(userDir(uid), "settings.json"); }
function proPath(uid) { return path.join(userDir(uid), "pro-settings.json"); }
function sessionPath(uid) { return path.join(userDir(uid), "personal-session.enc"); }

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function defaultProSettings() {
  return {
    version: 1,
    paused: false,
    skipNext: false,
    placeholders: true,
    staggerSeconds: 0,
    disabledDestinationIds: [],
    schedule: {
      enabled: false,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "00:00",
      end: "23:59",
      utcOffsetMinutes: 0,
    },
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
    disabledDestinationIds: Array.isArray(saved.disabledDestinationIds) ? saved.disabledDestinationIds.map(String) : [],
    templates: Array.isArray(saved.templates) ? saved.templates : [],
    history: Array.isArray(saved.history) ? saved.history.slice(-HISTORY_LIMIT) : [],
    schedule: { ...base.schedule, ...(saved.schedule || {}) },
  };
}

export function writeProSettings(uid, value) {
  const normalized = { ...defaultProSettings(), ...value, version: 1 };
  normalized.history = Array.isArray(normalized.history) ? normalized.history.slice(-HISTORY_LIMIT) : [];
  writeJsonAtomic(proPath(uid), normalized);
  return normalized;
}

export function readAppSettings(uid) {
  return readJson(settingsPath(uid), {});
}

export function listUserIds() {
  try {
    return fs.readdirSync(USERS_DIR, { withFileTypes: true })
      .filter(item => item.isDirectory() && /^\d+$/.test(item.name))
      .map(item => item.name);
  } catch {
    return [];
  }
}

export function hasPersonalSessionFile(uid) {
  try { return fs.existsSync(sessionPath(uid)) && fs.statSync(sessionPath(uid)).size > 20; }
  catch { return false; }
}

function destinationLabel(destination) {
  return String(destination?.username || destination?.label || destination?.id || "Destination");
}

function destinationId(destination) {
  return String(destination?.id || destination?.username || destination?.label || "");
}

function normalizeEntityCandidates(entity) {
  const out = new Set();
  if (typeof entity === "string" || typeof entity === "number" || typeof entity === "bigint") {
    out.add(String(entity).toLowerCase());
    return out;
  }
  const values = [
    entity?.id, entity?.username, entity?.entity?.id, entity?.entity?.username,
    entity?.inputEntity?.chatId, entity?.inputEntity?.channelId,
    entity?.chatId, entity?.channelId,
  ];
  for (const value of values) if (value !== undefined && value !== null) out.add(String(value).toLowerCase());
  return out;
}

function matchDestination(settings, entity, uid) {
  const groups = Array.isArray(settings?.groups) ? settings.groups : [];
  const candidates = normalizeEntityCandidates(entity);
  for (const group of groups) {
    const id = String(group.id || "").toLowerCase();
    const username = String(group.username || "").toLowerCase();
    const raw = id.replace(/^-100/, "").replace(/^-/, "");
    if (candidates.has(id) || (username && candidates.has(username)) || (username && candidates.has(username.replace(/^@/, "")))) return group;
    if (raw && [...candidates].some(value => value.replace(/\D/g, "") === raw)) return group;
  }

  const runtime = cycleRuntime.get(String(uid));
  if (runtime) {
    const next = groups.find(group => !runtime.seen.has(destinationId(group)));
    if (next) return next;
  }
  return groups[0] || null;
}

function findUidForBotSend(chatId, text) {
  const chat = String(chatId);
  for (const uid of listUserIds()) {
    if (hasPersonalSessionFile(uid)) continue;
    const settings = readAppSettings(uid);
    if (String(settings.adMessage || "") !== String(text || "")) continue;
    if ((settings.groups || []).some(group => String(group.id) === chat)) return uid;
  }
  return "";
}

function findUidByPersonalUsername(username) {
  const wanted = String(username || "").replace(/^@/, "").toLowerCase();
  if (!wanted) return "";
  for (const uid of listUserIds()) {
    const settings = readAppSettings(uid);
    if (String(settings.personalUsername || "").replace(/^@/, "").toLowerCase() === wanted) return uid;
  }
  return "";
}

function parseClock(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export function scheduleAllowsNow(pro, now = new Date()) {
  if (!pro?.schedule?.enabled) return true;
  const offset = Number(pro.schedule.utcOffsetMinutes || 0);
  const local = new Date(now.getTime() + offset * 60_000);
  const day = local.getUTCDay();
  const days = Array.isArray(pro.schedule.days) ? pro.schedule.days.map(Number) : [];
  if (!days.includes(day)) return false;

  const start = parseClock(pro.schedule.start);
  const end = parseClock(pro.schedule.end);
  if (start === null || end === null) return true;
  const current = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function localDateParts(pro, now = new Date()) {
  const offset = Number(pro?.schedule?.utcOffsetMinutes || 0);
  const local = new Date(now.getTime() + offset * 60_000);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const min = String(local.getUTCMinutes()).padStart(2, "0");
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}`, datetime: `${yyyy}-${mm}-${dd} ${hh}:${min}` };
}

function adjustEntitiesForReplacement(entities, start, oldLength, newLength) {
  const delta = newLength - oldLength;
  const oldEnd = start + oldLength;
  for (const entity of entities) {
    const eStart = Number(entity.offset || 0);
    const eEnd = eStart + Number(entity.length || 0);
    if (eStart >= oldEnd) entity.offset = eStart + delta;
    else if (eEnd > start && eStart < oldEnd) entity.length = Math.max(0, Number(entity.length || 0) + delta);
  }
}

export function renderDynamicMessage(text, entities, context) {
  let value = String(text || "");
  const outEntities = Array.isArray(entities) ? entities.map(entity => ({ ...entity })) : [];
  if (!context?.pro?.placeholders) return { text: value, entities: outEntities };

  const parts = localDateParts(context.pro);
  const replacements = new Map([
    ["{date}", parts.date],
    ["{time}", parts.time],
    ["{datetime}", parts.datetime],
    ["{destination}", destinationLabel(context.destination)],
    ["{sender}", String(context.sender || "TelePilot")],
  ]);

  for (const [token, replacement] of replacements) {
    let from = 0;
    while (from < value.length) {
      const index = value.indexOf(token, from);
      if (index < 0) break;
      value = value.slice(0, index) + replacement + value.slice(index + token.length);
      adjustEntitiesForReplacement(outEntities, index, token.length, replacement.length);
      from = index + replacement.length;
    }
  }

  return { text: value === "\u2063" ? "" : value, entities: outEntities.filter(e => Number(e.length) > 0) };
}

function appendHistory(uid, item) {
  const pro = readProSettings(uid);
  pro.history.push({ ts: Date.now(), ...item });
  pro.history = pro.history.slice(-HISTORY_LIMIT);
  writeProSettings(uid, pro);
}

function beginCycle(uid, settings, pro, destination) {
  const key = String(uid);
  const id = destinationId(destination);
  let cycle = cycleRuntime.get(key);
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const stale = cycle && Date.now() - cycle.startedAt > 10 * 60_000;
  if (!cycle || stale || cycle.seen.has(id) || cycle.seen.size >= Math.max(1, groups.length)) {
    cycle = {
      startedAt: Date.now(),
      seen: new Set(),
      index: 0,
      skip: pro.skipNext === true,
    };
    if (pro.skipNext) {
      pro.skipNext = false;
      writeProSettings(uid, pro);
    }
    cycleRuntime.set(key, cycle);
  }
  cycle.seen.add(id);
  cycle.index += 1;
  return cycle;
}

function skipReason(pro, cycle, destination) {
  if (pro.paused) return "paused";
  if (cycle.skip) return "skip-next";
  if ((pro.disabledDestinationIds || []).map(String).includes(destinationId(destination))) return "disabled";
  if (!scheduleAllowsNow(pro)) return "outside-schedule";
  return "";
}

function errorText(err) {
  return String(err?.description || err?.errorMessage || err?.message || err || "Unknown error").slice(0, 220);
}

function retryDelayMs(err) {
  const retryAfter = Number(err?.parameters?.retry_after || 0);
  if (retryAfter > 0 && retryAfter <= 60) return retryAfter * 1000;
  const match = errorText(err).toUpperCase().match(/FLOOD_WAIT_?(\d+)/);
  if (match && Number(match[1]) <= 60) return Number(match[1]) * 1000;
  return 1200;
}

function isRetryable(err) {
  const code = Number(err?.error_code || 0);
  const text = errorText(err).toUpperCase();
  if (code === 429 || code >= 500) return true;
  return ["TIMEOUT", "TIMED OUT", "ECONNRESET", "EAI_AGAIN", "RPC_CALL_FAIL", "INTERNAL", "SERVER_ERROR", "FLOOD_WAIT"].some(token => text.includes(token));
}

async function withRetry(fn) {
  try { return await fn(); }
  catch (err) {
    if (!isRetryable(err)) throw err;
    await new Promise(resolve => setTimeout(resolve, retryDelayMs(err)));
    return fn();
  }
}

function fakeMessage(rendered) {
  return { id: 0, message_id: 0, message: rendered?.text || "", text: rendered?.text || "" };
}

async function sendBotMedia(api, chatId, media, rendered, originalSendMessage, other) {
  const caption = rendered.text;
  const captionOptions = {
    ...(caption ? { caption } : {}),
    ...(rendered.entities.length ? { caption_entities: rendered.entities } : {}),
  };
  const file = media.fileId;
  if (!file) return originalSendMessage.call(api, chatId, caption || "\u2063", { ...(other || {}), entities: rendered.entities });

  if (caption.length > 1024) {
    const noCaption = {};
    if (media.kind === "photo") await api.sendPhoto(chatId, file, noCaption);
    else if (media.kind === "video") await api.sendVideo(chatId, file, noCaption);
    else if (media.kind === "animation") await api.sendAnimation(chatId, file, noCaption);
    else await api.sendDocument(chatId, file, noCaption);
    return originalSendMessage.call(api, chatId, caption, rendered.entities.length ? { entities: rendered.entities } : {});
  }

  if (media.kind === "photo") return api.sendPhoto(chatId, file, captionOptions);
  if (media.kind === "video") return api.sendVideo(chatId, file, { ...captionOptions, supports_streaming: true });
  if (media.kind === "animation") return api.sendAnimation(chatId, file, captionOptions);
  return api.sendDocument(chatId, file, captionOptions);
}

async function sendPersonalMedia(client, entity, media, rendered, params) {
  if (!media.localPath || !fs.existsSync(media.localPath)) {
    return client.__telepilotOriginalSendMessage(entity, { ...params, message: rendered.text, formattingEntities: rendered.entities });
  }
  return client.sendFile(entity, {
    file: media.localPath,
    caption: rendered.text,
    ...(rendered.entities.length ? { formattingEntities: rendered.entities } : {}),
    forceDocument: media.kind === "document",
    supportsStreaming: media.kind === "video",
  });
}

export function installPostingEngineEnhancements(ApiClass, TelegramClientClass) {
  if (ApiClass?.prototype && !ApiClass.prototype.__telepilotPostingEngineInstalled) {
    const originalSendMessage = ApiClass.prototype.sendMessage;
    Object.defineProperty(ApiClass.prototype, "__telepilotPostingEngineInstalled", { value: true });

    ApiClass.prototype.sendMessage = async function(chatId, text, other, ...rest) {
      const uid = findUidForBotSend(chatId, text);
      if (!uid) return originalSendMessage.call(this, chatId, text, other, ...rest);

      const settings = readAppSettings(uid);
      const pro = readProSettings(uid);
      const destination = matchDestination(settings, chatId, uid);
      if (!destination) return originalSendMessage.call(this, chatId, text, other, ...rest);
      const cycle = beginCycle(uid, settings, pro, destination);
      const reason = skipReason(pro, cycle, destination);
      const rendered = renderDynamicMessage(text, other?.entities || [], {
        pro, destination, sender: "TelePilot Bot",
      });

      if (reason) {
        appendHistory(uid, { destination: destinationLabel(destination), destinationId: destinationId(destination), status: "skipped", reason, sender: "TelePilot Bot" });
        return fakeMessage(rendered);
      }

      if (cycle.index > 1 && Number(pro.staggerSeconds || 0) > 0) {
        await new Promise(resolve => setTimeout(resolve, Number(pro.staggerSeconds) * 1000));
      }

      try {
        const result = await withRetry(() => pro.media
          ? sendBotMedia(this, chatId, pro.media, rendered, originalSendMessage, other)
          : originalSendMessage.call(this, chatId, rendered.text || "\u2063", {
              ...(other || {}),
              ...(rendered.entities.length ? { entities: rendered.entities } : { entities: undefined }),
            }, ...rest));
        appendHistory(uid, { destination: destinationLabel(destination), destinationId: destinationId(destination), status: "sent", sender: "TelePilot Bot" });
        return result;
      } catch (err) {
        appendHistory(uid, { destination: destinationLabel(destination), destinationId: destinationId(destination), status: "failed", error: errorText(err), sender: "TelePilot Bot" });
        throw err;
      }
    };
  }

  if (TelegramClientClass?.prototype && !TelegramClientClass.prototype.__telepilotPostingEngineInstalled) {
    const originalSendMessage = TelegramClientClass.prototype.sendMessage;
    const originalGetMe = TelegramClientClass.prototype.getMe;
    Object.defineProperty(TelegramClientClass.prototype, "__telepilotPostingEngineInstalled", { value: true });
    Object.defineProperty(TelegramClientClass.prototype, "__telepilotOriginalSendMessage", { value: originalSendMessage });

    TelegramClientClass.prototype.getMe = async function(...args) {
      const me = await originalGetMe.apply(this, args);
      const uid = findUidByPersonalUsername(me?.username || "");
      if (uid) clientOwners.set(this, uid);
      return me;
    };

    TelegramClientClass.prototype.sendMessage = async function(entity, params = {}, ...rest) {
      const message = String(params?.message || "");
      let uid = clientOwners.get(this) || "";
      if (!uid) {
        try {
          const me = await originalGetMe.call(this);
          uid = findUidByPersonalUsername(me?.username || "");
          if (uid) clientOwners.set(this, uid);
        } catch {}
      }
      if (!uid) return originalSendMessage.call(this, entity, params, ...rest);

      const settings = readAppSettings(uid);
      if (String(settings.adMessage || "") !== message) return originalSendMessage.call(this, entity, params, ...rest);
      const pro = readProSettings(uid);
      const destination = matchDestination(settings, entity, uid);
      if (!destination) return originalSendMessage.call(this, entity, params, ...rest);
      const cycle = beginCycle(uid, settings, pro, destination);
      const reason = skipReason(pro, cycle, destination);
      const sender = settings.personalUsername ? `@${settings.personalUsername}` : "Personal account";
      const rendered = renderDynamicMessage(message, params?.formattingEntities || [], { pro, destination, sender });

      if (reason) {
        appendHistory(uid, { destination: destinationLabel(destination), destinationId: destinationId(destination), status: "skipped", reason, sender });
        return fakeMessage(rendered);
      }

      if (cycle.index > 1 && Number(pro.staggerSeconds || 0) > 0) {
        await new Promise(resolve => setTimeout(resolve, Number(pro.staggerSeconds) * 1000));
      }

      try {
        const result = await withRetry(() => pro.media
          ? sendPersonalMedia(this, entity, pro.media, rendered, params)
          : originalSendMessage.call(this, entity, {
              ...params,
              message: rendered.text || "\u2063",
              formattingEntities: rendered.entities,
            }, ...rest));
        appendHistory(uid, { destination: destinationLabel(destination), destinationId: destinationId(destination), status: "sent", sender });
        return result;
      } catch (err) {
        appendHistory(uid, { destination: destinationLabel(destination), destinationId: destinationId(destination), status: "failed", error: errorText(err), sender });
        throw err;
      }
    };
  }
}
