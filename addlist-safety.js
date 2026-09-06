import fs from "node:fs";
import path from "node:path";
import { Api, TelegramClient } from "teleproto";
import { queueDestinationCleanup } from "./archive-mute-queue-v3.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const STANDARD_FOLDER_CHAT_LIMIT = 100;
const PREMIUM_FOLDER_CHAT_LIMIT = 200;
const CHATLIST_UPDATE_PERIOD_MS = 60 * 60_000;
const stateByClient = new WeakMap();

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function capacityPath(uid) { return path.join(userDir(uid), "addlist-capacity.json"); }
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function requestClassName(request) { return String(request?.className || request?.constructor?.className || ""); }
function valueString(value) {
  try { return String(value?.toString?.() ?? value ?? ""); }
  catch { return String(value || ""); }
}
function peerKey(peer) {
  const raw = peer?.channelId ?? peer?.chatId ?? peer?.userId ?? peer?.id ?? "";
  return valueString(raw).replace(/\D/g, "");
}
function chatKey(chat) { return valueString(chat?.id || "").replace(/\D/g, ""); }
function isAlreadyInvite(result) {
  return result?.className === "ChatlistInviteAlready" || Number.isInteger(Number(result?.filterId));
}
function mutateArray(target, values) {
  if (!Array.isArray(target)) return;
  target.splice(0, target.length, ...(Array.isArray(values) ? values : []));
}
function chatsForPeers(chats, peers) {
  const wanted = new Set((Array.isArray(peers) ? peers : []).map(peerKey).filter(Boolean));
  if (!wanted.size) return [];
  return (Array.isArray(chats) ? chats : []).filter(chat => wanted.has(chatKey(chat)) && chat?.className !== "ChannelForbidden");
}
function stateFor(client) {
  let state = stateByClient.get(client);
  if (!state) {
    state = { premium: null, checksBySlug: new Map(), checksByFilter: new Map(), updateCache: new Map() };
    stateByClient.set(client, state);
  }
  return state;
}
async function folderLimit(client, originalInvoke) {
  const state = stateFor(client);
  if (state.premium !== null) return state.premium ? PREMIUM_FOLDER_CHAT_LIMIT : STANDARD_FOLDER_CHAT_LIMIT;
  try {
    const me = typeof client.getMe === "function" ? await client.getMe() : null;
    state.premium = me?.premium === true;
  } catch {
    state.premium = false;
  }
  return state.premium ? PREMIUM_FOLDER_CHAT_LIMIT : STANDARD_FOLDER_CHAT_LIMIT;
}
function inputPeerDescriptor(peer) {
  if (!peer || typeof peer !== "object") return null;
  if (peer?.channelId !== undefined) {
    const channelId = valueString(peer.channelId).replace(/\D/g, "");
    const accessHash = valueString(peer.accessHash);
    if (channelId && /^-?\d+$/.test(accessHash)) return { kind: "channel", channelId, accessHash };
  }
  if (peer?.chatId !== undefined) {
    const chatId = valueString(peer.chatId).replace(/\D/g, "");
    if (chatId) return { kind: "chat", chatId };
  }
  return null;
}
function chatPeerDescriptor(chat) {
  if (!chat || chat?.className === "ChannelForbidden") return null;
  const id = chatKey(chat);
  if (!id) return null;
  if (chat?.className === "Channel" || chat?.broadcast === true || chat?.megagroup === true || chat?.forum === true) {
    const accessHash = valueString(chat?.accessHash);
    if (!/^-?\d+$/.test(accessHash)) return null;
    return { kind: "channel", channelId: id, accessHash };
  }
  return { kind: "chat", chatId: id };
}
function destinationIdForChat(chat) {
  const id = chatKey(chat);
  if (!id) return "";
  if (chat?.className === "Channel" || chat?.broadcast === true || chat?.megagroup === true || chat?.forum === true) return `-100${id}`;
  return `-${id}`;
}
function queueConfirmedCleanup(client, chats) {
  const uid = String(client.__telepilotOwnerUid || "");
  const accountId = String(client.__telepilotAccountId || "");
  if (!uid || !accountId) return;
  for (const chat of chats || []) {
    const destinationId = destinationIdForChat(chat);
    const descriptor = chatPeerDescriptor(chat);
    if (destinationId) queueDestinationCleanup(uid, accountId, destinationId, descriptor);
  }
}
function recordCapacity(client, data) {
  const uid = String(client.__telepilotOwnerUid || "");
  if (!uid) return;
  writeJsonAtomic(capacityPath(uid), {
    slug: String(data?.slug || ""),
    total: Math.max(0, Number(data?.total || 0) || 0),
    limit: Math.max(0, Number(data?.limit || 0) || 0),
    confirmed: Math.max(0, Number(data?.confirmed || 0) || 0),
    premium: data?.premium === true,
    at: Date.now(),
  });
}
export function recentAddlistCapacity(uid, withinMs = 120_000) {
  const row = readJson(capacityPath(String(uid || "")), null);
  if (!row || Date.now() - Number(row.at || 0) > Math.max(1_000, Number(withinMs) || 120_000)) return null;
  return row;
}
function storeCheck(client, slug, result) {
  const state = stateFor(client);
  const fullChats = Array.isArray(result?.chats) ? result.chats.slice() : [];
  const row = { slug: String(slug || ""), result, fullChats, at: Date.now() };
  if (row.slug) state.checksBySlug.set(row.slug, row);
  if (Number.isInteger(Number(result?.filterId))) state.checksByFilter.set(String(Number(result.filterId)), row);
  if (isAlreadyInvite(result)) {
    const confirmed = chatsForPeers(fullChats, result?.alreadyPeers);
    mutateArray(result.chats, confirmed);
    queueConfirmedCleanup(client, confirmed);
  }
  return row;
}
function updateCheckFromRefresh(client, row, refreshed) {
  if (!row || !refreshed) return;
  row.fullChats = Array.isArray(refreshed?.chats) ? refreshed.chats.slice() : [];
  row.at = Date.now();
  const confirmed = isAlreadyInvite(refreshed) ? chatsForPeers(row.fullChats, refreshed?.alreadyPeers) : [];
  mutateArray(row.result?.chats, confirmed);
  if (refreshed?.alreadyPeers !== undefined) row.result.alreadyPeers = refreshed.alreadyPeers;
  if (refreshed?.missingPeers !== undefined) row.result.missingPeers = refreshed.missingPeers;
  if (refreshed?.filterId !== undefined) row.result.filterId = refreshed.filterId;
  queueConfirmedCleanup(client, confirmed);
  const state = stateFor(client);
  if (Number.isInteger(Number(refreshed?.filterId))) state.checksByFilter.set(String(Number(refreshed.filterId)), row);
}
function requestedTotal(row) {
  if (!row?.result) return 0;
  if (isAlreadyInvite(row.result)) return (row.result.alreadyPeers?.length || 0) + (row.result.missingPeers?.length || 0);
  return row.result.peers?.length || 0;
}

