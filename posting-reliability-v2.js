import fs from "node:fs";
import path from "node:path";
import { currentDispatchContext } from "./dispatch-context.js";
import {
  readAppSettings,
  readProSettings,
  writeAppSettings,
  writeProSettings,
} from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const RECENT_MS = 60_000;
const DELIVERY_CONFIRM_MS = 15_000;
const recentErrors = new Map();
const rawSuccess = new Map();

function errorText(err) {
  return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 220);
}
function errorCode(err) { return errorText(err).toUpperCase(); }
function ctxKey(context) {
  if (!context?.uid || !context?.destinationId) return "";
  return `${context.uid}|${context.accountId || context.senderType || "sender"}|${context.destinationId}|${context.cycleId || "cycle"}`;
}
function destinationFor(context) {
  if (!context?.uid || !context?.destinationId) return null;
  const settings = readAppSettings(context.uid);
  return (settings.groups || []).find(group => String(group?.id || "") === String(context.destinationId)) || null;
}
function destinationLabel(context) {
  const group = destinationFor(context);
  return String(group?.topicTitle ? `${group?.username || group?.label || group?.id} → ${group.topicTitle}` : group?.username || group?.label || group?.id || context?.destinationId || "Destination");
}
function senderLabel(context) { return String(context?.senderLabel || "Telegram sender"); }
function duration(seconds) {
  const s = Math.max(1, Number(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

export function describePostingError(err) {
  const raw = errorText(err);
  const code = raw.toUpperCase();
  let match = code.match(/SLOWMODE_WAIT_?(\d+)/);
  if (match) return {
    code: `SLOWMODE_WAIT_${match[1]}`,
    title: "Group slow mode",
    detail: `Telegram requires this sender to wait ${duration(Number(match[1]))} before posting in this group again.`,
    action: "No re-import is needed. TelePilot can try again on a later posting cycle after the wait expires.",
  };
  match = code.match(/FLOOD_WAIT_?(\d+)/);
  if (match) return {
    code: `FLOOD_WAIT_${match[1]}`,
    title: "Telegram rate limit",
    detail: `Telegram asked this account to wait ${duration(Number(match[1]))}.`,
    action: "Wait for the cooldown to finish. Reconnecting or repeatedly retrying can extend the delay.",
  };
  if (code.includes("TOPIC_CLOSED")) return {
    code: "TOPIC_CLOSED",
    title: "Selected topic is closed",
    detail: "The group is reachable, but Telegram will not allow new posts in the selected forum topic.",
    action: "Open TelePilot → Destinations → Topics and choose an open topic. TelePilot has cleared the closed topic selection.",
  };
  if (code.includes("TOPIC_DELETED")) return {
    code: "TOPIC_DELETED",
    title: "Selected topic was deleted",
    detail: "The saved forum topic no longer exists in Telegram.",
    action: "Open TelePilot → Destinations → Topics and choose another topic.",
  };
  if (code.includes("TOPIC_ID_INVALID")) return {
    code: "TOPIC_ID_INVALID",
    title: "Saved topic is no longer valid",
    detail: "Telegram rejected the saved forum topic identifier.",
    action: "Open TelePilot → Destinations → Topics and choose the topic again.",
  };
  if (code.includes("CHAT_SEND_PHOTOS_FORBIDDEN")) return {
    code: "CHAT_SEND_PHOTOS_FORBIDDEN",
    title: "Photos are not allowed",
    detail: "This sender can reach the group, but Telegram blocks photo posts there.",
    action: "Use a text-only post, remove the photo, or choose a destination/topic where photos are allowed.",
  };
  if (code.includes("CHAT_SEND_MEDIA_FORBIDDEN") || code.includes("CHAT_SEND_VIDEOS_FORBIDDEN")) return {
    code: code.includes("CHAT_SEND_VIDEOS_FORBIDDEN") ? "CHAT_SEND_VIDEOS_FORBIDDEN" : "CHAT_SEND_MEDIA_FORBIDDEN",
    title: "Media is not allowed",
    detail: "Telegram blocks this type of media for the selected sender in this destination.",
    action: "Use a permitted post type or change the sender/group permissions in Telegram.",
  };
  if (code.includes("CHAT_SEND_PLAIN_FORBIDDEN") || code.includes("CHAT_WRITE_FORBIDDEN")) return {
    code: code.includes("CHAT_SEND_PLAIN_FORBIDDEN") ? "CHAT_SEND_PLAIN_FORBIDDEN" : "CHAT_WRITE_FORBIDDEN",
    title: "Sender cannot post in this group",
    detail: "The account can resolve the destination, but Telegram does not allow it to send messages there.",
    action: "Check the sender's group permissions/restrictions in Telegram or ask a group admin to allow posting.",
  };
  if (code.includes("CHAT_RESTRICTED")) return {
    code: "CHAT_RESTRICTED",
    title: "Sender is restricted in this chat",
    detail: "Telegram reports a chat-level restriction for this sender.",
    action: "Check the account's restrictions in the group or contact a group admin.",
  };
  if (code.includes("CHAT_ADMIN_REQUIRED")) return {
    code: "CHAT_ADMIN_REQUIRED",
    title: "Admin permission required",
    detail: "Telegram requires stronger permissions for this action in the destination.",
    action: "Grant the sender the required group permission or use another sender.",
  };
  if (code.includes("USER_NOT_PARTICIPANT") || code.includes("CHANNEL_PRIVATE") || code.includes("CHAT_FORBIDDEN")) return {
    code: code.includes("USER_NOT_PARTICIPANT") ? "USER_NOT_PARTICIPANT" : code.includes("CHANNEL_PRIVATE") ? "CHANNEL_PRIVATE" : "CHAT_FORBIDDEN",
    title: "Sender does not currently have access",
    detail: "Telegram says this sender is not an active member or cannot access the destination.",
    action: "Join/open the group with that Telegram account, then use Destinations → Check access.",
  };
  return {
    code: raw || "UNKNOWN",
    title: "Telegram rejected the post",
    detail: raw || "Telegram returned an unknown error.",
    action: "Open Destinations → Issues. If it repeats, use the exact Telegram error shown here to diagnose the destination.",
  };
}

function rememberError(context, err) {
  if (!context?.uid) return;
  const info = describePostingError(err);
  recentErrors.set(String(context.uid), {
    ts: Date.now(),
    context: { ...context },
    info,
    sender: senderLabel(context),
    destination: destinationLabel(context),
  });
}
function rememberSuccess(context, result) {
  const key = ctxKey(context);
  if (!key) return;
  rawSuccess.set(key, { ts: Date.now(), result });
}
function consumeRecentSuccess(context) {
  const key = ctxKey(context);
  if (!key) return null;
  const row = rawSuccess.get(key);
  rawSuccess.delete(key);
  return row && Date.now() - row.ts <= DELIVERY_CONFIRM_MS ? row : null;
}
function clearRecentSuccess(context) {
  const key = ctxKey(context);
  if (key) rawSuccess.delete(key);
}
function cleanupMaps() {
  const cutoff = Date.now() - RECENT_MS;
  for (const [key, value] of recentErrors) if (Number(value?.ts || 0) < cutoff) recentErrors.delete(key);
  for (const [key, value] of rawSuccess) if (Number(value?.ts || 0) < cutoff) rawSuccess.delete(key);
}

function topicIdForContext(context) {
  const group = destinationFor(context);
  const topicId = Number(group?.topicId || 0);
  return group?.topicRequired === true && topicId > 1 ? topicId : 0;
}
function withTopicRoute(context, params) {
  const topicId = topicIdForContext(context);
  if (!topicId) return params || {};
  return { ...(params || {}), replyTo: topicId, topMsgId: topicId };
}
function isTopicFailure(err) {
  const code = errorCode(err);
  return code.includes("TOPIC_CLOSED") || code.includes("TOPIC_DELETED") || code.includes("TOPIC_ID_INVALID");
}
function clearBrokenTopic(context, err) {
  if (!isTopicFailure(err) || !context?.uid || !context?.destinationId) return false;
  try {
    const settings = readAppSettings(context.uid);
    const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
    const index = groups.findIndex(group => String(group?.id || "") === String(context.destinationId));
    if (index < 0) return false;
    groups[index] = {
      ...groups[index],
      topicRequired: true,
      topicId: null,
      topicTitle: "",
      joinStatus: "needs_topic",
      lastCheckedAt: Date.now(),
      lastPostingIssue: { code: describePostingError(err).code, at: Date.now() },
    };
    writeAppSettings(context.uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
    syncUserGroups(context.uid);
    return true;
  } catch (writeErr) {
    console.warn("TelePilot could not clear invalid topic selection:", writeErr?.message || writeErr);
    return false;
  }
}

function repairFalseFailure(context, err, success) {
  if (!context?.uid || !context?.destinationId || !success) return;
  try {
    const uid = String(context.uid), id = String(context.destinationId), raw = errorText(err);
    const pro = readProSettings(uid);
    if (pro?.destinationFailures?.[id]) {
      pro.destinationFailures[id] = { ...pro.destinationFailures[id], transientCount: 0, permanentCount: 0, lastError: "" };
    }
    if (Array.isArray(pro.history)) {
      const cutoff = Number(success.ts || Date.now()) - 1000;
      pro.history = pro.history.filter(item => !(item?.status === "failed" && String(item?.destinationId || "") === id && Number(item?.ts || 0) >= cutoff && String(item?.error || "") === raw));
    }
    if (Array.isArray(pro.pendingAlerts)) {
      const cutoff = Number(success.ts || Date.now()) - 1000;
      pro.pendingAlerts = pro.pendingAlerts.filter(item => !(Number(item?.ts || 0) >= cutoff && String(item?.text || "").includes(raw)));
    }
    writeProSettings(uid, pro);
  } catch (repairErr) {
    console.warn("TelePilot could not repair post-send bookkeeping state:", repairErr?.message || repairErr);
  }
}

export function installPostingReliabilityPre(TelegramClientClass) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotPostingReliabilityPreInstalled) return false;
  Object.defineProperty(proto, "__telepilotPostingReliabilityPreInstalled", { value: true });

  const originalSendMessage = proto.sendMessage;
  if (typeof originalSendMessage === "function") {
    proto.sendMessage = async function(entity, params, ...rest) {
      const context = currentDispatchContext();
      try {
        const result = await originalSendMessage.call(this, entity, withTopicRoute(context, params), ...rest);
        rememberSuccess(context, result);
        return result;
      } catch (err) {
        rememberError(context, err);
        clearBrokenTopic(context, err);
        throw err;
      }
    };
  }

  const originalSendFile = proto.sendFile;
  if (typeof originalSendFile === "function") {
    proto.sendFile = async function(entity, params, ...rest) {
      const context = currentDispatchContext();
      try {
        const result = await originalSendFile.call(this, entity, withTopicRoute(context, params), ...rest);
        rememberSuccess(context, result);
        return result;
      } catch (err) {
        rememberError(context, err);
        clearBrokenTopic(context, err);
        throw err;
      }
    };
  }

  const originalForwardMessages = proto.forwardMessages;
  if (typeof originalForwardMessages === "function") {
    proto.forwardMessages = async function(entity, params, ...rest) {
      const context = currentDispatchContext();
      try {
        return await originalForwardMessages.call(this, entity, withTopicRoute(context, params), ...rest);
      } catch (err) {
        rememberError(context, err);
        clearBrokenTopic(context, err);
        throw err;
      }
    };
  }

  const originalGetForumTopics = proto.getForumTopics;
  if (typeof originalGetForumTopics === "function") {
    proto.getForumTopics = async function(...args) {
      const result = await originalGetForumTopics.apply(this, args);
      const topics = Array.isArray(result?.topics) ? result.topics.filter(topic => topic?.closed !== true && String(topic?.className || "") !== "ForumTopicDeleted") : [];
      if (!result || !Array.isArray(result?.topics) || topics.length === result.topics.length) return result;
      try { result.topics = topics; return result; }
      catch { return Object.assign(Object.create(Object.getPrototypeOf(result)), result, { topics }); }
    };
  }
  return true;
}

export function installPostingReliabilityPost(TelegramClientClass) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotPostingReliabilityPostInstalled || typeof proto.sendMessage !== "function") return false;
  const currentSendMessage = proto.sendMessage;
  Object.defineProperty(proto, "__telepilotPostingReliabilityPostInstalled", { value: true });
  proto.sendMessage = async function(...args) {
    const context = currentDispatchContext();
    clearRecentSuccess(context);
    try {
      const result = await currentSendMessage.apply(this, args);
      clearRecentSuccess(context);
      return result;
    } catch (err) {
      const success = consumeRecentSuccess(context);
      if (success) {
        repairFalseFailure(context, err, success);
        console.warn(`TelePilot suppressed a false delivery error after Telegram confirmed the post for ${context?.uid || "?"}/${context?.destinationId || "?"}: ${errorText(err)}`);
        return success.result;
      }
      rememberError(context, err);
      clearBrokenTopic(context, err);
      throw err;
    }
  };
  return true;
}

