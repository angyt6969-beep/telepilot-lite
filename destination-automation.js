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
import { listUserIds, readAppSettings, writeAppSettings } from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const WORKER_INTERVAL_MS = 5 * 60_000;
const JOIN_GAP_MS = 1400;
const TOPIC_PAGE_SIZE = 8;
const RECHECK_PER_TICK = 12;

function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function automationPath(uid) { return path.join(userDir(uid), "destination-automation.json"); }
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
function readAutomation(uid) {
  const raw = readJson(automationPath(uid), {});
  return {
    version: 1,
    topicQueue: Array.isArray(raw.topicQueue) ? raw.topicQueue : [],
    unresolvedInvites: Array.isArray(raw.unresolvedInvites) ? raw.unresolvedInvites : [],
    lastWorkerAt: Number(raw.lastWorkerAt || 0) || 0,
  };
}
function writeAutomation(uid, value) {
  const normalized = {
    version: 1,
    topicQueue: Array.isArray(value?.topicQueue) ? value.topicQueue.slice(-500) : [],
    unresolvedInvites: Array.isArray(value?.unresolvedInvites) ? value.unresolvedInvites.slice(-500) : [],
    lastWorkerAt: Number(value?.lastWorkerAt || 0) || 0,
  };
  writeJsonAtomic(automationPath(uid), normalized);
  return normalized;
}
function errorCode(err) {
  return String(err?.errorMessage || err?.description || err?.message || err || "").toUpperCase();
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function idString(value) {
  try { return String(value?.toString?.() ?? value ?? ""); } catch { return String(value || ""); }
}
function normalizeUsername(value) {
  const v = String(value || "").replace(/^@/, "").trim();
  return /^[A-Za-z0-9_]{5,32}$/.test(v) ? v : "";
}

export function parseDestinationInput(raw) {
  const input = String(raw || "").trim();
  if (!input) return null;
  const addlist = input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/addlist\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/i);
  if (addlist) return { kind: "addlist", slug: addlist[1], original: input };
  const plus = input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/\+([A-Za-z0-9_-]+)(?:[/?#].*)?$/i);
  if (plus) return { kind: "invite", hash: plus[1], original: input };
  const joinchat = input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/joinchat\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/i);
  if (joinchat) return { kind: "invite", hash: joinchat[1], original: input };
  const at = input.match(/^@([A-Za-z0-9_]{5,32})$/);
  if (at) return { kind: "public", username: at[1], original: input };
  const publicLink = input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})(?:[/?#].*)?$/i);
  if (publicLink && !["addlist", "joinchat", "c", "s"].includes(publicLink[1].toLowerCase())) {
    return { kind: "public", username: publicLink[1], original: input };
  }
  return null;
}

const AD_TOPIC_WORDS = [
  "advertising", "advertisement", "advertisements", "advertise", "ads", "adverts", "promo", "promotion",
  "marketplace", "market", "buy sell", "buy/sell", "selling", "sales", "services", "offers", "deals",
];
export function suggestTopic(topics) {
  const rows = Array.isArray(topics) ? topics : [];
  let best = null;
  let bestScore = 0;
  for (const topic of rows) {
    const title = String(topic?.title || "").toLowerCase().replace(/[_-]+/g, " ");
    if (!title) continue;
    let score = 0;
    for (const word of AD_TOPIC_WORDS) {
      if (title === word) score = Math.max(score, 100);
      else if (title.includes(word)) score = Math.max(score, word.length >= 8 ? 80 : 60);
    }
    if (/rules?|support|help|welcome|verification|verify|announcements?|general chat/.test(title)) score = 0;
    if (score > bestScore) { best = topic; bestScore = score; }
  }
  return bestScore > 0 ? { ...best, score: bestScore } : null;
}

function accountJoinEntry(status, reason = "") {
  return { status, reason: String(reason || "").slice(0, 180), checkedAt: Date.now() };
}
export function recordDestinationFailure(uid, destination, accountId, err) {
  const id = String(uid || "");
  const account = String(accountId || "");
  const destinationId = String(destination?.id || "");
  if (!id || !account || !destinationId) return false;
  const code = errorCode(err);
  const restricted = [
    "CHAT_WRITE_FORBIDDEN", "CHAT_SEND_PLAIN_FORBIDDEN", "CHAT_SEND_MEDIA_FORBIDDEN",
    "CHAT_SEND_PHOTOS_FORBIDDEN", "CHAT_SEND_VIDEOS_FORBIDDEN",
  ].some(token => code.includes(token));
  if (!restricted) return false;
  const settings = readAppSettings(id);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const group = groups.find(row => String(row?.id || "") === destinationId);
  if (!group) return false;
  group.accountJoin = { ...(group.accountJoin || {}) };
  group.accountJoin[account] = accountJoinEntry(
    "verification",
    "Telegram currently blocks posting from this account. Open the group and complete any verification or rules step, then TelePilot will recheck it.",
  );
  group.joinStatus = overallStatus(group);
  writeAppSettings(id, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  syncUserGroups(id);
  return true;
}

export function destinationAccountReady(destination, accountId = "") {
  if (!destination || typeof destination !== "object") return false;
  if (destination.topicRequired === true && !Number(destination.topicId || 0)) return false;
  if (String(destination.joinStatus || "") === "needs_topic") return false;
  const map = destination.accountJoin && typeof destination.accountJoin === "object" ? destination.accountJoin : null;
  if (!map) return true; // Legacy/manual destinations remain compatible.
  const row = map[String(accountId || "")];
  if (!row) return true;
  return String(row.status || "") === "ready";
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
  return client;
}
async function inputPeer(client, peer) {
  return client.getInputEntity(peer);
}
async function entityPeerId(client, entity) {
  const id = idString(await client.getPeerId(entity));
  if (/^-\d+$/.test(id)) return id;
  const raw = id.replace(/\D/g, "");
  if (!raw) throw new Error("Could not identify Telegram destination");
  if (entity?.broadcast === true || entity?.megagroup === true || entity?.className === "Channel") return `-100${raw}`;
  return `-${raw}`;
}
function entityType(entity) {
  if (entity?.broadcast === true) return "channel";
  if (entity?.megagroup === true || entity?.forum === true || entity?.className === "Channel") return "supergroup";
  return "group";
}
function entityLabel(entity, fallback = "Destination") {
  return String(entity?.title || entity?.username || fallback).slice(0, 120);
}
function entityUsername(entity) {
  const username = normalizeUsername(entity?.username || "");
  return username ? `@${username}` : "";
}
function restrictionFlags(participant) {
  const rights = participant?.bannedRights || participant?.banned_rights || participant?.participant?.bannedRights || participant?.participant?.banned_rights;
  if (!rights) return [];
  const keys = ["sendMessages", "sendPlain", "sendMedia", "sendPhotos", "sendVideos"];
  return keys.filter(key => rights[key] === true || rights[key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)] === true);
}
async function topicRows(client, entity) {
  if (entity?.forum !== true) return [];
  try {
    const result = await client.getForumTopics(entity, { limit: 100 });
    const topics = Array.isArray(result?.topics) ? result.topics : [];
    return topics
      .map(topic => ({ id: Number(topic?.id || 0), title: String(topic?.title || `Topic ${topic?.id || ""}`).slice(0, 100) }))
      .filter(topic => Number.isInteger(topic.id) && topic.id > 0);
  } catch {
    return [];
  }
}
async function assessEntity(client, entity) {
  if (!entity) return { status: "failed", reason: "Telegram did not return this chat.", topics: [] };
  if (entity?.broadcast === true && entity?.creator !== true && entity?.adminRights?.postMessages !== true) {
    return { status: "read_only", reason: "This sender can join the channel but cannot publish there.", topics: [] };
  }
  try {
    const participant = await client.getParticipant(entity, "me");
    const restricted = restrictionFlags(participant);
    if (restricted.length) {
      return { status: "verification", reason: "Joined, but Telegram still blocks posting. Complete the group verification in Telegram.", topics: [] };
    }
  } catch (err) {
    const code = errorCode(err);
    if (code.includes("USER_NOT_PARTICIPANT")) return { status: "pending", reason: "Waiting to join this group.", topics: [] };
  }
  const topics = await topicRows(client, entity);
  if (entity?.forum === true) {
    if (!topics.length) return { status: "verification", reason: "Forum joined, but topics are not available yet. Open the group in Telegram and complete any verification.", topics: [] };
    return { status: "needs_topic", reason: "Choose which topic TelePilot should post in.", topics };
  }
  return { status: "ready", reason: "", topics: [] };
}
function destinationFromEntity(entity, id, source = {}) {
  return {
    id: String(id),
    label: entityLabel(entity, source.original || id),
    type: entityType(entity),
    username: entityUsername(entity),
    accountMode: "inherit",
    accountIds: [],
    topicId: null,
    topicTitle: "",
    topicRequired: entity?.forum === true,
    joinStatus: entity?.forum === true ? "needs_topic" : "ready",
    accountJoin: {},
    source: String(source.kind || "auto"),
    sourceSlug: String(source.slug || source.hash || ""),
    importedAt: Date.now(),
  };
}
function mergeDestination(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    label: incoming.label || existing.label,
    type: incoming.type || existing.type,
    username: incoming.username || existing.username,
    topicRequired: incoming.topicRequired === true || existing.topicRequired === true,
    accountJoin: { ...(existing.accountJoin || {}), ...(incoming.accountJoin || {}) },
    source: existing.source || incoming.source,
    sourceSlug: existing.sourceSlug || incoming.sourceSlug,
    importedAt: Number(existing.importedAt || incoming.importedAt || Date.now()),
  };
}
function overallStatus(destination) {
  if (destination.topicRequired === true && !Number(destination.topicId || 0)) return "needs_topic";
  const rows = Object.values(destination.accountJoin || {});
  if (!rows.length) return destination.joinStatus || "ready";
  if (rows.every(row => row.status === "ready")) return "ready";
  if (rows.some(row => row.status === "ready")) return "partial";
  if (rows.some(row => row.status === "pending")) return "pending";
  if (rows.some(row => row.status === "verification")) return "verification";
  if (rows.some(row => row.status === "read_only")) return "read_only";
  return "failed";
}
function upsertTopicQueue(uid, destination, topics) {
  if (!destination?.id || !Array.isArray(topics) || !topics.length) return;
  const store = readAutomation(uid);
  const token = Buffer.from(String(destination.id)).toString("base64url").slice(0, 54);
  const suggestion = suggestTopic(topics);
  const row = {
    token,
    destinationId: String(destination.id),
    label: String(destination.label || destination.id),
    topics: topics.slice(0, 100),
    suggestedId: Number(suggestion?.id || 0) || null,
    createdAt: Date.now(),
  };
  const index = store.topicQueue.findIndex(item => String(item.destinationId) === String(destination.id));
  if (index >= 0) store.topicQueue[index] = row;
  else store.topicQueue.push(row);
  writeAutomation(uid, store);
}
function addUnresolvedInvite(uid, item) {
  const store = readAutomation(uid);
  const key = `${item.accountId}|${item.kind}|${item.hash || item.slug || item.username || ""}`;
  const row = { ...item, key, checkedAt: Date.now() };
  const index = store.unresolvedInvites.findIndex(value => value.key === key);
  if (index >= 0) store.unresolvedInvites[index] = row;
  else store.unresolvedInvites.push(row);
  writeAutomation(uid, store);
}
function removeUnresolvedInvite(uid, key) {
  const store = readAutomation(uid);
  store.unresolvedInvites = store.unresolvedInvites.filter(item => item.key !== key);
  writeAutomation(uid, store);
}
function saveDestination(uid, destination) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const index = groups.findIndex(group => String(group?.id || "") === String(destination.id));
  if (index >= 0) groups[index] = mergeDestination(groups[index], destination);
  else groups.push(destination);
  const saved = groups.find(group => String(group.id) === String(destination.id));
  saved.joinStatus = overallStatus(saved);
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  syncUserGroups(uid);
  return { destination: saved, duplicate: index >= 0, groups };
}

