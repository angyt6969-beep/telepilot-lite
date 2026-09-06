import fs from "node:fs";
import path from "node:path";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { InlineKeyboard } from "grammy";
import { accountDisplayLabel, effectiveAccountIds, listAccounts, loadAccountSession, updateAccountStatus } from "./account-store.js";
import { listUserIds, readAppSettings, writeAppSettings } from "./posting-engine-enhancements.js";
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

const statePath = uid => path.join(DATA_DIR, "users", String(uid), "destination-import-v1.json");
function readJson(file, fallback) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; } catch { return fallback; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readCleanup(uid) {
  const raw = readJson(statePath(uid), {}), now = Date.now();
  const rows = Array.isArray(raw.cleanup) ? raw.cleanup : [];
  return rows.map(row => ({
    accountId: String(row?.accountId || ""), destinationId: String(row?.destinationId || ""),
    muteDone: row?.muteDone === true, archiveDone: row?.archiveDone === true,
    nextMuteAt: Number(row?.nextMuteAt || 0) || 0, nextArchiveAt: Number(row?.nextArchiveAt || 0) || 0,
    muteAttempts: Number(row?.muteAttempts || 0) || 0, archiveAttempts: Number(row?.archiveAttempts || 0) || 0,
    lastMuteError: String(row?.lastMuteError || "").slice(0, 180), lastArchiveError: String(row?.lastArchiveError || "").slice(0, 180),
    completedAt: Number(row?.completedAt || 0) || 0,
  })).filter(row => row.accountId && /^-\d+$/.test(row.destinationId))
    .filter(row => !(row.muteDone && row.archiveDone && row.completedAt && now - row.completedAt > COMPLETED_RETENTION_MS));
}
function writeCleanup(uid, cleanup) { writeJson(statePath(uid), { version: 1, cleanup: cleanup.slice(-5000) }); }
function errText(err) { return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 220); }
function errCode(err) { return errText(err).toUpperCase(); }
export function floodWaitSeconds(err) {
  for (const value of [err?.seconds, err?.value, err?.retryAfter, err?.parameters?.retry_after]) {
    const n = Number(value); if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  const m = errCode(err).match(/(?:FLOOD_WAIT|PLEASE WAIT|WAIT)(?:_|\s|\(|:|-)*(\d+)/);
  return m ? Math.max(1, Number(m[1])) : 0;
}
function retryAt(err, attempts, base = 10_000) {
  const flood = floodWaitSeconds(err);
  return flood ? Date.now() + (flood + 2) * 1000 : Date.now() + Math.min(30 * 60_000, base * (2 ** Math.min(7, attempts)));
}
function idString(v) { try { return String(v?.toString?.() ?? v ?? ""); } catch { return String(v || ""); } }
const digits = v => idString(v).replace(/\D/g, "");
const peerKey = p => digits(p?.channelId ?? p?.chatId ?? p?.userId ?? p?.id ?? p);
const chatKey = c => digits(c?.id);
function findChat(chats, peer) { const key = peerKey(peer); return key ? (chats || []).find(chat => chatKey(chat) === key) || null : null; }
function uniqueChats(chats) {
  const out = [], seen = new Set();
  for (const chat of chats || []) { const key = chatKey(chat); if (!key || seen.has(key) || chat?.className === "ChannelForbidden") continue; seen.add(key); out.push(chat); }
  return out;
}

function unwrap(raw) {
  const text = String(raw || "").trim();
  const md = text.match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/i);
  return (md ? md[1] : text).replace(/^<|>$/g, "").trim();
}
export function parseDestinationInput(raw) {
  const input = unwrap(raw); if (!input) return null;
  let m = input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/addlist\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/i);
  if (m) return { kind: "addlist", slug: m[1], original: input };
  m = input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)(?:[/?#].*)?$/i);
  if (m) return { kind: "invite", hash: m[1], original: input };
  m = input.match(/^@([A-Za-z0-9_]{5,32})$/);
  if (m) return { kind: "public", username: m[1], original: input };
  m = input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})(?:[/?#].*)?$/i);
  if (m && !["addlist", "joinchat", "c", "s"].includes(m[1].toLowerCase())) return { kind: "public", username: m[1], original: input };
  return null;
}
export function parsedIdentity(parsed) {
  if (parsed?.kind === "public") return `public:${String(parsed.username || "").toLowerCase()}`;
  if (parsed?.kind === "invite") return `invite:${String(parsed.hash || "")}`;
  if (parsed?.kind === "addlist") return `addlist:${String(parsed.slug || "")}`;
  return "";
}

async function openClient(uid, account) {
  const client = new TelegramClient(new StringSession(loadAccountSession(uid, account.id)), API_ID, API_HASH, { connectionRetries: 5, floodSleepThreshold: 0 });
  client.__telepilotOwnerUid = String(uid); client.__telepilotAccountId = String(account.id);
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Saved Telegram session is no longer authorized");
  try {
    const me = await client.getMe();
    updateAccountStatus(uid, account.id, { telegramId: me?.id, username: me?.username, firstName: me?.firstName, lastName: me?.lastName, status: "connected", lastError: "", lastVerifiedAt: Date.now() });
  } catch {}
  return client;
}
function entityType(e) { return e?.broadcast === true ? "channel" : (e?.megagroup === true || e?.forum === true || e?.className === "Channel") ? "supergroup" : "group"; }
function entityLabel(e) { return String(e?.title || e?.username || e?.id || "Destination").slice(0, 120); }
function entityUsername(e) { const u = String(e?.username || "").replace(/^@/, ""); return /^[A-Za-z0-9_]{5,32}$/.test(u) ? `@${u}` : ""; }
async function entityPeerId(client, entity) {
  const direct = idString(await client.getPeerId(entity));
  if (/^-\d+$/.test(direct)) return direct;
  const raw = digits(direct || entity?.id); if (!raw) throw new Error("Could not identify Telegram destination");
  return entity?.broadcast === true || entity?.megagroup === true || entity?.forum === true || entity?.className === "Channel" ? `-100${raw}` : `-${raw}`;
}
function accountStatus(entity) {
  if (entity?.broadcast === true && entity?.creator !== true && entity?.adminRights?.postMessages !== true && entity?.admin_rights?.post_messages !== true) return { status: "read_only", reason: "Joined, but this account cannot post in this channel." };
  return { status: "ready", reason: "" };
}
function overallStatus(group) {
  if (group?.topicRequired === true && !Number(group?.topicId || 0)) return "needs_topic";
  const rows = Object.values(group?.accountJoin || {});
  for (const status of ["ready", "verification", "pending", "read_only"]) if (rows.some(row => row?.status === status)) return status;
  return rows.length ? "failed" : "ready";
}
async function saveJoined(uid, accountId, client, chats, source, sourceSlug) {
  const settings = readAppSettings(uid), groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const byId = new Map(groups.map((group, i) => [String(group.id), i]));
  const result = { addedIds: [], duplicateIds: [], joinedIds: [], topicIds: [] };
  for (const entity of uniqueChats(chats)) {
    const id = await entityPeerId(client, entity), rights = accountStatus(entity), forum = entity?.forum === true;
    const index = byId.get(id);
    if (index === undefined) {
      groups.push({ id, label: entityLabel(entity), type: entityType(entity), username: entityUsername(entity), accountMode: "inherit", accountIds: [], topicId: null, topicTitle: "", topicRequired: forum, joinStatus: forum ? "needs_topic" : rights.status, accountJoin: { [String(accountId)]: { status: rights.status, reason: rights.reason, checkedAt: Date.now() } }, source, sourceSlug, importedAt: Date.now() });
      byId.set(id, groups.length - 1); result.addedIds.push(id);
    } else {
      const group = { ...groups[index], accountJoin: { ...(groups[index].accountJoin || {}) } };
      group.label = entityLabel(entity); group.type = entityType(entity); group.username = entityUsername(entity) || group.username || "";
      group.topicRequired = group.topicRequired === true || forum;
      group.accountJoin[String(accountId)] = { status: rights.status, reason: rights.reason, checkedAt: Date.now() };
      group.source ||= source; group.sourceSlug ||= sourceSlug; group.joinStatus = overallStatus(group); groups[index] = group; result.duplicateIds.push(id);
    }
    result.joinedIds.push(id);
    const saved = groups[byId.get(id)]; if (saved.topicRequired === true && !Number(saved.topicId || 0)) result.topicIds.push(id);
  }
  if (result.joinedIds.length) { writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups }); syncUserGroups(uid); }
  return result;
}