function recentErrorFor(uid) {
  cleanupMaps();
  const row = recentErrors.get(String(uid || ""));
  return row && Date.now() - Number(row.ts || 0) <= RECENT_MS ? row : null;
}
function exactFailureNotice(uid, fallbackText) {
  const row = recentErrorFor(uid);
  if (!row) return fallbackText;
  return [
    `⚠️ ${row.sender} → ${row.destination} failed.`,
    "",
    `Reason: ${row.info.title}`,
    row.info.detail,
    "",
    `What to do: ${row.info.action}`,
    `Telegram: ${row.info.code}`,
  ].join("\n");
}
function transformDashboard(text, other) {
  let value = String(text || "");
  const match = value.match(/⚠\s+(\d+)\s+items?\s+need attention/i);
  if (!match) return { text: value, other };
  const count = Number(match[1]);
  value = value.replace(match[0], `⚠ ${count} destination${count === 1 ? "" : "s"} need attention — tap Review Issues`);
  const next = other && typeof other === "object" ? { ...other } : {};
  const keyboard = next?.reply_markup?.inline_keyboard;
  if (Array.isArray(keyboard) && !keyboard.flat().some(button => button?.callback_data === "v1_dest_issues_v13")) {
    next.reply_markup = { ...next.reply_markup, inline_keyboard: [...keyboard.slice(0, -1), [{ text: "⚠ Review Issues", callback_data: "v1_dest_issues_v13" }], ...keyboard.slice(-1)] };
  }
  return { text: value, other: next };
}
function transformUiMessage(chatId, text, other) {
  const uid = String(chatId || "");
  let value = String(text || "");
  if (/^⚠️ .* failed\. Check sender membership\/permissions or Destination routing\.$/s.test(value)) value = exactFailureNotice(uid, value);
  else if (/^⚠️ Post failed in /s.test(value)) {
    const raw = value.split("\n").slice(1).join("\n").trim();
    const info = describePostingError(raw);
    value = [value.split("\n")[0], "", `Reason: ${info.title}`, info.detail, "", `What to do: ${info.action}`, `Telegram: ${info.code}`].join("\n");
  }
  return transformDashboard(value, other);
}

