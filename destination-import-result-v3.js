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
  buildAddlistInputs,
  explainJoinError,
  formatDuration,
  importDestinationBatch as importDestinationBatchV2,
} from "./destination-import-engine-v2.js";
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
const MAX_SOURCE_TEXT = 20_000;
const SETTLE_MS = 650;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }
function idText(value) {
  try { return String(value?.toString?.() ?? value ?? ""); }
  catch { return String(value || ""); }
}
function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));
}
function sourceIdentity(parsed) {
  if (parsed?.kind === "addlist") return `addlist:${String(parsed.slug || "")}`;
  if (parsed?.kind === "invite") return `invite:${String(parsed.hash || "")}`;
  if (parsed?.kind === "public") return `public:${String(parsed.username || "").toLowerCase()}`;
  return "";
}
function sourceLabel(parsed) {
  if (parsed?.kind === "public") return `@${parsed.username}`;
  if (parsed?.kind === "invite") return "Private group invite";
  if (parsed?.kind === "addlist") return `Addlist ${String(parsed.slug || "").slice(0, 12)}…`;
  return "Telegram source";
}
function entityKey(entity) {
  const id = idText(entity?.id).replace(/\D/g, "");
  if (!id) return "";
  if (entity?.className === "Chat") return `chat:${id}`;
  return `channel:${id}`;
}
function peerKey(peer) {
  if (peer?.channelId !== undefined && peer?.channelId !== null) return `channel:${idText(peer.channelId).replace(/\D/g, "")}`;
  if (peer?.chatId !== undefined && peer?.chatId !== null) return `chat:${idText(peer.chatId).replace(/\D/g, "")}`;
  return "";
}
function candidateKey(candidate) {
  const id = String(candidate?.id || "");
  if (/^-100\d+$/.test(id)) return `channel:${id.slice(4)}`;
  if (/^-\d+$/.test(id)) return `chat:${id.slice(1)}`;
  return "";
}
function entityLabel(entity, fallback = "Destination") {
  const username = String(entity?.username || "").replace(/^@/, "");
  if (/^[A-Za-z0-9_]{5,32}$/.test(username)) return `@${username}`;
  return String(entity?.title || fallback).slice(0, 100);
}
function rightsBlockText(rights) {
  return rights?.sendMessages === true || rights?.sendPlain === true;
}

// Telegram's ChatBannedRights flags are inverted: when send_messages/send_plain
// is true, a normal member is not allowed to send. The channel constructor also
// exposes gigagroup/broadcast before membership, so these checks can happen
// before TelePilot issues a join request.
export function postingBlockReason(entity) {
  if (!entity || typeof entity !== "object") return "";
  if (entity.broadcast === true && entity.megagroup !== true) {
    return "Read-only channel — TelePilot only keeps destinations where normal group posting is available.";
  }
  const privileged = entity.creator === true || Boolean(entity.adminRights);
  if (!privileged && entity.gigagroup === true) {
    return "Read-only group — only admins can send messages.";
  }
  if (!privileged && rightsBlockText(entity.bannedRights)) {
    return "Posting restricted — this connected account cannot send messages in the group.";
  }
  if (!privileged && rightsBlockText(entity.defaultBannedRights)) {
    return "Read-only group — normal members cannot send messages.";
  }
  return "";
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

export function parseImportLines(text) {
  const raw = String(text || "").slice(0, MAX_SOURCE_TEXT);
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const seen = new Set();
  const sources = [];
  const duplicates = [];
  const invalid = [];
  for (const line of lines) {
    const parsed = parseDestinationInput(line);
    if (!parsed) {
      invalid.push({ source: line.slice(0, 80), reason: "Unsupported Telegram link or username." });
      continue;
    }
    const key = sourceIdentity(parsed);
    if (seen.has(key)) {
      duplicates.push({ source: sourceLabel(parsed), original: line });
      continue;
    }
    seen.add(key);
    sources.push({ parsed, original: line });
  }
  return { raw, sources, duplicates, invalid };
}

async function preflightDirect(client, parsed) {
  if (parsed.kind === "public") {
    const entity = await client.getEntity(`@${parsed.username}`);
    return { entity, reason: postingBlockReason(entity) };
  }
  if (parsed.kind === "invite") {
    const checked = await client.checkChatInvite(parsed.hash);
    if (checked?.chat) return { entity: checked.chat, reason: postingBlockReason(checked.chat) };
    if (checked?.broadcast === true) {
      return { entity: null, reason: "Read-only channel — TelePilot only keeps writable group destinations." };
    }
    return { entity: null, reason: "" };
  }
  return { entity: null, reason: "" };
}

function filterAddlistPeers(chats, peers) {
  const byKey = new Map();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const key = entityKey(chat);
    if (key) byKey.set(key, chat);
  }
  const allowedPeers = [];
  const discarded = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    const key = peerKey(peer);
    const entity = byKey.get(key);
    const reason = postingBlockReason(entity);
    if (reason) {
      discarded.push({ key, label: entityLabel(entity, "Addlist group"), reason });
      continue;
    }
    allowedPeers.push(peer);
  }
  return { allowedPeers, discarded };
}