async function joinPublic(client, parsed) {
  const target = `@${parsed.username}`;
  let entity;
  let joinState = "ready";
  let reason = "";
  try {
    entity = await client.getEntity(target);
    try { await client.getParticipant(entity, "me"); }
    catch (err) {
      if (!errorCode(err).includes("USER_NOT_PARTICIPANT")) throw err;
      try { await client.joinChannel(target); }
      catch (joinErr) {
        const code = errorCode(joinErr);
        if (code.includes("INVITE_REQUEST_SENT")) { joinState = "pending"; reason = "Join request sent; waiting for admin approval."; }
        else if (!code.includes("USER_ALREADY_PARTICIPANT")) throw joinErr;
      }
      if (joinState === "ready") entity = await client.getEntity(target);
    }
  } catch (err) {
    const code = errorCode(err);
    if (code.includes("INVITE_REQUEST_SENT")) return { entity: null, status: "pending", reason: "Join request sent; waiting for admin approval." };
    throw err;
  }
  return { entity, status: joinState, reason };
}
async function joinPrivateInvite(client, parsed) {
  let checked;
  try { checked = await client.checkChatInvite(parsed.hash); } catch {}
  const already = checked?.chat || checked?.className === "ChatInviteAlready" ? checked?.chat : null;
  if (already) return { entity: already, status: "ready", reason: "" };
  try {
    await client.importChatInvite(parsed.hash);
  } catch (err) {
    const code = errorCode(err);
    if (code.includes("INVITE_REQUEST_SENT")) return { entity: null, status: "pending", reason: "Join request sent; waiting for admin approval." };
    if (!code.includes("USER_ALREADY_PARTICIPANT")) throw err;
  }
  checked = await client.checkChatInvite(parsed.hash);
  if (checked?.chat) return { entity: checked.chat, status: "ready", reason: "" };
  return { entity: null, status: "pending", reason: "Waiting for Telegram to confirm membership." };
}
function peerKey(peer) {
  return idString(peer?.channelId || peer?.chatId || peer?.userId || peer?.id || "").replace(/\D/g, "");
}
function findChatForPeer(chats, peer) {
  const wanted = peerKey(peer);
  if (!wanted) return null;
  return (chats || []).find(chat => idString(chat?.id || "").replace(/\D/g, "") === wanted) || null;
}
async function importAddlist(client, parsed) {
  const invite = await client.api.chatlists.checkChatlistInvite({ slug: parsed.slug });
  const chats = Array.isArray(invite?.chats) ? invite.chats : [];
  const isAlready = invite?.className === "ChatlistInviteAlready" || Number.isInteger(Number(invite?.filterId));
  const peers = isAlready
    ? (Array.isArray(invite?.missingPeers) ? invite.missingPeers : [])
    : (Array.isArray(invite?.peers) ? invite.peers : []);
  if (peers.length) {
    const inputs = [];
    for (const peer of peers) {
      const chat = findChatForPeer(chats, peer);
      if (chat?.className === "ChannelForbidden") continue;
      try { inputs.push(await inputPeer(client, peer)); } catch {}
    }
    if (inputs.length) {
      if (isAlready) {
        await client.api.chatlists.joinChatlistUpdates({
          chatlist: new Api.InputChatlistDialogFilter({ filterId: Number(invite.filterId) }),
          peers: inputs,
        });
      } else {
        await client.api.chatlists.joinChatlistInvite({ slug: parsed.slug, peers: inputs });
      }
    }
  }
  return { invite, chats };
}