async function joinPublic(client, parsed) {
  const target = `@${parsed.username}`; let entity = await client.getEntity(target);
  try { await client.getParticipant(entity, "me"); }
  catch (err) {
    if (!errCode(err).includes("USER_NOT_PARTICIPANT")) throw err;
    try { await client.joinChannel(target); }
    catch (joinErr) {
      const code = errCode(joinErr);
      if (code.includes("INVITE_REQUEST_SENT")) return { pending: true, chats: [] };
      if (!code.includes("USER_ALREADY_PARTICIPANT")) throw joinErr;
    }
  }
  entity = await client.getEntity(target); return { pending: false, chats: [entity] };
}
async function joinInvite(client, parsed) {
  let checked = await client.checkChatInvite(parsed.hash);
  if (checked?.chat) return { pending: false, chats: [checked.chat] };
  let updates;
  try { updates = await client.importChatInvite(parsed.hash); }
  catch (err) {
    const code = errCode(err);
    if (code.includes("INVITE_REQUEST_SENT")) return { pending: true, chats: [] };
    if (!code.includes("USER_ALREADY_PARTICIPANT")) throw err;
  }
  const fromUpdates = uniqueChats(updates?.chats || []); if (fromUpdates.length) return { pending: false, chats: fromUpdates };
  checked = await client.checkChatInvite(parsed.hash); if (checked?.chat) return { pending: false, chats: [checked.chat] };
  throw new Error("Telegram accepted the invite but did not return the joined chat.");
}
async function inputPeers(client, peers, chats) {
  const inputs = [], acceptedChats = [];
  for (const peer of peers || []) {
    const chat = findChat(chats, peer); if (!chat || chat?.className === "ChannelForbidden") continue;
    try { inputs.push(await client.getInputEntity(chat)); acceptedChats.push(chat); } catch {}
  }
  return { inputs, acceptedChats };
}
export async function importAddlistWithClient(client, slug) {
  const invite = await client.api.chatlists.checkChatlistInvite({ slug });
  const chats = Array.isArray(invite?.chats) ? invite.chats : [];
  const already = invite?.className === "ChatlistInviteAlready" || Number.isInteger(Number(invite?.filterId));
  if (!already) {
    const { inputs, acceptedChats } = await inputPeers(client, invite?.peers || [], chats);
    if (inputs.length) await client.api.chatlists.joinChatlistInvite({ slug, peers: inputs });
    return { chats: uniqueChats(acceptedChats), joinedNow: acceptedChats.length, already: 0 };
  }
  const alreadyChats = uniqueChats((invite?.alreadyPeers || []).map(peer => findChat(chats, peer)).filter(Boolean));
  if (!(invite?.missingPeers || []).length) return { chats: alreadyChats, joinedNow: 0, already: alreadyChats.length };
  const chatlist = new Api.InputChatlistDialogFilter({ filterId: Number(invite.filterId) });
  const updates = await client.api.chatlists.getChatlistUpdates({ chatlist });
  const { inputs, acceptedChats } = await inputPeers(client, updates?.missingPeers || [], updates?.chats || []);
  if (inputs.length) await client.api.chatlists.joinChatlistUpdates({ chatlist, peers: inputs });
  return { chats: uniqueChats([...alreadyChats, ...acceptedChats]), joinedNow: acceptedChats.length, already: alreadyChats.length };
}

