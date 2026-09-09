import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bigInt from "big-integer";
import { InlineKeyboard } from "grammy";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import {
  accountDisplayLabel,
  effectiveAccountIds,
  listAccounts,
  loadAccountSession,
  updateAccountStatus,
} from "./account-store.js";
import {
  readAppSettings,
  writeAppSettings,
} from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";
import { setPendingInput } from "./qol-store.js";
import { recheckDestinationsV4 } from "./destination-membership-v4.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_VERSION = 2;
const INPUT_TTL_MS = 20 * 60_000;
const REVIEW_TTL_MS = 30 * 60_000;
const PAGE_SIZE = 8;
const ROUTING_BATCH_SIZE = 200;
const ROUTING_QUEUE_LIMIT = 100;

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function statePath(uid) { return path.join(userDir(uid), "destinations-v2.json"); }
function routingQueuePath(uid) { return path.join(userDir(uid), "destination-routing-sync.json"); }
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
function cleanRoutingQueue(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && typeof item === "object" && String(item.id || ""))
    .map(item => ({
      id: String(item.id),
      destinationIds: [...new Set((Array.isArray(item.destinationIds) ? item.destinationIds : []).map(String).filter(Boolean))].slice(0, ROUTING_BATCH_SIZE),
      accountIds: [...new Set((Array.isArray(item.accountIds) ? item.accountIds : []).map(String).filter(Boolean))],
      createdAt: Number(item.createdAt || 0) || Date.now(),
    }))
    .slice(-ROUTING_QUEUE_LIMIT);
}
function readRoutingQueue(uid) { return cleanRoutingQueue(readJson(routingQueuePath(uid), [])); }
function writeRoutingQueue(uid, queue) { writeJsonAtomic(routingQueuePath(uid), cleanRoutingQueue(queue)); }
function cleanState(raw = {}) {
  const review = raw?.review && Date.now() - Number(raw.review.createdAt || 0) <= REVIEW_TTL_MS ? raw.review : null;
  const pendingInput = raw?.pendingInput && Date.now() - Number(raw.pendingInput.createdAt || 0) <= INPUT_TTL_MS ? raw.pendingInput : null;
  return {
    version: STATE_VERSION,
    pendingInput,
    review,
    lastScan: raw?.lastScan && typeof raw.lastScan === "object" ? raw.lastScan : null,
  };
}
function readState(uid) { return cleanState(readJson(statePath(uid), {})); }
function writeState(uid, state) { writeJsonAtomic(statePath(uid), cleanState(state)); }
function patchState(uid, patch) { const state = readState(uid); writeState(uid, { ...state, ...patch }); }
function token(value) { return crypto.createHash("sha1").update(String(value || "")).digest("base64url").slice(0, 11); }
function reviewToken() { return crypto.randomBytes(8).toString("base64url"); }
function digits(value) { return String(value?.toString?.() ?? value ?? "").replace(/\D/g, ""); }
function errorText(err) { return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 180); }
function inline(text, data) { return { text, callback_data: data }; }
function rowsKeyboard(rows) { return { inline_keyboard: rows.filter(row => Array.isArray(row) && row.length) }; }

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
  if (match && !["addlist", "joinchat", "c", "s"].includes(match[1].toLowerCase())) return { kind: "public", username: match[1], original: input };
  return null;
}

function entityId(entity) {
  const raw = digits(entity?.id);
  if (!raw) return "";
  if (entity?.className === "Channel" || entity?.className === "Community" || entity?.megagroup === true || entity?.forum === true || entity?.broadcast === true) return `-100${raw}`;
  if (entity?.className === "Chat") return `-${raw}`;
  return `-100${raw}`;
}
function entityLabel(entity, fallback = "Destination") { return String(entity?.title || entity?.username || fallback).slice(0, 120); }
function entityUsername(entity) {
  const username = String(entity?.username || "").replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(username) ? `@${username}` : "";
}
function entityType(entity) {
  if (entity?.broadcast === true && entity?.megagroup !== true) return "channel";
  if (entity?.forum === true || entity?.megagroup === true || entity?.className === "Channel" || entity?.className === "Community") return "supergroup";
  return "group";
}
function candidateFromEntity(entity, source) {
  const id = entityId(entity);
  if (!id) return null;
  return {
    id,
    label: entityLabel(entity, source?.original || id),
    username: entityUsername(entity),
    type: entityType(entity),
    forum: entity?.forum === true,
    accessHash: entity?.accessHash !== undefined && entity?.accessHash !== null ? String(entity.accessHash) : "",
    sourceKind: String(source?.kind || "manual"),
    sourceSlug: String(source?.slug || source?.hash || source?.username || ""),
    accountJoin: {},
  };
}
function peerKey(peer) { return digits(peer?.channelId ?? peer?.chatId ?? peer?.userId ?? peer?.id ?? peer); }
function entityKey(entity) { return digits(entity?.id); }
function mergeCandidate(map, next) {
  if (!next?.id) return null;
  const existing = map.get(next.id);
  if (!existing) { map.set(next.id, next); return next; }
  existing.label ||= next.label;
  existing.username ||= next.username;
  existing.type ||= next.type;
  existing.forum = existing.forum === true || next.forum === true;
  existing.accessHash ||= next.accessHash;
  existing.accountJoin = { ...(existing.accountJoin || {}), ...(next.accountJoin || {}) };
  return existing;
}

