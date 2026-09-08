import fs from "node:fs";
import path from "node:path";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { listAccounts, loadAccountSession } from "./account-store.js";
import { saveReviewedDestinations } from "./destinations-v2.js";
import { enqueueCleanup, runDestinationPreparationTick } from "./destination-preparation-v1.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const STATE_VERSION = 1;

// One-by-one joining is only the fallback after Addlist bulk recovery could not
// finish the work. Keep it deliberately paced: Telegram FLOOD_WAIT always wins,
// and any account that already hit a flood wait uses the slower recovery gap.
const WORKER_INTERVAL_MS = 500;
const BASE_JOIN_GAP_MS = 5_000;
const RECOVERY_JOIN_GAP_MS = 12_000;
const INITIAL_JOIN_DELAY_MS = 200;
const MAX_JOINS_PER_SESSION = 1;
const REQUEST_PENDING_RETRY_MS = 24 * 60 * 60_000;
const MAX_ATTEMPTS = 6;
const DONE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_RECOVERY_PER_ACCOUNT = 200;

function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function statePath(uid) { return path.join(userDir(uid), "destination-join-v1.json"); }
function reviewStatePath(uid) { return path.join(userDir(uid), "destinations-v2.json"); }
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
function errorText(err) {
  return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 220);
}
function errorCode(err) { return errorText(err).toUpperCase(); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }

