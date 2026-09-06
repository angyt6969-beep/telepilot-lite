import fs from "node:fs";
import path from "node:path";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { InlineKeyboard } from "grammy";
import {
  accountDisplayLabel,
  effectiveAccountIds,
  listAccounts,
  loadAccountSession,
  updateAccountStatus,
} from "./account-store.js";
import {
  listUserIds,
  readAppSettings,
  writeAppSettings,
} from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";
import { advanceTutorialAfterAction } from "./onboarding.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const WORKER_INTERVAL_MS = 2_000;
const MUTE_FOREVER_UNIX = 2147483647;
const ARCHIVE_BATCH_SIZE = 50;
const TOPIC_PAGE_SIZE = 8;
const COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60_000;

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function importerStatePath(uid) { return path.join(userDir(uid), "destination-import-v1.json"); }
// ux-v13 already owns this small UI-state file. The fresh importer only writes
// topicQueue into it so the existing v1.3 Topics screen can render newly joined
// forum destinations. No legacy join/reconciliation worker reads this file.
function topicUiStatePath(uid) { return path.join(userDir(uid), "destination-automation.json"); }

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
  for (const value of [err?.seconds, err?.value, err?.retryAfter, err?.parameters?.retry_after]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.ceil(number);
  }
  const match = errorCode(err).match(/(?:FLOOD_WAIT|PLEASE WAIT|WAIT)(?:_|\s|\(|:|-)*(\d+)/);
  return match ? Math.max(1, Number(match[1])) : 0;
}
function retryAt(err, attempts, baseMs = 10_000) {
  const flood = floodWaitSeconds(err);
  if (flood) return Date.now() + (flood + 2) * 1000;
  return Date.now() + Math.min(30 * 60_000, baseMs * (2 ** Math.min(7, Math.max(0, attempts))));
}
function idString(value) {
  try { return String(value?.toString?.() ?? value ?? ""); }
  catch { return String(value || ""); }
}
function digits(value) { return idString(value).replace(/\D/g, ""); }
function peerKey(peer) { return digits(peer?.channelId ?? peer?.chatId ?? peer?.userId ?? peer?.id ?? peer); }
function chatKey(chat) { return digits(chat?.id); }
function findChat(chats, peer) {
  const wanted = peerKey(peer);
  return wanted ? (Array.isArray(chats) ? chats : []).find(chat => chatKey(chat) === wanted) || null : null;
}
function uniqueChats(chats) {
  const out = [], seen = new Set();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const key = chatKey(chat);
    if (!key || seen.has(key) || chat?.className === "ChannelForbidden") continue;
    seen.add(key);
    out.push(chat);
  }
  return out;
}

function readCleanup(uid) {
  const raw = readJson(importerStatePath(uid), {});
  const now = Date.now();
  return (Array.isArray(raw.cleanup) ? raw.cleanup : []).map(row => ({
    accountId: String(row?.accountId || ""),
    destinationId: String(row?.destinationId || ""),
    muteDone: row?.muteDone === true,
    archiveDone: row?.archiveDone === true,
    nextMuteAt: Math.max(0, Number(row?.nextMuteAt || 0) || 0),
    nextArchiveAt: Math.max(0, Number(row?.nextArchiveAt || 0) || 0),
    muteAttempts: Math.max(0, Number(row?.muteAttempts || 0) || 0),
    archiveAttempts: Math.max(0, Number(row?.archiveAttempts || 0) || 0),
    lastMuteError: String(row?.lastMuteError || "").slice(0, 180),
    lastArchiveError: String(row?.lastArchiveError || "").slice(0, 180),
    completedAt: Math.max(0, Number(row?.completedAt || 0) || 0),
  })).filter(row => row.accountId && /^-\d+$/.test(row.destinationId))
    .filter(row => !(row.muteDone && row.archiveDone && row.completedAt && now - row.completedAt > COMPLETED_RETENTION_MS));
}
function writeCleanup(uid, cleanup) {
  writeJsonAtomic(importerStatePath(uid), { version: 1, cleanup: cleanup.slice(-5000) });
}
function enqueueCleanup(uid, accountId, destinationIds) {
  const cleanup = readCleanup(uid);
  let added = 0;
  for (const destinationId of new Set((destinationIds || []).map(String))) {
    if (!/^-\d+$/.test(destinationId)) continue;
    const existing = cleanup.find(row => row.accountId === String(accountId) && row.destinationId === destinationId);
    if (existing) continue;
    cleanup.push({
      accountId: String(accountId), destinationId,
      muteDone: false, archiveDone: false,
      nextMuteAt: Date.now(), nextArchiveAt: Date.now(),
      muteAttempts: 0, archiveAttempts: 0,
      lastMuteError: "", lastArchiveError: "", completedAt: 0,
    });
    added++;
  }
  if (added) writeCleanup(uid, cleanup);
  return added;
}
function markCompleted(row) {
  if (row.muteDone && row.archiveDone && !row.completedAt) row.completedAt = Date.now();
}

