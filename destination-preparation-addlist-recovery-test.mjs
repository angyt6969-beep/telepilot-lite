import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-addlist-join-queue-"));
process.env.DATA_DIR = root;
process.env.API_ID ||= "1";
process.env.API_HASH ||= "test-hash";

const recoverySource = fs.readFileSync(new URL("./destination-preparation-addlist-recovery.js", import.meta.url), "utf8");
const queueSource = fs.readFileSync(new URL("./destination-join-queue-v1.js", import.meta.url), "utf8");
const scannerSource = fs.readFileSync(new URL("./destinations-v2.js", import.meta.url), "utf8");
const uiSource = fs.readFileSync(new URL("./destination-preparation-ui.js", import.meta.url), "utf8");
const startupSource = fs.readFileSync(new URL("./startup.js", import.meta.url), "utf8");

for (const forbidden of [".joinChannel(", "joinChatlistInvite(", "UpdateNotifySettings", "EditPeerFolders"]) {
  assert.equal(scannerSource.includes(forbidden), false, `Read-only scanner must stay mutation-free: ${forbidden}`);
}

assert.match(recoverySource, /enqueueJoinRecovery/);
assert.equal(recoverySource.includes("stopping this account recovery batch"), false);
assert.equal(recoverySource.includes("client.joinChannel"), false);
assert.match(recoverySource, /FILTER_INCLUDE_TOO_MUCH/);
assert.match(recoverySource, /DEFAULT_FOLDER_CHAT_LIMIT\s*=\s*100/);
assert.match(recoverySource, /limited-retry=true/);

assert.match(queueSource, /client\.joinChannel/);
assert.match(queueSource, /Api\.channels\.JoinChannel/);
assert.match(queueSource, /applyFloodWait/);
assert.match(queueSource, /WORKER_INTERVAL_MS\s*=\s*500/);
assert.match(queueSource, /BASE_JOIN_GAP_MS\s*=\s*5_000/);
assert.match(queueSource, /RECOVERY_JOIN_GAP_MS\s*=\s*12_000/);
assert.match(queueSource, /INITIAL_JOIN_DELAY_MS\s*=\s*200/);
assert.match(queueSource, /MAX_JOINS_PER_SESSION\s*=\s*1/);
assert.match(queueSource, /Telegram asked to wait before fallback/);
assert.match(queueSource, /paced fallback/);
assert.match(queueSource, /startDestinationJoinWorker/);
assert.match(startupSource, /startDestinationJoinWorker\(\)/);
assert.match(uiSource, /d3_join_status/);
assert.match(uiSource, /runDestinationJoinTick/);

const recovery = await import(`./destination-preparation-addlist-recovery.js?test=${Date.now()}`);
const queue = await import(`./destination-join-queue-v1.js?test=${Date.now()}`);

const review = {
  notJoined: [
    {
      id: "-1001001",
      label: "Private Addlist Group",
      username: "",
      sourceKind: "addlist",
      sourceSlug: "folder",
      accessHash: "9001",
      accountJoin: { acc1: { status: "not_member" }, acc2: { status: "ready" } },
    },
    {
      id: "-1001002",
      label: "Public Addlist Group",
      username: "@PublicGroup",
      sourceKind: "addlist",
      sourceSlug: "folder",
      accessHash: "9002",
      accountJoin: { acc1: { status: "not_member" } },
    },
    {
      id: "-1001003",
      label: "Manual Group",
      username: "@ManualGroup",
      sourceKind: "public",
      accountJoin: { acc1: { status: "not_member" } },
    },
  ],
};
const accounts = [{ id: "acc1" }, { id: "acc2" }];
const plan = recovery.buildRecoveryPlan(review, accounts);
assert.equal(plan.length, 1, "Only accounts with not-member Addlist candidates should get recovery work");
assert.equal(plan[0].accountId, "acc1");
assert.equal(plan[0].candidates.length, 2, "Manual/public scan rows must not be pulled into Addlist recovery");

assert.deepEqual(recovery.safeBulkRetrySizes(137, 7).slice(0, 3), [88, 44, 22]);
assert.deepEqual(recovery.safeBulkRetrySizes(1, 0), []);
assert.equal(recovery.__test.isFilterIncludeTooMuch({ errorMessage: "FILTER_INCLUDE_TOO_MUCH" }), true);
assert.equal(recovery.__test.isFilterIncludeTooMuch({ errorMessage: "FLOOD_WAIT_3" }), false);

