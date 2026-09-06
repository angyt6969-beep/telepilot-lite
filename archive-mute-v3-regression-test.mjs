import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bigInt from "big-integer";
import { Api } from "teleproto";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-cleanup-v3-"));
process.env.DATA_DIR = temp;

const {
  installArchiveMuteQueue,
  queueDestinationCleanup,
  floodWaitSecondsFromTelegram,
} = await import("./archive-mute-queue-v3.js");

assert.equal(floodWaitSecondsFromTelegram(new Error("Please wait 653 seconds before repeating the action.")), 653);

let rawCalls = 0;
class FakeClient {
  async invoke() { rawCalls++; return { ok: true }; }
}
installArchiveMuteQueue(FakeClient);
const client = new FakeClient();
client.__telepilotOwnerUid = "123";
client.__telepilotAccountId = "a1";
const peer = new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(789) });
await client.invoke(new Api.folders.EditPeerFolders({ folderPeers: [new Api.InputFolderPeer({ peer, folderId: 1 })] }));
await client.invoke(new Api.account.UpdateNotifySettings({ peer: new Api.InputNotifyPeer({ peer }), settings: new Api.InputPeerNotifySettings({ muteUntil: 2147483647 }) }));
assert.equal(rawCalls, 0, "Cleanup calls from join/import flows must be queued, not sent inline");

const file = path.join(temp, "users", "123", "archive-mute-queue.json");
let store = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(store.version, 3);
assert.equal(store.pending.length, 1, "Archive and mute requests for the same chat must collapse to one row");
assert.equal(store.pending[0].destinationId, "-100456");
assert.equal(store.pending[0].peer.kind, "channel", "Access-hash peer data should be persisted for private-chat cleanup");

// Simulate a completed cleanup. Re-seeing the same destination must not recreate work.
store.pending = [];
store.completed = [{ key: "a1|-100456", at: Date.now() }];
fs.writeFileSync(file, JSON.stringify(store, null, 2));
assert.equal(queueDestinationCleanup("123", "a1", "-100456", { kind: "channel", channelId: "456", accessHash: "789" }), false);
store = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(store.pending.length, 0, "Completed cleanup must stay completed instead of being requeued forever");

const source = fs.readFileSync("archive-mute-queue-v3.js", "utf8");
assert.doesNotMatch(source, /FULL_SCAN_INTERVAL_MS|refillPending|scanAccounts/, "v3 must not periodically rescan and requeue every destination");
assert.match(source, /MAX_MUTES_PER_ACCOUNT = 4/, "Mute operations should be paced instead of sent in 24-call bursts");
assert.match(source, /MUTE_SPACING_MS = 750/, "Mute operations need spacing between calls");
assert.match(source, /completed/, "v3 must persist completed cleanup keys");

console.log("Archive/mute v3 idempotency regression test passed");