function unwrapTelegramInput(raw) {
  const text = String(raw || "").trim();
  const markdown = text.match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/i);
  return (markdown ? markdown[1] : text).replace(/^<|>$/g, "").trim();
}
export function parseDestinationInput(raw) {
  const input = unwrapTelegramInput(raw);
  if (!input) return null;
  let match = input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/addlist\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/i);
  if (match) return { kind: "addlist", slug: match[1], original: input };
  match = input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)(?:[/?#].*)?$/i);
  if (match) return { kind: "invite", hash: match[1], original: input };
  match = input.match(/^@([A-Za-z0-9_]{5,32})$/);
  if (match) return { kind: "public", username: match[1], original: input };
  match = input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})(?:[/?#].*)?$/i);
  if (match && !["addlist", "joinchat", "c", "s"].includes(match[1].toLowerCase())) {
    return { kind: "public", username: match[1], original: input };
  }
  return null;
}
export function parsedIdentity(parsed) {
  if (parsed?.kind === "public") return `public:${String(parsed.username || "").toLowerCase()}`;
  if (parsed?.kind === "invite") return `invite:${String(parsed.hash || "")}`;
  if (parsed?.kind === "addlist") return `addlist:${String(parsed.slug || "")}`;
  return "";
}

async function openAccountClient(uid, account) {
  const client = new TelegramClient(new StringSession(loadAccountSession(uid, account.id)), API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 0,
  });
  client.__telepilotOwnerUid = String(uid);
  client.__telepilotAccountId = String(account.id);
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
function entityType(entity) {
  if (entity?.broadcast === true) return "channel";
  if (entity?.megagroup === true || entity?.forum === true || entity?.className === "Channel") return "supergroup";
  return "group";
}
function entityLabel(entity) { return String(entity?.title || entity?.username || entity?.id || "Destination").slice(0, 120); }
function entityUsername(entity) {
  const username = String(entity?.username || "").replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(username) ? `@${username}` : "";
}
async function entityPeerId(client, entity) {
  const direct = idString(await client.getPeerId(entity));
  if (/^-\d+$/.test(direct)) return direct;
  const raw = digits(direct || entity?.id);
  if (!raw) throw new Error("Could not identify Telegram destination");
  return entity?.broadcast === true || entity?.megagroup === true || entity?.forum === true || entity?.className === "Channel"
    ? `-100${raw}` : `-${raw}`;
}
function joinedAccountState(entity) {
  if (entity?.broadcast === true && entity?.creator !== true && entity?.adminRights?.postMessages !== true && entity?.admin_rights?.post_messages !== true) {
    return { status: "read_only", reason: "Joined, but this account cannot post in this channel." };
  }
  return { status: "ready", reason: "" };
}
function overallStatus(group) {
  if (group?.topicRequired === true && !Number(group?.topicId || 0)) return "needs_topic";
  const rows = Object.values(group?.accountJoin || {});
  if (!rows.length) return "ready";
  if (rows.every(row => row?.status === "ready")) return "ready";
  if (rows.some(row => row?.status === "ready")) return "partial";
  for (const status of ["pending", "verification", "read_only", "failed"]) {
    if (rows.some(row => row?.status === status)) return status;
  }
  return "failed";
}
async function forumTopics(client, entity) {
  if (entity?.forum !== true) return [];
  const result = await client.getForumTopics(entity, { limit: 100 });
  return (Array.isArray(result?.topics) ? result.topics : [])
    .map(topic => ({ id: Number(topic?.id || 0), title: String(topic?.title || `Topic ${topic?.id || ""}`).slice(0, 100) }))
    .filter(topic => Number.isInteger(topic.id) && topic.id > 0);
}
function writeTopicUiItem(uid, destinationId, label, topics) {
  const file = topicUiStatePath(uid);
  const state = readJson(file, {});
  const queue = Array.isArray(state.topicQueue) ? state.topicQueue.slice() : [];
  const token = `fresh_${digits(destinationId)}`;
  const item = {
    token,
    destinationId: String(destinationId),
    label: String(label || destinationId).slice(0, 120),
    topics: Array.isArray(topics) ? topics.slice(0, 100) : [],
    createdAt: Date.now(),
  };
  const index = queue.findIndex(row => String(row?.destinationId) === String(destinationId));
  if (index >= 0) queue[index] = item;
  else queue.push(item);
  writeJsonAtomic(file, {
    ...state,
    version: Math.max(1, Number(state.version || 1)),
    topicQueue: queue.slice(-500),
    unresolvedInvites: Array.isArray(state.unresolvedInvites) ? state.unresolvedInvites : [],
    routingQueue: Array.isArray(state.routingQueue) ? state.routingQueue : [],
    lastWorkerAt: Number(state.lastWorkerAt || 0) || 0,
  });
  return item;
}
function removeTopicUiItem(uid, destinationId) {
  const file = topicUiStatePath(uid);
  const state = readJson(file, {});
  if (!Array.isArray(state.topicQueue)) return;
  const next = state.topicQueue.filter(row => String(row?.destinationId) !== String(destinationId));
  if (next.length === state.topicQueue.length) return;
  writeJsonAtomic(file, { ...state, topicQueue: next });
}

async function saveJoinedChats(uid, accountId, client, chats, source, sourceSlug) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const byId = new Map(groups.map((group, index) => [String(group.id), index]));
  const result = { addedIds: [], duplicateIds: [], joinedIds: [], topicIds: [] };

  for (const entity of uniqueChats(chats)) {
    const id = await entityPeerId(client, entity);
    const accountState = joinedAccountState(entity);
    const forum = entity?.forum === true;
    let topics = [];
    if (forum) {
      try { topics = await forumTopics(client, entity); }
      catch (err) { console.warn(`Could not load forum topics for ${id}: ${errorText(err)}`); }
    }

    const index = byId.get(id);
    if (index === undefined) {
      groups.push({
        id,
        label: entityLabel(entity),
        type: entityType(entity),
        username: entityUsername(entity),
        accountMode: "inherit",
        accountIds: [],
        topicId: null,
        topicTitle: "",
        topicRequired: forum,
        joinStatus: forum ? "needs_topic" : accountState.status,
        accountJoin: {
          [String(accountId)]: { status: accountState.status, reason: accountState.reason, checkedAt: Date.now() },
        },
        source,
        sourceSlug,
        importedAt: Date.now(),
      });
      byId.set(id, groups.length - 1);
      result.addedIds.push(id);
    } else {
      const existing = groups[index];
      const group = { ...existing, accountJoin: { ...(existing.accountJoin || {}) } };
      group.label = entityLabel(entity) || group.label;
      group.type = entityType(entity) || group.type;
      group.username = entityUsername(entity) || group.username || "";
      group.topicRequired = group.topicRequired === true || forum;
      group.accountJoin[String(accountId)] = { status: accountState.status, reason: accountState.reason, checkedAt: Date.now() };
      group.source ||= source;
      group.sourceSlug ||= sourceSlug;
      group.joinStatus = overallStatus(group);
      groups[index] = group;
      result.duplicateIds.push(id);
    }

    const saved = groups[byId.get(id)];
    if (saved.topicRequired === true && !Number(saved.topicId || 0)) {
      writeTopicUiItem(uid, id, saved.label || saved.username || id, topics);
      result.topicIds.push(id);
    } else {
      removeTopicUiItem(uid, id);
    }
    result.joinedIds.push(id);
  }

  if (result.joinedIds.length) {
    writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
    syncUserGroups(uid);
  }
  return result;
}

