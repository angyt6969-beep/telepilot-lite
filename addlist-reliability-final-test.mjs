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
assert.match(adjusted.text, /^⏳ Addlist import processing/, "A recent large Addlist must not claim completion with zero additions");
assert.match(adjusted.text, /still being reconciled with Telegram/, "Processing copy should explain background reconciliation");
assert.match(adjusted.text, /duplicate detection remains active/, "Retry safety should be communicated");

const unrelated = await api.sendMessage("999999", original);
assert.equal(unrelated.text, original, "Non-Addlist import summaries must remain unchanged");

const coverage = fs.readFileSync("archive-mute-coverage.js", "utf8");
assert.match(coverage, /"ready", "verification", "read_only"/, "Cleanup coverage must include every confirmed joined state");
assert.match(coverage, /archive-mute-queue\.json/, "Coverage worker must feed the persisted cleanup queue");
assert.doesNotMatch(coverage, /"pending"/, "Pending join requests must not be treated as joined chats");

const startup = fs.readFileSync("startup.js", "utf8");
assert.match(startup, /installAddlistImportUi\(Api\)/);
assert.match(startup, /startArchiveMuteCoverageWorker\(\)/);

console.log("TelePilot final Addlist reliability checks passed");
