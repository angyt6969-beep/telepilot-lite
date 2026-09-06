import fs from "node:fs";
import path from "node:path";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { listAccounts, loadAccountSession } from "./account-store.js";
import { listUserIds, readAppSettings } from "./posting-engine-enhancements.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const WORKER_INTERVAL_MS = 2_000;
const MUTE_FOREVER_UNIX = 2147483647;
const ARCHIVE_FOLDER_ID = 1;
const MAX_PENDING = 5000;
const MAX_COMPLETED = 20000;
const COMPLETED_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_MUTES_PER_ACCOUNT = 4;
const MUTE_SPACING_MS = 750;
const ARCHIVE_BATCH_SIZE = 50;
const originalInvokeByPrototype = new WeakMap();

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function storePath(uid) { return path.join(userDir(uid), "archive-mute-queue.json"); }
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
function valueString(value) {
  try { return String(value?.toString?.() ?? value ?? ""); }
  catch { return String(value || ""); }
}
function retryAt(attempt) {
  const exponent = Math.min(8, Math.max(0, Number(attempt || 0)));
  return Date.now() + Math.min(10 * 60_000, 1_500 * (2 ** exponent));
}
function rowKey(accountId, destinationId) { return `${String(accountId)}|${String(destinationId)}`; }
function normalizePeerDescriptor(peer) {
  if (!peer || typeof peer !== "object") return null;
  const name = String(peer?.className || peer?.constructor?.className || "");
  if (name === "InputPeerChannel" || peer?.channelId !== undefined) {
    const channelId = valueString(peer?.channelId).replace(/\D/g, "");
    const accessHash = valueString(peer?.accessHash);
    if (channelId && /^-?\d+$/.test(accessHash)) return { kind: "channel", channelId, accessHash };
  }
  if (name === "InputPeerChat" || peer?.chatId !== undefined) {
    const chatId = valueString(peer?.chatId).replace(/\D/g, "");
    if (chatId) return { kind: "chat", chatId };
  }
  return null;
}
function destinationIdFromPeer(peer) {
  const descriptor = normalizePeerDescriptor(peer);
  if (!descriptor) return "";
  if (descriptor.kind === "channel") return `-100${descriptor.channelId}`;
  if (descriptor.kind === "chat") return `-${descriptor.chatId}`;
  return "";
}
function normalizePendingRow(row) {
  const legacyAttempts = Math.max(0, Number(row?.attempts || 0) || 0);
  return {
    accountId: String(row?.accountId || ""),
    destinationId: String(row?.destinationId || ""),
    peer: row?.peer && typeof row.peer === "object" ? row.peer : null,
    archived: row?.archived === true,
    muted: row?.muted === true,
    archiveAttempts: Math.max(0, Number(row?.archiveAttempts ?? legacyAttempts) || 0),
    muteAttempts: Math.max(0, Number(row?.muteAttempts ?? legacyAttempts) || 0),
    nextArchiveAt: Math.max(0, Number(row?.nextArchiveAt || 0) || 0),
    nextMuteAt: Math.max(0, Number(row?.nextMuteAt || 0) || 0),
    lastError: String(row?.lastError || "").slice(0, 180),
    queuedAt: Math.max(0, Number(row?.queuedAt || 0) || Date.now()),
  };
}
function normalizeCompleted(raw) {
  const now = Date.now();
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .map(item => typeof item === "string" ? { key: item, at: now } : { key: String(item?.key || ""), at: Number(item?.at || 0) || now })
    .filter(item => item.key && now - item.at <= COMPLETED_TTL_MS)
    .slice(-MAX_COMPLETED);
}
function readStore(uid) {
  const raw = readJson(storePath(uid), {});
  const legacyCooldowns = raw?.cooldowns && typeof raw.cooldowns === "object" && !Array.isArray(raw.cooldowns) ? raw.cooldowns : {};
  const pending = (Array.isArray(raw.pending) ? raw.pending : [])
    .map(normalizePendingRow)
    .filter(row => row.accountId && row.destinationId)
    .slice(-MAX_PENDING);
  return {
    version: 3,
    pending,
    completed: normalizeCompleted(raw?.completed),
    archiveCooldowns: raw?.archiveCooldowns && typeof raw.archiveCooldowns === "object" && !Array.isArray(raw.archiveCooldowns)
      ? Object.fromEntries(Object.entries(raw.archiveCooldowns).map(([id, until]) => [String(id), Number(until) || 0]))
      : Object.fromEntries(Object.entries(legacyCooldowns).map(([id, until]) => [String(id), Number(until) || 0])),
    muteCooldowns: raw?.muteCooldowns && typeof raw.muteCooldowns === "object" && !Array.isArray(raw.muteCooldowns)
      ? Object.fromEntries(Object.entries(raw.muteCooldowns).map(([id, until]) => [String(id), Number(until) || 0]))
      : {},
  };
}
function writeStore(uid, store) {
  const normalized = {
    version: 3,
    pending: (store.pending || []).map(normalizePendingRow).slice(-MAX_PENDING),
    completed: normalizeCompleted(store.completed),
    archiveCooldowns: store.archiveCooldowns || {},
    muteCooldowns: store.muteCooldowns || {},
  };
  writeJsonAtomic(storePath(uid), normalized);
  return normalized;
}
function completedSet(store) { return new Set((store.completed || []).map(item => String(item.key))); }
function markCompleted(store, key) {
  const existing = (store.completed || []).filter(item => String(item.key) !== String(key));
  existing.push({ key: String(key), at: Date.now() });
  store.completed = existing.slice(-MAX_COMPLETED);
}