export function installAddlistSafety(TelegramClientClass = TelegramClient) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotAddlistSafetyInstalled) return;
  const originalInvoke = proto.invoke;
  if (typeof originalInvoke !== "function") throw new Error("Unsupported TelegramClient shape for Addlist safety");
  Object.defineProperty(proto, "__telepilotAddlistSafetyInstalled", { value: true });

  proto.invoke = async function(request, ...rest) {
    const name = requestClassName(request);

    if (name === "chatlists.CheckChatlistInvite") {
      const result = await originalInvoke.call(this, request, ...rest);
      storeCheck(this, String(request?.slug || ""), result);
      return result;
    }

    if (name === "chatlists.GetChatlistUpdates") {
      const filterId = String(Number(request?.chatlist?.filterId || 0));
      const state = stateFor(this);
      const cached = state.updateCache.get(filterId);
      if (cached && Date.now() - cached.at < CHATLIST_UPDATE_PERIOD_MS) return cached.result;
      const result = await originalInvoke.call(this, request, ...rest);
      state.updateCache.set(filterId, { result, at: Date.now() });
      return result;
    }

    if (name === "chatlists.JoinChatlistInvite") {
      const slug = String(request?.slug || "");
      const state = stateFor(this);
      const row = state.checksBySlug.get(slug);
      const limit = await folderLimit(this, originalInvoke);
      const requested = Array.isArray(request?.peers) ? request.peers : [];
      const peers = requested.slice(0, limit);
      if (!peers.length) return null;
      const result = await originalInvoke.call(this, new Api.chatlists.JoinChatlistInvite({ slug, peers }), ...rest);
      let refreshed = null;
      try { refreshed = await originalInvoke.call(this, new Api.chatlists.CheckChatlistInvite({ slug })); } catch {}
      if (row && refreshed) updateCheckFromRefresh(this, row, refreshed);
      const total = Math.max(requested.length, requestedTotal(row));
      const confirmed = refreshed?.alreadyPeers?.length || row?.result?.alreadyPeers?.length || 0;
      if (total > limit) recordCapacity(this, { slug, total, limit, confirmed, premium: limit === PREMIUM_FOLDER_CHAT_LIMIT });
      return result;
    }

    if (name === "chatlists.JoinChatlistUpdates") {
      const filterId = String(Number(request?.chatlist?.filterId || 0));
      const state = stateFor(this);
      const row = state.checksByFilter.get(filterId);
      const limit = await folderLimit(this, originalInvoke);
      const alreadyCount = row?.result?.alreadyPeers?.length || 0;
      const remaining = Math.max(0, limit - alreadyCount);
      const requested = Array.isArray(request?.peers) ? request.peers : [];
      const peers = requested.slice(0, remaining);
      if (!peers.length) {
        const total = requestedTotal(row);
        if (row && total > limit) recordCapacity(this, { slug: row.slug, total, limit, confirmed: alreadyCount, premium: limit === PREMIUM_FOLDER_CHAT_LIMIT });
        return null;
      }
      const result = await originalInvoke.call(this, new Api.chatlists.JoinChatlistUpdates({ chatlist: request.chatlist, peers }), ...rest);
      if (row?.slug) {
        try {
          const refreshed = await originalInvoke.call(this, new Api.chatlists.CheckChatlistInvite({ slug: row.slug }));
          updateCheckFromRefresh(this, row, refreshed);
        } catch {}
      }
      const cached = state.updateCache.get(filterId);
      if (cached?.result?.missingPeers) {
        const joined = new Set(peers.map(peerKey).filter(Boolean));
        cached.result.missingPeers = cached.result.missingPeers.filter(peer => !joined.has(peerKey(peer)));
      }
      const total = requestedTotal(row);
      const confirmed = row?.result?.alreadyPeers?.length || alreadyCount;
      if (row && total > limit) recordCapacity(this, { slug: row.slug, total, limit, confirmed, premium: limit === PREMIUM_FOLDER_CHAT_LIMIT });
      return result;
    }

    return originalInvoke.call(this, request, ...rest);
  };
}
