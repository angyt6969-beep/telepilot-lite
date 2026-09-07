import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-bulk-addlist-"));
process.env.DATA_DIR = root;
process.env.API_ID ||= "1";
process.env.API_HASH ||= "test-hash";

const source = fs.readFileSync(new URL("./destination-preparation-addlist-recovery.js", import.meta.url), "utf8");

// The bulk path must use Telegram's shared-folder methods, not individual joins.
assert.match(source, /chatlists\.joinChatlistInvite/);
assert.match(source, /chatlists\.getChatlistUpdates/);
assert.match(source, /chatlists\.joinChatlistUpdates/);
assert.equal(source.includes("client.joinChannel"), false);
assert.equal(source.includes("hintedMissing"), false, "Already-imported Addlists must query getChatlistUpdates even when checkChatlistInvite has no missingPeers hint");
assert.match(source, /scanDestinationSources/);
assert.match(source, /enqueueCleanup/);
assert.match(source, /enqueueJoinRecovery/);

const recovery = await import(`./destination-preparation-addlist-recovery.js?test=${Date.now()}`);

const candidates = [
  { id: "-100123", sourceKind: "addlist", sourceSlug: "folder" },
];
const chats = [
  { className: "Channel", id: 123, accessHash: 999, megagroup: true },
  { className: "Channel", id: 456, accessHash: 888, megagroup: true },
];
const peers = [
  { channelId: 123 },
  { channelId: 456 },
];
const inputs = recovery.buildBulkInputs(chats, peers, candidates);
assert.equal(inputs.length, 1, "Bulk join must include only chats that the scan confirmed are not joined");
assert.equal(inputs[0]?.className, "InputPeerChannel");
assert.equal(String(inputs[0]?.channelId), "123");

const now = 1_000_000;
const queueState = {
  version: 1,
  accountNextAt: { acc1: now + 234_000 },
  tasks: {
    "acc1:-100123": {
      accountId: "acc1",
      candidate: { id: "-100123" },
      status: "pending",
      nextAt: now + 234_000,
      lastError: "Telegram asked to wait 234s",
      updatedAt: now - 1000,
    },
    "acc1:-100456": {
      accountId: "acc1",
      candidate: { id: "-100456" },
      status: "pending",
      nextAt: now + 234_000,
      lastError: "Telegram asked to wait 234s",
      updatedAt: now - 1000,
    },
  },
};
const review = {
  accessible: [
    { id: "-100123", accountJoin: { acc1: { status: "ready" } } },
  ],
};
const reconciled = recovery.reconcileFallbackState(
  queueState,
  review,
  { acc1: now + 234_000 },
  {},
  now,
);
assert.equal(reconciled.changed, 1);
assert.equal(reconciled.state.tasks["acc1:-100123"].status, "done", "A group confirmed by the bulk rescan must not be joined again one-by-one");
assert.equal(reconciled.state.tasks["acc1:-100456"].status, "pending");
assert.equal(reconciled.state.accountNextAt.acc1, now + 234_000, "Existing Telegram cooldown must be preserved for fallback leftovers");

const allReady = recovery.reconcileFallbackState(
  reconciled.state,
  { accessible: [
    { id: "-100123", accountJoin: { acc1: { status: "ready" } } },
    { id: "-100456", accountJoin: { acc1: { status: "ready" } } },
  ] },
  { acc1: now + 234_000 },
  {},
  now + 100,
);
assert.equal(allReady.state.tasks["acc1:-100456"].status, "done");
assert.equal(allReady.state.accountNextAt.acc1, undefined, "If bulk join confirms every queued group, the stale one-by-one cooldown should be removed");

console.log("TelePilot bulk Addlist recovery checks passed");