function enqueueCleanup(uid, accountId, ids) {
  const cleanup = readCleanup(uid); let added = 0;
  for (const destinationId of new Set(ids || [])) {
    if (!/^-\d+$/.test(String(destinationId))) continue;
    if (cleanup.some(row => row.accountId === String(accountId) && row.destinationId === String(destinationId))) continue;
    cleanup.push({ accountId: String(accountId), destinationId: String(destinationId), muteDone: false, archiveDone: false, nextMuteAt: Date.now(), nextArchiveAt: Date.now(), muteAttempts: 0, archiveAttempts: 0, lastMuteError: "", lastArchiveError: "", completedAt: 0 }); added++;
  }
  if (added) writeCleanup(uid, cleanup); return added;
}
async function processOne(uid, account, parsed) {
  let client;
  try {
    client = await openClient(uid, account);
    const joined = parsed.kind === "public" ? await joinPublic(client, parsed) : parsed.kind === "invite" ? await joinInvite(client, parsed) : await importAddlistWithClient(client, parsed.slug);
    if (joined.pending) return { pending: true, joinedIds: [], topicIds: [] };
    const sourceSlug = parsed.kind === "public" ? parsed.username : parsed.kind === "invite" ? parsed.hash : parsed.slug;
    const saved = await saveJoined(uid, account.id, client, joined.chats, parsed.kind, sourceSlug);
    enqueueCleanup(uid, account.id, saved.joinedIds);
    return { pending: false, ...saved };
  } finally { try { await client?.disconnect(); } catch {} }
}