export function floodWaitSeconds(err) {
  for (const value of [err?.seconds, err?.value]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  const match = errorCode(err).match(/FLOOD_WAIT(?:_|\s|\(|:|-)*(\d+)/);
  return match ? Math.max(1, Number(match[1])) : 0;
}

function taskKey(accountId, destinationId) { return `${String(accountId)}:${String(destinationId)}`; }
function cleanCandidate(candidate) {
  return {
    id: String(candidate?.id || ""),
    label: String(candidate?.label || candidate?.username || candidate?.id || "Destination").slice(0, 120),
    username: String(candidate?.username || "").slice(0, 40),
    type: String(candidate?.type || "group").slice(0, 20),
    forum: candidate?.forum === true,
    accessHash: String(candidate?.accessHash || "").slice(0, 100),
    sourceKind: String(candidate?.sourceKind || "addlist").slice(0, 20),
    sourceSlug: String(candidate?.sourceSlug || "").slice(0, 160),
  };
}
function cleanTask(task) {
  if (!task?.accountId || !task?.candidate?.id) return null;
  const status = ["pending", "done", "failed", "request_pending"].includes(task?.status) ? task.status : "pending";
  return {
    accountId: String(task.accountId),
    candidate: cleanCandidate(task.candidate),
    status,
    attempts: Math.max(0, Number(task.attempts || 0) || 0),
    nextAt: Math.max(0, Number(task.nextAt || 0) || 0),
    lastError: String(task.lastError || "").slice(0, 220),
    createdAt: Number(task.createdAt || 0) || Date.now(),
    updatedAt: Number(task.updatedAt || 0) || Date.now(),
  };
}
function readState(uid) {
  const raw = readJson(statePath(uid), {});
  const now = Date.now();
  const tasks = {};
  for (const [key, value] of Object.entries(raw?.tasks || {})) {
    const task = cleanTask(value);
    if (!task) continue;
    if (task.status === "done" && now - task.updatedAt > DONE_RETENTION_MS) continue;
    tasks[key] = task;
  }
  const accountNextAt = {};
  for (const [accountId, value] of Object.entries(raw?.accountNextAt || {})) {
    const n = Math.max(0, Number(value || 0) || 0);
    if (n) accountNextAt[String(accountId)] = n;
  }
  return { version: STATE_VERSION, tasks, accountNextAt, updatedAt: Number(raw?.updatedAt || 0) || 0 };
}
function writeState(uid, state) {
  writeJsonAtomic(statePath(uid), {
    version: STATE_VERSION,
    tasks: state.tasks || {},
    accountNextAt: state.accountNextAt || {},
    updatedAt: Date.now(),
  });
}
function candidateNeedsJoin(candidate, accountId) {
  return candidate?.sourceKind === "addlist"
    && candidate?.accountJoin?.[String(accountId)]?.status === "not_member";
}

export function enqueueJoinRecovery(uid, review) {
  const accounts = listAccounts(uid);
  const state = readState(uid);
  let created = 0;
  let requeued = 0;
  let touched = false;
  const now = Date.now();

  for (const account of accounts) {
    const candidates = (review?.notJoined || [])
      .filter(candidate => candidateNeedsJoin(candidate, account.id))
      .slice(0, MAX_RECOVERY_PER_ACCOUNT);
    const coolingDown = Number(state.accountNextAt[String(account.id)] || 0) > now;

    for (const candidate of candidates) {
      const key = taskKey(account.id, candidate.id);
      const existing = cleanTask(state.tasks[key]);
      if (existing) {
        existing.candidate = { ...existing.candidate, ...cleanCandidate(candidate) };
        const requestExpired = existing.status === "request_pending" && now - existing.updatedAt >= REQUEST_PENDING_RETRY_MS;
        if (existing.status === "failed" || existing.status === "done" || requestExpired) {
          existing.status = "pending";
          existing.attempts = 0;
          existing.nextAt = now + INITIAL_JOIN_DELAY_MS;
          existing.lastError = coolingDown ? "Telegram asked to wait before fallback" : "";
          requeued++;
        }
        existing.updatedAt = now;
        state.tasks[key] = existing;
        touched = true;
        continue;
      }

      state.tasks[key] = {
        accountId: String(account.id),
        candidate: cleanCandidate(candidate),
        status: "pending",
        attempts: 0,
        nextAt: now + INITIAL_JOIN_DELAY_MS,
        lastError: coolingDown ? "Telegram asked to wait before fallback" : "",
        createdAt: now,
        updatedAt: now,
      };
      created++;
      touched = true;
    }
  }

  if (touched) writeState(uid, state);
  return { created, requeued, ...joinQueueSummary(uid) };
}

export function joinQueueSummary(uid) {
  const state = readState(uid);
  const now = Date.now();
  let total = 0, joined = 0, pending = 0, requestPending = 0, failed = 0;
  let nextAt = 0;
  for (const task of Object.values(state.tasks)) {
    total++;
    if (task.status === "done") joined++;
    else if (task.status === "pending") {
      pending++;
      const when = Math.max(task.nextAt || 0, state.accountNextAt[task.accountId] || 0);
      if (when > now && (!nextAt || when < nextAt)) nextAt = when;
    } else if (task.status === "request_pending") requestPending++;
    else if (task.status === "failed") failed++;
  }
  return { total, joined, pending, requestPending, failed, nextAt, waiting: pending + requestPending };
}

function inputChannelFromCandidate(candidate) {
  const id = String(candidate?.id || "");
  const accessHash = String(candidate?.accessHash || "");
  if (!/^-100\d+$/.test(id) || !/^\d+$/.test(accessHash)) return null;
  return new Api.InputChannel({
    channelId: bigInt(id.slice(4)),
    accessHash: bigInt(accessHash),
  });
}
async function openClient(uid, account) {
  if (!API_ID || !API_HASH) throw new Error("Telegram API credentials are not configured");
  const session = loadAccountSession(uid, account.id);
  if (!session) throw new Error("Saved Telegram session is missing");
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 0,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Saved Telegram session is no longer authorized");
  return client;
}
async function joinCandidate(client, candidate) {
  const username = String(candidate?.username || "").replace(/^@/, "");
  try {
    if (username) {
      await client.joinChannel(`@${username}`);
      return { status: "joined", method: "username" };
    }
    const channel = inputChannelFromCandidate(candidate);
    if (!channel) {
      return {
        status: "unsupported",
        reason: "Telegram did not provide enough access data to join this private Addlist chat directly.",
      };
    }
    await client.invoke(new Api.channels.JoinChannel({ channel }));
    return { status: "joined", method: "input_channel" };
  } catch (err) {
    const code = errorCode(err);
    if (code.includes("USER_ALREADY_PARTICIPANT")) return { status: "joined", method: username ? "username" : "input_channel" };
    if (code.includes("INVITE_REQUEST_SENT")) return { status: "request_pending", method: username ? "username" : "input_channel" };
    throw err;
  }
}
function readyCandidate(task) {
  return {
    ...task.candidate,
    accountJoin: {
      [String(task.accountId)]: {
        status: "ready",
        reason: "Telegram confirmed the account joined this destination.",
        checkedAt: Date.now(),
      },
    },
  };
}
function patchReviewReady(uid, task) {
  const file = reviewStatePath(uid);
  const state = readJson(file, null);
  const review = state?.review;
  if (!review || !Array.isArray(review.notJoined)) return;
  const id = String(task.candidate.id);
  const index = review.notJoined.findIndex(candidate => String(candidate?.id || "") === id);
  if (index < 0) return;

  const candidate = { ...review.notJoined[index] };
  candidate.accountJoin = {
    ...(candidate.accountJoin || {}),
    [String(task.accountId)]: {
      status: "ready",
      reason: "Telegram confirmed the account joined this destination.",
      checkedAt: Date.now(),
    },
  };
  const hasReady = Object.values(candidate.accountJoin).some(row => row?.status === "ready");
  if (!hasReady) return;

  review.notJoined = review.notJoined.filter((_, rowIndex) => rowIndex !== index);
  const accessible = Array.isArray(review.accessible) ? review.accessible.slice() : [];
  const existingIndex = accessible.findIndex(row => String(row?.id || "") === id);
  if (existingIndex >= 0) accessible[existingIndex] = candidate;
  else accessible.push(candidate);
  review.accessible = accessible;
  state.review = review;
  writeJsonAtomic(file, state);
}
function completeTask(uid, task) {
  const candidate = readyCandidate(task);
  const saved = saveReviewedDestinations(uid, { accessible: [candidate] });
  const cleanup = enqueueCleanup(uid, { accessible: [candidate] });
  patchReviewReady(uid, task);

  task.status = "done";
  task.nextAt = 0;
  task.lastError = "";
  task.updatedAt = Date.now();
  console.log(`TelePilot join queue confirmed ${uid}/${task.accountId}/${task.candidate.id}: saved=${saved.added || 0}, cleanup=${cleanup.created || 0}`);
}
function normalRetryDelay(attempts) {
  return Math.min(30 * 60_000, Math.max(15_000, 15_000 * (2 ** Math.min(5, attempts))));
}
export function applyFloodWait(state, accountId, waitSeconds, now = Date.now()) {
  const seconds = Math.max(1, Number(waitSeconds || 0));
  const until = now + (seconds * 1000) + 1000;
  state.accountNextAt[String(accountId)] = Math.max(Number(state.accountNextAt[String(accountId)] || 0), until);
  for (const task of Object.values(state.tasks || {})) {
    if (String(task.accountId) !== String(accountId) || task.status !== "pending") continue;
    task.nextAt = Math.max(Number(task.nextAt || 0), until);
    task.lastError = `Telegram asked to wait ${seconds}s`;
    task.updatedAt = now;
  }
  return until;
}
function failTask(task, err) {
  task.attempts = Math.max(0, Number(task.attempts || 0)) + 1;
  task.lastError = errorText(err);
  task.updatedAt = Date.now();
  if (task.attempts >= MAX_ATTEMPTS) {
    task.status = "failed";
    task.nextAt = 0;
  } else {
    task.status = "pending";
    task.nextAt = Date.now() + normalRetryDelay(task.attempts);
  }
}
export function pickDueTask(state, accountId, now = Date.now()) {
  const accountReadyAt = Number(state?.accountNextAt?.[String(accountId)] || 0);
  if (accountReadyAt > now) return null;
  return Object.values(state?.tasks || {})
    .filter(task => String(task.accountId) === String(accountId) && task.status === "pending" && Number(task.nextAt || 0) <= now)
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))[0] || null;
}
function hasPendingForAccount(state, accountId) {
  return Object.values(state?.tasks || {}).some(task => String(task.accountId) === String(accountId) && task.status === "pending");
}
function accountJoinGapMs(state, accountId) {
  const hadFloodWait = Object.values(state?.tasks || {}).some(task =>
    String(task?.accountId || "") === String(accountId)
      && task?.status === "pending"
      && /^Telegram asked to wait/i.test(String(task?.lastError || "")),
  );
  return hadFloodWait ? RECOVERY_JOIN_GAP_MS : BASE_JOIN_GAP_MS;
}

