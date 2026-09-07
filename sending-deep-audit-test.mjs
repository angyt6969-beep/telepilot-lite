import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-send-audit-"));
process.env.DATA_DIR = root;
process.env.TELEPILOT_SECURITY_SECRET ||= "sending-audit-security-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
process.env.TELEPILOT_SESSION_KEY_B64 ||= Buffer.alloc(32, 17).toString("base64");

const enhancements = await import(`./posting-engine-enhancements.js?send-audit=${Date.now()}`);
const engine = await import(`./v1-engine.js?send-audit=${Date.now()}`);
const { withDispatchContext } = await import("./dispatch-context.js");
const worker = await import(`./v1-worker.js?send-audit=${Date.now()}`);

// A later app save must not erase the access hash needed to address a private supergroup directly.
enhancements.writeAppSettings("303", {
  groups: [{ id: "-100303", label: "Private group", accessHash: "998877665544" }],
});
enhancements.writeAppSettings("303", {
  groups: [{ id: "-100303", label: "Private group renamed" }],
});
assert.equal(enhancements.readAppSettings("303").groups[0].accessHash, "998877665544");
assert.equal(enhancements.__test.preserveDestinationPeerMetadata(
  [{ id: "-1001", accessHash: "123" }],
  [{ id: "-1001" }],
)[0].accessHash, "123");

// Saved private Telegram peers should be usable without depending on a dialogs scan.
const channelPeer = worker.__test.savedInputPeer({ id: "-100123456", accessHash: "987654321" });
assert.equal(channelPeer?.className, "InputPeerChannel");
assert.equal(String(channelPeer?.channelId), "123456");
assert.equal(String(channelPeer?.accessHash), "987654321");
const chatPeer = worker.__test.savedInputPeer({ id: "-5555" });
assert.equal(chatPeer?.className, "InputPeerChat");
assert.equal(String(chatPeer?.chatId), "5555");
assert.equal(worker.__test.savedInputPeer({ id: "-100123456", accessHash: "" }), null);

// A destination-specific failure must not mark the entire connected account unknown.
assert.equal(worker.__test.accountStatusPatchForSendError(new Error("CHAT_WRITE_FORBIDDEN")), null);
const fatalPatch = worker.__test.accountStatusPatchForSendError(new Error("SESSION_REVOKED"), 12345);
assert.equal(fatalPatch.status, "needs-reconnect");
assert.equal(fatalPatch.lastVerifiedAt, 12345);
assert.equal(worker.__test.isPartialDeliveryError({ __telepilotPartialDelivery: true }), true);

class FakeApi {
  constructor() {
    this.photoCalls = [];
    this.rawMessageCalls = [];
  }
  async sendMessage(chatId, text, options = {}) {
    this.rawMessageCalls.push({ chatId, text, options });
    throw new Error("FOLLOW_UP_TEXT_FAILED");
  }
  async sendPhoto(chatId, fileId, options = {}) {
    this.photoCalls.push({ chatId, fileId, options });
    return { message_id: 1 };
  }
  async sendVideo() { throw new Error("unexpected video send"); }
  async sendAnimation() { throw new Error("unexpected animation send"); }
  async sendDocument() { throw new Error("unexpected document send"); }
}

class FakePersonalClient {
  constructor() {
    this.fileCalls = [];
    this.rawMessageCalls = [];
  }
  async sendMessage(entity, params = {}) {
    this.rawMessageCalls.push({ entity, params });
    throw new Error("FOLLOW_UP_TEXT_FAILED");
  }
  async sendFile(entity, params = {}) {
    this.fileCalls.push({ entity, params });
    return { id: 1 };
  }
}

engine.prepareV1Engine(FakeApi, FakePersonalClient);
engine.installV1Engine(FakeApi, FakePersonalClient);

const longText = "x".repeat(engine.__test.MEDIA_CAPTION_LIMIT + 50);
const botUid = "401";
enhancements.writeAppSettings(botUid, {
  adMessage: longText,
  adEntities: [],
  groups: [{ id: "-100401", label: "Forum", topicRequired: true, topicId: 777 }],
});
enhancements.writeProSettings(botUid, { media: { kind: "photo", fileId: "photo-file-id" } });
const api = new FakeApi();
let botError = null;
try {
  await withDispatchContext({
    uid: botUid,
    destinationId: "-100401",
    cycleId: "audit-bot-media",
    senderType: "bot",
    senderLabel: "TelePilot Bot",
  }, () => api.sendMessage("-100401", longText, { message_thread_id: 777 }));
} catch (err) {
  botError = err;
}
assert.equal(botError?.__telepilotPartialDelivery, true, "media success + follow-up failure must be marked partial-delivery");
assert.equal(api.photoCalls.length, 1, "follow-up text failure must not resend successful bot media");
assert.equal(api.photoCalls[0].options.message_thread_id, 777, "bot media must stay in the selected forum topic");
assert.equal(api.photoCalls[0].options.caption, undefined, "oversized text must not be sent as an invalid media caption");
assert.equal(api.rawMessageCalls.length, 1);
assert.equal(api.rawMessageCalls[0].options.message_thread_id, 777, "split follow-up text must stay in the same forum topic");

const personalUid = "402";
const mediaPath = path.join(root, "personal-media.bin");
fs.writeFileSync(mediaPath, "test-media");
enhancements.writeAppSettings(personalUid, {
  adMessage: longText,
  adEntities: [],
  groups: [{ id: "-100402", label: "Forum", topicRequired: true, topicId: 888 }],
});
enhancements.writeProSettings(personalUid, { media: { kind: "document", localPath: mediaPath } });
const personal = new FakePersonalClient();
const replyTo = { replyToMsgId: 888, topMsgId: 888 };
let personalError = null;
try {
  await withDispatchContext({
    uid: personalUid,
    destinationId: "-100402",
    cycleId: "audit-personal-media",
    senderType: "personal",
    senderLabel: "Test account",
    accountId: "acc1",
  }, () => personal.sendMessage("-100402", { message: longText, replyTo }));
} catch (err) {
  personalError = err;
}
assert.equal(personalError?.__telepilotPartialDelivery, true);
assert.equal(personal.fileCalls.length, 1, "follow-up text failure must not resend successful personal media");
assert.equal(personal.fileCalls[0].params.caption, "", "oversized personal caption must be split into media + text");
assert.equal(personal.fileCalls[0].params.replyTo, replyTo, "personal media must preserve the selected topic/reply route");
assert.equal(personal.rawMessageCalls.length, 1);
assert.equal(personal.rawMessageCalls[0].params.replyTo, replyTo, "personal follow-up text must preserve the selected topic/reply route");

const engineSource = fs.readFileSync("v1-engine.js", "utf8");
assert.ok(engineSource.includes("MEDIA_CAPTION_LIMIT = 1024"));
assert.ok(engineSource.includes("await sendBotMedia(this,chatId,pro.media,rendered,other||{})"), "bot media must own its staged retry instead of being retried as one combined operation");
assert.ok(engineSource.includes("await sendPersonalMedia(this,entity,pro.media,rendered,params)"), "personal media must own its staged retry instead of being retried as one combined operation");

console.log("TelePilot sending deep-audit regression tests passed");