async function openAccountClient(uid, account) {
  const session = loadAccountSession(uid, account.id);
  if (!session) throw new Error("Saved Telegram session is missing");
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5, floodSleepThreshold: 0 });
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
async function buildAccountContext(uid, account) {
  const client = await openAccountClient(uid, account);
  const dialogs = await client.getDialogs({ limit: 500 });
  const dialogByKey = new Map();
  for (const dialog of dialogs || []) {
    const entity = dialog?.entity || dialog;
    const key = entityKey(entity);
    if (key) dialogByKey.set(key, entity);
  }
  return { account, client, dialogByKey };
}
function selectedAccounts(uid) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const selected = new Set(effectiveAccountIds(settings, null, accounts).map(String));
  const preferred = accounts.filter(account => selected.has(String(account.id)));
  return preferred.length ? preferred : accounts;
}
function membershipState(entity) {
  if (entity?.broadcast === true && entity?.megagroup !== true) {
    return { status: "unsupported", reason: "Broadcast channels are not part of the new group importer." };
  }
  return { status: "ready", reason: "Already joined in Telegram." };
}
function membershipErrorState(err) {
  const text = errorText(err);
  const code = text.toUpperCase();
  if (code.includes("USER_NOT_PARTICIPANT")) return { status: "not_member", reason: "Telegram explicitly reports this account is not a participant." };
  if (code.includes("USER_BANNED_IN_CHANNEL")) return { status: "issue", reason: "Telegram reports this account is banned/restricted in the destination." };
  if (code.includes("CHANNEL_PRIVATE") || code.includes("CHAT_FORBIDDEN") || code.includes("CHANNEL_INVALID") || code.includes("CHAT_INVALID")) return { status: "issue", reason: `Telegram could not verify access: ${text}` };
  return { status: "issue", reason: `Telegram membership check was inconclusive: ${text}` };
}
async function directMembershipState(ctx, entity) {
  try {
    await ctx.client.getParticipant(entity, "me");
    return membershipState(entity);
  } catch (err) {
    return membershipErrorState(err);
  }
}
async function verifyPublicMembership(ctx, parsed) {
  const entity = await ctx.client.getEntity(`@${parsed.username}`);
  const candidate = candidateFromEntity(entity, parsed);
  if (!candidate) return null;
  const key = entityKey(entity);
  candidate.accountJoin[String(ctx.account.id)] = ctx.dialogByKey.has(key) ? membershipState(entity) : await directMembershipState(ctx, entity);
  return candidate;
}
async function verifyPrivateInvite(ctx, parsed) {
  const checked = await ctx.client.checkChatInvite(parsed.hash);
  const entity = checked?.chat || null;
  if (!entity) return { unavailable: true, original: parsed.original, reason: "Join this private group in Telegram first." };
  const candidate = candidateFromEntity(entity, parsed);
  if (!candidate) return { unavailable: true, original: parsed.original, reason: "Telegram did not expose this joined group." };
  candidate.accountJoin[String(ctx.account.id)] = membershipState(entity);
  return candidate;
}
function addlistMembershipKeys(invite, dialogByKey) {
  const keys = new Set(dialogByKey.keys());
  for (const peer of Array.isArray(invite?.alreadyPeers) ? invite.alreadyPeers : []) {
    const key = peerKey(peer);
    if (key) keys.add(key);
  }
  return keys;
}
async function scanAddlistForAccount(ctx, parsed) {
  const invite = await ctx.client.api.chatlists.checkChatlistInvite({ slug: parsed.slug });
  const chats = Array.isArray(invite?.chats) ? invite.chats : [];
  const membership = addlistMembershipKeys(invite, ctx.dialogByKey);
  const out = [];
  for (const entity of chats) {
    const candidate = candidateFromEntity(entity, parsed);
    if (!candidate) continue;
    candidate.accountJoin[String(ctx.account.id)] = membership.has(entityKey(entity)) ? membershipState(entity) : await directMembershipState(ctx, entity);
    out.push(candidate);
  }
  return { inviteClass: String(invite?.className || ""), chats: out };
}

function candidateAccessible(candidate) {
  return Object.values(candidate?.accountJoin || {}).some(row => row?.status === "ready");
}
function candidateUnsupported(candidate) {
  const rows = Object.values(candidate?.accountJoin || {});
  return rows.length > 0 && rows.every(row => row?.status === "unsupported");
}
function candidateNotJoined(candidate) {
  const rows = Object.values(candidate?.accountJoin || {});
  return rows.length > 0 && rows.every(row => row?.status === "not_member");
}
function candidateIssue(candidate) {
  return !candidateAccessible(candidate) && !candidateUnsupported(candidate) && !candidateNotJoined(candidate);
}
function candidateIssueReason(candidate) {
  const reasons = [...new Set(Object.values(candidate?.accountJoin || {}).map(row => String(row?.reason || "").trim()).filter(Boolean))];
  return reasons.slice(0, 2).join(" · ") || "Telegram could not verify membership for the routed account(s).";
}
function sourceLabel(parsed) {
  if (parsed?.kind === "addlist") return "Shared folder";
  if (parsed?.kind === "invite") return "Private invite";
  return parsed?.username ? `@${parsed.username}` : "Telegram link";
}

