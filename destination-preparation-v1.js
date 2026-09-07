import fs from "node:fs";
import path from "node:path";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import {
  accountDisplayLabel,
  effectiveAccountIds,
  listAccounts,
  loadAccountSession,
  updateAccountStatus,
} from "./account-store.js";
import { readAppSettings } from "./posting-engine-enhancements.js";
import {
  parseDestinationInput,
  saveReviewedDestinations,
  scanDestinationSources,
} from "./destinations-v2.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const STATE_VERSION = 1;
const ARCHIVE_FOLDER_ID = 1;
const MUTE_FOREVER_UNIX = 2147483647;
const WORKER_INTERVAL_MS = 4_000;
const MUTES_PER_ACCOUNT_TICK = 3;
const ARCHIVE_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 6;
const DONE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_SOURCE_TEXT = 20_000;

function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function prepPath(uid) { return path.join(userDir(uid), "destination-preparation-v1.json"); }
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
export function floodWaitSeconds(err) {
  for (const value of [err?.seconds, err?.value]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  const match = errorCode(err).match(/FLOOD_WAIT(?:_|\s|\(|:|-)*(\d+)/);
  return match ? Math.max(1, Number(match[1])) : 0;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function digits(value) { return String(value?.toString?.() ?? value ?? "").replace(/\D/g, ""); }
function peerKey(peer) { return digits(peer?.channelId ?? peer?.chatId ?? peer?.userId ?? peer?.id ?? peer); }
function entityKey(entity) { return digits(entity?.id); }
function sourceIdentity(parsed) {
  if (parsed?.kind === "public") return `public:${String(parsed.username || "").toLowerCase()}`;
  if (parsed?.kind === "invite") return `invite:${String(parsed.hash || "")}`;
  if (parsed?.kind === "addlist") return `addlist:${String(parsed.slug || "")}`;
  return "";
}

function selectedAccounts(uid) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const selected = new Set(effectiveAccountIds(settings, null, accounts).map(String));
  const preferred = accounts.filter(account => selected.has(String(account.id)));
  return preferred.length ? preferred : accounts;
}
async function openAccountClient(uid, account) {
  const session = loadAccountSession(uid, account.id);
  if (!session) throw new Error("Saved Telegram session is missing");
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 0,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Saved Telegram session is no longer authorized");
  try {
    const me = await client.getMe();
    updateAccountStatus(uid, account.id, {
      telegramId: me?.id,
      username: me?.username,
      firstName: me?.firstName,
      lastName: me?.lastName,
      status: "connected",
      lastError: "",
      lastVerifiedAt: Date.now(),
    });
  } catch {}
  return client;
}

function isForbiddenChat(chat) {
  return /Forbidden$/i.test(String(chat?.className || ""));
}
function inputPeerFromChat(chat) {
  if (!chat || isForbiddenChat(chat)) return null;
  const className = String(chat.className || "");
  const id = chat.id;
  if (className === "Chat") return new Api.InputPeerChat({ chatId: id });
  if (className === "Channel" || chat.megagroup === true || chat.broadcast === true || chat.forum === true) {
    if (chat.accessHash === undefined || chat.accessHash === null) return null;
    return new Api.InputPeerChannel({ channelId: id, accessHash: chat.accessHash });
  }
  return null;
}
function findChatForPeer(chats, peer) {
  const wanted = peerKey(peer);
  if (!wanted) return null;
  return (Array.isArray(chats) ? chats : []).find(chat => entityKey(chat) === wanted) || null;
}
export function buildAddlistInputs(chats, peers) {
  const out = [];
  const seen = new Set();
  for (const peer of Array.isArray(peers) ? peers : []) {
    const key = peerKey(peer);
    if (!key || seen.has(key)) continue;
    const chat = findChatForPeer(chats, peer);
    let input = inputPeerFromChat(chat);
    if (!input && peer?.chatId !== undefined && peer?.chatId !== null) {
      input = new Api.InputPeerChat({ chatId: peer.chatId });
    }
    if (!input) continue;
    seen.add(key);
    out.push(input);
  }
  return out;
}
function inputPeerFromCandidate(candidate) {
  const id = String(candidate?.id || "");
  if (/^-100\d+$/.test(id)) {
    if (!candidate?.accessHash) return null;
    return new Api.InputPeerChannel({
      channelId: bigInt(id.slice(4)),
      accessHash: bigInt(String(candidate.accessHash)),
    });
  }
  if (/^-\d+$/.test(id)) return new Api.InputPeerChat({ chatId: bigInt(id.slice(1)) });
  return null;
}
async function inputPeerForTask(client, peer) {
  const direct = inputPeerFromCandidate(peer);
  if (direct) return direct;
  const username = String(peer?.username || "").replace(/^@/, "");
  if (username) return client.getInputEntity(`@${username}`);
  throw new Error("Could not reconstruct Telegram peer");
}

async function joinPublic(client, parsed) {
  const target = `@${parsed.username}`;
  let entity = await client.getEntity(target);
  try {
    await client.getParticipant(entity, "me");
    return { status: "already", count: 0 };
  } catch (err) {
    if (!errorCode(err).includes("USER_NOT_PARTICIPANT")) throw err;
  }
  try {
    await client.joinChannel(target);
  } catch (err) {
    const code = errorCode(err);
    if (code.includes("INVITE_REQUEST_SENT")) return { status: "pending", count: 0 };
    if (!code.includes("USER_ALREADY_PARTICIPANT")) throw err;
  }
  entity = await client.getEntity(target);
  try {
    await client.getParticipant(entity, "me");
    return { status: "joined", count: 1 };
  } catch {
    return { status: "pending", count: 0 };
  }
}
async function joinPrivate(client, parsed) {
  try {
    const checked = await client.checkChatInvite(parsed.hash);
    if (checked?.chat) return { status: "already", count: 0 };
  } catch {}
  try {
    const updates = await client.importChatInvite(parsed.hash);
    const chats = Array.isArray(updates?.chats) ? updates.chats : [];
    if (chats.length) return { status: "joined", count: chats.length };
  } catch (err) {
    const code = errorCode(err);
    if (code.includes("INVITE_REQUEST_SENT")) return { status: "pending", count: 0 };
    if (!code.includes("USER_ALREADY_PARTICIPANT")) throw err;
  }
  try {
    const checked = await client.checkChatInvite(parsed.hash);
    if (checked?.chat) return { status: "joined", count: 1 };
  } catch {}
  return { status: "pending", count: 0 };
}
async function joinAddlist(client, parsed) {
  const invite = await client.api.chatlists.checkChatlistInvite({ slug: parsed.slug });
  const className = String(invite?.className || "");
  const alreadyImported = className === "ChatlistInviteAlready" || Number.isInteger(Number(invite?.filterId));
  if (!alreadyImported) {
    const peers = Array.isArray(invite?.peers) ? invite.peers : [];
    const inputs = buildAddlistInputs(invite?.chats, peers);
    if (peers.length && !inputs.length) throw new Error("Telegram returned shared-folder peers without usable access data");
    if (!inputs.length) return { status: "already", count: 0 };
    try {
      await client.api.chatlists.joinChatlistInvite({ slug: parsed.slug, peers: inputs });
      return { status: "joined", count: inputs.length };
    } catch (err) {
      if (errorCode(err).includes("FILTER_INCLUDE_EMPTY")) return { status: "already", count: 0 };
      throw err;
    }
  }

  const filterId = Number(invite?.filterId);
  const hintedMissing = Array.isArray(invite?.missingPeers) ? invite.missingPeers : [];
  if (!Number.isInteger(filterId) || filterId <= 0 || !hintedMissing.length) return { status: "already", count: 0 };
  const chatlist = new Api.InputChatlistDialogFilter({ filterId });
  const updates = await client.api.chatlists.getChatlistUpdates({ chatlist });
  const missingPeers = Array.isArray(updates?.missingPeers) ? updates.missingPeers : [];
  const inputs = buildAddlistInputs(updates?.chats, missingPeers);
  if (missingPeers.length && !inputs.length) throw new Error("Telegram reported new shared-folder chats without usable access data");
  if (!inputs.length) return { status: "already", count: 0 };
  try {
    await client.api.chatlists.joinChatlistUpdates({ chatlist, peers: inputs });
    return { status: "joined", count: inputs.length };
  } catch (err) {
    if (errorCode(err).includes("FILTER_INCLUDE_EMPTY")) return { status: "already", count: 0 };
    throw err;
  }
}
async function joinSource(client, parsed) {
  if (parsed.kind === "public") return joinPublic(client, parsed);
  if (parsed.kind === "invite") return joinPrivate(client, parsed);
  if (parsed.kind === "addlist") return joinAddlist(client, parsed);
  throw new Error("Unsupported destination source");
}

function cleanPeer(candidate) {
  return {
    id: String(candidate?.id || ""),
    label: String(candidate?.label || candidate?.username || candidate?.id || "Destination").slice(0, 120),
    username: String(candidate?.username || "").slice(0, 40),
    type: String(candidate?.type || "group").slice(0, 20),
    accessHash: String(candidate?.accessHash || "").slice(0, 80),
  };
}
function taskKey(accountId, destinationId) { return `${String(accountId)}:${String(destinationId)}`; }
function newStep() { return { status: "pending", attempts: 0, nextAt: 0, lastError: "" }; }
function cleanStep(step) {
  const status = ["pending", "done", "failed"].includes(step?.status) ? step.status : "pending";
  return {
    status,
    attempts: Math.max(0, Number(step?.attempts || 0) || 0),
    nextAt: Math.max(0, Number(step?.nextAt || 0) || 0),
    lastError: String(step?.lastError || "").slice(0, 220),
  };
}
function cleanTask(task) {
  if (!task?.accountId || !task?.peer?.id) return null;
  return {
    accountId: String(task.accountId),
    peer: cleanPeer(task.peer),
    mute: cleanStep(task.mute),
    archive: cleanStep(task.archive),
    createdAt: Number(task.createdAt || 0) || Date.now(),
    updatedAt: Number(task.updatedAt || 0) || Date.now(),
  };
}
function readPrepState(uid) {
  const raw = readJson(prepPath(uid), {});
  const now = Date.now();
  const tasks = {};
  for (const [key, rawTask] of Object.entries(raw?.tasks || {})) {
    const task = cleanTask(rawTask);
    if (!task) continue;
    const done = task.mute.status === "done" && task.archive.status === "done";
    if (done && now - task.updatedAt > DONE_RETENTION_MS) continue;
    tasks[key] = task;
  }
  return { version: STATE_VERSION, tasks, updatedAt: Number(raw?.updatedAt || 0) || 0 };
}
function writePrepState(uid, state) {
  writeJsonAtomic(prepPath(uid), { version: STATE_VERSION, tasks: state.tasks || {}, updatedAt: Date.now() });
}
export function enqueueCleanup(uid, review) {
  const state = readPrepState(uid);
  let created = 0;
  let pending = 0;
  for (const candidate of review?.accessible || []) {
    for (const [accountId, row] of Object.entries(candidate?.accountJoin || {})) {
      if (row?.status !== "ready") continue;
      const key = taskKey(accountId, candidate.id);
      const existing = cleanTask(state.tasks[key]);
      if (existing) {
        existing.peer = { ...existing.peer, ...cleanPeer(candidate) };
        existing.updatedAt = Date.now();
        state.tasks[key] = existing;
        if (existing.mute.status !== "done" || existing.archive.status !== "done") pending++;
        continue;
      }
      state.tasks[key] = {
        accountId: String(accountId),
        peer: cleanPeer(candidate),
        mute: newStep(),
        archive: newStep(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      created++;
      pending++;
    }
  }
  if (created || pending) writePrepState(uid, state);
  return { created, pending };
}
export function cleanupSummary(uid) {
  const state = readPrepState(uid);
  let total = 0, muted = 0, archived = 0, complete = 0, failed = 0, waiting = 0;
  let nextAt = 0;
  for (const task of Object.values(state.tasks)) {
    total++;
    if (task.mute.status === "done") muted++;
    if (task.archive.status === "done") archived++;
    if (task.mute.status === "done" && task.archive.status === "done") complete++;
    if (task.mute.status === "failed" || task.archive.status === "failed") failed++;
    if (task.mute.status === "pending" || task.archive.status === "pending") waiting++;
    for (const step of [task.mute, task.archive]) {
      if (step.status === "pending" && step.nextAt > Date.now() && (!nextAt || step.nextAt < nextAt)) nextAt = step.nextAt;
    }
  }
  return { total, muted, archived, complete, failed, waiting, nextAt };
}
function retryDelay(attempts) { return Math.min(30 * 60_000, Math.max(15_000, 15_000 * (2 ** Math.min(6, attempts)))); }
function failStep(step, err) {
  const flood = floodWaitSeconds(err);
  if (flood) {
    step.status = "pending";
    step.nextAt = Date.now() + (flood * 1000) + 1000;
    step.lastError = `Telegram asked to wait ${flood}s`;
    return;
  }
  step.attempts = Math.max(0, Number(step.attempts || 0)) + 1;
  step.lastError = errorText(err);
  if (step.attempts >= MAX_ATTEMPTS) {
    step.status = "failed";
    step.nextAt = 0;
  } else {
    step.status = "pending";
    step.nextAt = Date.now() + retryDelay(step.attempts);
  }
}
async function muteTask(client, task) {
  const peer = await inputPeerForTask(client, task.peer);
  await client.invoke(new Api.account.UpdateNotifySettings({
    peer: new Api.InputNotifyPeer({ peer }),
    settings: new Api.InputPeerNotifySettings({ silent: true, muteUntil: MUTE_FOREVER_UNIX }),
  }));
}
async function archiveTasks(client, tasks) {
  const folderPeers = [];
  const used = [];
  for (const task of tasks) {
    try {
      const peer = await inputPeerForTask(client, task.peer);
      folderPeers.push(new Api.InputFolderPeer({ peer, folderId: ARCHIVE_FOLDER_ID }));
      used.push(task);
    } catch (err) {
      failStep(task.archive, err);
    }
  }
  if (!folderPeers.length) return { used: [], error: null };
  try {
    await client.invoke(new Api.folders.EditPeerFolders({ folderPeers }));
    return { used, error: null };
  } catch (err) {
    return { used, error: err };
  }
}
async function processAccountCleanup(uid, account, state, tasks) {
  let client;
  try {
    client = await openAccountClient(uid, account);
  } catch (err) {
    const now = Date.now();
    for (const task of tasks) {
      if (task.mute.status === "pending" && task.mute.nextAt <= now) failStep(task.mute, err);
      else if (task.mute.status === "done" && task.archive.status === "pending" && task.archive.nextAt <= now) failStep(task.archive, err);
      task.updatedAt = Date.now();
    }
    writePrepState(uid, state);
    throw err;
  }

  try {
    const now = Date.now();
    const muteDue = tasks.filter(task => task.mute.status === "pending" && task.mute.nextAt <= now).slice(0, MUTES_PER_ACCOUNT_TICK);
    for (let index = 0; index < muteDue.length; index++) {
      const task = muteDue[index];
      try {
        await muteTask(client, task);
        task.mute = { status: "done", attempts: task.mute.attempts, nextAt: 0, lastError: "" };
      } catch (err) {
        failStep(task.mute, err);
        if (floodWaitSeconds(err)) {
          const until = task.mute.nextAt;
          for (const other of tasks) if (other.mute.status === "pending") other.mute.nextAt = Math.max(other.mute.nextAt, until);
          break;
        }
      }
      task.updatedAt = Date.now();
      if (index < muteDue.length - 1) await delay(650);
    }

    const archiveReady = tasks
      .filter(task => task.mute.status === "done" && task.archive.status === "pending" && task.archive.nextAt <= Date.now());
    const muteOutstanding = tasks.some(task => task.mute.status === "pending");
    const shouldArchive = archiveReady.length > 0 && (!muteOutstanding || archiveReady.length >= ARCHIVE_BATCH_SIZE);
    if (shouldArchive) {
      const archiveDue = archiveReady.slice(0, ARCHIVE_BATCH_SIZE);
      const result = await archiveTasks(client, archiveDue);
      if (!result.error) {
        for (const task of result.used) {
          task.archive = { status: "done", attempts: task.archive.attempts, nextAt: 0, lastError: "" };
          task.updatedAt = Date.now();
        }
      } else {
        const flood = floodWaitSeconds(result.error);
        for (const task of result.used) {
          failStep(task.archive, result.error);
          task.updatedAt = Date.now();
        }
        if (flood) {
          const until = Date.now() + (flood * 1000) + 1000;
          for (const task of tasks) if (task.archive.status === "pending") task.archive.nextAt = Math.max(task.archive.nextAt, until);
        }
      }
    }
  } finally {
    try { await client?.disconnect(); } catch {}
    writePrepState(uid, state);
  }
}
let workerRunning = false;
export async function runDestinationPreparationTick() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    let userIds = [];
    try { userIds = fs.readdirSync(USERS_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
    catch { return; }
    for (const uid of userIds) {
      if (!fs.existsSync(prepPath(uid))) continue;
      const state = readPrepState(uid);
      const allTasks = Object.values(state.tasks);
      const due = allTasks.filter(task => {
        const now = Date.now();
        return (task.mute.status === "pending" && task.mute.nextAt <= now)
          || (task.mute.status === "done" && task.archive.status === "pending" && task.archive.nextAt <= now);
      });
      if (!due.length) continue;
      const accounts = listAccounts(uid);
      const accountIds = [...new Set(due.map(task => task.accountId))];
      for (const accountId of accountIds.slice(0, 1)) {
        const account = accounts.find(row => String(row.id) === String(accountId));
        const accountTasks = allTasks.filter(task => String(task.accountId) === String(accountId));
        if (!account) {
          for (const task of accountTasks) {
            if (task.mute.status === "pending" && task.mute.nextAt <= Date.now()) failStep(task.mute, new Error("Connected account no longer exists"));
            else if (task.mute.status === "done" && task.archive.status === "pending" && task.archive.nextAt <= Date.now()) failStep(task.archive, new Error("Connected account no longer exists"));
            task.updatedAt = Date.now();
          }
          writePrepState(uid, state);
          continue;
        }
        try { await processAccountCleanup(uid, account, state, accountTasks); }
        catch (err) {
          console.warn(`TelePilot destination cleanup failed for ${uid}/${accountId}: ${errorText(err)}`);
        }
      }
    }
  } finally { workerRunning = false; }
}
let workerTimer = null;
export function startDestinationPreparationWorker() {
  if (workerTimer) return workerTimer;
  workerTimer = setInterval(() => void runDestinationPreparationTick(), WORKER_INTERVAL_MS);
  workerTimer.unref?.();
  setTimeout(() => void runDestinationPreparationTick(), 1_000).unref?.();
  console.log("TelePilot destination preparation worker enabled (explicit jobs only; paced mute + batched archive)");
  return workerTimer;
}

export async function prepareReviewedSources(uid, review) {
  if (!API_ID || !API_HASH) throw new Error("Telegram API credentials are not configured");
  const sourceText = String(review?.sourceText || "").slice(0, MAX_SOURCE_TEXT).trim();
  if (!sourceText) throw new Error("This review has no source data. Scan the destinations again.");
  const parsed = sourceText.split(/\r?\n/).map(line => parseDestinationInput(line.trim())).filter(Boolean);
  if (!parsed.length) throw new Error("No supported Telegram sources were found");
  const accounts = selectedAccounts(uid);
  if (!accounts.length) throw new Error("Connect a personal Telegram account first");

  const beforeIds = new Set((review?.accessible || []).map(item => String(item.id)));
  const failures = [];
  const pending = [];
  let attempted = 0;
  let accepted = 0;

  for (const account of accounts) {
    let client;
    try {
      client = await openAccountClient(uid, account);
      for (const source of parsed) {
        attempted++;
        try {
          const result = await joinSource(client, source);
          accepted += Number(result?.count || 0);
          if (result?.status === "pending") pending.push(`${accountDisplayLabel(account)} · ${sourceIdentity(source)}`);
        } catch (err) {
          failures.push(`${accountDisplayLabel(account)} · ${sourceIdentity(source)} · ${errorText(err)}`);
        }
      }
    } catch (err) {
      failures.push(`${accountDisplayLabel(account)} · ${errorText(err)}`);
    } finally {
      try { await client?.disconnect(); } catch {}
    }
  }

  await delay(700);
  const postReview = await scanDestinationSources(uid, sourceText);
  postReview.sourceText = sourceText;
  const saved = saveReviewedDestinations(uid, postReview);
  const cleanup = enqueueCleanup(uid, postReview);
  const newlyAccessible = (postReview.accessible || []).filter(item => !beforeIds.has(String(item.id))).length;
  void runDestinationPreparationTick();

  return {
    postReview,
    saved,
    cleanup,
    attempted,
    accepted,
    newlyAccessible,
    pending,
    failures,
  };
}

export const __test = {
  inputPeerFromChat,
  inputPeerFromCandidate,
  findChatForPeer,
  sourceIdentity,
};
