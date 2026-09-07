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

// The working scanner must stay read-only. Join/mute/archive mutations remain in
// isolated preparation workers.
for (const forbidden of [".joinChannel(", "joinChatlistInvite(", "UpdateNotifySettings", "EditPeerFolders"]) {
  assert.equal(scannerSource.includes(forbidden), false, `Read-only scanner must stay mutation-free: ${forbidden}`);
}

// Recovery no longer performs a synchronous burst and must not stop/drop the
// rest of an Addlist when Telegram returns FLOOD_WAIT.
assert.match(recoverySource, /enqueueJoinRecovery/);
assert.equal(recoverySource.includes("stopping this account recovery batch"), false);
assert.equal(recoverySource.includes("client.joinChannel"), false);

// Actual Telegram joins live in the durable queue.
assert.match(queueSource, /client\.joinChannel/);
assert.match(queueSource, /Api\.channels\.JoinChannel/);
assert.match(queueSource, /applyFloodWait/);
assert.match(queueSource, /BASE_JOIN_GAP_MS\s*=\s*4_000/);
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

const channel = queue.__test.inputChannelFromCandidate({ id: "-1001001", accessHash: "9001" });
assert.equal(channel?.className, "InputChannel");
assert.equal(queue.__test.inputChannelFromCandidate({ id: "-1001001", accessHash: "" }), null);
assert.equal(queue.__test.inputChannelFromCandidate({ id: "-1234", accessHash: "9001" }), null);
assert.equal(queue.__test.candidateNeedsJoin(review.notJoined[0], "acc1"), true);
assert.equal(queue.__test.candidateNeedsJoin(review.notJoined[0], "acc2"), false);
assert.equal(queue.floodWaitSeconds({ errorMessage: "FLOOD_WAIT_3" }), 3);
assert.equal(queue.floodWaitSeconds({ seconds: 7 }), 7);

// A flood wait must pause every pending task for that account, keep them pending,
// and leave other accounts untouched. This is the exact regression from the
// production 4-group test where 1 joined and 3 were previously abandoned.
const now = 1_000_000;
const synthetic = {
  tasks: {
    "acc1:-1001": { accountId: "acc1", status: "pending", nextAt: 0, createdAt: 1 },
    "acc1:-1002": { accountId: "acc1", status: "pending", nextAt: 0, createdAt: 2 },
    "acc2:-1003": { accountId: "acc2", status: "pending", nextAt: 0, createdAt: 3 },
  },
  accountNextAt: {},
};
const resumeAt = queue.applyFloodWait(synthetic, "acc1", 3, now);
assert.equal(resumeAt, now + 4_000, "3-second Telegram wait should resume with a 1-second safety margin");
assert.equal(synthetic.tasks["acc1:-1001"].status, "pending");
assert.equal(synthetic.tasks["acc1:-1002"].status, "pending");
assert.equal(synthetic.tasks["acc1:-1001"].nextAt, resumeAt);
assert.equal(synthetic.tasks["acc1:-1002"].nextAt, resumeAt);
assert.equal(synthetic.tasks["acc2:-1003"].nextAt, 0, "another account must not inherit the cooldown");
assert.equal(queue.pickDueTask(synthetic, "acc1", resumeAt - 1), null, "paused work must not run early");
assert.equal(queue.pickDueTask(synthetic, "acc1", resumeAt)?.createdAt, 1, "the oldest paused task must resume instead of being dropped");
assert.equal(queue.pickDueTask(synthetic, "acc2", now)?.createdAt, 3, "other accounts remain runnable");

// Persistent summary must survive process restarts because it is file-backed.
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

console.log("TelePilot durable Addlist join queue checks passed");
