import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Api } from "teleproto";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-archive-mute-"));
process.env.DATA_DIR = temp;

const {
  floodWaitSecondsFromTelegram,
  installArchiveMuteQueue,
} = await import("./archive-mute-queue.js");

assert.equal(
  floodWaitSecondsFromTelegram(new Error("Please wait 653 seconds before repeating the action. (caused by folders.EditPeerFolders)")),
  653,
  "Telegram's human-readable wait message should be parsed",
);
assert.equal(floodWaitSecondsFromTelegram({ errorMessage: "FLOOD_WAIT_42" }), 42);

let rawCalls = 0;
class FakeClient {
  async invoke(request) { rawCalls++; return { raw: request?.className }; }
}
installArchiveMuteQueue(FakeClient);
const fake = new FakeClient();
fake.__telepilotOwnerUid = "123456";
fake.__telepilotAccountId = "account1";
const queuedArchive = await fake.invoke({ className: "folders.EditPeerFolders" });
const queuedMute = await fake.invoke({ className: "account.UpdateNotifySettings" });
assert.equal(queuedArchive?.queued, true, "Archive operations should be deferred instead of blocking joins");
assert.equal(queuedMute?.queued, true, "Mute operations should be deferred instead of blocking joins");
assert.equal(rawCalls, 0, "Deferred archive/mute operations should not hit Telegram inline");

const passthrough = await fake.invoke({ className: "messages.GetDialogs" });
assert.equal(passthrough?.raw, "messages.GetDialogs");
assert.equal(rawCalls, 1, "Non archive/mute MTProto calls must pass through unchanged");

const persisted = JSON.parse(fs.readFileSync(path.join(temp, "users", "123456", "archive-mute-queue.json"), "utf8"));
assert.deepEqual(persisted.scanAccounts, ["account1"], "Deferred cleanup should persist the sender account for the worker");
assert.equal(persisted.version, 2, "Archive/mute queue should use the independent-cooldown schema");
assert.ok(persisted.archiveCooldowns && persisted.muteCooldowns, "Archive and mute cooldowns must be independent");

const peer = new Api.InputPeerSelf();
const muteRequest = new Api.account.UpdateNotifySettings({
  peer: new Api.InputNotifyPeer({ peer }),
  settings: new Api.InputPeerNotifySettings({ muteUntil: 2147483647 }),
});
assert.equal(muteRequest.className, "account.UpdateNotifySettings");
const archiveRequest = new Api.folders.EditPeerFolders({
  folderPeers: [new Api.InputFolderPeer({ peer, folderId: 1 })],
});
assert.equal(archiveRequest.className, "folders.EditPeerFolders");

const source = fs.readFileSync("archive-mute-queue.js", "utf8");
const startup = fs.readFileSync("startup.js", "utf8");
assert.match(source, /WORKER_INTERVAL_MS = 2_000/, "Cleanup worker should drain large imports promptly");
assert.match(source, /MAX_MUTES_PER_ACCOUNT/, "Mute cleanup should drain multiple chats per connection");
assert.match(source, /ARCHIVE_BATCH_SIZE/, "Archive cleanup should batch folder edits");
assert.match(source, /archiveCooldowns/, "Archive cooldowns should be persisted separately");
assert.match(source, /muteCooldowns/, "Mute cooldowns should be persisted separately");
assert.ok(source.indexOf("Api.account.UpdateNotifySettings") < source.indexOf("Api.folders.EditPeerFolders", source.indexOf("async function processAccount")), "Worker should attempt mute before archive");
assert.doesNotMatch(source, /attempts\s*>=\s*5/, "Transient cleanup failures must not permanently discard a destination");
assert.match(startup, /installArchiveMuteQueue\(TelegramClient\)/, "TelegramClient archive/mute interception is not installed");
assert.match(startup, /startArchiveMuteWorker\(\)/, "Archive/mute worker is not started");

console.log("TelePilot archive/mute queue checks passed");
