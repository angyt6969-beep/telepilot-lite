import fs from "node:fs";
import path from "node:path";
import { recentAddlistCapacity } from "./addlist-safety.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const STATUS_TTL_MS = 10 * 60_000;
const POLL_MS = 4_000;
const MAX_POLL_MS = 3 * 60_000;
const MESSAGE_MATCH_WINDOW_MS = 10_000;

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function statusPath(uid) { return path.join(userDir(uid), "addlist-live-progress.json"); }
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
function cleanSlug(value) {
  const slug = String(value || "");
  return /^[A-Za-z0-9_-]+$/.test(slug) ? slug : "";
}
function requestClassName(request) { return String(request?.className || request?.constructor?.className || ""); }
function valueString(value) {
  try { return String(value?.toString?.() ?? value ?? ""); }
  catch { return String(value || ""); }
}
function isAlreadyInvite(result) {
  return result?.className === "ChatlistInviteAlready" || Number.isInteger(Number(result?.filterId));
}
function countsFromResult(result) {
  if (!result || typeof result !== "object") return { total: 0, confirmed: 0 };
  if (isAlreadyInvite(result)) {
    const confirmed = Array.isArray(result.alreadyPeers) ? result.alreadyPeers.length : 0;
    const missing = Array.isArray(result.missingPeers) ? result.missingPeers.length : 0;
    return { total: confirmed + missing, confirmed };
  }
  const peers = Array.isArray(result.peers) ? result.peers : [];
  return { total: peers.length, confirmed: 0 };
}
function normalizeStore(raw) {
  const rows = raw?.rows && typeof raw.rows === "object" ? raw.rows : {};
  return { version: 1, latestKey: String(raw?.latestKey || ""), rows };
}
function readStore(uid) { return normalizeStore(readJson(statusPath(uid), {})); }
function rowKey(accountId, slug) { return `${String(accountId || "")}|${cleanSlug(slug)}`; }
function errorText(err) {
  return String(err?.errorMessage || err?.description || err?.message || err || "").slice(0, 180);
}
function writeStatus(client, slug, patch = {}) {
  const uid = String(client?.__telepilotOwnerUid || "");
  const accountId = String(client?.__telepilotAccountId || "");
  const clean = cleanSlug(slug);
  if (!uid || !accountId || !clean) return null;
  const store = readStore(uid);
  const key = rowKey(accountId, clean);
  const previous = store.rows[key] && typeof store.rows[key] === "object" ? store.rows[key] : {};
  const now = Date.now();
  const row = {
    accountId,
    slug: clean,
    total: Math.max(0, Number(patch.total ?? previous.total ?? 0) || 0),
    confirmed: Math.max(0, Number(patch.confirmed ?? previous.confirmed ?? 0) || 0),
    phase: String(patch.phase ?? previous.phase ?? "checking").slice(0, 32),
    lastError: String(patch.lastError ?? previous.lastError ?? "").slice(0, 180),
    startedAt: Math.max(0, Number(previous.startedAt || now) || now),
    updatedAt: now,
  };
  if (patch.newAttempt === true) {
    row.startedAt = now;
    row.lastError = "";
  }
  store.rows[key] = row;
  store.latestKey = key;
  const cutoff = now - 24 * 60 * 60_000;
  for (const [storedKey, storedRow] of Object.entries(store.rows)) {
    if (Number(storedRow?.updatedAt || 0) < cutoff) delete store.rows[storedKey];
  }
  writeJsonAtomic(statusPath(uid), store);
  return { key, ...row };
}

export function recentAddlistLiveStatus(uid, key = "", withinMs = STATUS_TTL_MS) {
  const store = readStore(String(uid || ""));
  const wanted = String(key || store.latestKey || "");
  const row = wanted ? store.rows[wanted] : null;
  if (!row) return null;
  if (Date.now() - Number(row.updatedAt || 0) > Math.max(1_000, Number(withinMs) || STATUS_TTL_MS)) return null;
  return { key: wanted, ...row };
}

export function installAddlistLiveStatus(TelegramClientClass) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotAddlistLiveStatusInstalled) return;
  const originalInvoke = proto.invoke;
  if (typeof originalInvoke !== "function") throw new Error("Unsupported TelegramClient shape for Addlist live status");
  Object.defineProperty(proto, "__telepilotAddlistLiveStatusInstalled", { value: true });

  proto.invoke = async function(request, ...rest) {
    const name = requestClassName(request);
    const isCheck = name === "chatlists.CheckChatlistInvite";
    const isJoin = name === "chatlists.JoinChatlistInvite";
    const slug = cleanSlug(request?.slug || "");
    if ((isCheck || isJoin) && slug) {
      const previous = recentAddlistLiveStatus(String(this.__telepilotOwnerUid || ""));
      const isNew = !previous || previous.slug !== slug || previous.accountId !== String(this.__telepilotAccountId || "") || Date.now() - Number(previous.updatedAt || 0) > 15_000;
      writeStatus(this, slug, { phase: isJoin ? "joining" : "checking", newAttempt: isNew });
    }
    try {
      const result = await originalInvoke.call(this, request, ...rest);
      if (isCheck && slug) {
        const counts = countsFromResult(result);
        writeStatus(this, slug, { ...counts, phase: counts.total > 0 && counts.confirmed >= counts.total ? "confirmed" : "checking", lastError: "" });
      } else if (isJoin && slug) {
        writeStatus(this, slug, { phase: "joined", lastError: "" });
      }
      return result;
    } catch (err) {
      if ((isCheck || isJoin) && slug) writeStatus(this, slug, { phase: "error", lastError: errorText(err) });
      throw err;
    }
  };
  console.log("TelePilot Addlist live progress tracking enabled");
}