export async function scanDestinationSources(uid, text) {
  if (!API_ID || !API_HASH) throw new Error("Telegram API credentials are not configured");
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsedRows = lines.map(line => ({ line, parsed: parseDestinationInput(line) }));
  const invalid = parsedRows.filter(row => !row.parsed).map(row => ({ original: row.line, reason: "Unsupported Telegram link or username." }));
  const valid = parsedRows.filter(row => row.parsed);
  const accounts = selectedAccounts(uid);
  if (!accounts.length) throw new Error("Connect a personal Telegram account first. TelePilot does not join chats for you.");

  const contexts = [];
  const accountErrors = [];
  try {
    for (const account of accounts) {
      try { contexts.push(await buildAccountContext(uid, account)); }
      catch (err) { accountErrors.push(`${accountDisplayLabel(account)} — ${errorText(err)}`); }
    }
    if (!contexts.length) throw new Error(accountErrors[0] || "Could not open a connected Telegram account");

    const candidates = new Map();
    const unavailable = [];
    for (const row of valid) {
      if (row.parsed.kind === "addlist") {
        let sawPreview = false;
        for (const ctx of contexts) {
          try {
            const result = await scanAddlistForAccount(ctx, row.parsed);
            if (result.chats.length) sawPreview = true;
            for (const candidate of result.chats) mergeCandidate(candidates, candidate);
          } catch (err) {
            unavailable.push({ original: sourceLabel(row.parsed), reason: `${accountDisplayLabel(ctx.account)} — ${errorText(err)}` });
          }
        }
        if (!sawPreview) unavailable.push({ original: sourceLabel(row.parsed), reason: "Telegram returned no chats for this shared folder." });
        continue;
      }

      let produced = false;
      for (const ctx of contexts) {
        try {
          const result = row.parsed.kind === "invite" ? await verifyPrivateInvite(ctx, row.parsed) : await verifyPublicMembership(ctx, row.parsed);
          if (result?.unavailable) { unavailable.push(result); continue; }
          if (result) { mergeCandidate(candidates, result); produced = true; }
        } catch (err) {
          unavailable.push({ original: sourceLabel(row.parsed), reason: `${accountDisplayLabel(ctx.account)} — ${errorText(err)}` });
        }
      }
      if (!produced && !unavailable.some(item => item.original === row.parsed.original)) unavailable.push({ original: row.parsed.original, reason: "Could not verify this destination." });
    }

    const all = [...candidates.values()];
    const accessible = all.filter(candidateAccessible).filter(candidate => !candidateUnsupported(candidate));
    const notJoined = all.filter(candidateNotJoined);
    const unsupported = all.filter(candidateUnsupported);
    for (const candidate of all.filter(candidateIssue)) {
      unavailable.push({ original: candidate.username || candidate.label || candidate.id, reason: candidateIssueReason(candidate) });
    }
    return {
      token: reviewToken(),
      createdAt: Date.now(),
      sourceCount: valid.length,
      accessible,
      notJoined,
      unsupported,
      invalid,
      unavailable,
      accountErrors,
    };
  } finally {
    for (const ctx of contexts) try { await ctx.client.disconnect(); } catch {}
  }
}

function normalizedJoinStatus(group) {
  if (group?.topicRequired === true && !Number(group?.topicId || 0)) return "needs_topic";
  const rows = Object.values(group?.accountJoin || {});
  if (rows.some(row => row?.status === "ready")) return "ready";
  if (rows.some(row => row?.status === "not_member")) return "not_member";
  if (rows.some(row => row?.status === "unsupported")) return "unsupported";
  return "unknown";
}
function groupFromCandidate(candidate, existing = null) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  const accountJoin = { ...(base.accountJoin || {}), ...(candidate.accountJoin || {}) };
  const topicId = Number(base.topicId || 0) || null;
  const next = {
    ...base,
    id: String(candidate.id),
    label: candidate.label || base.label || candidate.id,
    username: candidate.username || base.username || "",
    type: candidate.type || base.type || "group",
    accessHash: candidate.accessHash || base.accessHash || "",
    accountMode: base.accountMode || "inherit",
    accountIds: Array.isArray(base.accountIds) ? base.accountIds : [],
    topicRequired: candidate.forum === true || base.topicRequired === true,
    topicId,
    topicTitle: topicId ? String(base.topicTitle || "") : "",
    accountJoin,
    source: candidate.sourceKind || base.source || "manual",
    sourceSlug: candidate.sourceSlug || base.sourceSlug || "",
    importedAt: Number(base.importedAt || Date.now()),
    lastCheckedAt: Date.now(),
  };
  next.joinStatus = normalizedJoinStatus(next);
  return next;
}
export function saveReviewedDestinations(uid, review) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const byId = new Map(groups.map((group, index) => [String(group.id), index]));
  let added = 0, existing = 0, topics = 0;
  const savedIds = [];
  for (const candidate of Array.isArray(review?.accessible) ? review.accessible : []) {
    const id = String(candidate.id || "");
    if (!id) continue;
    const index = byId.get(id);
    if (index === undefined) {
      const group = groupFromCandidate(candidate, null);
      groups.push(group);
      byId.set(id, groups.length - 1);
      added++;
      if (group.topicRequired && !group.topicId) topics++;
    } else {
      groups[index] = groupFromCandidate(candidate, groups[index]);
      existing++;
      if (groups[index].topicRequired && !groups[index].topicId) topics++;
    }
    savedIds.push(id);
  }
  if (savedIds.length) {
    writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
    syncUserGroups(uid);
  }
  return { added, existing, topics, savedIds };
}

