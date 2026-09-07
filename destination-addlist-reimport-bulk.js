import fs from "node:fs";
import path from "node:path";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import {
  effectiveAccountIds,
  listAccounts,
  loadAccountSession,
} from "./account-store.js";
import { readAppSettings } from "./posting-engine-enhancements.js";
import { parseDestinationInput } from "./destinations-v2.js";
import { isExpiredAddlistError } from "./expired-addlist-guard.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const PAUSE_MS = 60_000;
const SETTLE_MS = 250;

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function reviewPath(uid) { return path.join(userDir(uid), "destinations-v2.json"); }
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
function delay(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }
function idText(value) {
  try { return String(value?.toString?.() ?? value ?? ""); }
  catch { return String(value || ""); }
}
function candidateKey(candidate) {
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
export function buildReimportInputs(chats, peers, candidates) {
  const wanted = new Set((Array.isArray(candidates) ? candidates : []).map(candidateKey).filter(Boolean));
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

function selectedAccounts(uid) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const selected = new Set(effectiveAccountIds(settings, null, accounts).map(String));
  const preferred = accounts.filter(account => selected.has(String(account.id)));
  return preferred.length ? preferred : accounts;
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
function queueCooldown(uid, accountId, now = Date.now()) {
  const state = readJson(queuePath(uid), {});
  const until = Math.max(0, Number(state?.accountNextAt?.[String(accountId)] || 0) || 0);
  return until > now ? until : 0;
}
function pauseFallback(uid, accountId, now = Date.now()) {
  const file = queuePath(uid);
  const state = readJson(file, null);
  if (!state || typeof state !== "object") return;
  state.accountNextAt = state.accountNextAt && typeof state.accountNextAt === "object" ? state.accountNextAt : {};
  state.accountNextAt[String(accountId)] = Math.max(Number(state.accountNextAt[String(accountId)] || 0), now + PAUSE_MS);
  writeJsonAtomic(file, state);
}
function readReview(uid) {
  return readJson(reviewPath(uid), {})?.review || null;
}
function addlistSlugs(review) {
  const out = new Set();
  for (const line of String(review?.sourceText || "").split(/\r?\n/)) {
    const parsed = parseDestinationInput(line.trim());
    if (parsed?.kind === "addlist" && parsed.slug) out.add(String(parsed.slug));
  }
  return [...out];
}
function candidatesFor(review, accountId, slug) {
  return (Array.isArray(review?.notJoined) ? review.notJoined : []).filter(candidate =>
    candidate?.sourceKind === "addlist"
      && String(candidate?.sourceSlug || "") === String(slug)
      && candidate?.accountJoin?.[String(accountId)]?.status === "not_member"
  );
}

export async function reimportStaleAddlist(client, slug, candidates) {
  const first = await client.api.chatlists.checkChatlistInvite({ slug });
  const className = String(first?.className || "");
  const filterId = Number(first?.filterId);
  const imported = className === "ChatlistInviteAlready" || (Number.isInteger(filterId) && filterId > 0);
  if (!imported || !Number.isInteger(filterId) || filterId <= 0) return { handled: false, reason: "fresh" };

  const chatlist = new Api.InputChatlistDialogFilter({ filterId });
  const updates = await client.api.chatlists.getChatlistUpdates({ chatlist });
  const offeredUpdates = Array.isArray(updates?.missingPeers) ? updates.missingPeers : [];
  if (offeredUpdates.length) return { handled: false, reason: "updates_available", offered: offeredUpdates.length };

  const related = new Set((Array.isArray(first?.chats) ? first.chats : []).map(entityKey).filter(Boolean));
  const represented = (Array.isArray(candidates) ? candidates : []).filter(candidate => related.has(candidateKey(candidate))).length;
  if (!represented) return { handled: false, reason: "no_candidate_metadata" };

  // Official Telegram semantics: peers passed to leaveChatlist are the chats that
  // should ALSO be left. An empty vector deletes only the imported folder.
  await client.api.chatlists.leaveChatlist({ chatlist, peers: [] });
  await delay(SETTLE_MS);

  const fresh = await client.api.chatlists.checkChatlistInvite({ slug });
  const freshClass = String(fresh?.className || "");
  if (freshClass === "ChatlistInviteAlready" || Number.isInteger(Number(fresh?.filterId))) {
    throw new Error("Telegram still reports the shared folder as imported after detaching it");
  }
  const peers = Array.isArray(fresh?.peers) ? fresh.peers : [];
  const inputs = buildReimportInputs(fresh?.chats, peers, candidates);
  if (!inputs.length) throw new Error("Telegram returned no joinable peers after refreshing the shared folder");

  await client.api.chatlists.joinChatlistInvite({ slug, peers: inputs });
  return { handled: true, mode: "reimport", accepted: inputs.length, offered: peers.length };
}

export async function runBulkReimportBeforePreparation(uid, token) {
  const review = readReview(uid);
  if (!review || String(review.token || "") !== String(token || "")) return { handled: false, reason: "expired" };
  const slugs = addlistSlugs(review);
  if (!slugs.length || !(review?.notJoined || []).some(candidate => candidate?.sourceKind === "addlist")) {
    return { handled: false, reason: "no_addlist_work" };
  }

  const accounts = selectedAccounts(uid);
  let totalAccepted = 0;
  let handled = false;
  for (const account of accounts) {
    const accountId = String(account.id);
    const cooldown = queueCooldown(uid, accountId);
    if (cooldown) {
      return { handled: true, blocked: true, cooldown, accountId, totalAccepted };
    }

    let client;
    try {
      client = await openClient(uid, account);
      for (const slug of slugs) {
        const candidates = candidatesFor(review, accountId, slug);
        if (!candidates.length) continue;
        pauseFallback(uid, accountId);
        const result = await reimportStaleAddlist(client, slug, candidates);
        if (!result.handled) continue;
        handled = true;
        totalAccepted += Number(result.accepted || 0);
        console.log(`TelePilot Addlist full reimport ${uid}/${accountId}/${slug}: offered=${result.offered}, accepted=${result.accepted}`);
      }
    } finally {
      try { await client?.disconnect(); } catch {}
    }
  }
  return { handled, blocked: false, totalAccepted };
}

export function installAddlistBulkReimport(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotAddlistBulkReimportInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for Addlist bulk reimport");
  Object.defineProperty(BotClass.prototype, "__telepilotAddlistBulkReimportInstalled", { value: true });

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotAddlistBulkReimportHandlers) {
      Object.defineProperty(this, "__telepilotAddlistBulkReimportHandlers", { value: true });
      this.callbackQuery(/^d3_prepare:([A-Za-z0-9_-]+)$/, async (ctx, next) => {
        const uid = String(ctx.from?.id || "");
        try {
          const result = await runBulkReimportBeforePreparation(uid, String(ctx.match?.[1] || ""));
          if (result?.blocked) {
            const seconds = Math.max(1, Math.ceil((Number(result.cooldown || 0) - Date.now()) / 1000));
            await ctx.answerCallbackQuery({
              text: `Telegram cooldown is still active for about ${seconds}s. Wait for it to reach 0, then retry so TelePilot can use the full bulk import instead of one-by-one joining.`,
              show_alert: true,
            });
            return;
          }
          return next();
        } catch (err) {
          console.warn(`TelePilot Addlist full reimport failed for ${uid}: ${errorText(err)}`);
          await ctx.answerCallbackQuery({
            text: isExpiredAddlistError(err)
              ? "This shared-folder link has expired in Telegram. Copy a fresh t.me/addlist/... link and scan it again."
              : `Bulk import could not complete: ${errorText(err)}. The one-by-one fallback was not started. Retry after Telegram cooldowns clear.`,
            show_alert: true,
          });
        }
      });
    }
    return originalStart.apply(this, args);
  };
  console.log("TelePilot Addlist full reimport enabled (detach folder only; bulk join; no chat leave)");
}

export const __test = {
  candidateKey,
  peerKey,
  entityKey,
  queueCooldown,
};
