import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const queued = await fake.invoke({ className: "folders.EditPeerFolders" });
assert.equal(queued?.queued, true, "Archive operations should be deferred instead of blocking joins");
assert.equal(rawCalls, 0, "Deferred archive operation should not hit Telegram inline");

const passthrough = await fake.invoke({ className: "messages.GetDialogs" });
assert.equal(passthrough?.raw, "messages.GetDialogs");
assert.equal(rawCalls, 1, "Non archive/mute MTProto calls must pass through unchanged");

const persisted = JSON.parse(fs.readFileSync(path.join(temp, "users", "123456", "archive-mute-queue.json"), "utf8"));
assert.deepEqual(persisted.scanAccounts, ["account1"], "Deferred cleanup should persist the sender account for the worker");

const source = fs.readFileSync("archive-mute-queue.js", "utf8");
const startup = fs.readFileSync("startup.js", "utf8");
assert.match(source, /WORKER_INTERVAL_MS = 10_000/, "Archive/mute should run separately from fast joins");
assert.match(source, /cooldowns/, "Archive/mute Telegram cooldowns should be persisted");
assert.match(source, /archived: false, muted: false/, "Archive and mute stages should be tracked independently");
assert.match(startup, /installArchiveMuteQueue\(TelegramClient\)/, "TelegramClient archive/mute interception is not installed");
assert.match(startup, /startArchiveMuteWorker\(\)/, "Archive/mute worker is not started");

console.log("TelePilot archive/mute queue checks passed");
