import fs from "node:fs";
import path from "node:path";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { listAccounts, loadAccountSession } from "./account-store.js";
import { listUserIds, readAppSettings } from "./posting-engine-enhancements.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const WORKER_INTERVAL_MS = 2_000;
const FULL_SCAN_INTERVAL_MS = 30_000;
const MUTE_FOREVER_UNIX = 2147483647;
const ARCHIVE_FOLDER_ID = 1;
const MAX_PENDING = 5000;
const MAX_MUTES_PER_ACCOUNT = 24;
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
function retryAt(attempt) {
  const exponent = Math.min(8, Math.max(0, Number(attempt || 0)));
  return Date.now() + Math.min(10 * 60_000, 1_500 * (2 ** exponent));
}
function normalizePendingRow(row) {
  const legacyAttempts = Math.max(0, Number(row?.attempts || 0) || 0);
  return {
    accountId: String(row?.accountId || ""),
    destinationId: String(row?.destinationId || ""),
    archived: row?.archived === true,
    muted: row?.muted === true,
    archiveAttempts: Math.max(0, Number(row?.archiveAttempts ?? legacyAttempts) || 0),
    muteAttempts: Math.max(0, Number(row?.muteAttempts ?? legacyAttempts) || 0),
    nextArchiveAt: Math.max(0, Number(row?.nextArchiveAt || 0) || 0),
    nextMuteAt: Math.max(0, Number(row?.nextMuteAt || 0) || 0),
    lastError: String(row?.lastError || "").slice(0, 180),
  };
}
function readStore(uid) {
  const raw = readJson(storePath(uid), {});
  const legacyCooldowns = raw?.cooldowns && typeof raw.cooldowns === "object" && !Array.isArray(raw.cooldowns) ? raw.cooldowns : {};
  return {
    version: 2,
    scanAccounts: [...new Set((Array.isArray(raw.scanAccounts) ? raw.scanAccounts : []).map(String).filter(Boolean))],
    pending: (Array.isArray(raw.pending) ? raw.pending : []).map(normalizePendingRow).filter(row => row.accountId && row.destinationId).slice(-MAX_PENDING),
    archiveCooldowns: raw?.archiveCooldowns && typeof raw.archiveCooldowns === "object" && !Array.isArray(raw.archiveCooldowns)
      ? Object.fromEntries(Object.entries(raw.archiveCooldowns).map(([id, until]) => [String(id), Number(until) || 0]))
      : Object.fromEntries(Object.entries(legacyCooldowns).map(([id, until]) => [String(id), Number(until) || 0])),
    muteCooldowns: raw?.muteCooldowns && typeof raw.muteCooldowns === "object" && !Array.isArray(raw.muteCooldowns)
      ? Object.fromEntries(Object.entries(raw.muteCooldowns).map(([id, until]) => [String(id), Number(until) || 0]))
      : {},
    lastFullScanAt: Math.max(0, Number(raw?.lastFullScanAt || 0) || 0),
  };
}
function writeStore(uid, store) {
  const normalized = {
    version: 2,
    scanAccounts: [...new Set((store.scanAccounts || []).map(String).filter(Boolean))],
    pending: (store.pending || []).map(normalizePendingRow).slice(-MAX_PENDING),
    archiveCooldowns: store.archiveCooldowns || {},
    muteCooldowns: store.muteCooldowns || {},
    lastFullScanAt: Math.max(0, Number(store.lastFullScanAt || 0) || 0),
  };
  writeJsonAtomic(storePath(uid), normalized);
  return normalized;
}
function requestClassName(request) { return String(request?.className || request?.constructor?.className || ""); }
function isArchiveMuteRequest(request) {
  const name = requestClassName(request);
  return name === "folders.EditPeerFolders" || name === "account.UpdateNotifySettings";
}
function queueAccountScan(uid, accountId) {
  if (!uid || !accountId) return;
  const store = readStore(uid);
  if (!store.scanAccounts.includes(String(accountId))) store.scanAccounts.push(String(accountId));
  writeStore(uid, store);
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

export function installArchiveMuteQueue(TelegramClientClass = TelegramClient) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotArchiveMuteQueueInstalled) return;
  const originalInvoke = proto.invoke;
  if (typeof originalInvoke !== "function") throw new Error("Unsupported TelegramClient shape for archive/mute queue");
  originalInvokeByPrototype.set(proto, originalInvoke);
  Object.defineProperty(proto, "__telepilotArchiveMuteQueueInstalled", { value: true });
  proto.invoke = async function(request, ...rest) {
    if (this.__telepilotArchiveMuteWorker === true || !isArchiveMuteRequest(request)) {
      return originalInvoke.call(this, request, ...rest);
    }
    const uid = String(this.__telepilotOwnerUid || "");
    const accountId = String(this.__telepilotAccountId || "");
    if (!uid || !accountId) return originalInvoke.call(this, request, ...rest);
    queueAccountScan(uid, accountId);
    return { queued: true };
  };
}