async function joinPublic(client, parsed) {
  const target = `@${parsed.username}`;
  let entity = await client.getEntity(target);
  try {
    await client.getParticipant(entity, "me");
  } catch (err) {
    if (!errorCode(err).includes("USER_NOT_PARTICIPANT")) throw err;
    try {
      await client.joinChannel(target);
    } catch (joinErr) {
      const code = errorCode(joinErr);
      if (code.includes("INVITE_REQUEST_SENT")) return { pending: true, chats: [] };
      if (!code.includes("USER_ALREADY_PARTICIPANT")) throw joinErr;
    }
  }
  entity = await client.getEntity(target);
  return { pending: false, chats: [entity] };
}
async function joinPrivateInvite(client, parsed) {
  let checked = await client.checkChatInvite(parsed.hash);
  if (checked?.chat) return { pending: false, chats: [checked.chat] };

  let updates;
  try {
    updates = await client.importChatInvite(parsed.hash);
  } catch (err) {
    const code = errorCode(err);
    if (code.includes("INVITE_REQUEST_SENT")) return { pending: true, chats: [] };
    if (!code.includes("USER_ALREADY_PARTICIPANT")) throw err;
  }
  const updateChats = uniqueChats(updates?.chats || []);
  if (updateChats.length) return { pending: false, chats: updateChats };

  checked = await client.checkChatInvite(parsed.hash);
  if (checked?.chat) return { pending: false, chats: [checked.chat] };
  throw new Error("Telegram accepted the invite but did not return the joined chat.");
}
async function inputPeersFromFullChats(client, peers, chats) {
  const inputs = [], acceptedChats = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    const chat = findChat(chats, peer);
    if (!chat || chat?.className === "ChannelForbidden") continue;
    try {
      // Resolve through the full Chat object, not the lightweight PeerChannel.
      // The full object carries the access hash required for private chats.
      inputs.push(await client.getInputEntity(chat));
      acceptedChats.push(chat);
    } catch {}
  }
  return { inputs, acceptedChats };
}
export async function importAddlistWithClient(client, slug) {
  const invite = await client.api.chatlists.checkChatlistInvite({ slug });
  const inviteChats = Array.isArray(invite?.chats) ? invite.chats : [];
  const alreadyImported = invite?.className === "ChatlistInviteAlready" || Number.isInteger(Number(invite?.filterId));

  if (!alreadyImported) {
    const { inputs, acceptedChats } = await inputPeersFromFullChats(client, invite?.peers || [], inviteChats);
    if (inputs.length) await client.api.chatlists.joinChatlistInvite({ slug, peers: inputs });
    return { chats: uniqueChats(acceptedChats), joinedNow: acceptedChats.length, already: 0 };
  }

  const alreadyChats = uniqueChats((invite?.alreadyPeers || []).map(peer => findChat(inviteChats, peer)).filter(Boolean));
  const missingPreview = Array.isArray(invite?.missingPeers) ? invite.missingPeers : [];
  if (!missingPreview.length) {
    return { chats: alreadyChats, joinedNow: 0, already: alreadyChats.length };
  }

  const chatlist = new Api.InputChatlistDialogFilter({ filterId: Number(invite.filterId) });
  const updates = await client.api.chatlists.getChatlistUpdates({ chatlist });
  const { inputs, acceptedChats } = await inputPeersFromFullChats(client, updates?.missingPeers || [], updates?.chats || []);
  if (inputs.length) await client.api.chatlists.joinChatlistUpdates({ chatlist, peers: inputs });
  return {
    chats: uniqueChats([...alreadyChats, ...acceptedChats]),
    joinedNow: acceptedChats.length,
    already: alreadyChats.length,
  };
}