export function queueDestinationCleanup(uid, accountId, destinationId, peer = null) {
  const id = String(uid || ""), account = String(accountId || ""), destination = String(destinationId || "");
  if (!id || !account || !destination) return false;
  const store = readStore(id);
  const key = rowKey(account, destination);
  if (completedSet(store).has(key)) return false;
  const descriptor = normalizePeerDescriptor(peer) || (peer && peer.kind ? peer : null);
  const current = store.pending.find(row => rowKey(row.accountId, row.destinationId) === key);
  if (current) {
    if (!current.peer && descriptor) current.peer = descriptor;
    writeStore(id, store);
    return false;
  }
  if (store.pending.length >= MAX_PENDING) return false;
  store.pending.push(normalizePendingRow({ accountId: account, destinationId: destination, peer: descriptor, queuedAt: Date.now() }));
  writeStore(id, store);
  return true;
}

function requestClassName(request) { return String(request?.className || request?.constructor?.className || ""); }
function peerFromCleanupRequest(request) {
  const name = requestClassName(request);
  if (name === "folders.EditPeerFolders") return request?.folderPeers?.[0]?.peer || null;
  if (name === "account.UpdateNotifySettings") return request?.peer?.peer || request?.peer || null;
  return null;
}
function isCleanupRequest(request) {
  const name = requestClassName(request);
  return name === "folders.EditPeerFolders" || name === "account.UpdateNotifySettings";
}

export function installArchiveMuteQueue(TelegramClientClass = TelegramClient) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotArchiveMuteQueueV3Installed) return;
  const originalInvoke = proto.invoke;
  if (typeof originalInvoke !== "function") throw new Error("Unsupported TelegramClient shape for archive/mute queue v3");
  originalInvokeByPrototype.set(proto, originalInvoke);
  Object.defineProperty(proto, "__telepilotArchiveMuteQueueV3Installed", { value: true });
  proto.invoke = async function(request, ...rest) {
    if (this.__telepilotArchiveMuteWorker === true || !isCleanupRequest(request)) {
      return originalInvoke.call(this, request, ...rest);
    }
    const uid = String(this.__telepilotOwnerUid || "");
    const accountId = String(this.__telepilotAccountId || "");
    if (!uid || !accountId) return originalInvoke.call(this, request, ...rest);
    const peer = peerFromCleanupRequest(request);
    const destinationId = destinationIdFromPeer(peer);
    if (destinationId) queueDestinationCleanup(uid, accountId, destinationId, peer);
    return { queued: true };
  };
}