async function resolveEntity(client, group) {
  const username = String(group?.username || "").replace(/^@/, "");
  if (username) try { return await client.getEntity(`@${username}`); } catch {}
  try { return await client.getEntity(String(group?.id || "")); } catch {}
  for (const dialog of await client.getDialogs({})) {
    const entity = dialog?.entity || dialog;
    try { if (await entityPeerId(client, entity) === String(group.id)) return entity; } catch {}
  }
  throw new Error("Could not resolve joined Telegram destination");
}
async function inputFor(client, group) { return client.getInputEntity(await resolveEntity(client, group)); }
function completed(row) { if (row.muteDone && row.archiveDone && !row.completedAt) row.completedAt = Date.now(); }
async function processCleanup(uid) {
  const cleanup = readCleanup(uid), settings = readAppSettings(uid), groups = Array.isArray(settings.groups) ? settings.groups : [];
  const byGroup = new Map(groups.map(group => [String(group.id), group])), byAccount = new Map(listAccounts(uid).map(a => [String(a.id), a]));
  const now = Date.now(), accountId = cleanup.find(row => (!row.archiveDone && row.nextArchiveAt <= now) || (!row.muteDone && row.nextMuteAt <= now))?.accountId;
  const account = byAccount.get(accountId); if (!account) return 0;
  let client;
  try {
    client = await openClient(uid, account);
    const archiveRows = cleanup.filter(row => row.accountId === accountId && !row.archiveDone && row.nextArchiveAt <= now).slice(0, ARCHIVE_BATCH_SIZE);
    const resolved = [];
    for (const row of archiveRows) {
      const group = byGroup.get(row.destinationId);
      if (!group) { row.archiveDone = true; completed(row); continue; }
      try { resolved.push({ row, peer: await inputFor(client, group) }); }
      catch (err) { row.archiveAttempts++; row.lastArchiveError = errText(err); row.nextArchiveAt = retryAt(err, row.archiveAttempts, 15_000); }
    }
    if (resolved.length) {
      try {
        await client.invoke(new Api.folders.EditPeerFolders({ folderPeers: resolved.map(({ peer }) => new Api.InputFolderPeer({ peer, folderId: 1 })) }));
        for (const { row } of resolved) { row.archiveDone = true; row.lastArchiveError = ""; row.nextArchiveAt = 0; completed(row); }
      } catch (err) {
        const next = retryAt(err, Math.max(...resolved.map(({ row }) => row.archiveAttempts)), 15_000);
        for (const { row } of resolved) { row.archiveAttempts++; row.lastArchiveError = errText(err); row.nextArchiveAt = next; }
        const wait = floodWaitSeconds(err); if (wait) console.log(`Archive cooldown for sender ${accountId}: ${wait}s`); else console.warn(`Archive batch failed: ${errText(err)}`);
      }
    }
    const muteRow = cleanup.find(row => row.accountId === accountId && !row.muteDone && row.nextMuteAt <= Date.now());
    if (muteRow) {
      const group = byGroup.get(muteRow.destinationId);
      if (!group) { muteRow.muteDone = true; completed(muteRow); }
      else try {
        const peer = await inputFor(client, group);
        await client.invoke(new Api.account.UpdateNotifySettings({ peer: new Api.InputNotifyPeer({ peer }), settings: new Api.InputPeerNotifySettings({ silent: true, muteUntil: MUTE_FOREVER_UNIX }) }));
        muteRow.muteDone = true; muteRow.lastMuteError = ""; muteRow.nextMuteAt = 0; completed(muteRow);
      } catch (err) {
        muteRow.muteAttempts++; muteRow.lastMuteError = errText(err); muteRow.nextMuteAt = retryAt(err, muteRow.muteAttempts);
        const wait = floodWaitSeconds(err); if (wait) console.log(`Mute cooldown for sender ${accountId}: ${wait}s`); else console.warn(`Mute failed for ${muteRow.destinationId}: ${errText(err)}`);
      }
    }
    writeCleanup(uid, cleanup); return archiveRows.length + (muteRow ? 1 : 0);
  } finally { try { await client?.disconnect(); } catch {} }
}