function incompleteAddlistError(offered, resolved, discarded) {
  const err = new Error(`ADDLIST_INCOMPLETE_PEERS — Telegram offered ${offered} chats; TelePilot resolved ${resolved}, intentionally discarded ${discarded}, and could not safely identify the rest. No partial folder import was attempted.`);
  err.errorMessage = err.message;
  return err;
}

async function importFilteredAddlist(client, parsed) {
  const invite = await client.api.chatlists.checkChatlistInvite({ slug: parsed.slug });
  const className = String(invite?.className || "");
  const filterId = Number(invite?.filterId);
  const imported = className === "ChatlistInviteAlready" || (Number.isInteger(filterId) && filterId > 0);

  if (!imported) {
    const peers = Array.isArray(invite?.peers) ? invite.peers : [];
    const filtered = filterAddlistPeers(invite?.chats, peers);
    const built = buildAddlistInputs(invite?.chats, filtered.allowedPeers);
    const accounted = built.inputs.length + filtered.discarded.length;
    if (built.offered !== built.inputs.length) throw incompleteAddlistError(peers.length, built.inputs.length, filtered.discarded.length);
    if (accounted !== peers.length) throw incompleteAddlistError(peers.length, built.inputs.length, filtered.discarded.length);
    if (!built.inputs.length) {
      return { status: filtered.discarded.length ? "discarded" : "already", accepted: 0, offered: peers.length, discarded: filtered.discarded };
    }
    await client.api.chatlists.joinChatlistInvite({ slug: parsed.slug, peers: built.inputs });
    return { status: "joined", accepted: built.inputs.length, offered: peers.length, discarded: filtered.discarded };
  }

  if (!Number.isInteger(filterId) || filterId <= 0) {
    return { status: "already", accepted: 0, offered: 0, discarded: [] };
  }
  const chatlist = new Api.InputChatlistDialogFilter({ filterId });
  const updates = await client.api.chatlists.getChatlistUpdates({ chatlist });
  const peers = Array.isArray(updates?.missingPeers) ? updates.missingPeers : [];
  const filtered = filterAddlistPeers(updates?.chats, peers);
  const built = buildAddlistInputs(updates?.chats, filtered.allowedPeers);
  const accounted = built.inputs.length + filtered.discarded.length;
  if (built.offered !== built.inputs.length) throw incompleteAddlistError(peers.length, built.inputs.length, filtered.discarded.length);
  if (accounted !== peers.length) throw incompleteAddlistError(peers.length, built.inputs.length, filtered.discarded.length);
  if (!built.inputs.length) {
    return { status: filtered.discarded.length ? "discarded" : "already", accepted: 0, offered: peers.length, discarded: filtered.discarded };
  }
  await client.api.chatlists.joinChatlistUpdates({ chatlist, peers: built.inputs });
  return { status: "joined", accepted: built.inputs.length, offered: peers.length, discarded: filtered.discarded };
}

