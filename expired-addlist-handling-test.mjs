import assert from "node:assert/strict";
import fs from "node:fs";
import {
  canPrepareReview,
  expiredAddlistOnly,
  isExpiredAddlistError,
  normalizedUnavailable,
  reviewCouldNotUseCount,
} from "./expired-addlist-guard.js";
import { __test as preparationUiTest } from "./destination-preparation-ui.js";

const expiredReview = {
  token: "expired-review",
  createdAt: Date.now(),
  sourceCount: 1,
  sourceText: "https://t.me/addlist/exampleexpired",
  accessible: [],
  notJoined: [],
  unsupported: [],
  invalid: [],
  unavailable: [
    { original: "Shared folder", reason: "@example — INVITE_SLUG_EXPIRED" },
    { original: "Shared folder", reason: "Telegram returned no chats for this shared folder." },
  ],
};

assert.equal(isExpiredAddlistError(new Error("INVITE_SLUG_EXPIRED")), true);
assert.equal(expiredAddlistOnly(expiredReview), true);
assert.equal(canPrepareReview(expiredReview), false);
assert.equal(reviewCouldNotUseCount(expiredReview), 1, "one expired Addlist must not be counted as two unusable destinations");

const normalized = normalizedUnavailable(expiredReview);
assert.equal(normalized.length, 1);
assert.match(normalized[0].reason, /expired in Telegram/i);
assert.doesNotMatch(normalized[0].reason, /@example/);

const reviewScreen = preparationUiTest.reviewScreen(expiredReview);
assert.match(reviewScreen.text, /Addlist|shared-folder/i);
assert.match(reviewScreen.text, /fresh t\.me\/addlist/i);
assert.equal(reviewScreen.rows.flat().some(button => button.callback_data?.startsWith("d3_prepare:")), false, "expired-only review must not offer Join + prepare");
assert.equal(reviewScreen.rows.flat().some(button => button.callback_data === "d2_add"), true, "expired-only review must offer a fresh scan");

const skippedScreen = preparationUiTest.skippedScreen(expiredReview);
assert.match(skippedScreen.text, /expired in Telegram/i);
assert.doesNotMatch(skippedScreen.text, /Telegram returned no chats for this shared folder/i);
assert.doesNotMatch(skippedScreen.text, /@example — INVITE_SLUG_EXPIRED/i);

const mixedReview = {
  ...expiredReview,
  sourceCount: 2,
  sourceText: "https://t.me/addlist/exampleexpired\n@example_group",
  accessible: [{ id: "-1001", label: "Working group" }],
};
assert.equal(expiredAddlistOnly(mixedReview), false);
assert.equal(canPrepareReview(mixedReview), true, "one expired source must not block other actionable sources");

const regularUnavailable = {
  ...expiredReview,
  unavailable: [{ original: "Private invite", reason: "Join this private group in Telegram first." }],
};
assert.equal(expiredAddlistOnly(regularUnavailable), false);
assert.equal(canPrepareReview(regularUnavailable), true, "non-expired preparation behavior must remain unchanged");

const inputPrioritySource = fs.readFileSync(new URL("./destinations-v2-input-priority.js", import.meta.url), "utf8");
assert.match(inputPrioritySource, /reviewCouldNotUseCount\(review\)/);
assert.match(inputPrioritySource, /expiredAddlistOnly\(review\)/);
assert.match(inputPrioritySource, /Scan fresh Addlist/);

const reimportSource = fs.readFileSync(new URL("./destination-addlist-reimport-bulk.js", import.meta.url), "utf8");
assert.match(reimportSource, /leaveChatlist\(\{ chatlist, peers: \[\] \}\)/, "stale-folder detach-only behavior must remain intact");
assert.match(reimportSource, /joinChatlistInvite\(\{ slug, peers: inputs \}\)/, "bulk reimport must remain intact");
assert.doesNotMatch(reimportSource, /\.joinChannel\(/, "full Addlist reimport must not regress to one-by-one joinChannel");
assert.match(reimportSource, /This shared-folder link has expired in Telegram/);

console.log("TelePilot expired Addlist handling regression tests passed");