async function processEntityForAccount(uid, account, client, entity, source) {
  const id = await entityPeerId(client, entity);
  const base = destinationFromEntity(entity, id, source);
  const assessment = await assessEntity(client, entity);
  base.accountJoin[account.id] = accountJoinEntry(assessment.status === "needs_topic" ? "ready" : assessment.status, assessment.reason);
  base.joinStatus = assessment.status;
  if (assessment.status === "needs_topic") upsertTopicQueue(uid, base, assessment.topics);
  const saved = saveDestination(uid, base);
  if (assessment.status === "needs_topic") saved.destination.joinStatus = "needs_topic";
  return { ...saved, assessment };
}

async function processParsedForAccount(uid, account, client, parsed) {
  if (parsed.kind === "addlist") {
    const { chats } = await importAddlist(client, parsed);
    const rows = [];
    for (const entity of chats) {
      if (!entity || entity?.className === "ChannelForbidden") continue;
      try { rows.push(await processEntityForAccount(uid, account, client, entity, parsed)); }
      catch (err) { rows.push({ error: String(err?.message || err), source: entityLabel(entity) }); }
    }
    return rows;
  }
  const joined = parsed.kind === "invite" ? await joinPrivateInvite(client, parsed) : await joinPublic(client, parsed);
  if (!joined.entity) {
    addUnresolvedInvite(uid, {
      accountId: account.id,
      kind: parsed.kind,
      hash: parsed.hash || "",
      username: parsed.username || "",
      original: parsed.original,
      status: joined.status,
      reason: joined.reason,
    });
    return [{ pendingOnly: true, label: parsed.original, status: joined.status, reason: joined.reason }];
  }
  return [await processEntityForAccount(uid, account, client, joined.entity, parsed)];
}

