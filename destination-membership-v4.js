import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import {
  accountDisplayLabel,
  effectiveAccountIds,
  listAccounts,
  loadAccountSession,
  updateAccountStatus,
  usesBotSender,
} from "./account-store.js";
import { readAppSettings, writeAppSettings } from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const ISSUE_EMOJI_ID = "5280957715462505291";
const ISSUE_GROUP_EMOJI_ID = "5420323339723881652";
const PAGE_SIZE = 8;
const MAX_EXPLICIT_RECHECK = 200;

function inline(text, data, iconCustomEmojiId = "") {
  const button = { text, callback_data: data };
  if (iconCustomEmojiId) button.icon_custom_emoji_id = iconCustomEmojiId;
  return button;
}
function keyboard(rows) { return { inline_keyboard: rows.filter(row => Array.isArray(row) && row.length) }; }
function errorText(err) { return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 220); }
function errorCode(err) { return errorText(err).toUpperCase(); }
function groupLabel(group) { return String(group?.username || group?.label || group?.id || "Destination"); }
function token(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}
function peerKey(value) {
  const text = String(value?.toString?.() ?? value ?? "").trim();
  if (/^-100\d+$/.test(text)) return text.slice(4);
  if (/^-\d+$/.test(text)) return text.slice(1);
  return text.replace(/\D/g, "");
}
function entityKey(entity) { return peerKey(entity?.id); }
function rightsFlag(rights, camel, snake) { return rights?.[camel] === true || rights?.[snake] === true; }
function untilText(rights) {
  const until = Number(rights?.untilDate ?? rights?.until_date ?? 0);
  if (!until) return "";
  const ms = until * 1000;
  if (!Number.isFinite(ms) || ms <= Date.now()) return "";
  return ` until ${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}
function restrictionState(rights, fallback = "restricted") {
  if (!rights || typeof rights !== "object") return null;
  const suffix = untilText(rights);
  if (rightsFlag(rights, "viewMessages", "view_messages")) {
    return { status: "banned", reason: `Telegram says this account cannot view this group${suffix}.`, checkedAt: Date.now() };
  }
  if (rightsFlag(rights, "sendPlain", "send_plain") || rightsFlag(rights, "sendMessages", "send_messages")) {
    return { status: "text_blocked", reason: `Joined, but text/messages are not allowed for this account${suffix}.`, checkedAt: Date.now() };
  }
  if (
    rightsFlag(rights, "sendMedia", "send_media") || rightsFlag(rights, "sendPhotos", "send_photos") ||
    rightsFlag(rights, "sendVideos", "send_videos") || rightsFlag(rights, "sendDocs", "send_docs") ||
    rightsFlag(rights, "sendAudios", "send_audios") || rightsFlag(rights, "sendVoices", "send_voices")
  ) {
    return { status: "media_blocked", reason: `Joined, but one or more media types are not allowed for this account${suffix}.`, checkedAt: Date.now() };
  }
  const anyRestriction = [
    ["sendStickers", "send_stickers"], ["sendGifs", "send_gifs"], ["sendGames", "send_games"],
    ["sendInline", "send_inline"], ["embedLinks", "embed_links"], ["sendPolls", "send_polls"],
  ].some(([camel, snake]) => rightsFlag(rights, camel, snake));
  if (anyRestriction || fallback === "restricted") {
    return { status: "restricted", reason: `Joined, but Telegram reports account restrictions in this group${suffix}.`, checkedAt: Date.now() };
  }
  return null;
}
function stateFromEntity(entity) {
  const className = String(entity?.className || "");
  if (className === "ChatForbidden" || className === "ChannelForbidden" || entity?.deactivated === true) {
    return { status: "unavailable", reason: "Telegram reports this group as unavailable to the account.", checkedAt: Date.now() };
  }
  if (entity?.kicked === true) {
    return { status: "banned", reason: "Telegram reports that this account was removed/banned from the group.", checkedAt: Date.now() };
  }
  if (entity?.left === true) {
    return { status: "not_member", reason: "Telegram explicitly reports that this account left the group.", checkedAt: Date.now() };
  }
  const restricted = restrictionState(entity?.bannedRights, "none");
  if (restricted) return restricted;
  return { status: "ready", reason: "Joined in Telegram.", checkedAt: Date.now() };
}
function stateFromParticipant(result) {
  const participant = result?.participant || result;
  const className = String(participant?.className || "");
  if (className === "ChannelParticipantLeft") {
    return { status: "not_member", reason: "Telegram explicitly reports USER_NOT_PARTICIPANT / left membership.", checkedAt: Date.now() };
  }
  if (className === "ChannelParticipantBanned") {
    const restricted = restrictionState(participant?.bannedRights, "restricted");
    if (participant?.left === true && restricted?.status !== "text_blocked" && restricted?.status !== "media_blocked") {
      return { status: "banned", reason: "Telegram reports this account as banned/kicked from the group.", checkedAt: Date.now() };
    }
    return restricted || { status: "banned", reason: "Telegram reports this account as banned/restricted in the group.", checkedAt: Date.now() };
  }
  return { status: "ready", reason: "Telegram confirms this account is a participant.", checkedAt: Date.now() };
}
function stateFromError(err) {
  const code = errorCode(err);
  if (code.includes("USER_NOT_PARTICIPANT")) return { status: "not_member", reason: "Telegram explicitly returned USER_NOT_PARTICIPANT.", telegramCode: "USER_NOT_PARTICIPANT", checkedAt: Date.now() };
  if (code.includes("USER_BANNED_IN_CHANNEL")) return { status: "banned", reason: "Telegram reports this account is banned/restricted from sending in this group.", telegramCode: "USER_BANNED_IN_CHANNEL", checkedAt: Date.now() };
  if (code.includes("CHAT_SEND_PLAIN_FORBIDDEN") || code.includes("CHAT_WRITE_FORBIDDEN")) return { status: "text_blocked", reason: "Joined/access is known, but Telegram does not allow text/messages from this account.", telegramCode: code.includes("CHAT_SEND_PLAIN_FORBIDDEN") ? "CHAT_SEND_PLAIN_FORBIDDEN" : "CHAT_WRITE_FORBIDDEN", checkedAt: Date.now() };
  if (code.includes("CHAT_SEND_MEDIA_FORBIDDEN") || code.includes("CHAT_SEND_PHOTOS_FORBIDDEN") || code.includes("CHAT_SEND_VIDEOS_FORBIDDEN")) return { status: "media_blocked", reason: "Joined/access is known, but Telegram blocks the configured media type for this account.", telegramCode: code.match(/CHAT_SEND_[A-Z_]+_FORBIDDEN/)?.[0] || "CHAT_SEND_MEDIA_FORBIDDEN", checkedAt: Date.now() };
  if (code.includes("CHAT_RESTRICTED")) return { status: "restricted", reason: "Telegram reports this account is restricted in the group.", telegramCode: "CHAT_RESTRICTED", checkedAt: Date.now() };
  if (code.includes("CHANNEL_PRIVATE") || code.includes("CHAT_FORBIDDEN") || code.includes("CHANNEL_PUBLIC_GROUP_NA") || code.includes("CHANNEL_INVALID") || code.includes("CHAT_INVALID")) {
    const known = ["CHANNEL_PRIVATE", "CHAT_FORBIDDEN", "CHANNEL_PUBLIC_GROUP_NA", "CHANNEL_INVALID", "CHAT_INVALID"].find(value => code.includes(value));
    return { status: "unavailable", reason: `Telegram reports this group as unavailable/inaccessible (${known}). This does not prove you voluntarily left it.`, telegramCode: known, checkedAt: Date.now() };
  }
  if (code.includes("CHAT_ADMIN_REQUIRED")) return { status: "restricted", reason: "Telegram would not allow this membership/access check without stronger permissions; membership is not being marked as left.", telegramCode: "CHAT_ADMIN_REQUIRED", checkedAt: Date.now() };
  return { status: "issue", reason: `Telegram access check was inconclusive: ${errorText(err)}`, telegramCode: errorText(err), checkedAt: Date.now() };
}

async function openAccountClient(uid, account) {
  const session = loadAccountSession(uid, account.id);
  if (!session) throw new Error("Saved Telegram session is missing");
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5, floodSleepThreshold: 0 });
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Saved Telegram session is no longer authorized");
  try {
    const me = await client.getMe();
    updateAccountStatus(uid, account.id, { telegramId: me?.id, username: me?.username, firstName: me?.firstName, lastName: me?.lastName, status: "connected", lastError: "", lastVerifiedAt: Date.now() });
  } catch {}
  return client;
}
async function buildContext(uid, account) {
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
function explicitPeer(group) {
  const id = String(group?.id || "");
  const accessHash = String(group?.accessHash || "");
  if (/^-100\d+$/.test(id) && /^-?\d+$/.test(accessHash)) {
    return new Api.InputPeerChannel({ channelId: bigInt(id.slice(4)), accessHash: bigInt(accessHash) });
  }
  return null;
}
function hydratePeerMetadata(group, entity) {
  if (!group || !entity) return;
  if (entity?.accessHash !== undefined && entity?.accessHash !== null) group.accessHash = String(entity.accessHash);
  const username = String(entity?.username || "").replace(/^@/, "");
  if (username && !group.username) group.username = `@${username}`;
}
async function peerFromSavedSource(ctx, group) {
  const kind = String(group?.source || "");
  const slug = String(group?.sourceSlug || "");
  const wanted = peerKey(group?.id);
  if (!slug || !wanted) return null;
  if (kind === "invite") {
    try {
      const checked = await ctx.client.checkChatInvite(slug);
      const entity = checked?.chat || null;
      if (entity && entityKey(entity) === wanted) {
        hydratePeerMetadata(group, entity);
        return entity;
      }
    } catch {}
    return null;
  }
  if (kind === "addlist") {
    try {
      const checked = await ctx.client.api.chatlists.checkChatlistInvite({ slug });
      const entity = (Array.isArray(checked?.chats) ? checked.chats : []).find(item => entityKey(item) === wanted) || null;
      if (entity) {
        hydratePeerMetadata(group, entity);
        return entity;
      }
    } catch {}
  }
  return null;
}
async function verifyMissingDialog(ctx, group) {
  try {
    let peer = null;
    if (group?.username) {
      try { peer = await ctx.client.getInputEntity(String(group.username)); } catch {}
    }
    if (!peer) {
      try { peer = await ctx.client.getInputEntity(String(group.id)); } catch {}
    }
    if (!peer) peer = explicitPeer(group);
    if (!peer) peer = await peerFromSavedSource(ctx, group);
    if (!peer) return { status: "issue", reason: "This destination is not in the current dialog list and TelePilot has no resolvable peer for a direct membership check. It is not being marked as not joined.", checkedAt: Date.now() };
    const result = await ctx.client.getParticipant(peer, "me");
    return stateFromParticipant(result);
  } catch (err) {
    return stateFromError(err);
  }
}
function requiredAccountIds(settings, group, accounts) {
  if (usesBotSender(settings, group, accounts)) return [];
  return effectiveAccountIds(settings, group, accounts).map(String);
}
function joinStatusForRoute(group, requiredIds, botRoute = false) {
  if (group?.topicRequired === true && !Number(group?.topicId || 0)) return "needs_topic";
  if (botRoute) return "ready";
  if (!requiredIds.length) return "failed";
  const rows = requiredIds.map(id => group?.accountJoin?.[id]).filter(Boolean);
  if (rows.length === requiredIds.length && rows.every(row => row?.status === "ready")) return "ready";
  if (rows.some(row => row?.status === "ready")) return "partial";
  if (rows.some(row => ["text_blocked", "media_blocked", "restricted"].includes(row?.status))) return "read_only";
  if (rows.some(row => row?.status === "verification")) return "verification";
  if (rows.some(row => row?.status === "pending")) return "pending";
  return "failed";
}
function normalizeRecheckOptions(options) {
  if (typeof options === "number") return { limit: options };
  return options && typeof options === "object" ? options : {};
}

export async function recheckDestinationsV4(uid, rawOptions = {}) {
  if (!API_ID || !API_HASH) throw new Error("Telegram API credentials are not configured");
  const options = normalizeRecheckOptions(rawOptions);
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const accounts = listAccounts(uid);
  const accountById = new Map(accounts.map(account => [String(account.id), account]));
  const requestedDestinationIds = new Set((Array.isArray(options.destinationIds) ? options.destinationIds : []).map(String).filter(Boolean));
  const requestedAccountIds = new Set((Array.isArray(options.accountIds) ? options.accountIds : []).map(String).filter(Boolean));
  const limit = Math.max(1, Math.min(MAX_EXPLICIT_RECHECK, Number(options.limit || MAX_EXPLICIT_RECHECK) || MAX_EXPLICIT_RECHECK));
  const targetIndexes = [];
  for (let index = 0; index < groups.length && targetIndexes.length < limit; index++) {
    if (requestedDestinationIds.size && !requestedDestinationIds.has(String(groups[index]?.id || ""))) continue;
    targetIndexes.push(index);
  }
  if (!targetIndexes.length) return { checked: 0, changed: 0, total: groups.length, counts: healthCounts(groups) };

  const requiredByGroup = new Map();
  const accountIdsToOpen = new Set();
  for (const index of targetIndexes) {
    const group = groups[index];
    const botRoute = usesBotSender(settings, group, accounts);
    const required = requiredAccountIds(settings, group, accounts);
    requiredByGroup.set(index, { required, botRoute });
    for (const id of required) {
      if (!requestedAccountIds.size || requestedAccountIds.has(id)) accountIdsToOpen.add(id);
    }
  }

  const contexts = new Map();
  const accountErrors = new Map();
  try {
    for (const accountId of accountIdsToOpen) {
      const account = accountById.get(accountId);
      if (!account) continue;
      try { contexts.set(accountId, await buildContext(uid, account)); }
      catch (err) {
        const message = errorText(err);
        accountErrors.set(accountId, message);
        updateAccountStatus(uid, account.id, { lastError: message, lastVerifiedAt: Date.now() });
      }
    }

    let checked = 0;
    let changed = 0;
    const validAccountIds = new Set(accounts.map(account => String(account.id)));
    for (const index of targetIndexes) {
      const original = groups[index];
      const group = { ...original, accountJoin: {} };
      const route = requiredByGroup.get(index) || { required: [], botRoute: false };
      const requiredSet = new Set(route.required);
      for (const [accountId, row] of Object.entries(original?.accountJoin || {})) {
        if (validAccountIds.has(String(accountId)) && requiredSet.has(String(accountId))) group.accountJoin[String(accountId)] = row;
      }

      const key = peerKey(group.id);
      for (const accountId of route.required) {
        if (requestedAccountIds.size && !requestedAccountIds.has(accountId)) continue;
        const ctx = contexts.get(accountId);
        if (!ctx) {
          group.accountJoin[accountId] = {
            status: "issue",
            reason: accountErrors.get(accountId) ? `Could not check this sender: ${accountErrors.get(accountId)}` : "This routed sender is not available for an access check.",
            checkedAt: Date.now(),
          };
          continue;
        }
        const entity = ctx.dialogByKey.get(key);
        if (entity) hydratePeerMetadata(group, entity);
        group.accountJoin[accountId] = entity ? stateFromEntity(entity) : await verifyMissingDialog(ctx, group);
      }

      group.joinStatus = joinStatusForRoute(group, route.required, route.botRoute);
      group.lastCheckedAt = Date.now();
      const before = JSON.stringify({ accountJoin: original?.accountJoin || {}, joinStatus: original?.joinStatus || "", accessHash: original?.accessHash || "", username: original?.username || "" });
      const after = JSON.stringify({ accountJoin: group.accountJoin, joinStatus: group.joinStatus, accessHash: group.accessHash || "", username: group.username || "" });
      if (before !== after) changed++;
      groups[index] = group;
      checked++;
    }

    writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
    syncUserGroups(uid);
    return { checked, changed, total: groups.length, counts: healthCounts(groups) };
  } finally {
    for (const ctx of contexts.values()) try { await ctx.client.disconnect(); } catch {}
  }
}

function groupStatus(group) {
  if (group?.topicRequired === true && !Number(group?.topicId || 0)) return "topic";
  const rows = Object.values(group?.accountJoin || {});
  if (!rows.length) return String(group?.joinStatus || "") === "ready" ? "ready" : "unchecked";
  if (rows.every(row => row?.status === "ready")) return "ready";
  if (rows.some(row => row?.status === "ready")) return "issue";
  for (const status of ["banned", "unavailable", "text_blocked", "media_blocked", "restricted", "not_member", "issue"]) {
    if (rows.some(row => row?.status === status)) return status;
  }
  return "issue";
}
function healthCounts(groups) {
  const counts = { total: 0, ready: 0, topic: 0, banned: 0, unavailable: 0, text_blocked: 0, media_blocked: 0, restricted: 0, not_member: 0, unchecked: 0, issue: 0 };
  for (const group of groups || []) { counts.total++; counts[groupStatus(group)]++; }
  counts.attention = counts.total - counts.ready;
  return counts;
}
function statusTitle(status) {
  return status === "topic" ? "Choose a topic"
    : status === "banned" ? "Banned / kicked"
      : status === "unavailable" ? "Group unavailable"
        : status === "text_blocked" ? "Muted / text not allowed"
          : status === "media_blocked" ? "Media not allowed"
            : status === "restricted" ? "Account restricted"
              : status === "not_member" ? "Actually not joined"
                : status === "unchecked" ? "Access not checked"
                  : "Telegram/access issue";
}
function issueReason(group, status) {
  if (status === "topic") return "Choose an open forum topic before TelePilot posts here.";
  const matching = Object.values(group?.accountJoin || {}).filter(row => row?.status === status);
  const reasons = [...new Set(matching.map(row => String(row?.reason || "").trim()).filter(Boolean))];
  if (reasons.length) return reasons.slice(0, 2).join(" · ");
  return statusTitle(status);
}
function issueRows(uid) {
  const groups = Array.isArray(readAppSettings(uid)?.groups) ? readAppSettings(uid).groups : [];
  return groups.map(group => ({ group, status: groupStatus(group) })).filter(row => row.status !== "ready");
}
function groupByToken(uid, value) {
  const groups = Array.isArray(readAppSettings(uid)?.groups) ? readAppSettings(uid).groups : [];
  return groups.find(group => token(group.id) === String(value)) || null;
}
function issueScreen(uid, page = 0) {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings?.groups) ? settings.groups : [];
  const counts = healthCounts(groups);
  const issues = issueRows(uid);
  const pages = Math.max(1, Math.ceil(issues.length / PAGE_SIZE));
  const current = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const slice = issues.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const lines = slice.map(({ group, status }, index) => `${current * PAGE_SIZE + index + 1}. ${groupLabel(group)}\n   ${statusTitle(status)} — ${issueReason(group, status)}`);
  const rows = slice.map(({ group }) => [inline(groupLabel(group).slice(0, 40), `d6_issue:${token(group.id)}:${current}`, ISSUE_GROUP_EMOJI_ID)]);
  if (pages > 1) {
    const nav = [];
    if (current > 0) nav.push(inline("◀", `d6_issues:${current - 1}`));
    nav.push(inline(`${current + 1}/${pages}`, "d6_noop"));
    if (current < pages - 1) nav.push(inline("▶", `d6_issues:${current + 1}`));
    rows.push(nav);
  }
  rows.push([inline("Check access", "d6_refresh", ISSUE_EMOJI_ID), inline("Destination Hub", "v1_destinations_v13")]);
  return {
    text: [
      "Review Destination Issues",
      "",
      `Needs attention  ${counts.attention} / ${counts.total}`,
      counts.topic ? `Choose topic  ${counts.topic}` : null,
      counts.banned ? `Banned / kicked  ${counts.banned}` : null,
      counts.unavailable ? `Unavailable  ${counts.unavailable}` : null,
      counts.text_blocked ? `Muted / text blocked  ${counts.text_blocked}` : null,
      counts.media_blocked ? `Media blocked  ${counts.media_blocked}` : null,
      counts.restricted ? `Restricted  ${counts.restricted}` : null,
      counts.not_member ? `Actually not joined  ${counts.not_member}` : null,
      counts.unchecked ? `Not checked yet  ${counts.unchecked}` : null,
      counts.issue ? `Other issues  ${counts.issue}` : null,
      "",
      lines.length ? lines.join("\n\n") : "Everything currently looks ready.",
      issues.length > PAGE_SIZE ? `\nShowing ${current * PAGE_SIZE + 1}-${current * PAGE_SIZE + slice.length} of ${issues.length}.` : null,
    ].filter(Boolean).join("\n"),
    rows,
  };
}
function issueDetail(uid, group, page = 0) {
  const status = groupStatus(group);
  const accounts = listAccounts(uid);
  const accessLines = Object.entries(group?.accountJoin || {}).map(([accountId, row]) => {
    const account = accounts.find(item => String(item.id) === String(accountId));
    const label = account ? accountDisplayLabel(account) : `Account ${accountId}`;
    const state = String(row?.status || "unchecked");
    return `${label}\n   ${statusTitle(state)}${row?.reason ? ` — ${row.reason}` : ""}${row?.telegramCode ? `\n   Telegram: ${row.telegramCode}` : ""}`;
  });
  const rows = [];
  if (status === "topic") rows.push([inline("Choose topic", `d2_topic_open:${token(group.id)}:0`)]);
  rows.push([inline("Check access", "d6_refresh", ISSUE_EMOJI_ID)]);
  rows.push([inline("Review Issues", `d6_issues:${Number(page) || 0}`, ISSUE_EMOJI_ID)]);
  return {
    text: [
      groupLabel(group),
      "",
      `Status  ${statusTitle(status)}`,
      `Reason  ${issueReason(group, status)}`,
      group?.topicRequired ? `Topic  ${group?.topicTitle || "Not selected"}` : null,
      "",
      accessLines.length ? accessLines.join("\n\n") : "No sender-access result is stored yet.",
    ].filter(Boolean).join("\n"),
    rows,
  };
}
function decorateIssueButtons(payload) {
  const markup = payload?.reply_markup;
  if (!markup || !Array.isArray(markup.inline_keyboard)) return payload;
  const next = { ...payload, reply_markup: { ...markup, inline_keyboard: markup.inline_keyboard.map(row => row.map(source => {
    const button = { ...source };
    const data = String(button.callback_data || "");
    if (data.startsWith("d5_issue:") || data.startsWith("d6_issue:")) button.icon_custom_emoji_id = ISSUE_GROUP_EMOJI_ID;
    else if (data.startsWith("d5_issues:") || data.startsWith("d6_issues:") || data === "v1_dest_issues_v13") button.icon_custom_emoji_id = ISSUE_EMOJI_ID;
    return button;
  })) } };
  return next;
}
function installIssueEmojiTransformer(bot) {
  if (!bot?.api?.config?.use || bot.__telepilotIssueEmojiV4Installed) return;
  Object.defineProperty(bot, "__telepilotIssueEmojiV4Installed", { value: true });
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === "sendMessage" || method === "editMessageText") return prev(method, decorateIssueButtons(payload), signal);
    return prev(method, payload, signal);
  });
}
async function editOrReply(ctx, screen) {
  const options = { reply_markup: keyboard(screen.rows) };
  try { await ctx.editMessageText(screen.text, options); }
  catch { await ctx.reply(screen.text, options); }
}

export function installDestinationMembershipV4(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotDestinationMembershipV4Installed) return false;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for destination membership v4");
  Object.defineProperty(BotClass.prototype, "__telepilotDestinationMembershipV4Installed", { value: true });
  BotClass.prototype.start = function(...args) {
    installIssueEmojiTransformer(this);
    if (!this.__telepilotDestinationMembershipV4Handlers) {
      Object.defineProperty(this, "__telepilotDestinationMembershipV4Handlers", { value: true });
      this.callbackQuery(["d2_refresh", "d6_refresh"], async ctx => {
        await ctx.answerCallbackQuery({ text: "Checking all saved destinations…" });
        const uid = String(ctx.from?.id || "");
        try {
          const result = await recheckDestinationsV4(uid);
          const c = result.counts || {};
          await editOrReply(ctx, {
            text: [
              "Access check complete",
              "",
              `Checked  ${result.checked} / ${result.total}`,
              `Changed  ${result.changed}`,
              `Ready  ${c.ready || 0}`,
              c.banned ? `Banned / kicked  ${c.banned}` : null,
              c.unavailable ? `Unavailable  ${c.unavailable}` : null,
              c.text_blocked ? `Muted / text blocked  ${c.text_blocked}` : null,
              c.media_blocked ? `Media blocked  ${c.media_blocked}` : null,
              c.restricted ? `Restricted  ${c.restricted}` : null,
              c.not_member ? `Actually not joined  ${c.not_member}` : null,
              c.topic ? `Choose topic  ${c.topic}` : null,
              c.issue ? `Other issues  ${c.issue}` : null,
              "",
              "TelePilot only labels a destination Not joined when Telegram explicitly confirms that membership is missing.",
            ].filter(Boolean).join("\n"),
            rows: [[inline(`Review Issues · ${c.attention || 0}`, "d6_issues:0", ISSUE_EMOJI_ID)], [inline("Destination Hub", "v1_destinations_v13")]],
          });
        } catch (err) {
          await editOrReply(ctx, { text: `Access check failed\n\n${errorText(err)}`, rows: [[inline("Review Issues", "d6_issues:0", ISSUE_EMOJI_ID)]] });
        }
      });
      this.callbackQuery(/^d6_issues:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, issueScreen(String(ctx.from?.id || ""), Number(ctx.match[1]))); });
      this.callbackQuery(/^d6_issue:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {
        await ctx.answerCallbackQuery();
        const uid = String(ctx.from?.id || "");
        const group = groupByToken(uid, ctx.match[1]);
        await editOrReply(ctx, group ? issueDetail(uid, group, Number(ctx.match[2])) : issueScreen(uid, 0));
      });
      this.callbackQuery(/^d5_issues:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, issueScreen(String(ctx.from?.id || ""), Number(ctx.match[1]))); });
      this.callbackQuery(/^d5_issue:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {
        await ctx.answerCallbackQuery();
        const uid = String(ctx.from?.id || "");
        const group = groupByToken(uid, ctx.match[1]);
        await editOrReply(ctx, group ? issueDetail(uid, group, Number(ctx.match[2])) : issueScreen(uid, 0));
      });
      this.callbackQuery("v1_dest_issues_v13", async ctx => { await ctx.answerCallbackQuery(); await editOrReply(ctx, issueScreen(String(ctx.from?.id || ""), 0)); });
      this.callbackQuery("d6_noop", async ctx => { await ctx.answerCallbackQuery(); });
    }
    return originalStart.apply(this, args);
  };
  return true;
}

export const __test = {
  peerKey,
  stateFromEntity,
  stateFromParticipant,
  stateFromError,
  groupStatus,
  healthCounts,
  decorateIssueButtons,
  requiredAccountIds,
  joinStatusForRoute,
};
