import { readAppSettings, writeAppSettings } from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";

function errorCode(err) {
  return String(err?.errorMessage || err?.description || err?.message || err || "").toUpperCase();
}

function classifyFailure(code) {
  if (code.includes("USER_NOT_PARTICIPANT")) {
    return {
      status: "not_member",
      reason: "Telegram explicitly says this sender is not a participant. Join the group in Telegram, then use Check access.",
      telegramCode: "USER_NOT_PARTICIPANT",
    };
  }
  if (code.includes("USER_BANNED_IN_CHANNEL")) {
    return {
      status: "banned",
      reason: "Telegram reports this sender as banned/restricted from sending in this group.",
      telegramCode: "USER_BANNED_IN_CHANNEL",
    };
  }
  if (code.includes("CHANNEL_PRIVATE") || code.includes("CHAT_FORBIDDEN") || code.includes("CHANNEL_PUBLIC_GROUP_NA") || code.includes("CHANNEL_INVALID") || code.includes("CHAT_INVALID")) {
    const telegramCode = ["CHANNEL_PRIVATE", "CHAT_FORBIDDEN", "CHANNEL_PUBLIC_GROUP_NA", "CHANNEL_INVALID", "CHAT_INVALID"].find(value => code.includes(value));
    return {
      status: "unavailable",
      reason: `Telegram reports this destination as unavailable/inaccessible (${telegramCode}). This is not labelled as voluntarily left.`,
      telegramCode,
    };
  }
  if (code.includes("CHAT_SEND_PLAIN_FORBIDDEN") || code.includes("CHAT_WRITE_FORBIDDEN")) {
    const telegramCode = code.includes("CHAT_SEND_PLAIN_FORBIDDEN") ? "CHAT_SEND_PLAIN_FORBIDDEN" : "CHAT_WRITE_FORBIDDEN";
    return {
      status: "text_blocked",
      reason: "The sender can access the group, but Telegram blocks text/messages from this account (muted or text posting is not allowed).",
      telegramCode,
    };
  }
  if (code.includes("CHAT_SEND_MEDIA_FORBIDDEN") || code.includes("CHAT_SEND_PHOTOS_FORBIDDEN") || code.includes("CHAT_SEND_VIDEOS_FORBIDDEN")) {
    const telegramCode = code.match(/CHAT_SEND_[A-Z_]+_FORBIDDEN/)?.[0] || "CHAT_SEND_MEDIA_FORBIDDEN";
    return {
      status: "media_blocked",
      reason: "The sender can access the group, but Telegram blocks the configured media type.",
      telegramCode,
    };
  }
  if (code.includes("CHAT_RESTRICTED") || code.includes("CHAT_ADMIN_REQUIRED")) {
    const telegramCode = code.includes("CHAT_RESTRICTED") ? "CHAT_RESTRICTED" : "CHAT_ADMIN_REQUIRED";
    return {
      status: "restricted",
      reason: telegramCode === "CHAT_RESTRICTED"
        ? "Telegram reports this sender as restricted in the group."
        : "Telegram requires stronger permissions for this action in the group.",
      telegramCode,
    };
  }
  return null;
}

// Called by posting workers after Telegram rejects a send. This only updates
// TelePilot's local readiness metadata. It never joins, mutes, archives, or
// otherwise mutates the Telegram chat.
export function recordDestinationFailure(uid, destination, accountId, err) {
  const code = errorCode(err);
  const failure = classifyFailure(code);
  if (!failure) return false;

  const id = String(uid || "");
  const destinationId = String(destination?.id || "");
  const senderId = String(accountId || "");
  if (!id || !destinationId || !senderId) return false;

  const settings = readAppSettings(id);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const index = groups.findIndex(group => String(group?.id || "") === destinationId);
  if (index < 0) return false;

  const group = { ...groups[index], accountJoin: { ...(groups[index]?.accountJoin || {}) } };
  group.accountJoin[senderId] = {
    ...failure,
    checkedAt: Date.now(),
  };

  const rows = Object.values(group.accountJoin);
  if (group.topicRequired === true && !Number(group.topicId || 0)) group.joinStatus = "needs_topic";
  else if (rows.some(row => row?.status === "ready")) group.joinStatus = "ready";
  else if (rows.some(row => ["text_blocked", "media_blocked", "restricted"].includes(row?.status))) group.joinStatus = "read_only";
  else group.joinStatus = "failed";

  group.lastCheckedAt = Date.now();
  group.lastPostingIssue = { code: failure.telegramCode, at: Date.now() };
  groups[index] = group;
  writeAppSettings(id, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  syncUserGroups(id);
  return true;
}

export const __test = { classifyFailure };