async function processParsedForAccount(uid, account, parsed) {
  let client;
  try {
    client = await openAccountClient(uid, account);
    let joined;
    if (parsed.kind === "public") joined = await joinPublic(client, parsed);
    else if (parsed.kind === "invite") joined = await joinPrivateInvite(client, parsed);
    else joined = await importAddlistWithClient(client, parsed.slug);

    if (joined.pending) return { pending: true, joinedIds: [], addedIds: [], duplicateIds: [], topicIds: [] };
    const sourceSlug = parsed.kind === "public" ? parsed.username : parsed.kind === "invite" ? parsed.hash : parsed.slug;
    const saved = await saveJoinedChats(uid, account.id, client, joined.chats, parsed.kind, sourceSlug);
    enqueueCleanup(uid, account.id, saved.joinedIds);
    return { pending: false, ...saved };
  } finally {
    try { await client?.disconnect(); } catch {}
  }
}

async function resolveSavedEntity(client, group) {
  const username = String(group?.username || "").replace(/^@/, "");
  if (username) {
    try { return await client.getEntity(`@${username}`); } catch {}
  }
  try { return await client.getEntity(String(group?.id || "")); } catch {}
  const dialogs = await client.getDialogs({});
  for (const dialog of dialogs || []) {
    const entity = dialog?.entity || dialog;
    try {
      if (await entityPeerId(client, entity) === String(group?.id || "")) return entity;
    } catch {}
  }
  throw new Error("Could not resolve joined Telegram destination");
}
async function inputForSavedGroup(client, group) {
  return client.getInputEntity(await resolveSavedEntity(client, group));
}

