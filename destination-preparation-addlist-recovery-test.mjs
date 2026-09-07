import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-addlist-recovery-"));
process.env.DATA_DIR = root;
process.env.API_ID ||= "1";
process.env.API_HASH ||= "test-hash";

const recoverySource = fs.readFileSync(new URL("./destination-preparation-addlist-recovery.js", import.meta.url), "utf8");
const scannerSource = fs.readFileSync(new URL("./destinations-v2.js", import.meta.url), "utf8");
const uiSource = fs.readFileSync(new URL("./destination-preparation-ui.js", import.meta.url), "utf8");

assert.match(recoverySource, /Api\.channels\.JoinChannel/);
assert.match(recoverySource, /scanDestinationSources/);
assert.match(recoverySource, /enqueueCleanup/);
assert.match(uiSource, /recoverNotJoinedAddlistPeers/);
for (const forbidden of [".joinChannel(", "joinChatlistInvite(", "UpdateNotifySettings", "EditPeerFolders"]) {
  assert.equal(scannerSource.includes(forbidden), false, `Read-only scanner must stay mutation-free: ${forbidden}`);
}

const mod = await import(`./destination-preparation-addlist-recovery.js?test=${Date.now()}`);
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
const plan = mod.buildRecoveryPlan(review, accounts);
assert.equal(plan.length, 1, "Only accounts with not-member Addlist candidates should get recovery work");
assert.equal(plan[0].accountId, "acc1");
assert.equal(plan[0].candidates.length, 2, "Manual/public scan rows must not be pulled into Addlist recovery");

const channel = mod.__test.inputChannelFromCandidate({ id: "-1001001", accessHash: "9001" });
assert.equal(channel?.className, "InputChannel");
assert.equal(mod.__test.inputChannelFromCandidate({ id: "-1001001", accessHash: "" }), null);
assert.equal(mod.__test.inputChannelFromCandidate({ id: "-1234", accessHash: "9001" }), null);
assert.equal(mod.__test.candidateAccountNeedsJoin(review.notJoined[0], "acc1"), true);
assert.equal(mod.__test.candidateAccountNeedsJoin(review.notJoined[0], "acc2"), false);

console.log("TelePilot stale Addlist recovery checks passed");