function summaryCounts(groups) {
  const counts = { ready: 0, needs_topic: 0, pending: 0, verification: 0, partial: 0, read_only: 0, failed: 0 };
  for (const group of groups || []) {
    const status = overallStatus(group);
    if (counts[status] === undefined) counts.failed++;
    else counts[status]++;
  }
  return counts;
}
function groupDisplay(group) {
  const base = String(group?.username || group?.label || group?.id || "Destination");
  return group?.topicTitle ? `${base} → ${group.topicTitle}` : base;
}
export function destinationMenu(uid) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const counts = summaryCounts(groups);
  const store = readAutomation(uid);
  const unresolved = store.unresolvedInvites.length;
  const lines = groups.slice(0, 12).map(group => {
    const status = overallStatus(group);
    const icon = status === "ready" ? "✅" : status === "needs_topic" ? "💬" : status === "pending" ? "⏳" : status === "verification" ? "🛡" : status === "partial" ? "◐" : "⚠️";
    return `${icon} ${groupDisplay(group)}`;
  });
  if (groups.length > 12) lines.push(`… and ${groups.length - 12} more`);
  const text = [
    "📍 Destinations",
    "",
    `Saved  ${groups.length}`,
    `Ready  ${counts.ready}`,
    counts.needs_topic ? `Choose topic  ${counts.needs_topic}` : null,
    counts.pending || unresolved ? `Pending approval  ${counts.pending + unresolved}` : null,
    counts.verification ? `Verification needed  ${counts.verification}` : null,
    counts.partial ? `Partially ready  ${counts.partial}` : null,
    "",
    lines.length ? lines.join("\n") : "No destinations yet.",
  ].filter(Boolean).join("\n");
  const kb = new InlineKeyboard().text("＋ Add destinations", "add_group").row();
  if (counts.needs_topic) kb.text(`💬 Choose topics (${counts.needs_topic})`, "dest_topics").row();
  if (counts.pending || counts.verification || counts.partial || unresolved) kb.text("⏳ Pending & verification", "dest_pending").row();
  if (groups.length) kb.text("Manage", "remove_group_menu").text("Advanced routing", "route_groups:0").row();
  kb.text("← Home", "home");
  return { text, keyboard: kb };
}

