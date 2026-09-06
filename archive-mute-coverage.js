import fs from "node:fs";
import path from "node:path";
import { listAccounts } from "./account-store.js";
import { listUserIds, readAppSettings } from "./posting-engine-enhancements.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const WORKER_INTERVAL_MS = 15_000;
const MAX_PENDING = 5000;
const JOINED_STATUSES = new Set(["ready", "verification", "read_only"]);

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function queuePath(uid) { return path.join(userDir(uid), "archive-mute-queue.json"); }
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
function normalizeStore(raw) {
  return {
    version: 2,
    scanAccounts: [...new Set((Array.isArray(raw?.scanAccounts) ? raw.scanAccounts : []).map(String).filter(Boolean))],
    pending: (Array.isArray(raw?.pending) ? raw.pending : []).filter(row => row?.accountId && row?.destinationId).slice(-MAX_PENDING),
    archiveCooldowns: raw?.archiveCooldowns && typeof raw.archiveCooldowns === "object" && !Array.isArray(raw.archiveCooldowns) ? raw.archiveCooldowns : {},
    muteCooldowns: raw?.muteCooldowns && typeof raw.muteCooldowns === "object" && !Array.isArray(raw.muteCooldowns) ? raw.muteCooldowns : {},
    lastFullScanAt: Math.max(0, Number(raw?.lastFullScanAt || 0) || 0),
  };
}
function pendingRow(accountId, destinationId) {
  return {
    accountId: String(accountId),
    destinationId: String(destinationId),
    archived: false,
    muted: false,
    archiveAttempts: 0,
    muteAttempts: 0,
    nextArchiveAt: 0,
    nextMuteAt: 0,
    lastError: "",
  };
}

export function ensureJoinedCleanupCoverage(uid) {
  const id = String(uid || "");
  if (!id) return 0;
  const accounts = listAccounts(id);
  const validAccounts = new Set(accounts.map(account => String(account.id)));
  if (!validAccounts.size) return 0;

  const settings = readAppSettings(id);
  const file = queuePath(id);
  const store = normalizeStore(readJson(file, {}));
  const existing = new Set(store.pending.map(row => `${String(row.accountId)}|${String(row.destinationId)}`));
  let added = 0;

  for (const group of settings.groups || []) {
    const destinationId = String(group?.id || "");
    if (!destinationId) continue;
    const joins = group?.accountJoin && typeof group.accountJoin === "object" ? group.accountJoin : {};
    for (const [accountId, row] of Object.entries(joins)) {
      if (!validAccounts.has(String(accountId))) continue;
      if (!JOINED_STATUSES.has(String(row?.status || ""))) continue;
      const key = `${String(accountId)}|${destinationId}`;
      if (existing.has(key) || store.pending.length >= MAX_PENDING) continue;
      store.pending.push(pendingRow(accountId, destinationId));
      existing.add(key);
      if (!store.scanAccounts.includes(String(accountId))) store.scanAccounts.push(String(accountId));
      added++;
    }
  }

  if (added) writeJsonAtomic(file, store);
  return added;
}

let timer = null;
let busy = false;
export function startArchiveMuteCoverageWorker() {
  if (timer) return timer;
  const tick = () => {
    if (busy) return;
    busy = true;
    try {
      for (const uid of listUserIds()) {
        try { ensureJoinedCleanupCoverage(uid); }
        catch (err) { console.warn(`Archive/mute coverage failed for ${uid}: ${String(err?.message || err).slice(0, 160)}`); }
      }
    } finally { busy = false; }
  };
  timer = setInterval(tick, WORKER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 4_500).unref?.();
  console.log("TelePilot archive/mute coverage worker enabled for all confirmed joined chats");
  return timer;
}
