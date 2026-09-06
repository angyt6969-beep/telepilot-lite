import fs from "node:fs";
import path from "node:path";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { listAccounts, loadAccountSession } from "./account-store.js";
import { listUserIds, readAppSettings, writeAppSettings } from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const WORKER_INTERVAL_MS = 5_000;
const NORMAL_RECHECK_MS = 30 * 60_000;
const MAX_LINKS = 100;
const recentImports = new Map();

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function storePath(uid) { return path.join(userDir(uid), "addlist-reconciliation.json"); }
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
function readStore(uid) {
  const raw = readJson(storePath(uid), {});
  return {
    version: 1,
    links: (Array.isArray(raw.links) ? raw.links : []).map(row => ({
      accountId: String(row?.accountId || ""),
      slug: cleanSlug(row?.slug),
      nextCheckAt: Math.max(0, Number(row?.nextCheckAt || 0) || 0),
      attempts: Math.max(0, Number(row?.attempts || 0) || 0),
      lastCheckedAt: Math.max(0, Number(row?.lastCheckedAt || 0) || 0),
      confirmed: Math.max(0, Number(row?.confirmed || 0) || 0),
      lastError: String(row?.lastError || "").slice(0, 180),
    })).filter(row => row.accountId && row.slug).slice(-MAX_LINKS),
  };
}
function writeStore(uid, store) {
  const normalized = { version: 1, links: (store.links || []).slice(-MAX_LINKS) };
  writeJsonAtomic(storePath(uid), normalized);
  return normalized;
}
function linkKey(accountId, slug) { return `${String(accountId)}|${cleanSlug(slug)}`; }
function queueLink(uid, accountId, slug, delayMs = 12_000) {
  const id = String(uid || ""), account = String(accountId || ""), clean = cleanSlug(slug);
  if (!id || !account || !clean) return false;
  const store = readStore(id);
  const key = linkKey(account, clean);
  const requestedAt = Date.now() + Math.max(1_000, Number(delayMs) || 0);
  const index = store.links.findIndex(row => linkKey(row.accountId, row.slug) === key);
  let changed = false;
  if (index >= 0) {
    const current = Number(store.links[index].nextCheckAt || 0);
    const next = current > 0 ? Math.min(current, requestedAt) : requestedAt;
    if (next !== current) {
      store.links[index].nextCheckAt = next;
      changed = true;
    }
  } else {
    store.links.push({ accountId: account, slug: clean, nextCheckAt: requestedAt, attempts: 0, lastCheckedAt: 0, confirmed: 0, lastError: "" });
    changed = true;
  }
  if (changed) writeStore(id, store);
  recentImports.set(id, Date.now());
  return true;
}
function seedLinksFromDestinations(uid) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const validAccounts = new Set(accounts.map(account => String(account.id)));
  const wanted = new Map();
  for (const group of settings.groups || []) {
    const slug = cleanSlug(group?.sourceSlug);
    if (group?.source !== "addlist" || !slug) continue;
    for (const accountId of Object.keys(group?.accountJoin || {})) {
      if (!validAccounts.has(String(accountId))) continue;
      wanted.set(linkKey(accountId, slug), { accountId: String(accountId), slug });
    }
  }
  if (!wanted.size) return false;
  const store = readStore(uid);
  const existing = new Set(store.links.map(row => linkKey(row.accountId, row.slug)));
  let changed = false;
  for (const [key, value] of wanted) {
    if (existing.has(key) || store.links.length >= MAX_LINKS) continue;
    store.links.push({ ...value, nextCheckAt: Date.now() + NORMAL_RECHECK_MS, attempts: 0, lastCheckedAt: 0, confirmed: 0, lastError: "" });
    existing.add(key);
    changed = true;
  }
  if (changed) writeStore(uid, store);
  return changed;
}
function requestClassName(request) { return String(request?.className || request?.constructor?.className || ""); }
function requestSlug(request) { return cleanSlug(request?.slug || ""); }
function floodWaitSeconds(err) {
  for (const value of [err?.seconds, err?.value]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.ceil(number);
  }
  const text = String(err?.errorMessage || err?.description || err?.message || err || "").toUpperCase();
  const match = text.match(/(?:FLOOD_WAIT|PLEASE WAIT|WAIT)(?:_|\s|\(|:|-)*(\d+)/);
  return match ? Math.max(1, Number(match[1])) : 0;
}

export function installAddlistReconciliation(TelegramClientClass = TelegramClient) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotAddlistReconciliationInstalled) return;
  const originalInvoke = proto.invoke;
  if (typeof originalInvoke !== "function") throw new Error("Unsupported TelegramClient shape for Addlist reconciliation");
  Object.defineProperty(proto, "__telepilotAddlistReconciliationInstalled", { value: true });
  proto.invoke = async function(request, ...rest) {
    const result = await originalInvoke.call(this, request, ...rest);
    if (this.__telepilotAddlistReconcileWorker === true) return result;
    const uid = String(this.__telepilotOwnerUid || "");
    const accountId = String(this.__telepilotAccountId || "");
    if (!uid || !accountId) return result;
    const name = requestClassName(request);
    if (name === "chatlists.CheckChatlistInvite" || name === "chatlists.JoinChatlistInvite") {
      const slug = requestSlug(request);
      if (slug) queueLink(uid, accountId, slug, name === "chatlists.JoinChatlistInvite" ? 3_000 : 12_000);
    } else if (name === "chatlists.JoinChatlistUpdates") {
      const store = readStore(uid);
      let changed = false;
      for (const row of store.links) {
        if (String(row.accountId) !== accountId) continue;
        const next = Date.now() + 3_000;
        if (!row.nextCheckAt || row.nextCheckAt > next) {
          row.nextCheckAt = next;
          changed = true;
        }
      }
      if (changed) writeStore(uid, store);
      recentImports.set(uid, Date.now());
    }
    return result;
  };
}