export function installPostingReliabilityUi(ApiClass) {
  const proto = ApiClass?.prototype;
  if (!proto || proto.__telepilotPostingReliabilityUiInstalled) return false;
  Object.defineProperty(proto, "__telepilotPostingReliabilityUiInstalled", { value: true });
  const originalSendMessage = proto.sendMessage;
  const originalEditMessageText = proto.editMessageText;
  if (typeof originalSendMessage === "function") {
    proto.sendMessage = function(chatId, text, other, ...rest) {
      const transformed = transformUiMessage(chatId, text, other);
      return originalSendMessage.call(this, chatId, transformed.text, transformed.other, ...rest);
    };
  }
  if (typeof originalEditMessageText === "function") {
    proto.editMessageText = function(chatId, messageId, text, other, ...rest) {
      const transformed = transformUiMessage(chatId, text, other);
      return originalEditMessageText.call(this, chatId, messageId, transformed.text, transformed.other, ...rest);
    };
  }
  return true;
}

export function retireLegacyAttentionQueues() {
  let users = 0, unresolved = 0, routing = 0;
  let entries = [];
  try { entries = fs.readdirSync(USERS_DIR, { withFileTypes: true }); } catch { return { users, unresolved, routing }; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const file = path.join(USERS_DIR, entry.name, "destination-automation.json");
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const oldUnresolved = Array.isArray(raw?.unresolvedInvites) ? raw.unresolvedInvites.length : 0;
    const oldRouting = Array.isArray(raw?.routingQueue) ? raw.routingQueue.length : 0;
    if (!oldUnresolved && !oldRouting) continue;
    const next = {
      ...raw,
      unresolvedInvites: [],
      routingQueue: [],
      retiredLegacyAttentionAt: Date.now(),
      retiredLegacyAttentionCounts: {
        unresolvedInvites: Number(raw?.retiredLegacyAttentionCounts?.unresolvedInvites || 0) + oldUnresolved,
        routingQueue: Number(raw?.retiredLegacyAttentionCounts?.routingQueue || 0) + oldRouting,
      },
    };
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(temp, file);
      users++; unresolved += oldUnresolved; routing += oldRouting;
    } catch { try { fs.unlinkSync(temp); } catch {} }
  }
  return { users, unresolved, routing };
}

export const __test = {
  withTopicRoute,
  clearBrokenTopic,
  exactFailureNotice,
  transformUiMessage,
};