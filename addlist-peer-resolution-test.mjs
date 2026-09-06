import assert from "node:assert/strict";
import { installAddlistPeerResolution } from "./addlist-peer-resolution.js";

class MockClient {
  async invoke(request) {
    if (request?.className === "chatlists.CheckChatlistInvite") {
      return { chats: [{ id: 123, className: "Channel", accessHash: 999 }] };
    }
    if (request?.className === "chatlists.GetChatlistUpdates") {
      return { chats: [{ id: 456, className: "Channel", accessHash: 888 }] };
    }
    return {};
  }
  async getInputEntity(value) {
    if (value?.className === "Channel" && value?.accessHash) return { className: "InputPeerChannel", channelId: value.id, accessHash: value.accessHash };
    throw new Error("Could not find input entity");
  }
}

installAddlistPeerResolution(MockClient);
const client = new MockClient();

await client.invoke({ className: "chatlists.CheckChatlistInvite" });
const fromInvite = await client.getInputEntity({ className: "PeerChannel", channelId: 123 });
assert.equal(fromInvite.channelId, 123);
assert.equal(fromInvite.accessHash, 999);

await client.invoke({ className: "chatlists.GetChatlistUpdates" });
const fromUpdates = await client.getInputEntity({ className: "PeerChannel", channelId: 456 });
assert.equal(fromUpdates.channelId, 456);
assert.equal(fromUpdates.accessHash, 888);

await assert.rejects(() => client.getInputEntity({ className: "PeerChannel", channelId: 789 }), /Could not find input entity/);
console.log("Addlist peer resolution regression test passed");