async function processCleanupForUser(uid) {
  const cleanup = readCleanup(uid);
  if (!cleanup.length) return 0;
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const byGroup = new Map(groups.map(group => [String(group.id), group]));
  const byAccount = new Map(listAccounts(uid).map(account => [String(account.id), account]));
  const now = Date.now();
  const runnable = cleanup.find(row => (!row.archiveDone && row.nextArchiveAt <= now) || (!row.muteDone && row.nextMuteAt <= now));
  if (!runnable) return 0;
  const account = byAccount.get(String(runnable.accountId));
  if (!account) return 0;

  let client;
  let worked = 0;
  try {
    client = await openAccountClient(uid, account);

    const archiveRows = cleanup
      .filter(row => row.accountId === String(account.id) && !row.archiveDone && row.nextArchiveAt <= Date.now())
      .slice(0, ARCHIVE_BATCH_SIZE);
    const archiveResolved = [];
    for (const row of archiveRows) {
      const group = byGroup.get(row.destinationId);
      if (!group) {
        row.archiveDone = true;
        markCompleted(row);
        continue;
      }
      try {
        archiveResolved.push({ row, peer: await inputForSavedGroup(client, group) });
      } catch (err) {
        row.archiveAttempts++;
        row.lastArchiveError = errorText(err);
        row.nextArchiveAt = retryAt(err, row.archiveAttempts, 15_000);
      }
    }
    if (archiveResolved.length) {
      try {
        await client.invoke(new Api.folders.EditPeerFolders({
          folderPeers: archiveResolved.map(({ peer }) => new Api.InputFolderPeer({ peer, folderId: 1 })),
        }));
        for (const { row } of archiveResolved) {
          row.archiveDone = true;
          row.lastArchiveError = "";
          row.nextArchiveAt = 0;
          markCompleted(row);
        }
        worked += archiveResolved.length;
      } catch (err) {
        const attempt = Math.max(1, ...archiveResolved.map(({ row }) => Number(row.archiveAttempts || 0) + 1));
        const next = retryAt(err, attempt, 15_000);
        for (const { row } of archiveResolved) {
          row.archiveAttempts++;
          row.lastArchiveError = errorText(err);
          row.nextArchiveAt = next;
        }
        const wait = floodWaitSeconds(err);
        if (wait) console.log(`Archive cooldown for sender ${account.id}: ${wait}s`);
        else console.warn(`Archive batch failed for ${account.id}: ${errorText(err)}`);
      }
    }

    // Notification settings are one peer per RPC. Pace these deliberately rather
    // than blasting a large Addlist and immediately creating a Telegram flood wait.
    const muteRow = cleanup.find(row => row.accountId === String(account.id) && !row.muteDone && row.nextMuteAt <= Date.now());
    if (muteRow) {
      const group = byGroup.get(muteRow.destinationId);
      if (!group) {
        muteRow.muteDone = true;
        markCompleted(muteRow);
      } else {
        try {
          const peer = await inputForSavedGroup(client, group);
          await client.invoke(new Api.account.UpdateNotifySettings({
            peer: new Api.InputNotifyPeer({ peer }),
            settings: new Api.InputPeerNotifySettings({ silent: true, muteUntil: MUTE_FOREVER_UNIX }),
          }));
          muteRow.muteDone = true;
          muteRow.lastMuteError = "";
          muteRow.nextMuteAt = 0;
          markCompleted(muteRow);
          worked++;
        } catch (err) {
          muteRow.muteAttempts++;
          muteRow.lastMuteError = errorText(err);
          muteRow.nextMuteAt = retryAt(err, muteRow.muteAttempts);
          const wait = floodWaitSeconds(err);
          if (wait) console.log(`Mute cooldown for sender ${account.id}: ${wait}s`);
          else console.warn(`Mute failed for ${muteRow.destinationId}: ${errorText(err)}`);
        }
      }
    }

    writeCleanup(uid, cleanup);
    return worked;
  } finally {
    try { await client?.disconnect(); } catch {}
  }
}

export function destinationAccountReady(destination, accountId = "") {
  if (!destination || typeof destination !== "object") return false;
  if (destination.topicRequired === true && !Number(destination.topicId || 0)) return false;
  const map = destination.accountJoin && typeof destination.accountJoin === "object" && !Array.isArray(destination.accountJoin)
    ? destination.accountJoin : null;
  if (!map) return String(destination.joinStatus || "ready") === "ready";
  if (accountId) return map[String(accountId)]?.status === "ready";
  return Object.values(map).some(row => row?.status === "ready");
}
export function recordDestinationFailure(uid, destination, accountId, err) {
  const code = errorCode(err);
  if (!["CHAT_WRITE_FORBIDDEN", "CHAT_SEND_PLAIN_FORBIDDEN", "CHAT_SEND_MEDIA_FORBIDDEN", "USER_NOT_PARTICIPANT"].some(token => code.includes(token))) return false;
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const index = groups.findIndex(group => String(group.id) === String(destination?.id));
  if (index < 0) return false;
  const group = { ...groups[index], accountJoin: { ...(groups[index].accountJoin || {}) } };
  const pending = code.includes("USER_NOT_PARTICIPANT");
  group.accountJoin[String(accountId)] = {
    status: pending ? "pending" : "verification",
    reason: pending ? "This account is no longer a member of the destination." : "Telegram currently blocks posting from this account.",
    checkedAt: Date.now(),
  };
  group.joinStatus = overallStatus(group);
  groups[index] = group;
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  syncUserGroups(uid);
  return true;
}

