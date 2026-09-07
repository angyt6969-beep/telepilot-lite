import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-dest-v2-"));
process.env.DATA_DIR = root;

const source = fs.readFileSync(new URL("./destinations-v2.js", import.meta.url), "utf8");
for (const forbidden of [
  ".joinChannel(",
  ".importChatInvite(",
  "joinChatlistInvite(",
  "joinChatlistUpdates(",
  "UpdateNotifySettings",
  "EditPeerFolders",
]) {
  assert.equal(source.includes(forbidden), false, `Destinations v2 must not contain automatic Telegram action: ${forbidden}`);
}
assert.match(source, /recheckDestinationsV4/, "Destinations v2 rechecks must use the authoritative v4 membership engine");
assert.doesNotMatch(source, /export function queueRoutingSync\(\) \{ return 0; \}/, "routing sync must not remain a no-op");
assert.doesNotMatch(source, /export async function processRoutingQueue\(\) \{ return \{ processed: 0, changed: 0 \}; \}/, "routing processing must not remain a no-op");

const mod = await import(`./destinations-v2.js?test=${Date.now()}`);

assert.deepEqual(mod.parseDestinationInput("@RareHandle"), {
  kind: "public",
  username: "RareHandle",
  original: "@RareHandle",
});
assert.equal(mod.parseDestinationInput("t.me/RareHandle")?.kind, "public");
assert.equal(mod.parseDestinationInput("https://t.me/RareHandle")?.kind, "public");
assert.equal(mod.parseDestinationInput("https://t.me/+AbCdEf123")?.kind, "invite");
assert.equal(mod.parseDestinationInput("https://t.me/addlist/IdgqRZms8tQwZTEx")?.kind, "addlist");
assert.equal(mod.parseDestinationInput("[group](https://t.me/RareHandle)")?.kind, "public");
assert.equal(mod.parseDestinationInput("https://example.com/nope"), null);

// Only Telegram's explicit USER_NOT_PARTICIPANT result may be classified as
// not joined during a scan. Other access failures stay inconclusive.
assert.equal(mod.__test.membershipErrorState(new Error("USER_NOT_PARTICIPANT")).status, "not_member");
assert.equal(mod.__test.membershipErrorState(new Error("CHANNEL_PRIVATE")).status, "issue");
assert.equal(mod.__test.membershipErrorState(new Error("CHAT_ADMIN_REQUIRED")).status, "issue");
assert.equal(mod.__test.candidateNotJoined({ accountJoin: { a: { status: "not_member" }, b: { status: "not_member" } } }), true);
assert.equal(mod.__test.candidateNotJoined({ accountJoin: { a: { status: "not_member" }, b: { status: "issue" } } }), false);
assert.equal(mod.__test.candidateIssue({ accountJoin: { a: { status: "issue" } } }), true);

const review = {
  accessible: [
    {
      id: "-1001001",
      label: "Public Group",
      username: "@PublicGroup",
      type: "supergroup",
      forum: false,
      accessHash: "123",
      sourceKind: "public",
      sourceSlug: "PublicGroup",
      accountJoin: { acc1: { status: "ready", reason: "Already joined in Telegram." } },
    },
    {
      id: "-1001002",
      label: "Forum Group",
      username: "",
      type: "supergroup",
      forum: true,
      accessHash: "456",
      sourceKind: "addlist",
      sourceSlug: "folder",
      accountJoin: { acc1: { status: "ready", reason: "Already joined in Telegram." } },
    },
  ],
};

const saved = mod.saveReviewedDestinations("42", review);
assert.equal(saved.added, 2);
assert.equal(saved.existing, 0);
assert.equal(saved.topics, 1);

const settings = JSON.parse(fs.readFileSync(path.join(root, "users", "42", "settings.json"), "utf8"));
assert.equal(settings.groups.length, 2);
assert.equal(settings.groups[0].joinStatus, "ready");
assert.equal(settings.groups[1].joinStatus, "needs_topic");
assert.equal(settings.groups[1].topicId, null);
assert.equal(settings.groups[0].accessHash, "123");
assert.equal(settings.groups[1].accessHash, "456");
assert.equal(mod.destinationAccountReady(settings.groups[0], "acc1"), true);
assert.equal(mod.destinationAccountReady(settings.groups[1], "acc1"), false);

const duplicate = mod.saveReviewedDestinations("42", review);
assert.equal(duplicate.added, 0);
assert.equal(duplicate.existing, 2);
assert.equal(JSON.parse(fs.readFileSync(path.join(root, "users", "42", "settings.json"), "utf8")).groups.length, 2);

// Topic loading must prefer the account routed to this destination, not the
// unrelated account selected globally.
const topicAccounts = [{ id: "A" }, { id: "B" }];
const routedForum = { accountMode: "selected", accountIds: ["B"], accountJoin: { A: { status: "ready" }, B: { status: "ready" } } };
assert.equal(
  mod.__test.topicAccountFor({ senderMode: "selected", selectedAccountIds: ["A"] }, routedForum, topicAccounts)?.id,
  "B",
);

// Routing refresh requests are persisted separately from the interactive
// destinations-v2 state, so a pending Add/Review write cannot erase them.
const queued = mod.queueRoutingSync("42", "-1001001", ["acc2"]);
assert.equal(queued, 1);
const routingStatePath = path.join(root, "users", "42", "destination-routing-sync.json");
const routingState = JSON.parse(fs.readFileSync(routingStatePath, "utf8"));
assert.equal(routingState.length, 1);
assert.deepEqual(routingState[0].destinationIds, ["-1001001"]);
assert.deepEqual(routingState[0].accountIds, ["acc2"]);
assert.equal(typeof routingState[0].id, "string");
assert.ok(routingState[0].id.length > 0);

// Repeating the exact pending refresh must not create duplicate work.
assert.equal(mod.queueRoutingSync("42", "-1001001", ["acc2"]), 0);
assert.equal(JSON.parse(fs.readFileSync(routingStatePath, "utf8")).length, 1);

console.log("TelePilot Destinations v2 clean-slate checks passed");
