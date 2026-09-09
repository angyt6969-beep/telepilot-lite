import assert from "node:assert/strict";
import { withDispatchContext } from "./dispatch-context.js";
import {
  forwardConfiguredPost,
  installForwardedPostSend,
  normalizeForwardedModeLine,
  parseTelegramMessageLink,
  sourceFromForwardedMessage,
  threadIdFromSendParams,
  __test,
} from "./forwarded-post-v1.js";

const publicLink = parseTelegramMessageLink("https://t.me/examplechannel/321");
assert.equal(publicLink.sourcePeer, "@examplechannel");
assert.equal(publicLink.sourceMessageId, 321);
assert.equal(publicLink.enabled, true);

const privateForumLink = parseTelegramMessageLink("https://t.me/c/1234567890/77/654?single");
assert.equal(privateForumLink.sourcePeer, "-1001234567890");
assert.equal(privateForumLink.sourceMessageId, 654);

const previewLink = parseTelegramMessageLink("https://t.me/s/examplechannel/88");
assert.equal(previewLink.sourcePeer, "@examplechannel");
assert.equal(previewLink.sourceMessageId, 88);

assert.equal(parseTelegramMessageLink("https://t.me/addlist/abcdef"), null);
assert.equal(parseTelegramMessageLink("https://example.com/test/42"), null);

const origin = sourceFromForwardedMessage({
  forward_origin: {
    type: "channel",
    chat: { id: -1001234567890, title: "Premium Source", username: "premiumsource" },
    message_id: 91,
  },
});
assert.equal(origin.sourcePeer, "@premiumsource");
assert.equal(origin.sourceMessageId, 91);
assert.equal(origin.sourceLabel, "Premium Source");

assert.equal(sourceFromForwardedMessage({ forward_origin: { type: "user", sender_user: { id: 1 } } }), null);

assert.equal(threadIdFromSendParams({ topMsgId: 44 }), 44);
assert.equal(threadIdFromSendParams({ replyTo: 55 }), 55);
assert.equal(threadIdFromSendParams({ replyTo: { replyToMsgId: 66 } }), 66);
assert.equal(threadIdFromSendParams({}), 0);

const decorated = __test.messageMenuPayload("12345", {
  text: "📝 AD MESSAGE\n\n✅ Saved • 10 characters",
  reply_markup: {
    inline_keyboard: [
      [{ text: "Preview", callback_data: "message_preview" }, { text: "Change", callback_data: "message_change" }],
      [{ text: "Back", callback_data: "home" }],
    ],
  },
});
assert.equal(decorated.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "fp_setup"), true);
assert.match(decorated.text, /Mode — Normal Post/);


const cleanedModes = normalizeForwardedModeLine([
  "📝 Message",
  "● Ready",
  "",
  "Mode — Normal Post",
  "",
  "Mode: — Normal Post",
  "",
  "<b>Mode:</b> — Forwarded Post · Old Source",
].join("\n"), {
  enabled: true,
  sourcePeer: "@premiumsource",
  sourceLabel: "Premium Source",
});
const plainModes = cleanedModes.replace(/<[^>]+>/g, "").replace(/[*_`~]/g, "");
assert.equal((plainModes.match(/^Mode\s*:?\s*[—-]/gmi) || []).length, 1);
assert.match(cleanedModes, /Mode — Forwarded Post · Premium Source/);

let enabled = true;
let originalCalls = 0;
let forwardCall = null;
class FakeClient {
  async sendMessage(entity, params) {
    originalCalls += 1;
    return { entity, params, original: true };
  }
  async getInputEntity(peer) { return `resolved:${peer}`; }
  async forwardMessages(entity, params) {
    forwardCall = { entity, params };
    return [{ id: 999 }];
  }
}
installForwardedPostSend(FakeClient, {
  readConfig: () => enabled
    ? { enabled: true, sourcePeer: "@premiumsource", sourceMessageId: 91 }
    : { enabled: false, sourcePeer: "@premiumsource", sourceMessageId: 91 },
});
const client = new FakeClient();

const directForward = await forwardConfiguredPost(client, {
  enabled: true,
  sourcePeer: "@premiumsource",
  sourceMessageId: 91,
}, "me");
assert.equal(directForward.id, 999);
assert.equal(forwardCall.entity, "me");
assert.equal(forwardCall.params.messages, 91);
assert.equal(forwardCall.params.fromPeer, "resolved:@premiumsource");
forwardCall = null;
const forwarded = await withDispatchContext(
  { uid: "12345", senderType: "personal", destinationId: "-1001" },
  () => client.sendMessage("@destination", { message: "fallback", replyTo: { replyToMsgId: 77 } }),
);
assert.equal(forwarded.id, 999);
assert.equal(originalCalls, 0);
assert.equal(forwardCall.entity, "@destination");
assert.equal(forwardCall.params.messages, 91);
assert.equal(forwardCall.params.fromPeer, "resolved:@premiumsource");
assert.equal(forwardCall.params.topMsgId, 77);
assert.deepEqual(forwardCall.params.replyTo, { replyToMsgId: 77 });

enabled = false;
const normal = await withDispatchContext(
  { uid: "12345", senderType: "personal", destinationId: "-1001" },
  () => client.sendMessage("@destination", { message: "normal" }),
);
assert.equal(normal.original, true);
assert.equal(originalCalls, 1);

const outsideCycle = await client.sendMessage("@destination", { message: "outside" });
assert.equal(outsideCycle.original, true);
assert.equal(originalCalls, 2);

console.log("forwarded post regression tests passed");
