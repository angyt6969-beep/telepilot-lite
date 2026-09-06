import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-addlist-final-"));
process.env.DATA_DIR = temp;

const { installAddlistReconciliation } = await import("./addlist-reconciliation.js");
const { installAddlistImportUi } = await import("./addlist-import-ui.js");

class FakeTelegramClient {
  async invoke(request) { return { ok: true, request }; }
}
installAddlistReconciliation(FakeTelegramClient);
const tg = new FakeTelegramClient();
tg.__telepilotOwnerUid = "123456";
tg.__telepilotAccountId = "a1";
await tg.invoke({ className: "chatlists.CheckChatlistInvite", slug: "large_folder_123" });

class FakeApi {
  async sendMessage(chatId, text) { return { chatId, text }; }
  async editMessageText(chatId, messageId, text) { return { chatId, messageId, text }; }
}
installAddlistImportUi(FakeApi);
const api = new FakeApi();
const original = [
  "✅ Destination import complete",
  "Added — 0",
  "Duplicates skipped — 0",
  "Needs attention — 0",
  "Failed / invalid — 0",
].join("\n");
const adjusted = await api.sendMessage("123456", original);
assert.match(adjusted.text, /^⏳ Addlist import processing/, "A recent Addlist must not claim completion with zero additions while reconciliation is active");
assert.match(adjusted.text, /still being reconciled with Telegram/, "Processing copy should explain background reconciliation");
assert.match(adjusted.text, /duplicate detection remains active/, "Retry safety should be communicated");

const unrelated = await api.sendMessage("999999", original);
assert.equal(unrelated.text, original, "Non-Addlist import summaries must remain unchanged");

const cleanup = fs.readFileSync("archive-mute-queue-v3.js", "utf8");
assert.match(cleanup, /completed/, "Cleanup v3 must remember completed work");
assert.doesNotMatch(cleanup, /FULL_SCAN_INTERVAL_MS|refillPending|scanAccounts/, "Cleanup v3 must not full-scan and requeue every destination");

const startup = fs.readFileSync("startup.js", "utf8");
assert.match(startup, /installAddlistImportUi\(Api\)/);
assert.match(startup, /archive-mute-queue-v3\.js/);
assert.match(startup, /startArchiveMuteWorker\(\)/);
assert.doesNotMatch(startup, /startArchiveMuteCoverageWorker\(\)/, "The competing coverage worker must stay disabled");
assert.match(startup, /installAddlistPeerResolution\(TelegramClient\)[\s\S]*installAddlistSafety\(TelegramClient\)[\s\S]*installAddlistJoinCompatibility\(TelegramClient\)/, "Addlist wrapper order must preserve access-hash caching and safety interception");

console.log("TelePilot final Addlist reliability checks passed");