// A large fresh Addlist must not immediately fall back to one-by-one channel joins
// just because the recipient account cannot fit every shared chat into one folder.
// The first oversized RPC is allowed to fail, then TelePilot retries one safe subset.
const largeCount = 137;
const largePeers = [];
const largeChats = [];
const largeCandidates = [];
for (let index = 1; index <= largeCount; index++) {
  const id = 10_000 + index;
  largePeers.push({ channelId: id });
  largeChats.push({ className: "Channel", id, accessHash: 50_000 + index, megagroup: true });
  largeCandidates.push({
    id: `-100${id}`,
    accessHash: String(50_000 + index),
    sourceKind: "addlist",
    sourceSlug: "large-folder",
  });
}
const bulkAttempts = [];
const fakeClient = {
  api: {
    chatlists: {
      checkChatlistInvite: async () => ({
        className: "ChatlistInvite",
        peers: largePeers,
        chats: largeChats,
      }),
      joinChatlistInvite: async ({ peers }) => {
        bulkAttempts.push(peers.length);
        if (peers.length > 90) {
          const err = new Error("FILTER_INCLUDE_TOO_MUCH");
          err.errorMessage = "FILTER_INCLUDE_TOO_MUCH";
          throw err;
        }
      },
    },
  },
};
const largeResult = await recovery.__test.bulkJoinSlug(fakeClient, "large-folder", largeCandidates, 7);
assert.deepEqual(bulkAttempts, [137, 88], "137-group Addlist should retry as one safe bulk subset, not individual joins");
assert.equal(largeResult.accepted, 88);
assert.equal(largeResult.requested, 137);
assert.equal(largeResult.limited, true);

const channel = queue.__test.inputChannelFromCandidate({ id: "-1001001", accessHash: "9001" });
assert.equal(channel?.className, "InputChannel");
assert.equal(queue.__test.inputChannelFromCandidate({ id: "-1001001", accessHash: "" }), null);
assert.equal(queue.__test.inputChannelFromCandidate({ id: "-1234", accessHash: "9001" }), null);
assert.equal(queue.__test.candidateNeedsJoin(review.notJoined[0], "acc1"), true);
assert.equal(queue.__test.candidateNeedsJoin(review.notJoined[0], "acc2"), false);
assert.equal(queue.floodWaitSeconds({ errorMessage: "FLOOD_WAIT_3" }), 3);
assert.equal(queue.floodWaitSeconds({ seconds: 7 }), 7);

// Local pacing must never weaken Telegram's own cooldown. A FLOOD_WAIT_3 still
// pauses all pending work for the account for 4 seconds including margin, and
// once it expires the account switches to the slower recovery pacing.
const now = 1_000_000;
const synthetic = {
  tasks: {
    "acc1:-1001": { accountId: "acc1", status: "pending", nextAt: 0, createdAt: 1, lastError: "" },
    "acc1:-1002": { accountId: "acc1", status: "pending", nextAt: 0, createdAt: 2, lastError: "" },
    "acc2:-1003": { accountId: "acc2", status: "pending", nextAt: 0, createdAt: 3, lastError: "" },
  },
  accountNextAt: {},
};
assert.equal(queue.__test.accountJoinGapMs(synthetic, "acc1"), 5_000);
const resumeAt = queue.applyFloodWait(synthetic, "acc1", 3, now);
assert.equal(resumeAt, now + 4_000);
assert.equal(synthetic.tasks["acc1:-1001"].status, "pending");
assert.equal(synthetic.tasks["acc1:-1002"].status, "pending");
assert.equal(synthetic.tasks["acc1:-1001"].nextAt, resumeAt);
assert.equal(synthetic.tasks["acc1:-1002"].nextAt, resumeAt);
assert.equal(synthetic.tasks["acc2:-1003"].nextAt, 0);
assert.equal(queue.__test.accountJoinGapMs(synthetic, "acc1"), 12_000);
assert.equal(queue.__test.accountJoinGapMs(synthetic, "acc2"), 5_000);
assert.equal(queue.pickDueTask(synthetic, "acc1", resumeAt - 1), null);
assert.equal(queue.pickDueTask(synthetic, "acc1", resumeAt)?.createdAt, 1);
assert.equal(queue.pickDueTask(synthetic, "acc2", now)?.createdAt, 3);

const userDir = path.join(root, "users", "42");
fs.mkdirSync(userDir, { recursive: true });
fs.writeFileSync(path.join(userDir, "destination-join-v1.json"), JSON.stringify({
  version: 1,
  accountNextAt: {},
  tasks: {
    done: { accountId: "acc1", candidate: { id: "-1001" }, status: "done", updatedAt: Date.now(), createdAt: Date.now() },
    pending1: { accountId: "acc1", candidate: { id: "-1002" }, status: "pending", updatedAt: Date.now(), createdAt: Date.now() },
    pending2: { accountId: "acc1", candidate: { id: "-1003" }, status: "pending", updatedAt: Date.now(), createdAt: Date.now() },
    request: { accountId: "acc1", candidate: { id: "-1004" }, status: "request_pending", updatedAt: Date.now(), createdAt: Date.now() },
    failed: { accountId: "acc1", candidate: { id: "-1005" }, status: "failed", updatedAt: Date.now(), createdAt: Date.now() },
  },
}), "utf8");
const summary = queue.joinQueueSummary("42");
assert.deepEqual(
  { total: summary.total, joined: summary.joined, pending: summary.pending, requestPending: summary.requestPending, failed: summary.failed },
  { total: 5, joined: 1, pending: 2, requestPending: 1, failed: 1 },
);

console.log("TelePilot paced durable Addlist join queue checks passed");