export async function handleDestinationText(uid, text) {
  const id = String(uid || "");
  const settings = readAppSettings(id);
  const accounts = listAccounts(id);
  const selectedIds = effectiveAccountIds(settings, null, accounts);
  const byId = new Map(accounts.map(account => [String(account.id), account]));
  const rawLines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsed = [];
  let invalid = 0;
  for (const line of rawLines) {
    const item = parseDestinationInput(line);
    if (!item) invalid++;
    else if (!parsed.some(existing => JSON.stringify(existing) === JSON.stringify(item))) parsed.push(item);
  }
  if (!parsed.length) return { added: 0, duplicates: 0, failed: invalid || 1, attention: 0, text: "No valid Telegram destinations were found." };
  if (!selectedIds.length) {
    return { requiresPersonal: true, parsed, invalid, added: 0, duplicates: 0, failed: 0, attention: 0 };
  }
  const before = new Set((settings.groups || []).map(group => String(group.id)));
  const failures = [];
  let pendingOnly = 0;
  const touched = new Set();
  for (const accountId of selectedIds) {
    const account = byId.get(String(accountId));
    if (!account) continue;
    let client;
    try {
      client = await openAccountClient(id, account);
      for (let index = 0; index < parsed.length; index++) {
        const item = parsed[index];
        try {
          const rows = await processParsedForAccount(id, account, client, item);
          for (const row of rows) {
            if (row?.destination?.id) touched.add(String(row.destination.id));
            if (row?.pendingOnly) pendingOnly++;
            if (row?.error) failures.push(`${row.source || item.original} — ${row.error}`);
          }
        } catch (err) {
          const code = errorCode(err);
          const label = item.original;
          if (code.includes("FLOOD_WAIT")) {
            failures.push(`${label} — Telegram rate-limited joining. Try again later.`);
            break;
          }
          if (code.includes("INVITE_SLUG_EXPIRED") || code.includes("INVITE_HASH_EXPIRED")) failures.push(`${label} — invite expired.`);
          else if (code.includes("CHANNELS_TOO_MUCH")) failures.push(`${label} — this account has reached Telegram's joined-channel limit.`);
          else if (code.includes("USER_BANNED_IN_CHANNEL")) failures.push(`${label} — this account is banned from that destination.`);
          else failures.push(`${label} — ${String(err?.message || err).slice(0, 160)}`);
        }
        if (index < parsed.length - 1) await sleep(JOIN_GAP_MS);
      }
    } catch (err) {
      failures.push(`${accountDisplayLabel(account)} — ${String(err?.message || err).slice(0, 160)}`);
      updateAccountStatus(id, account.id, { status: "unknown", lastError: String(err?.message || err).slice(0, 180), lastVerifiedAt: Date.now() });
    } finally {
      try { await client?.disconnect(); } catch {}
    }
  }
  const afterSettings = readAppSettings(id);
  const afterGroups = Array.isArray(afterSettings.groups) ? afterSettings.groups : [];
  const added = afterGroups.filter(group => !before.has(String(group.id))).length;
  const duplicates = [...touched].filter(value => before.has(value)).length;
  const counts = summaryCounts(afterGroups);
  const attention = counts.needs_topic + counts.pending + counts.verification + counts.partial + pendingOnly;
  const summary = [
    "✅ Destination import complete",
    `Added — ${added}`,
    `Already saved — ${duplicates}`,
    `Needs attention — ${attention}`,
    `Failed / invalid — ${failures.length + invalid}`,
  ];
  if (counts.needs_topic) summary.push(`Topics to choose — ${counts.needs_topic}`);
  if (pendingOnly || counts.pending) summary.push(`Awaiting approval — ${pendingOnly + counts.pending}`);
  if (counts.verification) summary.push(`Verification required — ${counts.verification}`);
  if (failures.length) summary.push("", ...failures.slice(0, 8));
  return { added, duplicates, failed: failures.length + invalid, attention, text: summary.join("\n") };
}

