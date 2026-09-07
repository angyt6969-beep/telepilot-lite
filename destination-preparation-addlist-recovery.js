import fs from "node:fs";
import path from "node:path";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { listAccounts, loadAccountSession } from "./account-store.js";
import {
  scanDestinationSources,
  saveReviewedDestinations,
} from "./destinations-v2.js";
import {
  enqueueCleanup,
  runDestinationPreparationTick,
} from "./destination-preparation-v1.js";
import {
  enqueueJoinRecovery,
  joinQueueSummary,
} from "./destination-join-queue-v1.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const BULK_SETTLE_MS = 900;
const FALLBACK_PAUSE_MS = 30_000;

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function queuePath(uid) { return path.join(userDir(uid), "destination-join-v1.json"); }
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
function floodWaitSeconds(err) {
  for (const value of [err?.seconds, err?.value]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  const match = errorCode(err).match(/FLOOD_WAIT(?:_|\s|\(|:|-)*(\d+)/);
  return match ? Math.max(1, Number(match[1])) : 0;
}
function idText(value) {
  try { return String(value?.toString?.() ?? value ?? ""); }
  catch { return String(value || ""); }
}
function candidatePeerKey(candidate) {
  const id = String(candidate?.id || "");
  if (/^-100\d+$/.test(id)) return `channel:${id.slice(4)}`;
  if (/^-\d+$/.test(id)) return `chat:${id.slice(1)}`;
  return "";
}
function peerKey(peer) {
  if (peer?.channelId !== undefined && peer?.channelId !== null) return `channel:${idText(peer.channelId).replace(/\D/g, "")}`;
  if (peer?.chatId !== undefined && peer?.chatId !== null) return `chat:${idText(peer.chatId).replace(/\D/g, "")}`;
  return "";
}
function entityKey(chat) {
  const raw = idText(chat?.id).replace(/\D/g, "");
  if (!raw) return "";
  const className = String(chat?.className || "");
  if (className === "Chat") return `chat:${raw}`;
  if (className === "Channel" || chat?.megagroup === true || chat?.broadcast === true || chat?.forum === true) return `channel:${raw}`;
  return "";
}
function inputPeerFromChat(chat) {
  if (!chat || /Forbidden$/i.test(String(chat?.className || ""))) return null;
  const className = String(chat.className || "");
  if (className === "Chat") return new Api.InputPeerChat({ chatId: chat.id });
  if (className === "Channel" || chat.megagroup === true || chat.broadcast === true || chat.forum === true) {
    if (chat.accessHash === undefined || chat.accessHash === null) return null;
    return new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash });
  }
  return null;
}
export function buildBulkInputs(chats, peers, candidates) {
  const wanted = new Set((Array.isArray(candidates) ? candidates : []).map(candidatePeerKey).filter(Boolean));
  const chatMap = new Map();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const key = entityKey(chat);
    if (key) chatMap.set(key, chat);
  }

  const out = [];
  const seen = new Set();
  for (const peer of Array.isArray(peers) ? peers : []) {
    const key = peerKey(peer);
    if (!key || !wanted.has(key) || seen.has(key)) continue;
    const chat = chatMap.get(key);
    let input = inputPeerFromChat(chat);
    if (!input && key.startsWith("chat:") && peer?.chatId !== undefined && peer?.chatId !== null) {
      input = new Api.InputPeerChat({ chatId: peer.chatId });
    }
    if (!input) continue;
    seen.add(key);
    out.push(input);
  }
  return out;
}

export function buildRecoveryPlan(review, accounts) {
  const rows = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const candidates = (review?.notJoined || [])
      .filter(candidate => candidate?.sourceKind === "addlist"
        && candidate?.sourceSlug
        && candidate?.accountJoin?.[String(account.id)]?.status === "not_member")
      .slice(0, 200);
    if (candidates.length) rows.push({ accountId: String(account.id), candidates });
  }
  return rows;
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

