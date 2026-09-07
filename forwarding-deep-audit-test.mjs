import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-forward-audit-"));
process.env.DATA_DIR = root;
process.env.TELEPILOT_SECURITY_SECRET ||= "forward-audit-security-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
process.env.TELEPILOT_SESSION_KEY_B64 ||= Buffer.alloc(32, 19).toString("base64");

const enhancements = await import(`./posting-engine-enhancements.js?forward-audit=${Date.now()}`);
const engine = await import(`./v1-engine.js?forward-audit=${Date.now()}`);
const reliability = await import(`./posting-reliability-v2.js?forward-audit=${Date.now()}`);
const forwarded = await import(`./forwarded-post-v1.js?forward-audit=${Date.now()}`);
const { withDispatchContext } = await import("./dispatch-context.js");

class FakeClient {
  constructor() {
    this.forwardCalls = [];
    this.originalCalls = [];
    this.forwardMode = "nested-success";
  }
  async sendMessage(entity, params = {}) {
    this.originalCalls.push({ entity, params });
    return { original: true, entity, params };
  }
  async forwardMessages(entity, params = {}) {
    this.forwardCalls.push({ entity, params });
    if (this.forwardMode === "topic-closed") throw new Error("TOPIC_CLOSED");
    if (this.forwardMode === "transient") throw new Error("RPC_CALL_FAIL");
    return [[{ id: 9001, entity, params }]];
  }
}

reliability.installPostingReliabilityPre(FakeClient);
forwarded.installForwardedPostSend(FakeClient, {
  readConfig: () => ({ enabled: true, sourcePeer: "@sourcechannel", sourceMessageId: 321 }),
  resolveSource: async () => "resolved-source",
});

// Forwarded Post must obey the same disabled-destination guard as normal personal sends.
const disabledUid = "6101";
enhancements.writeAppSettings(disabledUid, {
  adMessage: "\u2063",
  groups: [{ id: "-1006101", label: "Disabled destination" }],
});
enhancements.writeProSettings(disabledUid, { disabledDestinationIds: ["-1006101"] });
const disabledClient = new FakeClient();
const disabledResult = await withDispatchContext({
  uid: disabledUid,
  destinationId: "-1006101",
  cycleId: "forward-disabled",
  senderType: "personal",
  senderLabel: "Audit account",
  accountId: "a1",
}, () => disabledClient.sendMessage("-1006101", { message: "\u2063" }));
assert.equal(disabledResult.__telepilotSkipped, true);
assert.equal(disabledResult.__telepilotSkipReason, "disabled");
assert.equal(disabledClient.forwardCalls.length, 0, "disabled forwarding destination must never reach Telegram");
assert.equal(engine.readV1(disabledUid).history.at(-1)?.reason, "disabled");

// A successful forward must count toward history/post limits, preserve forum routing,
// and tolerate Teleproto's potentially nested response shape.
const successUid = "6102";
enhancements.writeAppSettings(successUid, {
  adMessage: "\u2063",
  groups: [{ id: "-1006102", label: "Forum destination", topicRequired: true, topicId: 777, topicTitle: "Ads" }],
});
enhancements.writeProSettings(successUid, {
  postLimit: { enabled: true, max: 1, sent: 0 },
});
const successClient = new FakeClient();
const successContext = {
  uid: successUid,
  destinationId: "-1006102",
  senderType: "personal",
  senderLabel: "Audit account",
  accountId: "a1",
};
const successResult = await withDispatchContext({ ...successContext, cycleId: "forward-success-1" }, () =>
  successClient.sendMessage("-1006102", { message: "\u2063", replyTo: { replyToMsgId: 777 } }),
);
assert.equal(successResult.id, 9001);
assert.equal(successClient.forwardCalls.length, 1);
assert.equal(successClient.forwardCalls[0].params.topMsgId, 777);
assert.equal(successClient.forwardCalls[0].params.replyTo, 777, "reliability routing must keep the forward inside the selected topic");
let successPro = engine.readV1(successUid);
assert.equal(successPro.postLimit.sent, 1, "successful forwarded post must increment the normal post limit");
assert.equal(successPro.history.at(-1)?.status, "sent", "successful forwarded post must appear in normal posting history");
const limitedResult = await withDispatchContext({ ...successContext, cycleId: "forward-success-2" }, () =>
  successClient.sendMessage("-1006102", { message: "\u2063", replyTo: 777 }),
);
assert.equal(limitedResult.__telepilotSkipped, true);
assert.equal(limitedResult.__telepilotSkipReason, "post-limit");
assert.equal(successClient.forwardCalls.length, 1, "post-limit skip must not issue another forward");

// Forward failures remain single-attempt. Topic failures must flow through the established
// topic-repair path and must also be recorded in v1 history.
const failureUid = "6103";
enhancements.writeAppSettings(failureUid, {
  adMessage: "\u2063",
  groups: [{ id: "-1006103", label: "Closed forum", topicRequired: true, topicId: 888, topicTitle: "Closed" }],
});
enhancements.writeProSettings(failureUid, {});
const failureClient = new FakeClient();
failureClient.forwardMode = "topic-closed";
let failure = null;
try {
  await withDispatchContext({
    uid: failureUid,
    destinationId: "-1006103",
    cycleId: "forward-topic-failure",
    senderType: "personal",
    senderLabel: "Audit account",
    accountId: "a1",
  }, () => failureClient.sendMessage("-1006103", { message: "\u2063", replyTo: 888 }));
} catch (err) {
  failure = err;
}
assert.match(String(failure?.message || failure), /TOPIC_CLOSED/);
assert.equal(failureClient.forwardCalls.length, 1, "forwarding must not add immediate retries that can duplicate an ambiguous delivery");
const repaired = enhancements.readAppSettings(failureUid).groups[0];
assert.equal(repaired.topicId, null);
assert.equal(repaired.joinStatus, "needs_topic");
assert.equal(engine.readV1(failureUid).history.at(-1)?.status, "failed");

// Private source fallback should search the same 1000-dialog ceiling used by the personal destination resolver.
let dialogLimit = 0;
const privateSourceClient = {
  async getInputEntity() { throw new Error("cache miss"); },
  async getDialogs(options = {}) {
    dialogLimit = Number(options.limit || 0);
    return [{ id: "-100987654", inputEntity: { marker: "resolved-private-source" } }];
  },
};
const privateSource = await forwarded.__test.resolveForwardSourcePeer(privateSourceClient, {
  sourcePeer: "-100987654",
  sourceMessageId: 42,
});
assert.equal(dialogLimit, 1000);
assert.equal(privateSource.marker, "resolved-private-source");

assert.equal(forwarded.__test.firstForwardedResult([[null], [{ id: 7 }]])?.id, 7);

console.log("TelePilot forwarding deep-audit regression tests passed");
