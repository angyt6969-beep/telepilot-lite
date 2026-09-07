import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withDispatchContext } from "./dispatch-context.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-posting-reliability-"));
process.env.DATA_DIR = root;

const uid = "42";
const userDir = path.join(root, "users", uid);
fs.mkdirSync(userDir, { recursive: true });
fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({
  version: 5,
  groups: [{
    id: "-100123",
    label: "Forum Test",
    username: "@ForumTest",
    topicRequired: true,
    topicId: 77,
    topicTitle: "Open topic",
    joinStatus: "ready",
    accountJoin: { acc1: { status: "ready" } },
  }],
}, null, 2));
fs.writeFileSync(path.join(userDir, "pro-settings.json"), JSON.stringify({ version: 2, history: [], pendingAlerts: [], destinationFailures: {} }, null, 2));
fs.writeFileSync(path.join(userDir, "destination-automation.json"), JSON.stringify({
  version: 1,
  topicQueue: [{ id: "keep-topic-queue" }],
  unresolvedInvites: [{ original: "old invite" }, { original: "old invite 2" }],
  routingQueue: [{ id: "old route" }],
}, null, 2));

const mod = await import(`./posting-reliability-v2.js?test=${Date.now()}`);

class FakeTelegramClient {
  async sendMessage(entity, params) {
    this.lastEntity = entity;
    this.lastMessageParams = params;
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return { id: 9001, message: params?.message || "" };
  }
  async sendFile(entity, params) {
    this.lastFileEntity = entity;
    this.lastFileParams = params;
    return { id: 9002 };
  }
  async getForumTopics() {
    return {
      topics: [
        { id: 77, title: "Open", className: "ForumTopic", closed: false },
        { id: 88, title: "Closed", className: "ForumTopic", closed: true },
        { id: 99, title: "Deleted", className: "ForumTopicDeleted" },
      ],
    };
  }
}

assert.equal(mod.installPostingReliabilityPre(FakeTelegramClient), true);
const client = new FakeTelegramClient();
const context = {
  uid,
  accountId: "acc1",
  destinationId: "-100123",
  cycleId: "cycle-1",
  senderType: "personal",
  senderLabel: "@sender",
};

await withDispatchContext(context, () => client.sendMessage("peer", { message: "hello", replyTo: { stale: true } }));
assert.equal(client.lastMessageParams.replyTo, 77, "forum text must target the selected topic root");
assert.equal(client.lastMessageParams.topMsgId, 77, "forum text must include Teleproto's explicit thread topMsgId");

await withDispatchContext(context, () => client.sendFile("peer", { file: "photo.jpg", caption: "hello" }));
assert.equal(client.lastFileParams.replyTo, 77, "forum media must keep the selected topic route");
assert.equal(client.lastFileParams.topMsgId, 77, "forum media must include the thread topMsgId");

const forumTopics = await client.getForumTopics("peer");
assert.deepEqual(forumTopics.topics.map(topic => topic.id), [77], "closed and deleted forum topics must not be offered for selection");

const closed = new Error("TOPIC_CLOSED");
closed.errorMessage = "TOPIC_CLOSED";
client.failNext = closed;
await assert.rejects(() => withDispatchContext({ ...context, cycleId: "cycle-closed" }, () => client.sendMessage("peer", { message: "closed" })), /TOPIC_CLOSED/);
const afterClosed = JSON.parse(fs.readFileSync(path.join(userDir, "settings.json"), "utf8"));
assert.equal(afterClosed.groups[0].topicId, null, "a closed topic must be cleared so the destination returns to Topics");
assert.equal(afterClosed.groups[0].joinStatus, "needs_topic");

// Restore an open topic for the false-bookkeeping regression.
afterClosed.groups[0].topicId = 77;
afterClosed.groups[0].topicTitle = "Open topic";
afterClosed.groups[0].joinStatus = "ready";
fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify(afterClosed, null, 2));

const preSend = FakeTelegramClient.prototype.sendMessage;
FakeTelegramClient.prototype.sendMessage = async function(...args) {
  await preSend.apply(this, args);
  throw new Error("local bookkeeping failure after delivery");
};
assert.equal(mod.installPostingReliabilityPost(FakeTelegramClient), true);
const delivered = await withDispatchContext({ ...context, cycleId: "cycle-bookkeeping" }, () => client.sendMessage("peer", { message: "delivered" }));
assert.equal(delivered.id, 9001, "a confirmed Telegram delivery must not become a user-facing failure because local bookkeeping threw afterward");

const slow = mod.describePostingError({ errorMessage: "SLOWMODE_WAIT_3587" });
assert.equal(slow.title, "Group slow mode");
assert.match(slow.detail, /1h/);
const photos = mod.describePostingError({ errorMessage: "CHAT_SEND_PHOTOS_FORBIDDEN" });
assert.equal(photos.title, "Photos are not allowed");
const topic = mod.describePostingError({ errorMessage: "TOPIC_CLOSED" });
assert.match(topic.action, /Destinations → Topics/);

const retired = mod.retireLegacyAttentionQueues();
assert.equal(retired.unresolved, 2);
assert.equal(retired.routing, 1);
const automation = JSON.parse(fs.readFileSync(path.join(userDir, "destination-automation.json"), "utf8"));
assert.deepEqual(automation.unresolvedInvites, []);
assert.deepEqual(automation.routingQueue, []);
assert.equal(automation.topicQueue.length, 1, "current topic data must not be cleared with retired legacy queues");

const dashboard = mod.__test.transformUiMessage(uid, "✈️ TelePilot\n\n⚠ 3 items need attention", {
  reply_markup: { inline_keyboard: [[{ text: "⚙️ Settings", callback_data: "v1_settings_v13" }]] },
});
assert.match(dashboard.text, /3 destinations need attention — tap Review Issues/);
assert.equal(dashboard.other.reply_markup.inline_keyboard.some(row => row.some(button => button.callback_data === "v1_dest_issues_v13")), true);

console.log("TelePilot posting reliability v2 regression checks passed");
