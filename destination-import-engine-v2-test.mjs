import assert from "node:assert/strict";
import { Api } from "teleproto";
import {
  buildAddlistInputs,
  explainJoinError,
  formatDuration,
  importResultScreen,
  parseBatchSources,
} from "./destination-import-engine-v2.js";
import { __test as copyTest } from "./destination-import-ui-copy.js";
import { retirePendingAddlistFallbacksForState } from "./retire-addlist-fallback-startup.js";

assert.equal(formatDuration(3), "3s");
assert.equal(formatDuration(300), "5m");
assert.equal(formatDuration(305), "5m 5s");
assert.equal(explainJoinError(new Error("FLOOD_WAIT_300")).reason, "Telegram join cooldown — try again in 5m.");
assert.match(explainJoinError(new Error("USER_BANNED_IN_CHANNEL")).reason, /banned or restricted/i);

const batch = parseBatchSources([
  "@examplegroup",
  "@examplegroup",
  "https://t.me/addlist/AbCd_123",
  "https://t.me/addlist/AbCd_123",
].join("\n"));
assert.equal(batch.parsed.length, 2, "duplicate group and Addlist sources must be deduplicated");
assert.deepEqual(batch.parsed.map(row => row.kind), ["public", "addlist"]);

// Test doubles: model the minimal peer/chat shapes returned by Telegram's
// chatlists preview. The production function must reconstruct every offered peer
// directly from the Telegram-provided ID/access-hash pair.
const peers = [
  { channelId: 101n },
  { channelId: 202n },
  { chatId: 303n },
];
const chats = [
  { id: 101n, accessHash: 1001n, min: true },
  { id: 202n, accessHash: 2002n, min: true },
  { id: 303n, className: "Chat" },
];
const built = buildAddlistInputs(chats, peers);
assert.equal(built.offered, 3);
assert.equal(built.inputs.length, 3, "all Addlist peers must be preserved for one native bulk import");
assert.equal(built.unresolved.length, 0);
assert.ok(built.inputs[0] instanceof Api.InputPeerChannel);
assert.ok(built.inputs[2] instanceof Api.InputPeerChat);

const incomplete = buildAddlistInputs([{ id: 101n, accessHash: 1001n, min: true }], peers);
assert.equal(incomplete.inputs.length, 2);
assert.equal(incomplete.unresolved.length, 1, "missing Addlist metadata must be visible instead of silently importing a subset");

const retired = retirePendingAddlistFallbacksForState({
  tasks: {
    "a:1": { accountId: "a", status: "pending", candidate: { sourceKind: "addlist" } },
    "a:2": { accountId: "a", status: "done", candidate: { sourceKind: "addlist" } },
    "b:3": { accountId: "b", status: "pending", candidate: { sourceKind: "public" } },
  },
  accountNextAt: { a: 123, b: 456 },
});
assert.equal(retired.removed, 1);
assert.equal(retired.state.tasks["a:1"], undefined);
assert.ok(retired.state.tasks["a:2"]);
assert.ok(retired.state.tasks["b:3"]);
assert.equal(retired.state.accountNextAt.a, undefined);
assert.equal(retired.state.accountNextAt.b, 456);

const successScreen = importResultScreen({
  postReview: { accessible: [{ username: "@one" }, { username: "@two" }], notJoined: [], invalid: [], unavailable: [] },
  saved: { added: 2, existing: 0, topics: 0 },
  cleanup: { pending: 2 },
  outcomes: [{ source: "@one", status: "joined" }, { source: "@two", status: "joined" }],
});
assert.match(successScreen.text, /<b><i>Groups added<\/i><\/b>/);
assert.match(successScreen.text, /Successfully added:/);
assert.match(successScreen.text, /Mute \+ archive:<\/b> — processing 2/);
assert.equal(successScreen.parse_mode, "HTML");

const errorScreen = importResultScreen({
  postReview: { accessible: [{ username: "@one" }], notJoined: [{ username: "@two" }], invalid: [], unavailable: [] },
  saved: { added: 1, existing: 0, topics: 0 },
  cleanup: { pending: 1 },
  cooldownSeconds: 300,
  outcomes: [{ source: "@two", status: "error", reason: "Telegram join cooldown — try again in 5m." }],
});
assert.match(errorScreen.text, /Telegram cooldown:<\/b> — 5m/);
assert.match(errorScreen.text, /@two:<\/b> — Telegram join cooldown/);

const transformed = copyTest.transform("＋ Add destinations\n\nold copy", { reply_markup: { inline_keyboard: [] } });
assert.match(transformed.text, /<b><i>Add \/ Import<\/i><\/b>/);
assert.match(transformed.text, /native bulk folder import/);
assert.equal(transformed.other.reply_markup.inline_keyboard.at(-1)[0].text, "𝙂𝙤 𝙗𝙖𝙘𝙠");

console.log("TelePilot destination import v2 regression test passed");
