import assert from "node:assert/strict";
import { __test as health } from "./destination-membership-v4.js";
import { __test as failure } from "./destination-failure-v2.js";
import { cleanReviewIssuesButton, cleanReviewIssuesPayload } from "./review-issues-icon-cleanup.js";

assert.equal(health.peerKey("-1001234567890"), "1234567890", "supergroup -100 prefix must be removed before dialog lookup");
assert.equal(health.peerKey("-123456789"), "123456789", "basic group minus prefix must be removed before dialog lookup");
assert.equal(health.peerKey("123456789"), "123456789");

assert.equal(health.stateFromError(new Error("USER_NOT_PARTICIPANT")).status, "not_member");
assert.equal(health.stateFromError(new Error("CHANNEL_PRIVATE")).status, "unavailable", "CHANNEL_PRIVATE must not be mislabeled as voluntary not-member");
assert.equal(health.stateFromError(new Error("USER_BANNED_IN_CHANNEL")).status, "banned");
assert.equal(health.stateFromError(new Error("CHAT_WRITE_FORBIDDEN")).status, "text_blocked");
assert.equal(health.stateFromError(new Error("CHAT_SEND_PHOTOS_FORBIDDEN")).status, "media_blocked");
assert.equal(health.stateFromError(new Error("CHAT_RESTRICTED")).status, "restricted");
assert.notEqual(health.stateFromError(new Error("SOME_UNKNOWN_ACCESS_ERROR")).status, "not_member", "unknown failures must never invent lost membership");

assert.equal(health.stateFromEntity({ className: "Channel", id: 1, bannedRights: { sendPlain: true } }).status, "text_blocked");
assert.equal(health.stateFromEntity({ className: "Channel", id: 1, bannedRights: { viewMessages: true } }).status, "banned");
assert.equal(health.stateFromEntity({ className: "Channel", id: 1 }).status, "ready");
assert.equal(health.stateFromEntity({ className: "Channel", id: 1, left: true }).status, "not_member");

assert.equal(health.stateFromParticipant({ participant: { className: "ChannelParticipantBanned", left: false, bannedRights: { sendPlain: true } } }).status, "text_blocked");
assert.equal(health.stateFromParticipant({ participant: { className: "ChannelParticipantBanned", left: true, bannedRights: { viewMessages: true } } }).status, "banned");
assert.equal(health.stateFromParticipant({ participant: { className: "ChannelParticipantSelf" } }).status, "ready");

// Route-specific sender selection must override the global sender selection.
// This is the exact failure mode that previously left a newly routed sender
// unchecked forever because routing sync was a no-op.
const routeAccounts = [{ id: "A" }, { id: "B" }];
const globalA = { senderMode: "selected", selectedAccountIds: ["A"] };
assert.deepEqual(
  health.requiredAccountIds(globalA, { accountMode: "selected", accountIds: ["B"] }, routeAccounts),
  ["B"],
  "destination routing must check B even when A is selected globally",
);
assert.deepEqual(
  health.requiredAccountIds(globalA, { accountMode: "all", accountIds: [] }, routeAccounts).sort(),
  ["A", "B"],
  "all-account routes must check every connected sender",
);
assert.deepEqual(
  health.requiredAccountIds(globalA, { accountMode: "bot", accountIds: ["B"] }, routeAccounts),
  [],
  "bot-routed destinations must not be blocked by stale personal-account membership",
);

assert.equal(
  health.joinStatusForRoute({ accountJoin: { A: { status: "ready" }, B: { status: "not_member" } } }, ["A", "B"], false),
  "partial",
  "a multi-sender route with only some ready accounts must not be called fully ready",
);
assert.equal(
  health.joinStatusForRoute({ accountJoin: {} }, [], true),
  "ready",
  "an explicit bot route has no personal-account membership requirement",
);

const counts = health.healthCounts([
  { id: "-1001", accountJoin: { a: { status: "ready" } } },
  { id: "-1002", accountJoin: { a: { status: "banned" } } },
  { id: "-1003", accountJoin: { a: { status: "text_blocked" } } },
  { id: "-1004", accountJoin: { a: { status: "not_member" } } },
  { id: "-1005", topicRequired: true, topicId: null, accountJoin: { a: { status: "ready" } } },
]);
assert.deepEqual({ total: counts.total, ready: counts.ready, banned: counts.banned, text: counts.text_blocked, notMember: counts.not_member, topic: counts.topic, attention: counts.attention }, {
  total: 5, ready: 1, banned: 1, text: 1, notMember: 1, topic: 1, attention: 4,
});

const mixedRouteCounts = health.healthCounts([
  { id: "-1006", joinStatus: "partial", accountJoin: { A: { status: "ready" }, B: { status: "not_member" } } },
]);
assert.equal(mixedRouteCounts.ready, 0, "a partially ready multi-sender route must appear in issues instead of being hidden as ready");
assert.equal(mixedRouteCounts.issue, 1);

const decorated = health.decorateIssueButtons({
  reply_markup: {
    inline_keyboard: [
      [{ text: "Review Issues", callback_data: "d5_issues:0" }],
      [{ text: "Some group", callback_data: "d6_issue:abc:0" }],
    ],
  },
});
assert.equal(decorated.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, "5280957715462505291");
assert.equal(decorated.reply_markup.inline_keyboard[1][0].icon_custom_emoji_id, "5420323339723881652");

const cleanedButton = cleanReviewIssuesButton({ text: "⚠ Review Issues · 12", callback_data: "d5_issues:0" });
assert.equal(cleanedButton.text, "Review Issues · 12", "fallback warning symbol must be removed from Review Issues text");
assert.equal(cleanedButton.icon_custom_emoji_id, "5280957715462505291", "premium Issues emoji must remain on Review Issues");
const cleanedPayload = cleanReviewIssuesPayload({
  reply_markup: {
    inline_keyboard: [
      [{ text: "❗️ Review Issues", callback_data: "v1_dest_issues_v13" }],
      [{ text: "Unrelated", callback_data: "home" }],
    ],
  },
});
assert.equal(cleanedPayload.reply_markup.inline_keyboard[0][0].text, "Review Issues");
assert.equal(cleanedPayload.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, "5280957715462505291");
assert.equal(cleanedPayload.reply_markup.inline_keyboard[1][0].text, "Unrelated", "unrelated buttons must be untouched");

assert.equal(failure.classifyFailure("USER_NOT_PARTICIPANT").status, "not_member");
assert.equal(failure.classifyFailure("CHANNEL_PRIVATE").status, "unavailable");
assert.equal(failure.classifyFailure("USER_BANNED_IN_CHANNEL").status, "banned");
assert.equal(failure.classifyFailure("CHAT_WRITE_FORBIDDEN").status, "text_blocked");
assert.equal(failure.classifyFailure("CHAT_SEND_MEDIA_FORBIDDEN").status, "media_blocked");
assert.equal(failure.classifyFailure("CHAT_RESTRICTED").status, "restricted");
assert.equal(failure.classifyFailure("SLOWMODE_WAIT_30"), null, "transient slow mode must not rewrite membership health");

console.log("destination membership v4 regression tests passed");
