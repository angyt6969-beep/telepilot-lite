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
assert.equal(mod.destinationAccountReady(settings.groups[0], "acc1"), true);
assert.equal(mod.destinationAccountReady(settings.groups[1], "acc1"), false);

const duplicate = mod.saveReviewedDestinations("42", review);
assert.equal(duplicate.added, 0);
assert.equal(duplicate.existing, 2);
assert.equal(JSON.parse(fs.readFileSync(path.join(root, "users", "42", "settings.json"), "utf8")).groups.length, 2);

console.log("TelePilot Destinations v2 clean-slate checks passed");
