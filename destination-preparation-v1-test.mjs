import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bigInt from "big-integer";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-prep-v1-"));
process.env.DATA_DIR = root;
process.env.API_ID ||= "1";
process.env.API_HASH ||= "test-hash";

const source = fs.readFileSync(new URL("./destination-preparation-v1.js", import.meta.url), "utf8");
const scannerSource = fs.readFileSync(new URL("./destinations-v2.js", import.meta.url), "utf8");
const inputSource = fs.readFileSync(new URL("./destinations-v2-input-priority.js", import.meta.url), "utf8");
const startupSource = fs.readFileSync(new URL("./startup.js", import.meta.url), "utf8");

// The working scanner remains read-only. Telegram mutations must live only in the
// isolated preparation module.
for (const forbidden of [
  ".joinChannel(",
  ".importChatInvite(",
  "joinChatlistInvite(",
  "joinChatlistUpdates(",
  "UpdateNotifySettings",
  "EditPeerFolders",
]) {
  assert.equal(scannerSource.includes(forbidden), false, `Destinations v2 scanner unexpectedly mutates Telegram: ${forbidden}`);
}
assert.match(source, /joinChatlistInvite/);
assert.match(source, /getChatlistUpdates/);
assert.match(source, /joinChatlistUpdates/);
assert.match(source, /UpdateNotifySettings/);
assert.match(source, /EditPeerFolders/);
assert.match(inputSource, /d3_prepare:/);
assert.match(startupSource, /installDestinationPreparationUi\(Bot\)/);
assert.match(startupSource, /startDestinationPreparationWorker\(\)/);

const mod = await import(`./destination-preparation-v1.js?test=${Date.now()}`);

// Test doubles: these are minimal Telegram chat/peer-shaped objects used only to
// verify peer construction. In particular, min=true reproduces the shape that
// previously broke Addlist conversion.
const chats = [
  { className: "Channel", id: bigInt(1001), accessHash: bigInt(9001), min: true, megagroup: true },
  { className: "Chat", id: bigInt(2002) },
  { className: "ChannelForbidden", id: bigInt(3003), accessHash: bigInt(9003) },
];
const peers = [
  { channelId: bigInt(1001) },
  { chatId: bigInt(2002) },
  { channelId: bigInt(3003) },
];
const inputs = mod.buildAddlistInputs(chats, peers);
assert.equal(inputs.length, 2, "usable Addlist peers should be preserved and forbidden peers skipped");
assert.equal(inputs[0].className, "InputPeerChannel");
assert.equal(inputs[1].className, "InputPeerChat");

const directChannel = mod.__test.inputPeerFromCandidate({ id: "-1001001", accessHash: "9001" });
assert.equal(directChannel.className, "InputPeerChannel");
const directChat = mod.__test.inputPeerFromCandidate({ id: "-2002", accessHash: "" });
assert.equal(directChat.className, "InputPeerChat");
assert.equal(mod.__test.inputPeerFromCandidate({ id: "-1001001", accessHash: "" }), null);

assert.equal(mod.floodWaitSeconds({ errorMessage: "FLOOD_WAIT_17" }), 17);
assert.equal(mod.floodWaitSeconds({ seconds: 9 }), 9);

const review = {
  accessible: [
    {
      id: "-1001001",
      label: "Prepared group",
      username: "@PreparedGroup",
      type: "supergroup",
      accessHash: "9001",
      accountJoin: { acc1: { status: "ready" } },
    },
  ],
};
const first = mod.enqueueCleanup("42", review);
assert.equal(first.created, 1);
assert.equal(first.pending, 1);
const second = mod.enqueueCleanup("42", review);
assert.equal(second.created, 0, "re-enqueue must not duplicate an existing cleanup task");
assert.equal(mod.cleanupSummary("42").total, 1, "cleanup queue must stay idempotent");

const prepState = JSON.parse(fs.readFileSync(path.join(root, "users", "42", "destination-preparation-v1.json"), "utf8"));
assert.equal(Object.keys(prepState.tasks).length, 1);
assert.equal(prepState.tasks["acc1:-1001001"].mute.status, "pending");
assert.equal(prepState.tasks["acc1:-1001001"].archive.status, "pending");

console.log("TelePilot destination preparation v1 regression checks passed");