export function destinationAccountReady(destination, accountId = "") {
  if (!destination || typeof destination !== "object") return false;
  if (destination.topicRequired === true && !Number(destination.topicId || 0)) return false;
  const map = destination.accountJoin && typeof destination.accountJoin === "object" && !Array.isArray(destination.accountJoin) ? destination.accountJoin : {};
  if (accountId) return map[String(accountId)]?.status === "ready";
  const rows = Object.values(map);
  if (!rows.length) return String(destination.joinStatus || "ready") === "ready";
  return rows.some(row => row?.status === "ready");
}

function groupStatus(group) {
  if (group?.topicRequired === true && !Number(group?.topicId || 0)) return "topic";
  const rows = Object.values(group?.accountJoin || {});
  if (!rows.length) return "unchecked";
  if (rows.some(row => row?.status === "ready")) return "ready";
  if (rows.some(row => row?.status === "not_member")) return "not_member";
  return "issue";
}
function statusIcon(status) {
  return status === "ready" ? "✅" : status === "topic" ? "💬" : status === "not_member" ? "↗️" : status === "unchecked" ? "◌" : "⚠️";
}
function groupLabel(group) { return String(group?.username || group?.label || group?.id || "Destination"); }
function savedGroups(uid) { const groups = readAppSettings(uid).groups; return Array.isArray(groups) ? groups : []; }
function counts(uid) {
  const out = { total: 0, ready: 0, topic: 0, not_member: 0, unchecked: 0, issue: 0 };
  for (const group of savedGroups(uid)) { out.total++; const status = groupStatus(group); out[status] = Number(out[status] || 0) + 1; }
  return out;
}

export function destinationsHomeScreen(uid) {
  const c = counts(uid);
  return {
    text: [
      "🗂 Destination Hub",
      "",
      `Saved  ${c.total}`,
      `Ready  ${c.ready}`,
      c.topic ? `Choose topic  ${c.topic}` : null,
      c.not_member ? `Join in Telegram  ${c.not_member}` : null,
      c.unchecked ? `Not checked yet  ${c.unchecked}` : null,
      "",
      "TelePilot only uses chats you already have access to.",
      "It does not join, mute or archive chats.",
    ].filter(Boolean).join("\n"),
    rows: [
      [inline("＋ Add destinations", "d2_add"), inline("📚 Browse", "d2_browse:0")],
      [inline("💬 Topics", "d2_topics:0"), inline("↻ Check access", "d2_refresh")],
      [inline("🗑 Manage", "d2_manage:0")],
      [inline("📊 Dashboard", "v1_dashboard_v13")],
    ],
  };
}
function addScreen() {
  return {
    text: [
      "＋ Add destinations",
      "",
      "Send one or many Telegram sources, one per line.",
      "",
      "Supported",
      "• @groupname",
      "• t.me/groupname",
      "• https://t.me/groupname",
      "• private t.me/+ invite links",
      "• t.me/addlist/... shared folders",
      "",
      "TelePilot scans access only. If you have not joined a group, it will be listed as ‘Join in Telegram first’ and will not be saved.",
    ].join("\n"),
    rows: [[inline("← Destination Hub", "v1_destinations_v13")]],
  };
}
function reviewScreen(review) {
  const accessible = review?.accessible?.length || 0;
  const notJoined = review?.notJoined?.length || 0;
  const unsupported = review?.unsupported?.length || 0;
  const invalid = (review?.invalid?.length || 0) + (review?.unavailable?.length || 0);
  const forums = (review?.accessible || []).filter(item => item.forum).length;
  const sample = (review?.accessible || []).slice(0, 6).map(item => `✅ ${item.username || item.label}`).join("\n");
  return {
    text: [
      "🔎 Review scan",
      "",
      `Ready to save  ${accessible}`,
      forums ? `Forum groups  ${forums}` : null,
      notJoined ? `Join in Telegram first  ${notJoined}` : null,
      unsupported ? `Unsupported  ${unsupported}` : null,
      invalid ? `Could not use  ${invalid}` : null,
      "",
      sample || "No accessible groups were found.",
      accessible > 6 ? `… and ${accessible - 6} more` : null,
      "",
      "Nothing has been changed yet.",
    ].filter(Boolean).join("\n"),
    rows: [
      accessible ? [inline(`Add ${accessible} accessible`, `d2_confirm:${review.token}`)] : [],
      notJoined || invalid || unsupported ? [inline("View not added", `d2_skipped:${review.token}`)] : [],
      [inline("Cancel", "v1_destinations_v13")],
    ],
  };
}
function skippedScreen(review) {
  const lines = [];
  for (const item of review?.notJoined || []) lines.push(`↗️ ${item.username || item.label}\nJoin this group in Telegram first.`);
  for (const item of review?.unsupported || []) lines.push(`⚠️ ${item.username || item.label}\nBroadcast channels are not included in this importer.`);
  for (const item of review?.invalid || []) lines.push(`❌ ${String(item.original || "Input").slice(0, 60)}\n${item.reason}`);
  for (const item of review?.unavailable || []) lines.push(`❌ ${String(item.original || "Input").slice(0, 60)}\n${item.reason}`);
  return {
    text: ["↗️ Not added", "", lines.slice(0, 12).join("\n\n") || "Nothing was skipped.", lines.length > 12 ? `\n…and ${lines.length - 12} more` : ""].join("\n"),
    rows: [[inline("← Review", `d2_review:${review.token}`)]],
  };
}
function browseScreen(uid, page = 0, manage = false) {
  const groups = savedGroups(uid);
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const current = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const slice = groups.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const rows = slice.map(group => [inline(`${statusIcon(groupStatus(group))} ${groupLabel(group).slice(0, 38)}`, `${manage ? "d2_manage_item" : "d2_detail"}:${token(group.id)}:${current}`)]);
  if (pages > 1) {
    const nav = [];
    if (current > 0) nav.push(inline("◀", `${manage ? "d2_manage" : "d2_browse"}:${current - 1}`));
    nav.push(inline(`${current + 1}/${pages}`, "d2_noop"));
    if (current < pages - 1) nav.push(inline("▶", `${manage ? "d2_manage" : "d2_browse"}:${current + 1}`));
    rows.push(nav);
  }
  rows.push([inline("← Destination Hub", "v1_destinations_v13")]);
  return {
    text: [manage ? "🗑 Manage destinations" : "📚 Saved destinations", "", groups.length ? `${groups.length} saved · tap a destination for details.` : "No destinations saved yet."].join("\n"),
    rows,
  };
}
function groupByToken(uid, value) { return savedGroups(uid).find(group => token(group.id) === String(value)) || null; }
function detailScreen(uid, group, page = 0, manage = false) {
  const status = groupStatus(group);
  const accounts = listAccounts(uid);
  const accessLines = Object.entries(group?.accountJoin || {}).map(([accountId, row]) => {
    const account = accounts.find(item => String(item.id) === String(accountId));
    const label = account ? accountDisplayLabel(account) : `Account ${accountId}`;
    return `${row?.status === "ready" ? "✅" : "⚠️"} ${label} · ${String(row?.status || "unchecked")}`;
  });
  const rows = [];
  if (group.topicRequired) rows.push([inline(group.topicId ? "💬 Change topic" : "💬 Choose topic", `d2_topic_open:${token(group.id)}:0`)]);
  if (manage) rows.push([inline("🗑 Delete", `d2_delete_confirm:${token(group.id)}:${page}`)]);
  rows.push([inline("← Back", `${manage ? "d2_manage" : "d2_browse"}:${page}`)]);
  return {
    text: [
      `${statusIcon(status)} ${groupLabel(group)}`,
      "",
      `Status  ${status.replace("_", " ")}`,
      `Type  ${group.type || "group"}`,
      group.topicRequired ? `Topic  ${group.topicTitle || "Not selected"}` : null,
      "",
      accessLines.length ? accessLines.join("\n") : "Access has not been checked in Destinations v2 yet.",
    ].filter(Boolean).join("\n"),
    rows,
  };
}