async function bulkJoinSlug(client, slug, candidates) {
  const invite = await client.api.chatlists.checkChatlistInvite({ slug });
  const className = String(invite?.className || "");
  const filterId = Number(invite?.filterId);
  const alreadyImported = className === "ChatlistInviteAlready"
    || (Number.isInteger(filterId) && filterId > 0);

  if (!alreadyImported) {
    const peers = Array.isArray(invite?.peers) ? invite.peers : [];
    const inputs = buildBulkInputs(invite?.chats, peers, candidates);
    if (!inputs.length) return { mode: "fresh", accepted: 0, offered: peers.length };
    await client.api.chatlists.joinChatlistInvite({ slug, peers: inputs });
    return { mode: "fresh", accepted: inputs.length, offered: peers.length };
  }

  if (!Number.isInteger(filterId) || filterId <= 0) {
    return { mode: "updates", accepted: 0, offered: 0 };
  }

  const chatlist = new Api.InputChatlistDialogFilter({ filterId });
  const updates = await client.api.chatlists.getChatlistUpdates({ chatlist });
  const missingPeers = Array.isArray(updates?.missingPeers) ? updates.missingPeers : [];
  const inputs = buildBulkInputs(updates?.chats, missingPeers, candidates);
  if (!inputs.length) return { mode: "updates", accepted: 0, offered: missingPeers.length };
  await client.api.chatlists.joinChatlistUpdates({ chatlist, peers: inputs });
  return { mode: "updates", accepted: inputs.length, offered: missingPeers.length };
}

function pauseFallbackQueue(uid, accountIds, now = Date.now()) {
  const file = queuePath(uid);
  const state = readJson(file, null);
  if (!state || typeof state !== "object") return {};
  state.accountNextAt = state.accountNextAt && typeof state.accountNextAt === "object" ? state.accountNextAt : {};
  const previous = {};
  const until = now + FALLBACK_PAUSE_MS;
  for (const accountId of accountIds) {
    const id = String(accountId);
    previous[id] = Math.max(0, Number(state.accountNextAt[id] || 0) || 0);
    state.accountNextAt[id] = Math.max(previous[id], until);
  }
  writeJsonAtomic(file, state);
  return previous;
}

export function reconcileFallbackState(state, review, previousCooldowns = {}, bulkCooldowns = {}, now = Date.now()) {
  if (!state || typeof state !== "object") return { changed: 0, state };
  state.tasks = state.tasks && typeof state.tasks === "object" ? state.tasks : {};
  state.accountNextAt = state.accountNextAt && typeof state.accountNextAt === "object" ? state.accountNextAt : {};

  const ready = new Set();
  for (const candidate of Array.isArray(review?.accessible) ? review.accessible : []) {
    const destinationId = String(candidate?.id || "");
    if (!destinationId) continue;
    for (const [accountId, row] of Object.entries(candidate?.accountJoin || {})) {
      if (row?.status === "ready") ready.add(`${String(accountId)}:${destinationId}`);
    }
  }

  let changed = 0;
  for (const task of Object.values(state.tasks)) {
    const key = `${String(task?.accountId || "")}:${String(task?.candidate?.id || "")}`;
    if (!ready.has(key) || task?.status === "done") continue;
    task.status = "done";
    task.nextAt = 0;
    task.lastError = "";
    task.updatedAt = now;
    changed++;
  }

  const accountIds = new Set([
    ...Object.keys(previousCooldowns || {}),
    ...Object.keys(bulkCooldowns || {}),
    ...Object.values(state.tasks).map(task => String(task?.accountId || "")).filter(Boolean),
  ]);
  for (const accountId of accountIds) {
    const stillPending = Object.values(state.tasks).some(task => String(task?.accountId || "") === accountId && task?.status === "pending");
    if (!stillPending) {
      delete state.accountNextAt[accountId];
      continue;
    }
    const previous = Math.max(0, Number(previousCooldowns?.[accountId] || 0) || 0);
    const bulk = Math.max(0, Number(bulkCooldowns?.[accountId] || 0) || 0);
    const keepUntil = Math.max(previous, bulk);
    if (keepUntil > now) state.accountNextAt[accountId] = keepUntil;
    else delete state.accountNextAt[accountId];
  }

  return { changed, state };
}

function reconcileFallbackQueue(uid, review, previousCooldowns, bulkCooldowns) {
  const file = queuePath(uid);
  const state = readJson(file, null);
  if (!state || typeof state !== "object") return 0;
  const result = reconcileFallbackState(state, review, previousCooldowns, bulkCooldowns);
  writeJsonAtomic(file, result.state);
  return result.changed;
}