// Existing sender-routing UI still calls these hooks. The fresh importer does not
// maintain a second hidden join queue; membership changes are rechecked explicitly.
export function queueRoutingSync() { return 0; }
export async function processRoutingQueue() { return { processed: 0, changed: 0 }; }

export async function recheckDestinations(uid, limit = 24) {
  const id = String(uid || "");
  const settings = readAppSettings(id);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const accounts = listAccounts(id);
  if (!groups.length || !accounts.length) return { checked: 0, changed: 0 };

  let checked = 0, changed = 0;
  for (const account of accounts) {
    const relevant = groups.filter(group => effectiveAccountIds(settings, group, accounts).map(String).includes(String(account.id)));
    if (!relevant.length) continue;
    let client;
    try {
      client = await openAccountClient(id, account);
      for (const original of relevant) {
        if (checked >= Math.max(1, Number(limit) || 24)) break;
        checked++;
        const index = groups.findIndex(group => String(group.id) === String(original.id));
        if (index < 0) continue;
        const group = { ...groups[index], accountJoin: { ...(groups[index].accountJoin || {}) } };
        const before = JSON.stringify(group.accountJoin[String(account.id)] || {});
        try {
          const entity = await resolveSavedEntity(client, group);
          let isMember = true;
          try { await client.getParticipant(entity, "me"); }
          catch (err) { if (errorCode(err).includes("USER_NOT_PARTICIPANT")) isMember = false; else throw err; }
          if (!isMember) {
            group.accountJoin[String(account.id)] = { status: "pending", reason: "This account is not currently a member.", checkedAt: Date.now() };
          } else {
            const state = joinedAccountState(entity);
            group.accountJoin[String(account.id)] = { status: state.status, reason: state.reason, checkedAt: Date.now() };
            enqueueCleanup(id, account.id, [group.id]);
            if (entity?.forum === true && !Number(group.topicId || 0)) {
              group.topicRequired = true;
              try { writeTopicUiItem(id, group.id, group.label || group.username || group.id, await forumTopics(client, entity)); }
              catch (err) { console.warn(`Could not refresh topics for ${group.id}: ${errorText(err)}`); }
            }
          }
        } catch (err) {
          group.accountJoin[String(account.id)] = { status: "verification", reason: errorText(err), checkedAt: Date.now() };
        }
        group.joinStatus = overallStatus(group);
        if (JSON.stringify(group.accountJoin[String(account.id)] || {}) !== before) changed++;
        groups[index] = group;
      }
    } finally {
      try { await client?.disconnect(); } catch {}
    }
    if (checked >= Math.max(1, Number(limit) || 24)) break;
  }

  if (checked) {
    writeAppSettings(id, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
    syncUserGroups(id);
  }
  return { checked, changed };
}

export async function handleDestinationText(uid, text) {
  const id = String(uid || "");
  const initialSettings = readAppSettings(id);
  const accounts = listAccounts(id);
  const selectedIds = new Set(effectiveAccountIds(initialSettings, null, accounts).map(String));
  const selectedAccounts = accounts.filter(account => selectedIds.has(String(account.id)));
  if (!selectedAccounts.length) {
    return {
      text: "Connect and select a personal Telegram account before importing destinations.",
      added: 0, duplicates: 0, failed: 1, attention: 0, pending: 0, topics: 0,
      destinationIds: [], requiresPersonal: true,
    };
  }

  const lines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsedRows = lines.map(line => ({ line, parsed: parseDestinationInput(line) }));
  const beforeIds = new Set((Array.isArray(initialSettings.groups) ? initialSettings.groups : []).map(group => String(group.id)));
  const joinedIds = new Set();
  const topicIds = new Set();
  let failed = 0, pending = 0;
  const errors = [];

  for (const row of parsedRows) {
    if (!row.parsed) {
      failed++;
      errors.push(`${row.line} — invalid Telegram destination.`);
      continue;
    }
    for (const account of selectedAccounts) {
      try {
        const result = await processParsedForAccount(id, account, row.parsed);
        if (result.pending) {
          pending++;
          continue;
        }
        for (const destinationId of result.joinedIds || []) joinedIds.add(String(destinationId));
        for (const destinationId of result.topicIds || []) topicIds.add(String(destinationId));
      } catch (err) {
        failed++;
        errors.push(`${accountDisplayLabel(account)} — ${errorText(err)}`);
      }
    }
  }

  const finalSettings = readAppSettings(id);
  const finalGroups = Array.isArray(finalSettings.groups) ? finalSettings.groups : [];
  const addedIds = finalGroups.map(group => String(group.id)).filter(destinationId => !beforeIds.has(destinationId));
  const duplicateIds = [...joinedIds].filter(destinationId => beforeIds.has(destinationId));
  const attention = finalGroups.filter(group => ["needs_topic", "pending", "verification", "read_only", "failed", "partial"].includes(String(group.joinStatus || ""))).length;
  const cleanupPending = readCleanup(id).filter(row => !row.muteDone || !row.archiveDone).length;

  if (addedIds.length && !topicIds.size) {
    try { advanceTutorialAfterAction(id, 3, 4); } catch {}
  }

  const resultLines = [
    "✅ Destination import finished",
    "",
    `Added — ${addedIds.length}`,
    `Already saved — ${duplicateIds.length}`,
    `Join requests pending — ${pending}`,
    `Topics to choose — ${topicIds.size}`,
    `Failed / invalid — ${failed}`,
    `Mute + archive queued — ${cleanupPending}`,
  ];
  if (errors.length) resultLines.push("", ...errors.slice(0, 6).map(value => `• ${value}`));

  return {
    text: resultLines.join("\n"),
    added: addedIds.length,
    duplicates: duplicateIds.length,
    failed,
    attention,
    pending,
    topics: topicIds.size,
    destinationIds: addedIds,
    error: errors[0] || "",
  };
}

function destinationGroups(uid) {
  const groups = readAppSettings(uid).groups;
  return Array.isArray(groups) ? groups : [];
}
export function destinationMenu(uid) {
  const groups = destinationGroups(uid);
  const topicCount = groups.filter(group => group.topicRequired === true && !Number(group.topicId || 0)).length;
  const cleanupCount = readCleanup(uid).filter(row => !row.muteDone || !row.archiveDone).length;
  const lines = groups.slice(0, 30).map((group, index) => `${index + 1}. ${group.username || group.label || group.id}${group.topicTitle ? ` → ${group.topicTitle}` : ""}`);
  if (groups.length > 30) lines.push(`…and ${groups.length - 30} more`);
  const text = [
    `📍 Destinations · ${groups.length}`,
    "",
    lines.length ? lines.join("\n") : "No destinations yet.",
    "",
    `Topics ${topicCount} · Cleanup queued ${cleanupCount}`,
  ].join("\n");
  const keyboard = new InlineKeyboard().text("＋ Add destinations", "add_group").row();
  if (topicCount) keyboard.text(`💬 Choose topics (${topicCount})`, "dest_topics").row();
  if (cleanupCount) keyboard.text("⏳ Cleanup status", "dest_pending").row();
  if (groups.length) keyboard.text("Manage", "remove_group_menu").row();
  keyboard.text("← Home", "home");
  return { text, keyboard };
}

async function fetchTopicsForSavedGroup(uid, group) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const selected = effectiveAccountIds(settings, group, accounts).map(String);
  const account = accounts.find(item => selected.includes(String(item.id))) || accounts[0];
  if (!account) throw new Error("Connect a personal Telegram account first.");
  let client;
  try {
    client = await openAccountClient(uid, account);
    const entity = await resolveSavedEntity(client, group);
    return forumTopics(client, entity);
  } finally {
    try { await client?.disconnect(); } catch {}
  }
}
async function showTopicIndex(ctx) {
  const uid = String(ctx.from?.id || "");
  const waiting = destinationGroups(uid).filter(group => group.topicRequired === true && !Number(group.topicId || 0));
  const keyboard = new InlineKeyboard();
  for (const group of waiting.slice(0, 30)) keyboard.text(String(group.label || group.username || group.id).slice(0, 42), `dest_topic_open:${group.id}:0`).row();
  keyboard.text("← Destinations", "groups");
  return ctx.editMessageText(
    waiting.length ? "💬 Choose a forum group\n\nSelect a group, then choose the exact posting topic." : "✅ No forum topics are waiting for selection.",
    { reply_markup: keyboard },
  );
}
async function showTopicPage(ctx, destinationId, page = 0) {
  const uid = String(ctx.from?.id || "");
  const group = destinationGroups(uid).find(item => String(item.id) === String(destinationId));
  if (!group) throw new Error("Destination no longer exists.");
  const topics = await fetchTopicsForSavedGroup(uid, group);
  writeTopicUiItem(uid, group.id, group.label || group.username || group.id, topics);
  const pages = Math.max(1, Math.ceil(topics.length / TOPIC_PAGE_SIZE));
  const current = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const keyboard = new InlineKeyboard();
  for (const topic of topics.slice(current * TOPIC_PAGE_SIZE, (current + 1) * TOPIC_PAGE_SIZE)) {
    keyboard.text(topic.title.slice(0, 42), `dest_topic_pick:${group.id}:${topic.id}`).row();
  }
  if (pages > 1) {
    if (current > 0) keyboard.text("◀ Prev", `dest_topic_open:${group.id}:${current - 1}`);
    if (current < pages - 1) keyboard.text("Next ▶", `dest_topic_open:${group.id}:${current + 1}`);
    keyboard.row();
  }
  keyboard.text("← Forum groups", "dest_topics");
  return ctx.editMessageText(`💬 ${group.label || group.username || group.id}\n\nChoose the exact topic TelePilot should use.`, { reply_markup: keyboard });
}
async function chooseTopic(uid, destinationId, topicId) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const index = groups.findIndex(group => String(group.id) === String(destinationId));
  if (index < 0) return false;
  const group = { ...groups[index] };
  let title = `Topic ${topicId}`;
  try {
    const topics = await fetchTopicsForSavedGroup(uid, group);
    title = topics.find(topic => topic.id === Number(topicId))?.title || title;
  } catch {}
  group.topicRequired = true;
  group.topicId = Number(topicId);
  group.topicTitle = title;
  group.joinStatus = overallStatus(group);
  groups[index] = group;
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  removeTopicUiItem(uid, destinationId);
  syncUserGroups(uid);
  return true;
}