function savedChannelId(group) {
  const raw = String(group?.id || "").trim();
  if (/^-100\d+$/.test(raw)) return raw.slice(4);
  const numeric = digits(raw);
  return numeric || "";
}
function validLong(value) { return /^-?\d+$/.test(String(value || "").trim()); }
function persistResolvedTopicPeer(uid, groupId, peer) {
  const channelId = String(peer?.channelId?.toString?.() ?? peer?.channelId ?? "");
  const accessHash = String(peer?.accessHash?.toString?.() ?? peer?.accessHash ?? "");
  if (!validLong(channelId) || !validLong(accessHash)) return;
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const index = groups.findIndex(item => String(item?.id || "") === String(groupId));
  if (index < 0) return;
  if (String(groups[index]?.accessHash || "") === accessHash) return;
  groups[index] = { ...groups[index], accessHash };
  writeAppSettings(uid, { ...settings, groups });
  syncUserGroups(uid);
}
async function topicPeerForGroup(uid, client, group) {
  const channelId = savedChannelId(group);
  const accessHash = String(group?.accessHash || "").trim();
  if (validLong(channelId) && validLong(accessHash)) {
    return new Api.InputPeerChannel({ channelId: bigInt(channelId), accessHash: bigInt(accessHash) });
  }

  const username = String(group?.username || "").replace(/^@/, "").trim();
  if (username) {
    const peer = await client.getInputEntity(`@${username}`);
    persistResolvedTopicPeer(uid, group.id, peer);
    return peer;
  }

  const sourceSlug = String(group?.sourceSlug || "").replace(/^@/, "").trim();
  if (/^[A-Za-z0-9_]{5,32}$/.test(sourceSlug)) {
    const peer = await client.getInputEntity(`@${sourceSlug}`);
    persistResolvedTopicPeer(uid, group.id, peer);
    return peer;
  }

  throw new Error("Saved Telegram peer is incomplete. Remove and re-add this destination once.");
}
function topicAccountFor(settings, group, accounts) {
  const routedIds = new Set(effectiveAccountIds(settings, group, accounts).map(String));
  const readyIds = new Set(Object.entries(group?.accountJoin || {}).filter(([, row]) => row?.status === "ready").map(([id]) => String(id)));
  return accounts.find(item => routedIds.has(String(item.id)) && readyIds.has(String(item.id)))
    || accounts.find(item => readyIds.has(String(item.id)))
    || accounts.find(item => routedIds.has(String(item.id)))
    || accounts[0]
    || null;
}
async function topicsForGroup(uid, group) {
  const settings = readAppSettings(uid);
  const accounts = listAccounts(uid);
  const account = topicAccountFor(settings, group, accounts);
  if (!account) throw new Error("Connect a personal Telegram account first");
  let client;
  try {
    client = await openAccountClient(uid, account);
    const peer = await topicPeerForGroup(uid, client, group);
    const result = await client.getForumTopics(peer, { limit: 100 });
    const topics = (Array.isArray(result?.topics) ? result.topics : [])
      .map(topic => ({ id: Number(topic?.id || 0), title: String(topic?.title || `Topic ${topic?.id || ""}`).slice(0, 100) }))
      .filter(topic => topic.id > 0);
    if (!topics.length) throw new Error("Telegram returned no forum topics for this group.");
    return topics;
  } catch (err) {
    const message = errorText(err);
    throw new Error(message || "Could not load forum topics");
  } finally {
    try { await client?.disconnect(); } catch {}
  }
}
async function topicScreen(uid, group, page = 0) {
  const topics = await topicsForGroup(uid, group);
  const pages = Math.max(1, Math.ceil(topics.length / PAGE_SIZE));
  const current = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const rows = topics.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(topic => [inline(topic.title.slice(0, 42), `d2_topic_pick:${token(group.id)}:${topic.id}`)]);
  if (pages > 1) {
    const nav = [];
    if (current > 0) nav.push(inline("◀", `d2_topic_open:${token(group.id)}:${current - 1}`));
    if (current < pages - 1) nav.push(inline("▶", `d2_topic_open:${token(group.id)}:${current + 1}`));
    rows.push(nav);
  }
  rows.push([inline("← Destination Hub", "v1_destinations_v13")]);
  return { text: ["💬 Choose posting topic", "", groupLabel(group), "", "Select the exact forum topic TelePilot should post in."].join("\n"), rows };
}
function setTopic(uid, groupId, topicId, title) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const index = groups.findIndex(group => String(group.id) === String(groupId));
  if (index < 0) return false;
  groups[index] = { ...groups[index], topicRequired: true, topicId: Number(topicId), topicTitle: String(title || `Topic ${topicId}`).slice(0, 100) };
  groups[index].joinStatus = normalizedJoinStatus(groups[index]);
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  syncUserGroups(uid);
  return true;
}
function deleteGroup(uid, groupId) {
  const settings = readAppSettings(uid);
  const groups = (Array.isArray(settings.groups) ? settings.groups : []).filter(group => String(group.id) !== String(groupId));
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  syncUserGroups(uid);
}

