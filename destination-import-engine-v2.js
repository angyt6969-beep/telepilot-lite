import fs from "node:fs";
import path from "node:path";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import {
  accountDisplayLabel,
  effectiveAccountIds,
  listAccounts,
  loadAccountSession,
} from "./account-store.js";
import { readAppSettings } from "./posting-engine-enhancements.js";
import {
  parseDestinationInput,
  saveReviewedDestinations,
  scanDestinationSources,
} from "./destinations-v2.js";
import {
  enqueueCleanup,
  runDestinationPreparationTick,
} from "./destination-preparation-v1.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const MAX_SOURCE_TEXT = 20_000;
const SETTLE_MS = 600;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }
function errorText(err) { return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 220); }
function errorCode(err) { return errorText(err).toUpperCase(); }
function idText(value) {
  try { return String(value?.toString?.() ?? value ?? ""); }
  catch { return String(value || ""); }
}
function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));
}

export function floodWaitSeconds(err) {
  for (const value of [err?.seconds, err?.value]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  const match = errorCode(err).match(/FLOOD_WAIT(?:_|\s|\(|:|-)*(\d+)/);
  return match ? Math.max(1, Number(match[1])) : 0;
}

export function formatDuration(seconds) {
  const total = Math.max(1, Math.ceil(Number(seconds || 0)));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (!minutes) return `${secs}s`;
  if (!secs) return `${minutes}m`;
  return `${minutes}m ${secs}s`;
}

export function explainJoinError(err) {
  const code = errorCode(err);
  const wait = floodWaitSeconds(err);
  if (wait) return { kind: "cooldown", cooldownSeconds: wait, reason: `Telegram join cooldown — try again in ${formatDuration(wait)}.` };
  if (code.includes("INVITE_REQUEST_SENT")) return { kind: "approval", reason: "Join request sent — an admin must approve the account first." };
  if (code.includes("USER_ALREADY_PARTICIPANT")) return { kind: "already", reason: "Already joined." };
  if (code.includes("USER_BANNED_IN_CHANNEL")) return { kind: "blocked", reason: "Telegram reports this account is banned or restricted in the group." };
  if (code.includes("CHANNELS_TOO_MUCH") || code.includes("USER_CHANNELS_TOO_MUCH")) return { kind: "limit", reason: "Telegram group limit reached for this account — leave unused groups before adding more." };
  if (code.includes("USERNAME_INVALID") || code.includes("USERNAME_NOT_OCCUPIED")) return { kind: "invalid", reason: "Telegram username does not exist or is no longer available." };
  if (code.includes("INVITE_HASH_EXPIRED")) return { kind: "expired", reason: "Telegram invite link expired — send a fresh link." };
  if (code.includes("INVITE_HASH_INVALID")) return { kind: "invalid", reason: "Telegram invite link is invalid." };
  if (code.includes("CHANNEL_PRIVATE") || code.includes("CHAT_FORBIDDEN")) return { kind: "private", reason: "Telegram denied access to this group for the connected account." };
  if (code.includes("FILTER_INCLUDE_TOO_MUCH")) return { kind: "folder_limit", reason: "Telegram refused the shared folder because it contains more chats than this account can import." };
  if (code.includes("CHATLISTS_TOO_MUCH") || code.includes("FILTERS_TOO_MUCH")) return { kind: "folder_limit", reason: "Telegram folder limit reached for this account." };
  if (code.includes("ADDLIST_INCOMPLETE_PEERS")) return { kind: "addlist_metadata", reason: errorText(err) };
  return { kind: "telegram", reason: `Telegram error — ${errorText(err)}` };
}

function sourceIdentity(parsed) {
  if (parsed?.kind === "addlist") return `addlist:${String(parsed.slug || "")}`;
  if (parsed?.kind === "invite") return `invite:${String(parsed.hash || "")}`;
  if (parsed?.kind === "public") return `public:${String(parsed.username || "").toLowerCase()}`;
  return "";
}
function sourceLabel(parsed) {
  if (parsed?.kind === "addlist") return `Addlist ${String(parsed.slug || "").slice(0, 12)}…`;
  if (parsed?.kind === "invite") return "Private group invite";
  if (parsed?.kind === "public") return `@${parsed.username}`;
  return "Telegram source";
}

export function parseBatchSources(text) {
  const raw = String(text || "").slice(0, MAX_SOURCE_TEXT);
  const rows = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const seen = new Set();
  const parsed = [];
  const invalid = [];
  for (const line of rows) {
    const source = parseDestinationInput(line);
    if (!source) {
      invalid.push({ source: line.slice(0, 80), reason: "Unsupported Telegram link or username." });
      continue;
    }
    const key = sourceIdentity(source);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    parsed.push(source);
  }
  return { raw, parsed, invalid };
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

function peerKey(peer) {
  if (peer?.channelId !== undefined && peer?.channelId !== null) return `channel:${idText(peer.channelId).replace(/\D/g, "")}`;
  if (peer?.chatId !== undefined && peer?.chatId !== null) return `chat:${idText(peer.chatId).replace(/\D/g, "")}`;
  return "";
}
function chatKey(chat) {
  const id = idText(chat?.id).replace(/\D/g, "");
  if (!id) return "";
  if (chat?.className === "Chat") return `chat:${id}`;
  return `channel:${id}`;
}

// Telegram may return minimal Channel objects for shared-folder previews. For
// chatlists.joinChatlistInvite, Telegram expects the same ID/access-hash pair it
// supplied in the preview. Build that InputPeer directly instead of routing the
// min object through generic entity resolution.
export function buildAddlistInputs(chats, peers) {
  const chatMap = new Map();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const key = chatKey(chat);
    if (key) chatMap.set(key, chat);
  }
  const inputs = [];
  const unresolved = [];
  const seen = new Set();
  for (const peer of Array.isArray(peers) ? peers : []) {
    const key = peerKey(peer);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (key.startsWith("chat:") && peer?.chatId !== undefined && peer?.chatId !== null) {
      inputs.push(new Api.InputPeerChat({ chatId: peer.chatId }));
      continue;
    }
    const chat = chatMap.get(key);
    if (key.startsWith("channel:") && peer?.channelId !== undefined && peer?.channelId !== null && chat?.accessHash !== undefined && chat?.accessHash !== null) {
      inputs.push(new Api.InputPeerChannel({ channelId: peer.channelId, accessHash: chat.accessHash }));
      continue;
    }
    unresolved.push(key);
  }
  return { inputs, offered: seen.size, unresolved };
}

function incompleteAddlistError(offered, resolved) {
  const err = new Error(`ADDLIST_INCOMPLETE_PEERS — Telegram offered ${offered} chats, but TelePilot could resolve ${resolved}. No partial folder import was attempted.`);
  err.errorMessage = err.message;
  return err;
}

export async function bulkImportAddlist(client, parsed) {
  const invite = await client.api.chatlists.checkChatlistInvite({ slug: parsed.slug });
  const className = String(invite?.className || "");
  const filterId = Number(invite?.filterId);
  const imported = className === "ChatlistInviteAlready" || (Number.isInteger(filterId) && filterId > 0);

  if (!imported) {
    const peers = Array.isArray(invite?.peers) ? invite.peers : [];
    const built = buildAddlistInputs(invite?.chats, peers);
    if (built.offered && built.inputs.length !== built.offered) throw incompleteAddlistError(built.offered, built.inputs.length);
    if (!built.inputs.length) return { status: "already", accepted: 0, offered: built.offered, mode: "fresh" };
    await client.api.chatlists.joinChatlistInvite({ slug: parsed.slug, peers: built.inputs });
    return { status: "joined", accepted: built.inputs.length, offered: built.offered, mode: "fresh" };
  }

  if (!Number.isInteger(filterId) || filterId <= 0) return { status: "already", accepted: 0, offered: 0, mode: "imported" };
  const chatlist = new Api.InputChatlistDialogFilter({ filterId });
  const updates = await client.api.chatlists.getChatlistUpdates({ chatlist });
  const missingPeers = Array.isArray(updates?.missingPeers) ? updates.missingPeers : [];
  const built = buildAddlistInputs(updates?.chats, missingPeers);
  if (built.offered && built.inputs.length !== built.offered) throw incompleteAddlistError(built.offered, built.inputs.length);
  if (!built.inputs.length) return { status: "already", accepted: 0, offered: built.offered, mode: "updates" };
  await client.api.chatlists.joinChatlistUpdates({ chatlist, peers: built.inputs });
  return { status: "joined", accepted: built.inputs.length, offered: built.offered, mode: "updates" };
}

async function joinPublic(client, parsed) {
  try {
    await client.joinChannel(`@${parsed.username}`);
    return { status: "joined", accepted: 1 };
  } catch (err) {
    const explained = explainJoinError(err);
    if (explained.kind === "already") return { status: "already", accepted: 0 };
    if (explained.kind === "approval") return { status: "approval", accepted: 0 };
    throw err;
  }
}

async function joinPrivate(client, parsed) {
  try {
    const checked = await client.checkChatInvite(parsed.hash);
    if (checked?.chat) return { status: "already", accepted: 0 };
  } catch {}
  try {
    const updates = await client.importChatInvite(parsed.hash);
    const chats = Array.isArray(updates?.chats) ? updates.chats : [];
    return { status: chats.length ? "joined" : "approval", accepted: chats.length ? 1 : 0 };
  } catch (err) {
    const explained = explainJoinError(err);
    if (explained.kind === "already") return { status: "already", accepted: 0 };
    if (explained.kind === "approval") return { status: "approval", accepted: 0 };
    throw err;
  }
}

function retireLegacyAddlistFallback(uid) {
  const file = path.join(DATA_DIR, "users", String(uid), "destination-join-v1.json");
  let state;
  try { state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; }
  catch { state = null; }
  if (!state?.tasks || typeof state.tasks !== "object") return 0;
  let removed = 0;
  for (const [key, task] of Object.entries(state.tasks)) {
    if (task?.status === "done") continue;
    if (task?.candidate?.sourceKind !== "addlist") continue;
    delete state.tasks[key];
    removed++;
  }
  if (!removed) return 0;
  const pendingAccounts = new Set(Object.values(state.tasks)
    .filter(task => task?.status === "pending")
    .map(task => String(task?.accountId || ""))
    .filter(Boolean));
  state.accountNextAt = state.accountNextAt && typeof state.accountNextAt === "object" ? state.accountNextAt : {};
  for (const accountId of Object.keys(state.accountNextAt)) if (!pendingAccounts.has(accountId)) delete state.accountNextAt[accountId];
  state.updatedAt = Date.now();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  return removed;
}

export async function importDestinationBatch(uid, sourceText) {
  const batch = parseBatchSources(sourceText);
  if (!batch.parsed.length) {
    const reason = batch.invalid[0]?.reason || "No supported Telegram groups or Addlist links were found.";
    throw new Error(reason);
  }
  const accounts = selectedAccounts(uid);
  if (!accounts.length) throw new Error("Connect a personal Telegram account first.");

  const retiredFallbacks = retireLegacyAddlistFallback(uid);
  const outcomes = [];
  let maxCooldownSeconds = 0;

  for (const account of accounts) {
    let client;
    try {
      client = await openClient(uid, account);
    } catch (err) {
      outcomes.push({ account: accountDisplayLabel(account), source: "Account", status: "error", ...explainJoinError(err) });
      continue;
    }

    try {
      // Addlists always use Telegram's native shared-folder import. There is no
      // individual join fallback for chats that belong to an Addlist.
      for (const source of batch.parsed.filter(item => item.kind === "addlist")) {
        try {
          const result = await bulkImportAddlist(client, source);
          outcomes.push({
            account: accountDisplayLabel(account),
            source: sourceLabel(source),
            sourceKind: "addlist",
            status: result.status,
            accepted: Number(result.accepted || 0),
            offered: Number(result.offered || 0),
            reason: result.status === "already" ? "Shared folder is already imported and has no new chats." : `Telegram bulk-imported ${result.accepted} chat${result.accepted === 1 ? "" : "s"}.`,
          });
        } catch (err) {
          const explained = explainJoinError(err);
          maxCooldownSeconds = Math.max(maxCooldownSeconds, Number(explained.cooldownSeconds || 0));
          outcomes.push({ account: accountDisplayLabel(account), source: sourceLabel(source), sourceKind: "addlist", status: "error", ...explained });
        }
      }

      const direct = batch.parsed.filter(item => item.kind !== "addlist");
      for (let index = 0; index < direct.length; index++) {
        const source = direct[index];
        try {
          const result = source.kind === "invite" ? await joinPrivate(client, source) : await joinPublic(client, source);
          outcomes.push({
            account: accountDisplayLabel(account),
            source: sourceLabel(source),
            sourceKind: source.kind,
            status: result.status,
            accepted: Number(result.accepted || 0),
            reason: result.status === "approval" ? "Join request sent — an admin must approve the account first." : result.status === "already" ? "Already joined." : "Joined successfully.",
          });
        } catch (err) {
          const explained = explainJoinError(err);
          maxCooldownSeconds = Math.max(maxCooldownSeconds, Number(explained.cooldownSeconds || 0));
          outcomes.push({ account: accountDisplayLabel(account), source: sourceLabel(source), sourceKind: source.kind, status: "error", ...explained });
          if (explained.kind === "cooldown") {
            for (const remaining of direct.slice(index + 1)) {
              outcomes.push({
                account: accountDisplayLabel(account),
                source: sourceLabel(remaining),
                sourceKind: remaining.kind,
                status: "not_attempted",
                kind: "cooldown",
                cooldownSeconds: explained.cooldownSeconds,
                reason: `Not attempted — Telegram join cooldown is active for ${formatDuration(explained.cooldownSeconds)}.`,
              });
            }
            break;
          }
        }
      }
    } finally {
      try { await client.disconnect(); } catch {}
    }
  }

  await delay(SETTLE_MS);
  const scanned = await scanDestinationSources(uid, batch.raw);
  const postReview = { ...scanned, sourceText: batch.raw };
  const saved = saveReviewedDestinations(uid, postReview);
  const cleanup = enqueueCleanup(uid, postReview);
  if (cleanup?.pending) void runDestinationPreparationTick();

  const addlistNotJoined = (postReview.notJoined || []).filter(item => item?.sourceKind === "addlist");
  if (addlistNotJoined.length) {
    const bySlug = new Map();
    for (const item of addlistNotJoined) {
      const slug = String(item?.sourceSlug || "shared-folder");
      bySlug.set(slug, Number(bySlug.get(slug) || 0) + 1);
    }
    for (const [slug, count] of bySlug) {
      outcomes.push({
        account: "Telegram",
        source: `Addlist ${slug.slice(0, 12)}…`,
        sourceKind: "addlist",
        status: "error",
        kind: "addlist_partial",
        reason: `Telegram bulk import finished, but ${count} chat${count === 1 ? " is" : "s are"} still not joined — TelePilot did not switch to individual joins.`,
      });
    }
  }

  for (const item of batch.invalid) outcomes.push({ account: "Input", source: item.source, status: "error", kind: "invalid", reason: item.reason });
  for (const item of postReview.unavailable || []) {
    outcomes.push({ account: "Telegram", source: String(item.original || "Destination").slice(0, 80), status: "error", kind: "unavailable", reason: String(item.reason || "Could not verify this destination.").slice(0, 220) });
  }

  return {
    sourceText: batch.raw,
    postReview,
    saved,
    cleanup,
    outcomes,
    retiredFallbacks,
    cooldownSeconds: maxCooldownSeconds,
  };
}

function readyNames(review) {
  return (Array.isArray(review?.accessible) ? review.accessible : [])
    .map(item => String(item?.username || item?.label || item?.id || "Destination"))
    .filter(Boolean);
}
function uniqueFailures(outcomes) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(outcomes) ? outcomes : []) {
    if (!["error", "not_attempted", "approval"].includes(String(row?.status || ""))) continue;
    const key = `${row.source}|${row.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function importResultScreen(result) {
  const review = result?.postReview || {};
  const names = readyNames(review);
  const failures = uniqueFailures(result?.outcomes);
  const topics = Number(result?.saved?.topics || 0);
  const cleanupPending = Number(result?.cleanup?.pending || 0);
  const allGood = failures.length === 0 && (review?.notJoined?.length || 0) === 0 && (review?.invalid?.length || 0) === 0 && (review?.unavailable?.length || 0) === 0;
  const title = allGood ? "Groups added" : "Destination import finished";
  const icon = allGood ? "✅" : "⚠️";
  const body = [
    `${icon} <b><i>${title}</i></b>`,
    "",
    `<b>Ready:</b> — ${names.length}`,
    `<b>New:</b> — ${Number(result?.saved?.added || 0)}`,
    Number(result?.saved?.existing || 0) ? `<b>Already saved:</b> — ${Number(result.saved.existing)}` : null,
    topics ? `<b>Topics:</b> — ${topics} need selection` : null,
    cleanupPending ? `<b>Mute + archive:</b> — processing ${cleanupPending}` : `<b>Mute + archive:</b> — complete / nothing pending`,
    result?.cooldownSeconds ? `<b>Telegram cooldown:</b> — ${esc(formatDuration(result.cooldownSeconds))}` : null,
    "",
  ].filter(Boolean);

  if (allGood) {
    body.push("<b>Successfully added:</b>");
    for (const name of names.slice(0, 10)) body.push(`• ${esc(name)}`);
    if (names.length > 10) body.push(`<i>…and ${names.length - 10} more</i>`);
    body.push("", "<i>All requested groups were processed successfully.</i>");
  } else {
    if (names.length) {
      body.push(`<b>Successfully added:</b> — ${names.length}`);
      for (const name of names.slice(0, 5)) body.push(`• ${esc(name)}`);
      if (names.length > 5) body.push(`<i>…and ${names.length - 5} more</i>`);
      body.push("");
    }
    body.push("<b>Needs attention:</b>");
    for (const row of failures.slice(0, 8)) body.push(`• <b>${esc(row.source)}:</b> — ${esc(row.reason)}`);
    if (failures.length > 8) body.push(`<i>…and ${failures.length - 8} more</i>`);
    if (!failures.length && (review?.notJoined?.length || 0)) body.push(`• <b>Not joined:</b> — ${review.notJoined.length} destination${review.notJoined.length === 1 ? "" : "s"}`);
    body.push("", "<i>TelePilot states the Telegram reason directly and does not retry Addlist chats one by one.</i>");
  }

  const rows = [];
  if (topics) rows.push([{ text: "Topics", callback_data: "d2_topics:0" }]);
  rows.push([{ text: "Browse", callback_data: "d2_browse:0" }]);
  rows.push([{ text: "𝙂𝙤 𝙗𝙖𝙘𝙠", callback_data: "v1_destinations_v13" }]);
  return { text: body.join("\n"), parse_mode: "HTML", rows };
}

export const __test = {
  sourceIdentity,
  peerKey,
  chatKey,
  retireLegacyAddlistFallback,
};