function installHandlers(bot) {
  bot.callbackQuery("dest_topics", async ctx => {
    await ctx.answerCallbackQuery();
    try { await showTopicIndex(ctx); }
    catch (err) { await ctx.editMessageText(`Could not load topics: ${errorText(err)}`, { reply_markup: new InlineKeyboard().text("← Destinations", "groups") }); }
  });
  bot.callbackQuery(/^dest_topic_open:(-\d+):(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    try { await showTopicPage(ctx, ctx.match[1], Number(ctx.match[2])); }
    catch (err) { await ctx.editMessageText(`Could not load topics: ${errorText(err)}`, { reply_markup: new InlineKeyboard().text("← Destinations", "groups") }); }
  });
  bot.callbackQuery(/^dest_topic_pick:(-\d+):(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery({ text: "Topic selected" });
    const uid = String(ctx.from?.id || "");
    await chooseTopic(uid, ctx.match[1], Number(ctx.match[2]));
    if (!destinationGroups(uid).some(group => group.topicRequired === true && !Number(group.topicId || 0))) {
      const screen = advanceTutorialAfterAction(uid, 3, 4);
      if (screen) return ctx.editMessageText(screen.text, { reply_markup: screen.keyboard });
    }
    return showTopicIndex(ctx);
  });
  bot.callbackQuery("dest_pending", async ctx => {
    await ctx.answerCallbackQuery();
    const pending = readCleanup(String(ctx.from?.id || "")).filter(row => !row.muteDone || !row.archiveDone);
    await ctx.editMessageText([
      "⏳ Cleanup status",
      "",
      `Mute/archive jobs waiting — ${pending.length}`,
      "",
      "Each joined destination is queued once. Completed jobs are retained and are not continuously re-added.",
    ].join("\n"), { reply_markup: new InlineKeyboard().text("← Destinations", "groups") });
  });
}
export function installDestinationAutomation(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotDestinationAutomationInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for destination automation");
  Object.defineProperty(BotClass.prototype, "__telepilotDestinationAutomationInstalled", { value: true });
  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotFreshDestinationHandlers) {
      Object.defineProperty(this, "__telepilotFreshDestinationHandlers", { value: true });
      installHandlers(this);
    }
    return originalStart.apply(this, args);
  };
}

let timer = null;
let busy = false;
export function startDestinationAutomationWorker() {
  if (timer || !API_ID || !API_HASH) return timer;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const uid of listUserIds()) {
        try { await processCleanupForUser(uid); }
        catch (err) { console.warn(`Destination cleanup failed for ${uid}: ${errorText(err)}`); }
      }
    } finally {
      busy = false;
    }
  };
  timer = setInterval(() => void tick(), WORKER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 1_000).unref?.();
  console.log("TelePilot fresh destination importer enabled (public/private/Addlist + topics + cleanup)");
  return timer;
}