export async function recheckDestinations(uid, limit = 40) {
  return recheckDestinationsV4(uid, { limit: Math.max(1, Number(limit) || 40) });
}

async function editOrReply(ctx, screen) {
  const options = { reply_markup: rowsKeyboard(screen.rows || []) };
  try { return await ctx.editMessageText(screen.text, options); }
  catch { return ctx.reply(screen.text, options); }
}
function setInputFromCtx(ctx) {
  const uid = String(ctx.from?.id || "");
  setPendingInput(uid, null);
  patchState(uid, { pendingInput: { type: "source", chatId: Number(ctx.chat?.id || 0), messageId: Number(ctx.callbackQuery?.message?.message_id || 0), createdAt: Date.now() }, review: null });
}
async function editStoredPrompt(ctx, pending, screen) {
  const options = { reply_markup: rowsKeyboard(screen.rows || []) };
  try { return await ctx.api.editMessageText(Number(pending.chatId), Number(pending.messageId), screen.text, options); }
  catch { return ctx.reply(screen.text, options); }
}
async function destinationTextMiddleware(ctx, next) {
  if (ctx.chat?.type !== "private" || !ctx.from?.id || !ctx.message?.text) return next();
  const uid = String(ctx.from.id);
  const state = readState(uid);
  const pending = state.pendingInput;
  if (!pending?.type) return next();
  if (pending.type !== "source") return next();
  try { await ctx.deleteMessage(); } catch {}
  try {
    await editStoredPrompt(ctx, pending, { text: "🔎 Scanning Telegram access…\n\nChecking only chats your connected personal accounts already belong to.", rows: [] });
    const review = await scanDestinationSources(uid, ctx.message.text);
    writeState(uid, { ...state, pendingInput: null, review, lastScan: { at: Date.now(), token: review.token } });
    return editStoredPrompt(ctx, pending, reviewScreen(review));
  } catch (err) {
    patchState(uid, { pendingInput: null });
    return editStoredPrompt(ctx, pending, { text: `❌ Could not scan destinations\n\n${errorText(err)}`, rows: [[inline("Try again", "d2_add")], [inline("← Destination Hub", "v1_destinations_v13")]] });
  }
}

function legacyRedirectScreen() {
  return { text: "🗂 Destination Hub\n\nThis section was rebuilt. Use the controls below.", rows: [[inline("Open Destination Hub", "v1_destinations_v13")]] };
}