function topicQueueForGroups(uid) {
  const settings = readAppSettings(uid);
  const groups = new Map((settings.groups || []).map(group => [String(group.id), group]));
  const store = readAutomation(uid);
  store.topicQueue = store.topicQueue.filter(item => {
    const group = groups.get(String(item.destinationId));
    return group && group.topicRequired === true && !Number(group.topicId || 0);
  });
  writeAutomation(uid, store);
  return store.topicQueue;
}
async function showTopicIndex(ctx) {
  const uid = String(ctx.from?.id || "");
  const queue = topicQueueForGroups(uid);
  const kb = new InlineKeyboard();
  for (const item of queue.slice(0, 12)) kb.text(`💬 ${String(item.label).slice(0, 40)}`, `dest_topic_page:${item.token}:0`).row();
  kb.text("← Destinations", "groups");
  await ctx.editMessageText([
    "💬 Choose posting topics",
    "",
    queue.length ? `${queue.length} forum destination${queue.length === 1 ? " needs" : "s need"} a topic.` : "All forum destinations have a posting topic selected.",
    "",
    "TelePilot can suggest likely advertising topics, but it will never silently guess where to post.",
  ].join("\n"), { reply_markup: kb });
}
async function showTopicPage(ctx, token, requestedPage = 0) {
  const uid = String(ctx.from?.id || "");
  const item = topicQueueForGroups(uid).find(row => row.token === token);
  if (!item) return showTopicIndex(ctx);
  const pages = Math.max(1, Math.ceil(item.topics.length / TOPIC_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
  const start = page * TOPIC_PAGE_SIZE;
  const kb = new InlineKeyboard();
  for (const topic of item.topics.slice(start, start + TOPIC_PAGE_SIZE)) {
    const star = Number(topic.id) === Number(item.suggestedId) ? "⭐ " : "";
    kb.text(`${star}${String(topic.title).slice(0, 42)}`, `dest_topic_pick:${token}:${topic.id}`).row();
  }
  if (pages > 1) {
    if (page > 0) kb.text("◀ Prev", `dest_topic_page:${token}:${page - 1}`);
    if (page < pages - 1) kb.text("Next ▶", `dest_topic_page:${token}:${page + 1}`);
    kb.row();
  }
  kb.text("Choose later", "groups").row().text("← Forum groups", "dest_topics");
  await ctx.editMessageText([
    `💬 ${item.label}`,
    "",
    item.suggestedId ? "⭐ TelePilot highlighted the most likely advertising topic. Check it before selecting." : "Choose the exact topic where TelePilot should post.",
    "",
    `Page ${page + 1}/${pages}`,
  ].join("\n"), { reply_markup: kb });
}
function chooseTopic(uid, token, topicId) {
  const store = readAutomation(uid);
  const item = store.topicQueue.find(row => row.token === token);
  if (!item) return null;
  const topic = item.topics.find(row => Number(row.id) === Number(topicId));
  if (!topic) return null;
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const group = groups.find(row => String(row.id) === String(item.destinationId));
  if (!group) return null;
  group.topicId = Number(topic.id);
  group.topicTitle = String(topic.title || "");
  group.topicRequired = true;
  group.joinStatus = overallStatus(group);
  if (group.joinStatus === "needs_topic") group.joinStatus = Object.values(group.accountJoin || {}).some(row => row.status === "ready") ? "ready" : overallStatus({ ...group, topicRequired: false });
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  store.topicQueue = store.topicQueue.filter(row => row.token !== token);
  writeAutomation(uid, store);
  syncUserGroups(uid);
  return { group, topic };
}

async function showPending(ctx) {
  const uid = String(ctx.from?.id || "");
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const store = readAutomation(uid);
  const lines = [];
  for (const group of groups) {
    const rows = Object.entries(group.accountJoin || {}).filter(([, row]) => row?.status && row.status !== "ready");
    for (const [accountId, row] of rows.slice(0, 30)) {
      const account = listAccounts(uid).find(item => item.id === accountId);
      const name = account ? accountDisplayLabel(account) : "Sender";
      const icon = row.status === "pending" ? "⏳" : row.status === "verification" ? "🛡" : "⚠️";
      lines.push(`${icon} ${groupDisplay(group)} · ${name}\n${row.reason || row.status}`);
    }
  }
  for (const row of store.unresolvedInvites.slice(0, 20)) lines.push(`⏳ ${row.original || "Private invite"}\n${row.reason || "Waiting for approval"}`);
  const kb = new InlineKeyboard().text("↻ Check again", "dest_recheck").row().text("← Destinations", "groups");
  await ctx.editMessageText([
    "⏳ Pending & verification",
    "",
    lines.length ? lines.join("\n\n") : "Nothing currently needs attention.",
    "",
    "TelePilot does not bypass captchas or verification bots. Complete those steps in Telegram; TelePilot will recheck automatically.",
  ].join("\n"), { reply_markup: kb });
}

async function resolveForRecheck(client, group) {
  if (group.username) return client.getEntity(group.username);
  return client.getEntity(group.id);
}
async function recheckGroupAccount(uid, group, account, client) {
  let entity;
  try { entity = await resolveForRecheck(client, group); }
  catch { return false; }
  const assessment = await assessEntity(client, entity);
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const current = groups.find(row => String(row.id) === String(group.id));
  if (!current) return false;
  current.accountJoin = { ...(current.accountJoin || {}) };
  current.accountJoin[account.id] = accountJoinEntry(assessment.status === "needs_topic" ? "ready" : assessment.status, assessment.reason);
  current.topicRequired = current.topicRequired === true || entity?.forum === true;
  if (assessment.status === "needs_topic" && !Number(current.topicId || 0)) upsertTopicQueue(uid, current, assessment.topics);
  current.joinStatus = overallStatus(current);
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  return true;
}
async function recheckUnresolved(uid, item, account, client) {
  if (item.kind === "invite" && item.hash) {
    try {
      const checked = await client.checkChatInvite(item.hash);
      if (!checked?.chat) return false;
      await processEntityForAccount(uid, account, client, checked.chat, item);
      removeUnresolvedInvite(uid, item.key);
      return true;
    } catch { return false; }
  }
  if (item.kind === "public" && item.username) {
    try {
      const entity = await client.getEntity(`@${item.username}`);
      const assessment = await assessEntity(client, entity);
      if (assessment.status === "pending") return false;
      await processEntityForAccount(uid, account, client, entity, item);
      removeUnresolvedInvite(uid, item.key);
      return true;
    } catch { return false; }
  }
  return false;
}
export async function recheckDestinations(uid, maxItems = RECHECK_PER_TICK) {
  const id = String(uid || "");
  const accounts = listAccounts(id);
  if (!accounts.length) return { checked: 0, changed: 0 };
  const byId = new Map(accounts.map(account => [account.id, account]));
  const settings = readAppSettings(id);
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const work = [];
  for (const group of groups) {
    for (const [accountId, row] of Object.entries(group.accountJoin || {})) {
      if (["pending", "verification", "read_only", "failed"].includes(String(row?.status || ""))) work.push({ type: "group", group, accountId });
    }
  }
  const store = readAutomation(id);
  for (const item of store.unresolvedInvites) work.push({ type: "invite", item, accountId: item.accountId });
  let checked = 0, changed = 0;
  const clients = new Map();
  try {
    for (const item of work.slice(0, Math.max(1, Number(maxItems) || RECHECK_PER_TICK))) {
      const account = byId.get(String(item.accountId));
      if (!account) continue;
      let client = clients.get(account.id);
      if (!client) { try { client = await openAccountClient(id, account); clients.set(account.id, client); } catch { continue; } }
      checked++;
      if (item.type === "group") changed += (await recheckGroupAccount(id, item.group, account, client)) ? 1 : 0;
      else changed += (await recheckUnresolved(id, item.item, account, client)) ? 1 : 0;
    }
  } finally { for (const client of clients.values()) try { await client.disconnect(); } catch {} }
  if (changed) syncUserGroups(id);
  return { checked, changed };
}

function installHandlers(bot) {
  bot.callbackQuery("dest_topics", async ctx => { await ctx.answerCallbackQuery(); await showTopicIndex(ctx); });
  bot.callbackQuery(/^dest_topic_page:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    await showTopicPage(ctx, String(ctx.match?.[1] || ""), Number(ctx.match?.[2] || 0));
  });
  bot.callbackQuery(/^dest_topic_pick:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {
    const result = chooseTopic(String(ctx.from?.id || ""), String(ctx.match?.[1] || ""), Number(ctx.match?.[2] || 0));
    if (!result) return ctx.answerCallbackQuery({ text: "That topic is no longer available.", show_alert: true });
    await ctx.answerCallbackQuery({ text: `Posting topic: ${result.topic.title}` });
    await showTopicIndex(ctx);
  });
  bot.callbackQuery("dest_pending", async ctx => { await ctx.answerCallbackQuery(); await showPending(ctx); });
  bot.callbackQuery("dest_recheck", async ctx => {
    await ctx.answerCallbackQuery({ text: "Checking…" });
    await recheckDestinations(String(ctx.from?.id || ""), 30);
    await showPending(ctx);
  });
}
export function installDestinationAutomation(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotDestinationAutomationInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for destination automation");
  Object.defineProperty(BotClass.prototype, "__telepilotDestinationAutomationInstalled", { value: true });
  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotDestinationAutomationHandlersRegistered) {
      Object.defineProperty(this, "__telepilotDestinationAutomationHandlersRegistered", { value: true });
      installHandlers(this);
    }
    return originalStart.apply(this, args);
  };
}

let workerTimer = null;
let workerBusy = false;
export function startDestinationAutomationWorker() {
  if (workerTimer || !API_ID || !API_HASH) return workerTimer;
  const tick = async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
      for (const uid of listUserIds()) {
        const store = readAutomation(uid);
        const settings = readAppSettings(uid);
        const hasAttention = store.unresolvedInvites.length || (settings.groups || []).some(group => Object.values(group.accountJoin || {}).some(row => ["pending", "verification"].includes(String(row?.status || ""))));
        if (!hasAttention) continue;
        try { await recheckDestinations(uid, RECHECK_PER_TICK); } catch (err) { console.warn(`Destination recheck failed for ${uid}:`, err?.message || err); }
      }
    } finally { workerBusy = false; }
  };
  workerTimer = setInterval(() => void tick(), WORKER_INTERVAL_MS);
  workerTimer.unref?.();
  setTimeout(() => void tick(), 60_000).unref?.();
  console.log("TelePilot destination approval/verification worker enabled");
  return workerTimer;
}