export function floodWaitSecondsFromTelegram(err) {
  for (const value of [err?.seconds, err?.value]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.ceil(number);
  }
  const text = String(err?.errorMessage || err?.description || err?.message || err || "").toUpperCase();
  for (const pattern of [/FLOOD_WAIT(?:_|\s|\(|:|-)*(\d+)/, /PLEASE WAIT\s+(\d+)\s+SECONDS?/, /WAIT\s+(\d+)\s+SECONDS?/]) {
    const match = text.match(pattern);
    if (match) return Math.max(1, Number(match[1]));
  }
  return 0;
}
function setCooldown(map, accountId, seconds) {
  map[String(accountId)] = Date.now() + Math.max(1, Number(seconds) || 1) * 1000 + 1_000;
}
function markTransient(row, kind, err) {
  const field = kind === "mute" ? "muteAttempts" : "archiveAttempts";
  const nextField = kind === "mute" ? "nextMuteAt" : "nextArchiveAt";
  row[field] = Number(row[field] || 0) + 1;
  row[nextField] = retryAt(row[field]);
  row.lastError = String(err?.message || err || "Telegram cleanup failed").slice(0, 180);
}
function reconstructPeer(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return null;
  if (descriptor.kind === "channel" && descriptor.channelId && descriptor.accessHash) {
    return new Api.InputPeerChannel({ channelId: bigInt(String(descriptor.channelId)), accessHash: bigInt(String(descriptor.accessHash)) });
  }
  if (descriptor.kind === "chat" && descriptor.chatId) {
    return new Api.InputPeerChat({ chatId: bigInt(String(descriptor.chatId)) });
  }
  return null;
}
async function openWorkerClient(uid, account) {
  const client = new TelegramClient(new StringSession(loadAccountSession(uid, account.id)), API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 0,
  });
  client.__telepilotArchiveMuteWorker = true;
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Saved Telegram session is no longer authorized");
  return client;
}
async function resolveGroupPeer(client, group, row) {
  const direct = reconstructPeer(row?.peer);
  if (direct) return direct;
  const target = group?.username || group?.id;
  if (!target) throw new Error("Destination cannot be resolved");
  const entity = await client.getEntity(target);
  return client.getInputEntity(entity);
}
async function rawInvoke(client, request) {
  const original = originalInvokeByPrototype.get(Object.getPrototypeOf(client));
  if (typeof original === "function") return original.call(client, request);
  return client.invoke(request);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function pruneStore(uid, store, validAccountIds) {
  const groups = new Set((readAppSettings(uid).groups || []).map(group => String(group.id)));
  store.pending = (store.pending || []).filter(row => validAccountIds.has(String(row.accountId)) && groups.has(String(row.destinationId)));
  for (const map of [store.archiveCooldowns, store.muteCooldowns]) {
    for (const [accountId, until] of Object.entries(map || {})) {
      if (!validAccountIds.has(String(accountId)) || Number(until) <= Date.now()) delete map[accountId];
    }
  }
  store.completed = normalizeCompleted(store.completed);
}
function finalizeCompleted(store) {
  const keep = [];
  for (const row of store.pending || []) {
    if (row.archived && row.muted) markCompleted(store, rowKey(row.accountId, row.destinationId));
    else keep.push(row);
  }
  store.pending = keep;
}

async function processAccount(uid, account, store, rows) {
  const accountId = String(account.id);
  const settings = readAppSettings(uid);
  const groups = new Map((settings.groups || []).map(group => [String(group.id), group]));
  const dueMute = rows.filter(row => !row.muted && Number(row.nextMuteAt || 0) <= Date.now());
  const dueArchive = rows.filter(row => !row.archived && Number(row.nextArchiveAt || 0) <= Date.now());
  const muteBlocked = Number(store.muteCooldowns[accountId] || 0) > Date.now();
  const archiveBlocked = Number(store.archiveCooldowns[accountId] || 0) > Date.now();
  if ((!dueMute.length || muteBlocked) && (!dueArchive.length || archiveBlocked)) return false;

  let client;
  const peerCache = new Map();
  const peerFor = async row => {
    const id = String(row.destinationId);
    if (peerCache.has(id)) return peerCache.get(id);
    const group = groups.get(id);
    if (!group) throw new Error("Destination no longer exists");
    const peer = await resolveGroupPeer(client, group, row);
    peerCache.set(id, peer);
    return peer;
  };
  try {
    client = await openWorkerClient(uid, account);

    if (!muteBlocked) {
      let completed = 0;
      for (const row of dueMute) {
        if (completed >= MAX_MUTES_PER_ACCOUNT) break;
        try {
          const peer = await peerFor(row);
          await rawInvoke(client, new Api.account.UpdateNotifySettings({
            peer: new Api.InputNotifyPeer({ peer }),
            settings: new Api.InputPeerNotifySettings({ silent: true, muteUntil: MUTE_FOREVER_UNIX }),
          }));
          row.muted = true;
          row.muteAttempts = 0;
          row.nextMuteAt = 0;
          row.lastError = "";
          completed++;
          if (completed < MAX_MUTES_PER_ACCOUNT) await sleep(MUTE_SPACING_MS);
        } catch (err) {
          const seconds = floodWaitSecondsFromTelegram(err);
          if (seconds) {
            setCooldown(store.muteCooldowns, accountId, seconds);
            console.log(`Mute cooldown for sender ${accountId}: ${seconds}s`);
            break;
          }
          markTransient(row, "mute", err);
        }
      }
      finalizeCompleted(store);
      writeStore(uid, store);
    }

    if (!archiveBlocked && Number(store.archiveCooldowns[accountId] || 0) <= Date.now()) {
      const candidates = dueArchive.filter(row => !row.archived).slice(0, ARCHIVE_BATCH_SIZE);
      const batch = [];
      for (const row of candidates) {
        try {
          const peer = await peerFor(row);
          batch.push({ row, folderPeer: new Api.InputFolderPeer({ peer, folderId: ARCHIVE_FOLDER_ID }) });
        } catch (err) {
          const seconds = floodWaitSecondsFromTelegram(err);
          if (seconds) {
            setCooldown(store.archiveCooldowns, accountId, seconds);
            console.log(`Archive cooldown for sender ${accountId}: ${seconds}s`);
            break;
          }
          markTransient(row, "archive", err);
        }
      }
      if (batch.length && Number(store.archiveCooldowns[accountId] || 0) <= Date.now()) {
        try {
          await rawInvoke(client, new Api.folders.EditPeerFolders({ folderPeers: batch.map(item => item.folderPeer) }));
          for (const { row } of batch) {
            row.archived = true;
            row.archiveAttempts = 0;
            row.nextArchiveAt = 0;
            row.lastError = "";
          }
        } catch (err) {
          const seconds = floodWaitSecondsFromTelegram(err);
          if (seconds) {
            setCooldown(store.archiveCooldowns, accountId, seconds);
            console.log(`Archive cooldown for sender ${accountId}: ${seconds}s`);
          } else {
            for (const { row } of batch) markTransient(row, "archive", err);
          }
        }
      }
      finalizeCompleted(store);
      writeStore(uid, store);
    }
  } catch (err) {
    const seconds = floodWaitSecondsFromTelegram(err);
    if (seconds) {
      setCooldown(store.muteCooldowns, accountId, seconds);
      setCooldown(store.archiveCooldowns, accountId, seconds);
    } else {
      console.warn(`Archive/mute worker could not open sender ${uid}/${accountId}: ${String(err?.message || err).slice(0, 160)}`);
    }
    writeStore(uid, store);
  } finally {
    try { await client?.disconnect(); } catch {}
  }
  return true;
}

export async function processArchiveMuteUser(uid) {
  const accounts = listAccounts(uid);
  if (!accounts.length) return false;
  const validAccountIds = new Set(accounts.map(account => String(account.id)));
  const store = readStore(uid);
  pruneStore(uid, store, validAccountIds);
  finalizeCompleted(store);
  writeStore(uid, store);
  let didWork = false;
  for (const account of accounts) {
    const rows = store.pending.filter(row => String(row.accountId) === String(account.id));
    if (!rows.length) continue;
    if (await processAccount(uid, account, store, rows)) didWork = true;
  }
  pruneStore(uid, store, validAccountIds);
  finalizeCompleted(store);
  writeStore(uid, store);
  return didWork;
}

let timer = null;
let busy = false;
export function startArchiveMuteWorker() {
  if (timer || !API_ID || !API_HASH) return timer;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const uid of listUserIds()) {
        try { await processArchiveMuteUser(uid); }
        catch (err) { console.warn(`Archive/mute queue failed for ${uid}: ${String(err?.message || err).slice(0, 160)}`); }
      }
    } finally { busy = false; }
  };
  timer = setInterval(() => void tick(), WORKER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 2_000).unref?.();
  console.log("TelePilot archive/mute queue v3 enabled (idempotent, mute-paced, batched archive)");
  return timer;
}