export function installDestinationsV2(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotDestinationsV2Installed) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for Destinations v2");
  Object.defineProperty(BotClass.prototype, "__telepilotDestinationsV2Installed", { value: true });
  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotDestinationsV2Handlers) {
      Object.defineProperty(this, "__telepilotDestinationsV2Handlers", { value: true });
      this.callbackQuery(["v1_destinations_v13", "groups"], async ctx => { await ctx.answerCallbackQuery(); patchState(String(ctx.from?.id || ""), { pendingInput: null }); await editOrReply(ctx, destinationsHomeScreen(String(ctx.from?.id || ""))); });
      this.callbackQuery(["v1_dest_add_v13", "add_group"], async ctx => { await ctx.answerCallbackQuery(); setInputFromCtx(ctx); await editOrReply(ctx, addScreen()); });
      this.callbackQuery("d2_add", async ctx => { await ctx.answerCallbackQuery(); setInputFromCtx(ctx); await editOrReply(ctx, addScreen()); });
      this.callbackQuery(/^d2_review:([A-Za-z0-9_-]+)$/, async ctx => { await ctx.answerCallbackQuery(); const review = readState(String(ctx.from?.id || "")).review; await editOrReply(ctx, review?.token === ctx.match[1] ? reviewScreen(review) : destinationsHomeScreen(String(ctx.from?.id || ""))); });
      this.callbackQuery(/^d2_skipped:([A-Za-z0-9_-]+)$/, async ctx => { await ctx.answerCallbackQuery(); const review = readState(String(ctx.from?.id || "")).review; await editOrReply(ctx, review?.token === ctx.match[1] ? skippedScreen(review) : destinationsHomeScreen(String(ctx.from?.id || ""))); });
      this.callbackQuery(/^d2_confirm:([A-Za-z0-9_-]+)$/, async ctx => {
        await ctx.answerCallbackQuery({ text: "Saving accessible groups…" });
        const uid = String(ctx.from?.id || "");
        const state = readState(uid);
        const review = state.review;
        if (!review || review.token !== ctx.match[1]) return editOrReply(ctx, destinationsHomeScreen(uid));
        const result = saveReviewedDestinations(uid, review);
        patchState(uid, { review: null });
        await editOrReply(ctx, {
          text: ["✅ Destinations updated", "", `New  ${result.added}`, `Already saved  ${result.existing}`, result.topics ? `Topics to choose  ${result.topics}` : null, `Not added  ${(review.notJoined?.length || 0) + (review.invalid?.length || 0) + (review.unavailable?.length || 0) + (review.unsupported?.length || 0)}`, "", "No chats were joined, muted or archived."].filter(Boolean).join("\n"),
          rows: [result.topics ? [inline("💬 Choose topics", "d2_topics:0")] : [], [inline("📚 Browse", "d2_browse:0")], [inline("← Destination Hub", "v1_destinations_v13")]].filter(row => row.length),
        });
      });
      this.callbackQuery(/^d2_browse:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, browseScreen(String(ctx.from?.id || ""), Number(ctx.match[1]), false)); });
      this.callbackQuery(/^d2_manage:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, browseScreen(String(ctx.from?.id || ""), Number(ctx.match[1]), true)); });
      this.callbackQuery(/^d2_detail:([A-Za-z0-9_-]+):(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); const uid = String(ctx.from?.id || ""); const group = groupByToken(uid, ctx.match[1]); await editOrReply(ctx, group ? detailScreen(uid, group, Number(ctx.match[2]), false) : destinationsHomeScreen(uid)); });
      this.callbackQuery(/^d2_manage_item:([A-Za-z0-9_-]+):(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); const uid = String(ctx.from?.id || ""); const group = groupByToken(uid, ctx.match[1]); await editOrReply(ctx, group ? detailScreen(uid, group, Number(ctx.match[2]), true) : destinationsHomeScreen(uid)); });
      this.callbackQuery(/^d2_delete_confirm:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {
        await ctx.answerCallbackQuery();
        const uid = String(ctx.from?.id || ""); const group = groupByToken(uid, ctx.match[1]);
        if (!group) return editOrReply(ctx, destinationsHomeScreen(uid));
        await editOrReply(ctx, { text: `🗑 Delete destination?\n\n${groupLabel(group)}\n\nThis removes it from TelePilot only. Nothing changes in Telegram.`, rows: [[inline("Delete", `d2_delete:${ctx.match[1]}:${ctx.match[2]}`)], [inline("Cancel", `d2_manage_item:${ctx.match[1]}:${ctx.match[2]}`)]] });
      });
      this.callbackQuery(/^d2_delete:([A-Za-z0-9_-]+):(\d+)$/, async ctx => { await ctx.answerCallbackQuery({ text: "Deleted" }); const uid = String(ctx.from?.id || ""); const group = groupByToken(uid, ctx.match[1]); if (group) deleteGroup(uid, group.id); await editOrReply(ctx, browseScreen(uid, Number(ctx.match[2]), true)); });
      this.callbackQuery(/^d2_topics:(\d+)$/, async ctx => {
        await ctx.answerCallbackQuery();
        const uid = String(ctx.from?.id || ""); const waiting = savedGroups(uid).filter(group => group.topicRequired === true && !Number(group.topicId || 0));
        const page = Number(ctx.match[1]); const pages = Math.max(1, Math.ceil(waiting.length / PAGE_SIZE)); const current = Math.max(0, Math.min(page, pages - 1));
        const rows = waiting.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(group => [inline(`💬 ${groupLabel(group).slice(0, 38)}`, `d2_topic_open:${token(group.id)}:0`)]);
        if (pages > 1) { const nav = []; if (current > 0) nav.push(inline("◀", `d2_topics:${current - 1}`)); if (current < pages - 1) nav.push(inline("▶", `d2_topics:${current + 1}`)); rows.push(nav); }
        rows.push([inline("← Destination Hub", "v1_destinations_v13")]);
        await editOrReply(ctx, { text: ["💬 Posting topics", "", waiting.length ? `${waiting.length} forum group${waiting.length === 1 ? " needs" : "s need"} a topic.` : "Every forum destination has a topic selected.", "", "Topics are always chosen manually."].join("\n"), rows });
      });
      this.callbackQuery(/^d2_topic_open:([A-Za-z0-9_-]+):(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); const uid = String(ctx.from?.id || ""); const group = groupByToken(uid, ctx.match[1]); try { await editOrReply(ctx, group ? await topicScreen(uid, group, Number(ctx.match[2])) : destinationsHomeScreen(uid)); } catch (err) { await editOrReply(ctx, { text: `❌ Could not load topics\n\n${errorText(err)}`, rows: [[inline("← Destination Hub", "v1_destinations_v13")]] }); } });
      this.callbackQuery(/^d2_topic_pick:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {
        const uid = String(ctx.from?.id || ""); const group = groupByToken(uid, ctx.match[1]);
        if (!group) { await ctx.answerCallbackQuery({ text: "Destination not found" }); return editOrReply(ctx, destinationsHomeScreen(uid)); }
        let title = `Topic ${ctx.match[2]}`;
        try { const topics = await topicsForGroup(uid, group); title = topics.find(topic => topic.id === Number(ctx.match[2]))?.title || title; } catch {}
        setTopic(uid, group.id, Number(ctx.match[2]), title);
        await ctx.answerCallbackQuery({ text: "Topic saved" });
        await editOrReply(ctx, destinationsHomeScreen(uid));
      });
      this.callbackQuery("d2_refresh", async ctx => { await ctx.answerCallbackQuery({ text: "Checking access…" }); const uid = String(ctx.from?.id || ""); const result = await recheckDestinations(uid, 40); await editOrReply(ctx, { text: ["↻ Access check complete", "", `Checked  ${result.checked}`, `Changed  ${result.changed}`, "", "TelePilot only checked membership. It did not join, mute or archive anything."].join("\n"), rows: [[inline("← Destination Hub", "v1_destinations_v13")]] }); });
      this.callbackQuery("d2_noop", async ctx => { await ctx.answerCallbackQuery(); });
      for (const old of ["v1_make_ready_v13", "v1_fix_issues_v13", "v1_recheck_v13", "v1_dest_issues_v13", "v1_topics_v13", "dest_topics", "dest_pending", "remove_group_menu"]) {
        this.callbackQuery(old, async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, legacyRedirectScreen()); });
      }
      this.use(destinationTextMiddleware);
    }
    return originalStart.apply(this, args);
  };
  console.log("TelePilot Destinations v2 registered (manual access only; no auto-join/mute/archive)");
}