function peerKey(peer) {
  return String(peer?.channelId || peer?.chatId || peer?.userId || peer?.id || "").replace(/\D/g, "");
}
function chatKey(chat) { return String(chat?.id || "").replace(/\D/g, ""); }
function findChat(chats, peer) {
  const wanted = peerKey(peer);
  return wanted ? (chats || []).find(chat => chatKey(chat) === wanted) || null : null;
}
function peerIdForChat(chat) {
  const raw = chatKey(chat);
  if (!raw) return "";
  if (chat?.broadcast === true || chat?.megagroup === true || chat?.forum === true || chat?.className === "Channel") return `-100${raw}`;
  return `-${raw}`;
}
function usernameForChat(chat) {
  const username = String(chat?.username || "").replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(username) ? `@${username}` : "";
}
function labelForChat(chat) { return String(chat?.title || chat?.username || chat?.id || "Destination").slice(0, 120); }
function canPostToChat(chat) {
  if (chat?.broadcast !== true) return true;
  return chat?.creator === true || chat?.adminRights?.postMessages === true || chat?.admin_rights?.post_messages === true;
}
function mergeConfirmedDestinations(uid, accountId, slug, chats) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const byId = new Map(groups.map((group, index) => [String(group.id), index]));
  let added = 0;
  let updated = 0;
  for (const chat of chats) {
    const id = peerIdForChat(chat);
    if (!id || chat?.className === "ChannelForbidden") continue;
    const forum = chat?.forum === true;
    const status = canPostToChat(chat) ? "ready" : "read_only";
    const incoming = {
      id,
      label: labelForChat(chat),
      type: chat?.broadcast === true ? "channel" : (chat?.megagroup === true || forum || chat?.className === "Channel") ? "supergroup" : "group",
      username: usernameForChat(chat),
      accountMode: "inherit",
      accountIds: [],
      topicId: forum ? 1 : null,
      topicTitle: forum ? "General" : "",
      topicRequired: forum,
      autoGeneralTopic: forum,
      joinStatus: status,
      accountJoin: { [String(accountId)]: { status, reason: status === "read_only" ? "Joined, but this sender cannot publish to this channel." : "", checkedAt: Date.now() } },
      source: "addlist",
      sourceSlug: slug,
      importedAt: Date.now(),
    };
    const index = byId.get(id);
    if (index === undefined) {
      groups.push(incoming);
      byId.set(id, groups.length - 1);
      added++;
    } else {
      const existing = groups[index];
      groups[index] = {
        ...existing,
        label: incoming.label || existing.label,
        type: incoming.type || existing.type,
        username: incoming.username || existing.username,
        topicRequired: incoming.topicRequired === true || existing.topicRequired === true,
        topicId: Number(existing.topicId || 0) > 0 ? existing.topicId : incoming.topicId,
        topicTitle: existing.topicTitle || incoming.topicTitle,
        autoGeneralTopic: existing.autoGeneralTopic === true || incoming.autoGeneralTopic === true,
        accountJoin: { ...(existing.accountJoin || {}), ...incoming.accountJoin },
        source: existing.source || "addlist",
        sourceSlug: existing.sourceSlug || slug,
      };
      updated++;
    }
  }
  if (added || updated) {
    writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
    syncUserGroups(uid);
  }
  return { added, updated, total: groups.length };
}
async function inputPeers(client, peers, chats) {
  const out = [];
  for (const peer of peers || []) {
    const chat = findChat(chats, peer);
    if (chat?.className === "ChannelForbidden") continue;
    try { out.push(await client.getInputEntity(peer)); } catch {}
  }
  return out;
}
async function openClient(uid, account) {
  const client = new TelegramClient(new StringSession(loadAccountSession(uid, account.id)), API_ID, API_HASH, {
    connectionRetries: 5,
    floodSleepThreshold: 0,
  });
  client.__telepilotAddlistReconcileWorker = true;
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Saved Telegram session is no longer authorized");
  return client;
}
async function reconcileLink(uid, account, row) {
  let client;
  try {
    client = await openClient(uid, account);
    let invite = await client.api.chatlists.checkChatlistInvite({ slug: row.slug });
    let chats = Array.isArray(invite?.chats) ? invite.chats : [];
    let isAlready = invite?.className === "ChatlistInviteAlready" || Number.isInteger(Number(invite?.filterId));
    const peers = isAlready ? (Array.isArray(invite?.missingPeers) ? invite.missingPeers : []) : (Array.isArray(invite?.peers) ? invite.peers : []);
    const inputs = await inputPeers(client, peers, chats);
    if (inputs.length) {
      if (isAlready) {
        await client.api.chatlists.joinChatlistUpdates({
          chatlist: new Api.InputChatlistDialogFilter({ filterId: Number(invite.filterId) }),
          peers: inputs,
        });
      } else {
        await client.api.chatlists.joinChatlistInvite({ slug: row.slug, peers: inputs });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      invite = await client.api.chatlists.checkChatlistInvite({ slug: row.slug });
      chats = Array.isArray(invite?.chats) ? invite.chats : [];
      isAlready = invite?.className === "ChatlistInviteAlready" || Number.isInteger(Number(invite?.filterId));
    }

    const confirmedPeers = isAlready ? (Array.isArray(invite?.alreadyPeers) ? invite.alreadyPeers : []) : [];
    const confirmedChats = [];
    const seen = new Set();
    for (const peer of confirmedPeers) {
      const chat = findChat(chats, peer);
      const key = chatKey(chat);
      if (!chat || !key || seen.has(key) || chat?.className === "ChannelForbidden") continue;
      seen.add(key);
      confirmedChats.push(chat);
    }
    const merged = mergeConfirmedDestinations(uid, account.id, row.slug, confirmedChats);
    row.confirmed = confirmedChats.length;
    row.attempts = 0;
    row.lastError = "";
    row.lastCheckedAt = Date.now();
    row.nextCheckAt = Date.now() + NORMAL_RECHECK_MS;
    if (merged.added) console.log(`Addlist reconciliation added ${merged.added} destination(s) for ${uid}/${account.id}`);
  } catch (err) {
    row.attempts = Number(row.attempts || 0) + 1;
    row.lastCheckedAt = Date.now();
    row.lastError = String(err?.errorMessage || err?.message || err).slice(0, 180);
    const seconds = floodWaitSeconds(err);
    if (seconds) row.nextCheckAt = Date.now() + (seconds + 2) * 1000;
    else row.nextCheckAt = Date.now() + Math.min(30 * 60_000, 10_000 * (2 ** Math.min(7, row.attempts)));
    console.warn(`Addlist reconciliation failed for ${uid}/${account.id}: ${row.lastError}`);
  } finally {
    try { await client?.disconnect(); } catch {}
  }
}

async function processUser(uid) {
  seedLinksFromDestinations(uid);
  const accounts = listAccounts(uid);
  if (!accounts.length) return;
  const byId = new Map(accounts.map(account => [String(account.id), account]));
  const store = readStore(uid);
  const row = store.links.find(link => Number(link.nextCheckAt || 0) <= Date.now() && byId.has(String(link.accountId)));
  if (!row) return;
  await reconcileLink(uid, byId.get(String(row.accountId)), row);
  writeStore(uid, store);
}

export function recentAddlistImport(uid, withinMs = 90_000) {
  return Date.now() - Number(recentImports.get(String(uid || "")) || 0) <= Math.max(1_000, Number(withinMs) || 90_000);
}

let timer = null;
let busy = false;
export function startAddlistReconciliationWorker() {
  if (timer || !API_ID || !API_HASH) return timer;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const uid of listUserIds()) {
        try { await processUser(uid); }
        catch (err) { console.warn(`Addlist reconciliation worker failed for ${uid}: ${String(err?.message || err).slice(0, 160)}`); }
      }
    } finally { busy = false; }
  };
  timer = setInterval(() => void tick(), WORKER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 4_000).unref?.();
  console.log("TelePilot Addlist reconciliation worker enabled");
  return timer;
}