function readyDestinationRows(uid, accountId) {
  const settings = readAppSettings(uid);
  return (settings.groups || []).filter(group => {
    const row = group?.accountJoin?.[String(accountId)];
    if (row) return String(row.status || "") === "ready";
    return Boolean(group?.username || group?.source === "addlist");
  });
}
function refillPending(uid, accountId, store) {
  const existing = new Set((store.pending || []).map(row => `${row.accountId}|${row.destinationId}`));
  for (const group of readyDestinationRows(uid, accountId)) {
    const key = `${accountId}|${String(group.id)}`;
    if (existing.has(key)) continue;
    if (store.pending.length >= MAX_PENDING) break;
    store.pending.push(normalizePendingRow({ accountId, destinationId: String(group.id) }));
    existing.add(key);
  }
  store.scanAccounts = (store.scanAccounts || []).filter(id => String(id) !== String(accountId));
}
function cleanupStore(uid, store, validAccountIds) {
  const groups = new Set((readAppSettings(uid).groups || []).map(group => String(group.id)));
  store.pending = (store.pending || []).filter(row => validAccountIds.has(String(row.accountId)) && groups.has(String(row.destinationId)) && !(row.archived && row.muted));
  for (const map of [store.archiveCooldowns, store.muteCooldowns]) {
    for (const [accountId, until] of Object.entries(map || {})) {
      if (!validAccountIds.has(String(accountId)) || Number(until) <= Date.now()) delete map[accountId];
    }
  }
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
async function resolveGroupPeer(client, group) {
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
    const peer = await resolveGroupPeer(client, group);
    peerCache.set(id, peer);
    return peer;
  };
  try {
    client = await openWorkerClient(uid, account);

    // Mute first. Archive FLOOD_WAIT must never prevent notification cleanup.
    if (!muteBlocked) {
      let completed = 0;
      for (const row of dueMute) {
        if (completed >= MAX_MUTES_PER_ACCOUNT) break;
        try {
          const peer = await peerFor(row);
          await rawInvoke(client, new Api.account.UpdateNotifySettings({
            peer: new Api.InputNotifyPeer({ peer }),
            settings: new Api.InputPeerNotifySettings({ muteUntil: MUTE_FOREVER_UNIX }),
          }));
          row.muted = true;
          row.muteAttempts = 0;
          row.nextMuteAt = 0;
          row.lastError = "";
          completed++;
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
      writeStore(uid, store);
    }

    // Archive in a single vector request where possible to avoid one folder edit per chat.
    if (!archiveBlocked && Number(store.archiveCooldowns[accountId] || 0) <= Date.now()) {
      const candidates = dueArchive.slice(0, ARCHIVE_BATCH_SIZE);
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

async function processUser(uid) {
  const accounts = listAccounts(uid);
  if (!accounts.length) return false;
  const validAccountIds = new Set(accounts.map(account => String(account.id)));
  const store = readStore(uid);
  if (Date.now() - Number(store.lastFullScanAt || 0) >= FULL_SCAN_INTERVAL_MS) {
    for (const account of accounts) if (!store.scanAccounts.includes(String(account.id))) store.scanAccounts.push(String(account.id));
    store.lastFullScanAt = Date.now();
  }
  for (const accountId of [...store.scanAccounts]) {
    if (validAccountIds.has(String(accountId))) refillPending(uid, accountId, store);
    else store.scanAccounts = store.scanAccounts.filter(id => String(id) !== String(accountId));
  }
  cleanupStore(uid, store, validAccountIds);
  writeStore(uid, store);

  let didWork = false;
  for (const account of accounts) {
    const rows = store.pending.filter(row => String(row.accountId) === String(account.id));
    if (!rows.length) continue;
    if (await processAccount(uid, account, store, rows)) didWork = true;
  }
  cleanupStore(uid, store, validAccountIds);
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
        try { await processUser(uid); }
        catch (err) { console.warn(`Archive/mute worker failed for ${uid}: ${String(err?.message || err).slice(0, 160)}`); }
      }
    } finally { busy = false; }
  };
  timer = setInterval(() => void tick(), WORKER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 2_000).unref?.();
  console.log("TelePilot archive/mute queue worker enabled (mute-first + batched archive)");
  return timer;
}