function targetCount(chatId, status) {
  const capacity = recentAddlistCapacity(String(chatId || ""), STATUS_TTL_MS);
  if (capacity && capacity.slug === status?.slug && Number(capacity.total || 0) > 0) {
    const total = Math.max(0, Number(capacity.total || 0) || 0);
    const limit = Math.max(0, Number(capacity.limit || 0) || 0);
    return limit > 0 ? Math.min(total, limit) : total;
  }
  return Math.max(0, Number(status?.total || 0) || 0);
}
function capacityLine(chatId, status) {
  const capacity = recentAddlistCapacity(String(chatId || ""), STATUS_TTL_MS);
  if (!capacity || capacity.slug !== status?.slug || !capacity.limit || capacity.total <= capacity.limit) return "";
  return `⚠️ Telegram folder limit — ${capacity.limit} of ${capacity.total} chats can be imported by this account.`;
}

export function renderAddlistLiveText(chatId, status) {
  if (!status) return "";
  const target = targetCount(chatId, status);
  const confirmed = Math.max(0, Number(status.confirmed || 0) || 0);
  const capLine = capacityLine(chatId, status);
  if (status.lastError) {
    return [
      "⚠️ Addlist import needs attention",
      target ? `Telegram confirmed — ${Math.min(confirmed, target)} / ${target}` : `Telegram confirmed — ${confirmed}`,
      `Telegram response — ${status.lastError}`,
      "",
      "🔄 TelePilot will keep the saved job and retry when Telegram allows it.",
      capLine,
    ].filter(Boolean).join("\n");
  }
  if (target > 0 && confirmed >= target) {
    return [
      "✅ Addlist import finished",
      `Telegram confirmed — ${target} / ${target}`,
      "🧹 Archive + mute cleanup is queued for the confirmed joined chats.",
      capLine,
    ].filter(Boolean).join("\n");
  }
  return [
    "⏳ Addlist import processing",
    target ? `Telegram confirmed — ${Math.min(confirmed, target)} / ${target}` : `Telegram confirmed — ${confirmed}`,
    "🔄 TelePilot is still checking the shared folder. This message will update automatically.",
    capLine,
  ].filter(Boolean).join("\n");
}

function isImportSummary(text) {
  const value = String(text || "");
  return value.startsWith("✅ Destination import complete") || value.startsWith("⏳ Addlist import processing");
}
function isFinishedText(text) { return /^✅ Addlist import finished/.test(String(text || "")); }

export function installAddlistLiveProgressUi(ApiClass) {
  const proto = ApiClass?.prototype;
  if (!proto || proto.__telepilotAddlistLiveProgressUiInstalled) return;
  const originalSendMessage = proto.sendMessage;
  const originalEditMessageText = proto.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for Addlist live progress UI");
  }
  Object.defineProperty(proto, "__telepilotAddlistLiveProgressUiInstalled", { value: true });

  proto.sendMessage = async function(chatId, text, other, ...rest) {
    const result = await originalSendMessage.call(this, chatId, text, other, ...rest);
    if (!isImportSummary(text)) return result;
    const initial = recentAddlistLiveStatus(String(chatId || ""));
    if (!initial || Date.now() - Number(initial.updatedAt || 0) > MESSAGE_MATCH_WINDOW_MS) return result;
    const messageId = Number(result?.message_id || result?.messageId || 0);
    if (!messageId) return result;
    const key = initial.key;
    let lastText = "";
    const started = Date.now();
    const update = async () => {
      const status = recentAddlistLiveStatus(String(chatId || ""), key);
      if (!status) return false;
      const nextText = renderAddlistLiveText(chatId, status);
      if (nextText && nextText !== lastText) {
        lastText = nextText;
        try { await originalEditMessageText.call(this, chatId, messageId, nextText, other); }
        catch (err) {
          const message = String(err?.description || err?.message || err);
          if (!/message is not modified/i.test(message)) return false;
        }
      }
      return isFinishedText(nextText);
    };
    const doneImmediately = await update();
    if (doneImmediately) return result;
    const timer = setInterval(() => {
      void update().then(done => {
        if (done || Date.now() - started >= MAX_POLL_MS) clearInterval(timer);
      });
    }, POLL_MS);
    timer.unref?.();
    return result;
  };
}