async function processAccount(uid, account, state) {
  const firstTask = pickDueTask(state, account.id);
  if (!firstTask) return;

  let client;
  let completedAny = false;
  try {
    client = await openClient(uid, account);
  } catch (err) {
    failTask(firstTask, err);
    writeState(uid, state);
    return;
  }

  try {
    for (let slot = 0; slot < MAX_JOINS_PER_SESSION; slot++) {
      const task = pickDueTask(state, account.id);
      if (!task) break;

      try {
        const outcome = await joinCandidate(client, task.candidate);
        if (outcome.status === "joined") {
          completeTask(uid, task);
          completedAny = true;
        } else if (outcome.status === "request_pending") {
          task.status = "request_pending";
          task.nextAt = 0;
          task.lastError = "Telegram sent a join request; approval is required.";
          task.updatedAt = Date.now();
        } else {
          task.status = "failed";
          task.nextAt = 0;
          task.lastError = outcome.reason || "This Addlist chat cannot be joined automatically.";
          task.updatedAt = Date.now();
        }
        state.accountNextAt[String(account.id)] = Date.now() + accountJoinGapMs(state, account.id);
      } catch (err) {
        const wait = floodWaitSeconds(err);
        if (wait) {
          const until = applyFloodWait(state, account.id, wait);
          console.warn(`TelePilot join queue flood wait for ${uid}/${account.id}: ${wait}s; resumeAt=${new Date(until).toISOString()}`);
          writeState(uid, state);
          break;
        }
        failTask(task, err);
        state.accountNextAt[String(account.id)] = Date.now() + accountJoinGapMs(state, account.id);
      }

      writeState(uid, state);
      if (!hasPendingForAccount(state, account.id) || slot >= MAX_JOINS_PER_SESSION - 1) break;

      const waitMs = Math.max(0, Number(state.accountNextAt[String(account.id)] || 0) - Date.now());
      if (waitMs > 0) await delay(waitMs);
    }
  } finally {
    try { await client?.disconnect(); } catch {}
    writeState(uid, state);
    if (completedAny) void runDestinationPreparationTick();
  }
}

