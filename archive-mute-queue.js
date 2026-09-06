import fs from "node:fs";
import path from "node:path";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { listAccounts, loadAccountSession } from "./account-store.js";
import { listUserIds, readAppSettings } from "./posting-engine-enhancements.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const WORKER_INTERVAL_MS = 10_000;
const MUTE_FOREVER_UNIX = 2147483647;
const ARCHIVE_FOLDER_ID = 1;
const MAX_PENDING = 5000;
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
function readStore(uid) {
  const raw = readJson(storePath(uid), {});
  return {
    version: 1,
    scanAccounts: [...new Set((Array.isArray(raw.scanAccounts) ? raw.scanAccounts : []).map(String).filter(Boolean))],
    pending: (Array.isArray(raw.pending) ? raw.pending : []).map(row => ({
      accountId: String(row?.accountId || ""),
      destinationId: String(row?.destinationId || ""),
      archived: row?.archived === true,
      muted: row?.muted === true,
      attempts: Math.max(0, Number(row?.attempts || 0) || 0),
    })).filter(row => row.accountId && row.destinationId).slice(-MAX_PENDING),
    cooldowns: raw?.cooldowns && typeof raw.cooldowns === "object" && !Array.isArray(raw.cooldowns)
      ? Object.fromEntries(Object.entries(raw.cooldowns).map(([id, until]) => [String(id), Number(until) || 0]))
      : {},
  };
}
function writeStore(uid, store) {
  const normalized = {
    version: 1,
    scanAccounts: [...new Set((store.scanAccounts || []).map(String).filter(Boolean))],
    pending: (store.pending || []).slice(-MAX_PENDING),
    cooldowns: store.cooldowns || {},
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
  const patterns = [
    /FLOOD_WAIT(?:_|\s|\(|:|-)*(\d+)/,
    /PLEASE WAIT\s+(\d+)\s+SECONDS?/,
    /WAIT\s+(\d+)\s+SECONDS?/,
  ];
  for (const pattern of patterns) {
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
    return String(row?.status || "") === "ready" || (!row && group?.username);
  });
}
function refillPending(uid, accountId, store) {
  const existing = new Set((store.pending || []).map(row => `${row.accountId}|${row.destinationId}`));
  for (const group of readyDestinationRows(uid, accountId)) {
    const key = `${accountId}|${String(group.id)}`;
    if (existing.has(key)) continue;
    if (store.pending.length >= MAX_PENDING) break;
    store.pending.push({ accountId: String(accountId), destinationId: String(group.id), archived: false, muted: false, attempts: 0 });
    existing.add(key);
  }
  store.scanAccounts = (store.scanAccounts || []).filter(id => String(id) !== String(accountId));
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
async function processOne(uid) {
  const accounts = listAccounts(uid);
  if (!accounts.length) return false;
  const byId = new Map(accounts.map(account => [String(account.id), account]));
  const store = readStore(uid);
  for (const accountId of [...store.scanAccounts]) refillPending(uid, accountId, store);
  const now = Date.now();
  for (const [accountId, until] of Object.entries(store.cooldowns)) if (Number(until) <= now) delete store.cooldowns[accountId];
  writeStore(uid, store);

  const row = store.pending.find(item => Number(store.cooldowns[item.accountId] || 0) <= Date.now());
  if (!row) return false;
  const account = byId.get(String(row.accountId));
  if (!account) {
    store.pending = store.pending.filter(item => item !== row);
    writeStore(uid, store);
    return true;
  }
  const settings = readAppSettings(uid);
  const group = (settings.groups || []).find(item => String(item.id) === String(row.destinationId));
  if (!group) {
    store.pending = store.pending.filter(item => item !== row);
    writeStore(uid, store);
    return true;
  }

  let client;
  try {
    client = await openWorkerClient(uid, account);
    const peer = await resolveGroupPeer(client, group);
    if (!row.archived) {
      await rawInvoke(client, new Api.folders.EditPeerFolders({
        folderPeers: [new Api.InputFolderPeer({ peer, folderId: ARCHIVE_FOLDER_ID })],
      }));
      row.archived = true;
      writeStore(uid, store);
    }
    if (!row.muted) {
      await rawInvoke(client, new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer }),
        settings: new Api.InputPeerNotifySettings({ silent: true, muteUntil: MUTE_FOREVER_UNIX }),
      }));
      row.muted = true;
      writeStore(uid, store);
    }
    if (row.archived && row.muted) {
      store.pending = store.pending.filter(item => item !== row);
      writeStore(uid, store);
    }
  } catch (err) {
    row.attempts = Number(row.attempts || 0) + 1;
    const seconds = floodWaitSecondsFromTelegram(err);
    if (seconds) {
      store.cooldowns[row.accountId] = Date.now() + seconds * 1000 + 1000;
    } else if (row.attempts >= 5) {
      store.pending = store.pending.filter(item => item !== row);
    }
    writeStore(uid, store);
    if (seconds) console.log(`Archive/mute cooldown for sender ${row.accountId}: ${seconds}s`);
    else console.warn(`Archive/mute cleanup failed for ${uid}/${row.accountId}/${row.destinationId}: ${String(err?.message || err).slice(0, 160)}`);
  } finally {
    try { await client?.disconnect(); } catch {}
  }
  return true;
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
        try { await processOne(uid); } catch (err) { console.warn(`Archive/mute worker failed for ${uid}: ${String(err?.message || err).slice(0, 160)}`); }
      }
    } finally { busy = false; }
  };
  timer = setInterval(() => void tick(), WORKER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 3_000).unref?.();
  console.log("TelePilot archive/mute queue worker enabled");
  return timer;
}