export function destinationAccountReady(destination, accountId = "") {
  if (!destination || (destination.topicRequired === true && !Number(destination.topicId || 0))) return false;
  const map = destination.accountJoin && typeof destination.accountJoin === "object" ? destination.accountJoin : null;
  if (!map) return String(destination.joinStatus || "ready") === "ready";
  if (accountId) return map[String(accountId)]?.status === "ready";
  return Object.values(map).some(row => row?.status === "ready");
}
export function recordDestinationFailure(uid, destination, accountId, err) {
  const code = errCode(err);
  if (!["CHAT_WRITE_FORBIDDEN", "CHAT_SEND_PLAIN_FORBIDDEN", "CHAT_SEND_MEDIA_FORBIDDEN", "USER_NOT_PARTICIPANT"].some(token => code.includes(token))) return false;
  const settings = readAppSettings(uid), groups = Array.isArray(settings.groups) ? settings.groups.slice() : [], i = groups.findIndex(g => String(g.id) === String(destination?.id)); if (i < 0) return false;
  const group = { ...groups[i], accountJoin: { ...(groups[i].accountJoin || {}) } };
  group.accountJoin[String(accountId)] = { status: code.includes("USER_NOT_PARTICIPANT") ? "pending" : "verification", reason: code.includes("USER_NOT_PARTICIPANT") ? "This account is no longer a member of the group." : "Telegram currently blocks posting from this account.", checkedAt: Date.now() };
  group.joinStatus = overallStatus(group); groups[i] = group; writeAppSettings(uid, { ...settings, groups }); syncUserGroups(uid); return true;
}
export function queueRoutingSync() { return 0; }
export async function processRoutingQueue() { return 0; }

export async function handleDestinationText(uid, text) {
  const id = String(uid || ""), settings = readAppSettings(id), accounts = listAccounts(id), selected = new Set(effectiveAccountIds(settings, null, accounts).map(String));
  const active = accounts.filter(account => selected.has(String(account.id)));
  if (!active.length) return { text: "Connect and select a personal Telegram account before importing destinations." };
  const lines = String(text || "").split(/\r?\n/).map(v => v.trim()).filter(Boolean), parsed = lines.map(parseDestinationInput);
  let failed = parsed.filter(v => !v).length, pending = 0; const errors = [], joinedIds = new Set(), topicIds = new Set();
  const before = new Set((Array.isArray(settings.groups) ? settings.groups : []).map(g => String(g.id)));
  for (const item of parsed.filter(Boolean)) for (const account of active) {
    try {
      const result = await processOne(id, account, item);
      if (result.pending) { pending++; continue; }
      for (const value of result.joinedIds || []) joinedIds.add(value);
      for (const value of result.topicIds || []) topicIds.add(value);
    } catch (err) { failed++; errors.push(`${accountDisplayLabel(account)}: ${errText(err)}`); }
  }
  const latest = readAppSettings(id), groups = Array.isArray(latest.groups) ? latest.groups : [], added = groups.filter(g => !before.has(String(g.id))).length;
  if (added > 0 && topicIds.size === 0) try { advanceTutorialAfterAction(id, 3, 4); } catch {}
  const result = ["✅ Destination import finished", "", `Added — ${added}`, `Already saved — ${Math.max(0, joinedIds.size - added)}`, `Join requests pending — ${pending}`, `Topics to choose — ${topicIds.size}`, `Failed / invalid — ${failed}`, `Mute + archive queued — ${readCleanup(id).filter(row => !row.muteDone || !row.archiveDone).length}`];
  if (errors.length) result.push("", ...errors.slice(0, 3).map(value => `• ${value}`));
  return { text: result.join("\n") };
}