let workerRunning = false;
export async function runDestinationJoinTick() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    let userIds = [];
    try {
      userIds = fs.readdirSync(USERS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return;
    }

    for (const uid of userIds) {
      if (!fs.existsSync(statePath(uid))) continue;
      const state = readState(uid);
      const pendingAccountIds = [...new Set(
        Object.values(state.tasks)
          .filter(task => task.status === "pending")
          .map(task => String(task.accountId)),
      )];
      if (!pendingAccountIds.length) continue;

      const accounts = listAccounts(uid);
      for (const accountId of pendingAccountIds.slice(0, 1)) {
        const account = accounts.find(row => String(row.id) === accountId);
        if (!account) {
          const task = pickDueTask(state, accountId);
          if (task) failTask(task, new Error("Connected account no longer exists"));
          writeState(uid, state);
          continue;
        }
        await processAccount(uid, account, state);
      }
    }
  } finally {
    workerRunning = false;
  }
}

let workerTimer = null;
export function startDestinationJoinWorker() {
  if (workerTimer) return workerTimer;
  workerTimer = setInterval(() => void runDestinationJoinTick(), WORKER_INTERVAL_MS);
  workerTimer.unref?.();
  setTimeout(() => void runDestinationJoinTick(), 250).unref?.();
  console.log("TelePilot destination join queue enabled (durable, flood-aware, paced fallback)");
  return workerTimer;
}

export const __test = {
  candidateNeedsJoin,
  inputChannelFromCandidate,
  cleanCandidate,
  accountJoinGapMs,
};