function filterDiscardedReview(review, discardedKeys, discardedOriginals) {
  const blockedCandidate = candidate => discardedKeys.has(candidateKey(candidate));
  const blockedOriginal = row => discardedOriginals.has(String(row?.original || "").trim());
  return {
    ...review,
    accessible: (review?.accessible || []).filter(item => !blockedCandidate(item)),
    notJoined: (review?.notJoined || []).filter(item => !blockedCandidate(item)),
    unsupported: (review?.unsupported || []).filter(item => !blockedCandidate(item)),
    unavailable: (review?.unavailable || []).filter(item => !blockedOriginal(item)),
  };
}
function groupName(candidate) {
  return String(candidate?.username || candidate?.label || candidate?.id || "Destination");
}
function uniqueRows(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export async function importDestinationBatch(uid, sourceText) {
  const parsed = parseImportLines(sourceText);
  if (!parsed.sources.length) {
    const reason = parsed.invalid[0]?.reason || "No supported Telegram groups or Addlist links were found.";
    throw new Error(reason);
  }
  const accounts = selectedAccounts(uid);
  if (!accounts.length) throw new Error("Connect a personal Telegram account first.");

  const existingBefore = new Set((readAppSettings(uid).groups || []).map(group => String(group?.id || "")).filter(Boolean));
  const outcomes = [];
  const discardedKeys = new Set();
  const discardedOriginals = new Set();
  const allowedDirect = [];
  let cooldownSeconds = 0;
  let directResult = null;

  const clients = [];
  try {
    for (const account of accounts) {
      try { clients.push({ account, client: await openClient(uid, account) }); }
      catch (err) {
        outcomes.push({ account: accountDisplayLabel(account), source: "Account", status: "error", ...explainJoinError(err) });
      }
    }
    if (!clients.length) throw new Error(outcomes[0]?.reason || "Could not open a connected Telegram account.");

    for (const row of parsed.sources.filter(item => item.parsed.kind !== "addlist")) {
      const checks = [];
      for (const ctx of clients) {
        try {
          const check = await preflightDirect(ctx.client, row.parsed);
          checks.push({ ...check, account: accountDisplayLabel(ctx.account) });
        } catch {
          checks.push({ reason: "", entity: null });
        }
      }
      const blocked = checks.filter(check => check.reason);
      const writable = checks.some(check => !check.reason);
      if (blocked.length && !writable) {
        const first = blocked[0];
        const key = entityKey(first.entity);
        if (key) discardedKeys.add(key);
        discardedOriginals.add(String(row.parsed.original || row.original));
        outcomes.push({
          account: first.account || "Telegram",
          source: sourceLabel(row.parsed),
          sourceKind: row.parsed.kind,
          status: "discarded",
          kind: "read_only",
          reason: `${first.reason} Discarded without joining.`,
        });
      } else {
        allowedDirect.push(row);
      }
    }

    for (const ctx of clients) {
      for (const row of parsed.sources.filter(item => item.parsed.kind === "addlist")) {
        try {
          const result = await importFilteredAddlist(ctx.client, row.parsed);
          for (const item of result.discarded || []) {
            if (item.key) discardedKeys.add(item.key);
            outcomes.push({
              account: accountDisplayLabel(ctx.account),
              source: item.label,
              sourceKind: "addlist",
              status: "discarded",
              kind: "read_only",
              reason: `${item.reason} Discarded without joining.`,
            });
          }
          outcomes.push({
            account: accountDisplayLabel(ctx.account),
            source: sourceLabel(row.parsed),
            sourceKind: "addlist",
            status: result.status,
            accepted: Number(result.accepted || 0),
            offered: Number(result.offered || 0),
            reason: result.status === "already"
              ? "Shared folder is already imported and has no new chats."
              : result.status === "discarded"
                ? "No writable new groups were available in this shared folder."
                : `Telegram bulk-imported ${result.accepted} writable chat${result.accepted === 1 ? "" : "s"}.`,
          });
        } catch (err) {
          const explained = explainJoinError(err);
          cooldownSeconds = Math.max(cooldownSeconds, Number(explained.cooldownSeconds || 0));
          outcomes.push({ account: accountDisplayLabel(ctx.account), source: sourceLabel(row.parsed), sourceKind: "addlist", status: "error", ...explained });
        }
      }
    }
  } finally {
    for (const ctx of clients) try { await ctx.client.disconnect(); } catch {}
  }

  if (allowedDirect.length) {
    directResult = await importDestinationBatchV2(uid, allowedDirect.map(row => row.original).join("\n"));
    outcomes.push(...(directResult.outcomes || []));
    cooldownSeconds = Math.max(cooldownSeconds, Number(directResult.cooldownSeconds || 0));
  }

  for (const row of parsed.duplicates) {
    outcomes.push({ account: "Input", source: row.source, status: "duplicate", kind: "duplicate", reason: "Duplicate skipped — this destination appeared more than once in the same message." });
  }
  for (const row of parsed.invalid) {
    outcomes.push({ account: "Input", source: row.source, status: "error", kind: "invalid", reason: row.reason });
  }

  await delay(SETTLE_MS);
  const scanned = await scanDestinationSources(uid, parsed.raw);
  const postReview = filterDiscardedReview({ ...scanned, sourceText: parsed.raw }, discardedKeys, discardedOriginals);
  const actualSaved = saveReviewedDestinations(uid, postReview);
  const finalSettings = readAppSettings(uid);
  const finalById = new Map((finalSettings.groups || []).map(group => [String(group?.id || ""), group]));
  const accessibleIds = uniqueRows(postReview.accessible || [], row => String(row?.id || "")).map(row => String(row.id));
  const newNames = [];
  const existingNames = [];
  for (const candidate of postReview.accessible || []) {
    if (existingBefore.has(String(candidate?.id || ""))) existingNames.push(groupName(candidate));
    else newNames.push(groupName(candidate));
  }
  const topics = accessibleIds.filter(id => {
    const group = finalById.get(id);
    return group?.topicRequired === true && !Number(group?.topicId || 0);
  }).length;
  const saved = {
    ...actualSaved,
    added: uniqueRows(newNames, name => name).length,
    existing: uniqueRows(existingNames, name => name).length,
    topics,
    savedIds: accessibleIds,
  };
  const cleanup = enqueueCleanup(uid, postReview);
  if (cleanup?.pending) void runDestinationPreparationTick();

  return {
    sourceText: parsed.raw,
    postReview,
    saved,
    cleanup: {
      ...cleanup,
      pending: Math.max(Number(cleanup?.pending || 0), Number(directResult?.cleanup?.pending || 0)),
    },
    outcomes,
    cooldownSeconds,
    newNames: uniqueRows(newNames, name => name),
    existingNames: uniqueRows(existingNames, name => name),
  };
}

function uniqueOutcomeRows(outcomes, statuses) {
  return uniqueRows(
    (outcomes || []).filter(row => statuses.includes(String(row?.status || ""))),
    row => `${String(row?.source || "")}|${String(row?.status || "")}|${String(row?.reason || "")}`,
  );
}
function normalized(value) { return String(value || "").trim().toLowerCase().replace(/^@/, ""); }

export function importResultScreen(result) {
  const review = result?.postReview || {};
  const newNames = result?.newNames || [];
  const existingNames = result?.existingNames || [];
  const already = uniqueOutcomeRows(result?.outcomes, ["already"]);
  const duplicates = uniqueOutcomeRows(result?.outcomes, ["duplicate"]);
  const discarded = uniqueOutcomeRows(result?.outcomes, ["discarded"]);
  const approvals = uniqueOutcomeRows(result?.outcomes, ["approval"]);
  const failures = uniqueOutcomeRows(result?.outcomes, ["error", "not_attempted"]);
  const addlistRows = uniqueRows(
    (result?.outcomes || []).filter(row => row?.sourceKind === "addlist" && ["joined", "already"].includes(row?.status)),
    row => `${row.source}|${row.status}|${row.reason}`,
  );
  const topics = Number(result?.saved?.topics || 0);
  const cleanupPending = Number(result?.cleanup?.pending || 0);
  const warnings = discarded.length + duplicates.length + approvals.length;
  const allGood = failures.length === 0 && warnings === 0 && (review?.notJoined?.length || 0) === 0 && (review?.invalid?.length || 0) === 0 && (review?.unavailable?.length || 0) === 0;
  const title = allGood ? "Groups added" : failures.length ? "Destination import finished" : "Import complete";
  const icon = allGood ? "✅" : failures.length ? "⚠️" : "ℹ️";
  const body = [
    `${icon} <b><i>${title}</i></b>`,
    "",
    newNames.length ? `<b>Added:</b> — ${newNames.length}` : null,
    already.length ? `<b>Already joined:</b> — ${already.length}` : null,
    existingNames.length ? `<b>Already added:</b> — ${existingNames.length}` : null,
    duplicates.length ? `<b>Duplicates skipped:</b> — ${duplicates.length}` : null,
    discarded.length ? `<b>Discarded:</b> — ${discarded.length}` : null,
    topics ? `<b>Topics:</b> — ${topics} need selection` : null,
    cleanupPending ? `<b>Mute + archive:</b> — processing ${cleanupPending}` : `<b>Mute + archive:</b> — complete / nothing pending`,
    result?.cooldownSeconds ? `<b>Telegram cooldown:</b> — ${esc(formatDuration(result.cooldownSeconds))}` : null,
    "",
    "<b>Results:</b>",
  ].filter(Boolean);

  const alreadySources = new Map(already.map(row => [normalized(row.source), row]));
  const forumNames = new Set((review?.accessible || []).filter(row => row?.forum === true).map(row => normalized(groupName(row))));
  const detail = [];
  for (const name of newNames) {
    const old = alreadySources.get(normalized(name));
    const topic = forumNames.has(normalized(name)) && topics ? " — topic required" : "";
    detail.push(old
      ? `✅ <b>${esc(name)}</b> — Already joined — added to TelePilot${topic}.`
      : `✅ <b>${esc(name)}</b> — Added${topic}.`);
  }
  for (const name of existingNames) detail.push(`♻️ <b>${esc(name)}</b> — Already added to TelePilot.`);
  for (const row of duplicates) detail.push(`↪️ <b>${esc(row.source)}</b> — Duplicate skipped.`);
  for (const row of discarded) detail.push(`🚫 <b>${esc(row.source)}</b> — ${esc(row.reason)}`);
  for (const row of approvals) detail.push(`🔒 <b>${esc(row.source)}</b> — ${esc(row.reason)}`);
  for (const row of failures) detail.push(`⚠️ <b>${esc(row.source)}</b> — ${esc(row.reason)}`);
  for (const row of addlistRows) detail.push(`📁 <b>${esc(row.source)}</b> — ${esc(row.reason)}`);

  const shown = uniqueRows(detail, row => row).slice(0, 16);
  body.push(...shown);
  if (detail.length > shown.length) body.push(`<i>…and ${detail.length - shown.length} more result${detail.length - shown.length === 1 ? "" : "s"}</i>`);
  if (!detail.length) body.push("<i>No destination changes were needed.</i>");

  if (failures.length) body.push("", "<i>TelePilot states the Telegram reason directly. Addlist chats are never retried one by one.</i>");
  else if (discarded.length) body.push("", "<i>Read-only destinations were discarded before joining and were not saved.</i>");
  else body.push("", "<i>All requested destinations were processed successfully.</i>");

  const rows = [];
  if (topics) rows.push([{ text: "Topics", callback_data: "d2_topics:0" }]);
  rows.push([{ text: "Browse", callback_data: "d2_browse:0" }]);
  rows.push([{ text: "𝙂𝙤 𝙗𝙖𝙘𝙠", callback_data: "v1_destinations_v13" }]);
  return { text: body.join("\n"), parse_mode: "HTML", rows };
}

export const __test = {
  filterAddlistPeers,
  candidateKey,
  entityKey,
  peerKey,
};
