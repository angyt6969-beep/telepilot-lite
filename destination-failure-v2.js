import { readAppSettings, writeAppSettings } from "./posting-engine-enhancements.js";
import { syncUserGroups } from "./runtime-hooks.js";

function errorCode(err) {
  return String(err?.errorMessage || err?.description || err?.message || err || "").toUpperCase();
}

const MEMBERSHIP_ERRORS = [
  "USER_NOT_PARTICIPANT",
  "CHANNEL_PRIVATE",
  "CHAT_FORBIDDEN",
];

const POSTING_ERRORS = [
  "CHAT_WRITE_FORBIDDEN",
  "CHAT_SEND_PLAIN_FORBIDDEN",
  "CHAT_SEND_MEDIA_FORBIDDEN",
  "CHAT_SEND_PHOTOS_FORBIDDEN",
  "CHAT_SEND_VIDEOS_FORBIDDEN",
  "CHAT_ADMIN_REQUIRED",
];

// Called by the posting workers after Telegram rejects a send. This only updates
// TelePilot's local readiness metadata. It never joins, mutes, archives, or
// otherwise mutates the Telegram chat.
export function recordDestinationFailure(uid, destination, accountId, err) {
  const code = errorCode(err);
  const lostMembership = MEMBERSHIP_ERRORS.some(value => code.includes(value));
  const postingBlocked = POSTING_ERRORS.some(value => code.includes(value));
  if (!lostMembership && !postingBlocked) return false;

  const id = String(uid || "");
  const destinationId = String(destination?.id || "");
  const senderId = String(accountId || "");
  if (!id || !destinationId || !senderId) return false;

  const settings = readAppSettings(id);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const index = groups.findIndex(group => String(group?.id || "") === destinationId);
  if (index < 0) return false;

  const group = { ...groups[index], accountJoin: { ...(groups[index]?.accountJoin || {}) } };
  group.accountJoin[senderId] = lostMembership
    ? {
        status: "not_member",
        reason: "This sender no longer has access. Join the group in Telegram, then use Check access.",
        checkedAt: Date.now(),
      }
    : {
        status: "issue",
        reason: "Telegram currently blocks posting from this sender. Check the group's posting permissions in Telegram.",
        checkedAt: Date.now(),
      };

  const rows = Object.values(group.accountJoin);
  if (group.topicRequired === true && !Number(group.topicId || 0)) group.joinStatus = "needs_topic";
  else if (rows.some(row => row?.status === "ready")) group.joinStatus = "ready";
  else if (rows.some(row => row?.status === "not_member")) group.joinStatus = "not_member";
  else group.joinStatus = "issue";

  group.lastCheckedAt = Date.now();
  groups[index] = group;
  writeAppSettings(id, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  syncUserGroups(id);
  return true;
}
