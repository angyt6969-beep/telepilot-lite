import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Api } from "teleproto";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-addlist-reconcile-"));
process.env.DATA_DIR = temp;

const {
  installAddlistReconciliation,
  recentAddlistImport,
} = await import("./addlist-reconciliation.js");

let rawCalls = 0;
class FakeClient {
  async invoke(request) {
    rawCalls++;
    return { className: "chatlists.ChatlistInvite", peers: [], chats: [] };
  }
}
installAddlistReconciliation(FakeClient);
const fake = new FakeClient();
fake.__telepilotOwnerUid = "123456";
fake.__telepilotAccountId = "account1";
const check = new Api.chatlists.CheckChatlistInvite({ slug: "test_slug_123" });
assert.equal(check.className, "chatlists.CheckChatlistInvite");
await fake.invoke(check);
assert.equal(rawCalls, 1, "Addlist observation must not swallow Telegram requests");
assert.equal(recentAddlistImport("123456"), true, "Observed Addlist checks should mark the import as recent");

const storeFile = path.join(temp, "users", "123456", "addlist-reconciliation.json");
assert.equal(fs.existsSync(storeFile), true, "Observed Addlists should be persisted for background reconciliation");
const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
assert.equal(store.links.length, 1);
assert.equal(store.links[0].accountId, "account1");
assert.equal(store.links[0].slug, "test_slug_123");

const join = new Api.chatlists.JoinChatlistInvite({ slug: "test_slug_123", peers: [new Api.InputPeerSelf()] });
assert.equal(join.className, "chatlists.JoinChatlistInvite");
await fake.invoke(join);
assert.equal(rawCalls, 2);

const source = fs.readFileSync("addlist-reconciliation.js", "utf8");
const startup = fs.readFileSync("startup.js", "utf8");
assert.match(source, /alreadyPeers/, "Reconciliation must use Telegram-confirmed already-joined peers rather than blindly saving every chat in an Addlist");
assert.match(source, /missingPeers/, "Missing peers should be retried through Telegram's Addlist flow");
assert.match(source, /source: "addlist"/, "Recovered destinations must retain their Addlist source");
assert.match(source, /topicId: forum \? 1 : null/, "Recovered forum destinations should default to General");
assert.match(source, /new Map\(groups\.map/, "Recovered Addlists should deduplicate by Telegram destination id");
assert.match(startup, /installAddlistReconciliation\(TelegramClient\)/);
assert.match(startup, /startAddlistReconciliationWorker\(\)/);

console.log("TelePilot Addlist reconciliation checks passed");
