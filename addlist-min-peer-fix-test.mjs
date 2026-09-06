import assert from "node:assert/strict";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";

const before = TelegramClient.prototype.getInputEntity;
await import("./addlist-min-peer-fix.js");
const after = TelegramClient.prototype.getInputEntity;
assert.notEqual(after, before, "Addlist min-peer resolver must install");

// Test double: model the minimal Channel shape Telegram may return from
// chatlists.checkChatlistInvite. This specifically reproduces the shape that
// teleproto's normal getInputPeer path rejects when min=true.
const minChannel = Object.create(Api.Channel.prototype);
minChannel.id = bigInt("2000383834");
minChannel.accessHash = bigInt("1234567890123456789");
minChannel.min = true;

const input = await after.call({}, minChannel);
assert.ok(input instanceof Api.InputPeerChannel);
assert.equal(input.channelId.toString(), "2000383834");
assert.equal(input.accessHash.toString(), "1234567890123456789");

// Ordinary already-resolved input peers must still use the normal teleproto path.
const ordinary = new Api.InputPeerChannel({
  channelId: bigInt("1001"),
  accessHash: bigInt("2002"),
});
const ordinaryResolved = await after.call({}, ordinary);
assert.equal(ordinaryResolved, ordinary);

console.log("TelePilot Addlist min-peer regression test passed");