export async function recoverNotJoinedAddlistPeers(uid, initialResult) {
  const postReview = initialResult?.postReview;
  const hasAddlistWork = (postReview?.notJoined || []).some(candidate => candidate?.sourceKind === "addlist");
  if (!hasAddlistWork) {
    return {
      ...initialResult,
      recovery: { bulkAccepted: 0, queued: 0, requeued: 0, summary: joinQueueSummary(uid) },
    };
  }

  const accounts = listAccounts(uid);
  const plan = buildRecoveryPlan(postReview, accounts);
  const previousCooldowns = pauseFallbackQueue(uid, plan.map(row => row.accountId));
  const bulkCooldowns = {};
  const bulkFailures = [];
  let bulkAccepted = 0;
  let bulkRequests = 0;

  for (const row of plan) {
    const account = accounts.find(item => String(item.id) === String(row.accountId));
    if (!account) {
      bulkFailures.push(`${row.accountId} · Connected account no longer exists`);
      continue;
    }

    const bySlug = new Map();
    for (const candidate of row.candidates) {
      const slug = String(candidate?.sourceSlug || "");
      if (!slug) continue;
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(candidate);
    }

    let client;
    try {
      client = await openClient(uid, account);
      for (const [slug, candidates] of bySlug) {
        bulkRequests++;
        try {
          const result = await bulkJoinSlug(client, slug, candidates);
          bulkAccepted += Number(result.accepted || 0);
          console.log(`TelePilot Addlist bulk join ${uid}/${row.accountId}/${slug}: mode=${result.mode}, offered=${result.offered}, accepted=${result.accepted}`);
        } catch (err) {
          const wait = floodWaitSeconds(err);
          if (wait) {
            const until = Date.now() + (wait * 1000) + 1000;
            bulkCooldowns[String(row.accountId)] = Math.max(Number(bulkCooldowns[String(row.accountId)] || 0), until);
          }
          const code = errorCode(err);
          const harmlessEmpty = code.includes("FILTER_INCLUDE_EMPTY");
          if (!harmlessEmpty) {
            bulkFailures.push(`${row.accountId} · addlist:${slug} · ${errorText(err)}`);
            console.warn(`TelePilot Addlist bulk join failed ${uid}/${row.accountId}/${slug}: ${errorText(err)}`);
          }
        }
      }
    } catch (err) {
      bulkFailures.push(`${row.accountId} · ${errorText(err)}`);
    } finally {
      try { await client?.disconnect(); } catch {}
    }
  }

  await delay(BULK_SETTLE_MS);

  let refreshed = postReview;
  const sourceText = String(postReview?.sourceText || initialResult?.postReview?.sourceText || "").trim();
  if (sourceText) {
    refreshed = await scanDestinationSources(uid, sourceText);
    refreshed.sourceText = sourceText;
  }

  const saved = saveReviewedDestinations(uid, refreshed);
  const cleanup = enqueueCleanup(uid, refreshed);
  const reconciled = reconcileFallbackQueue(uid, refreshed, previousCooldowns, bulkCooldowns);
  const queued = enqueueJoinRecovery(uid, refreshed);
  if (cleanup?.pending) void runDestinationPreparationTick();

  console.log(
    `TelePilot Addlist bulk recovery ${uid}: requests=${bulkRequests}, accepted=${bulkAccepted}, `
    + `confirmed=${refreshed?.accessible?.length || 0}, fallbackPending=${queued.pending}, reconciled=${reconciled}`,
  );

  return {
    ...initialResult,
    postReview: refreshed,
    saved,
    cleanup,
    accepted: Number(initialResult?.accepted || 0) + bulkAccepted,
    failures: [...(initialResult?.failures || []), ...bulkFailures],
    recovery: {
      bulkAccepted,
      bulkRequests,
      reconciled,
      queued: Number(queued.created || 0),
      requeued: Number(queued.requeued || 0),
      summary: joinQueueSummary(uid),
    },
  };
}

export const __test = {
  candidatePeerKey,
  peerKey,
  entityKey,
};