export async function handleDestinationText(uid, text) {
  const review = await scanDestinationSources(uid, text);
  const result = saveReviewedDestinations(uid, review);
  return {
    text: ["✅ Destination scan complete", `Added  ${result.added}`, `Already saved  ${result.existing}`, `Needs topic  ${result.topics}`, `Not joined  ${review.notJoined.length}`, "No chats were joined, muted or archived."].join("\n"),
    added: result.added,
    duplicates: result.existing,
    failed: review.invalid.length + review.unavailable.length,
    attention: result.topics + review.notJoined.length,
    pending: 0,
    topics: result.topics,
    destinationIds: result.savedIds,
  };
}

export function queueRoutingSync(uid, destinationId = "", accountIds = []) {
  const settings = readAppSettings(uid);
  const allIds = (Array.isArray(settings.groups) ? settings.groups : []).map(group => String(group?.id || "")).filter(Boolean);
  const wanted = destinationId ? allIds.filter(id => id === String(destinationId)) : allIds;
  if (!wanted.length) return 0;
  const queue = readRoutingQueue(uid);
  const normalizedAccounts = [...new Set((Array.isArray(accountIds) ? accountIds : []).map(String).filter(Boolean))];
  const requests = [];
  for (let index = 0; index < wanted.length; index += ROUTING_BATCH_SIZE) {
    const destinationIds = wanted.slice(index, index + ROUTING_BATCH_SIZE);
    const duplicate = queue.some(item =>
      JSON.stringify(item.destinationIds) === JSON.stringify(destinationIds)
      && JSON.stringify(item.accountIds) === JSON.stringify(normalizedAccounts)
    );
    if (duplicate) continue;
    requests.push({ id: crypto.randomBytes(8).toString("hex"), destinationIds, accountIds: normalizedAccounts, createdAt: Date.now() });
  }
  if (!requests.length) return 0;
  writeRoutingQueue(uid, [...queue, ...requests].slice(-ROUTING_QUEUE_LIMIT));
  return requests.length;
}

export async function processRoutingQueue(uid, limit = 8) {
  const max = Math.max(1, Math.min(20, Number(limit) || 8));
  let processed = 0;
  let changed = 0;
  for (let index = 0; index < max; index++) {
    const queue = readRoutingQueue(uid);
    const request = queue[0];
    if (!request) break;
    const result = await recheckDestinationsV4(uid, {
      destinationIds: request.destinationIds,
      accountIds: request.accountIds,
      limit: Math.max(1, request.destinationIds.length),
    });
    changed += Number(result?.changed || 0);
    writeRoutingQueue(uid, readRoutingQueue(uid).filter(item => item.id !== request.id));
    processed++;
  }
  return { processed, changed };
}

export const __test = {
  membershipErrorState,
  candidateNotJoined,
  candidateIssue,
  topicAccountFor,
};