function destinationGroups(uid) { const groups = readAppSettings(uid).groups; return Array.isArray(groups) ? groups : []; }
export function destinationMenu(uid) {
  const groups = destinationGroups(uid), topics = groups.filter(g => g.topicRequired === true && !Number(g.topicId || 0)).length, cleanup = readCleanup(uid).filter(row => !row.muteDone || !row.archiveDone).length;
  const lines = groups.slice(0, 30).map((g, i) => `${i + 1}. ${g.username || g.label || g.id}${g.topicTitle ? ` → ${g.topicTitle}` : ""}`); if (groups.length > 30) lines.push(`…and ${groups.length - 30} more`);
  const text = [`📍 Destinations · ${groups.length}`, "", lines.length ? lines.join("\n") : "No destinations yet.", "", `Topics ${topics} · Cleanup queued ${cleanup}`].join("\n");
  const kb = new InlineKeyboard().text("＋ Add destinations", "add_group").row(); if (topics) kb.text(`💬 Choose topics (${topics})`, "dest_topics").row(); if (cleanup) kb.text("⏳ Cleanup status", "dest_pending").row(); if (groups.length) kb.text("Manage", "remove_group_menu").row(); kb.text("← Home", "home");
  return { text, keyboard: kb };
}
async function fetchTopics(uid, group) {
  const settings = readAppSettings(uid), accounts = listAccounts(uid), ids = effectiveAccountIds(settings, group, accounts).map(String), account = accounts.find(a => ids.includes(String(a.id))) || accounts[0]; if (!account) throw new Error("Connect a personal Telegram account first.");
  let client; try { client = await openClient(uid, account); const entity = await resolveEntity(client, group); const result = await client.getForumTopics(entity, { limit: 100 }); return (result?.topics || []).map(t => ({ id: Number(t.id || 0), title: String(t.title || `Topic ${t.id}`).slice(0, 100) })).filter(t => t.id > 0); } finally { try { await client?.disconnect(); } catch {} }
}
async function showTopics(ctx, destinationId = "", page = 0) {
  const uid = String(ctx.from?.id || ""), waiting = destinationGroups(uid).filter(g => g.topicRequired === true && !Number(g.topicId || 0));
  if (!destinationId) {
    const kb = new InlineKeyboard(); for (const group of waiting.slice(0, 30)) kb.text(String(group.label || group.username || group.id).slice(0, 42), `dest_topic_open:${group.id}:0`).row(); kb.text("← Destinations", "groups");
    return ctx.editMessageText(waiting.length ? "💬 Choose a forum group\n\nSelect a group, then choose the exact posting topic." : "✅ No forum topics are waiting for selection.", { reply_markup: kb });
  }
  const group = waiting.find(g => String(g.id) === String(destinationId)) || destinationGroups(uid).find(g => String(g.id) === String(destinationId)); if (!group) throw new Error("Destination no longer exists.");
  const topics = await fetchTopics(uid, group), pages = Math.max(1, Math.ceil(topics.length / TOPIC_PAGE_SIZE)), p = Math.max(0, Math.min(Number(page) || 0, pages - 1)), kb = new InlineKeyboard();
  for (const topic of topics.slice(p * TOPIC_PAGE_SIZE, (p + 1) * TOPIC_PAGE_SIZE)) kb.text(topic.title.slice(0, 42), `dest_topic_pick:${group.id}:${topic.id}`).row();
  if (pages > 1) { if (p > 0) kb.text("◀ Prev", `dest_topic_open:${group.id}:${p - 1}`); if (p < pages - 1) kb.text("Next ▶", `dest_topic_open:${group.id}:${p + 1}`); kb.row(); } kb.text("← Forum groups", "dest_topics");
  return ctx.editMessageText(`💬 ${group.label || group.username || group.id}\n\nChoose the exact topic TelePilot should use.`, { reply_markup: kb });
}
async function chooseTopic(uid, destinationId, topicId) {
  const settings = readAppSettings(uid), groups = Array.isArray(settings.groups) ? settings.groups.slice() : [], i = groups.findIndex(g => String(g.id) === String(destinationId)); if (i < 0) return false;
  const group = { ...groups[i] }; let title = `Topic ${topicId}`; try { title = (await fetchTopics(uid, group)).find(t => t.id === Number(topicId))?.title || title; } catch {}
  group.topicRequired = true; group.topicId = Number(topicId); group.topicTitle = title; group.joinStatus = overallStatus(group); groups[i] = group; writeAppSettings(uid, { ...settings, groups }); syncUserGroups(uid); return true;
}
function installHandlers(bot) {
  bot.callbackQuery("dest_topics", async ctx => { await ctx.answerCallbackQuery(); try { await showTopics(ctx); } catch (err) { await ctx.editMessageText(`Could not load topics: ${errText(err)}`, { reply_markup: new InlineKeyboard().text("← Destinations", "groups") }); } });
  bot.callbackQuery(/^dest_topic_open:(-\d+):(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); try { await showTopics(ctx, ctx.match[1], Number(ctx.match[2])); } catch (err) { await ctx.editMessageText(`Could not load topics: ${errText(err)}`, { reply_markup: new InlineKeyboard().text("← Destinations", "groups") }); } });
  bot.callbackQuery(/^dest_topic_pick:(-\d+):(\d+)$/, async ctx => { await ctx.answerCallbackQuery({ text: "Topic selected" }); const uid = String(ctx.from?.id || ""); await chooseTopic(uid, ctx.match[1], Number(ctx.match[2])); if (!destinationGroups(uid).some(g => g.topicRequired === true && !Number(g.topicId || 0))) { const screen = advanceTutorialAfterAction(uid, 3, 4); if (screen) return ctx.editMessageText(screen.text, { reply_markup: screen.keyboard }); } await showTopics(ctx); });
  bot.callbackQuery("dest_pending", async ctx => { await ctx.answerCallbackQuery(); const pending = readCleanup(String(ctx.from?.id || "")).filter(row => !row.muteDone || !row.archiveDone); await ctx.editMessageText(`⏳ Cleanup status\n\nMute/archive jobs waiting — ${pending.length}\n\nEach joined destination is queued once. Completed jobs are not continuously re-added.`, { reply_markup: new InlineKeyboard().text("← Destinations", "groups") }); });
}
export function installDestinationAutomation(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotDestinationAutomationInstalled) return;
  const start = BotClass.prototype.start; Object.defineProperty(BotClass.prototype, "__telepilotDestinationAutomationInstalled", { value: true });
  BotClass.prototype.start = function(...args) { if (!this.__telepilotFreshDestinationHandlers) { this.__telepilotFreshDestinationHandlers = true; installHandlers(this); } return start.apply(this, args); };
}
let timer = null, busy = false;
export function startDestinationAutomationWorker() {
  if (timer || !API_ID || !API_HASH) return timer;
  const tick = async () => { if (busy) return; busy = true; try { for (const uid of listUserIds()) try { await processCleanup(uid); } catch (err) { console.warn(`Destination cleanup failed for ${uid}: ${errText(err)}`); } } finally { busy = false; } };
  timer = setInterval(() => void tick(), WORKER_INTERVAL_MS); timer.unref?.(); setTimeout(() => void tick(), 1_000).unref?.();
  console.log("TelePilot fresh destination importer enabled (public/private/Addlist + topics + cleanup)"); return timer;
}
