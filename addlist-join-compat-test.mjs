import assert from "node:assert/strict";
import { installAddlistJoinCompatibility } from "./addlist-join-compat.js";

class FakeClient {
  constructor() {
    this.calls = [];
    this.missingPeers = [];
    this.failJoin = false;
  }
  async invoke(request) {
    const name = String(request?.className || request?.constructor?.className || "");
    this.calls.push({ name, request });
    if (name === "chatlists.GetChatlistUpdates") return { missingPeers: this.missingPeers };
    if (name === "chatlists.JoinChatlistUpdates") {
      if (this.failJoin) {
        const err = new Error("FILTER_INCLUDE_EMPTY");
        err.errorMessage = "FILTER_INCLUDE_EMPTY";
        throw err;
      }
      return { ok: true };
    }
    return { passthrough: true };
  }
  async getInputEntity(peer) { return peer; }
}

installAddlistJoinCompatibility(FakeClient);

const ownFolder = new FakeClient();
const ownResult = await ownFolder.invoke({
  className: "chatlists.JoinChatlistUpdates",
  chatlist: { filterId: 7 },
  peers: [{ channelId: 1001 }],
});
assert.equal(ownResult, null, "Already-imported folder with no current missing peers should be a no-op");
assert.deepEqual(ownFolder.calls.map(call => call.name), ["chatlists.GetChatlistUpdates"]);

const updatedFolder = new FakeClient();
updatedFolder.missingPeers = [{ channelId: 1001 }];
const updatedResult = await updatedFolder.invoke({
  className: "chatlists.JoinChatlistUpdates",
  chatlist: { filterId: 8 },
  peers: [{ channelId: 1001 }, { channelId: 9999 }],
});
assert.equal(updatedResult?.ok, true);
const joinCall = updatedFolder.calls.find(call => call.name === "chatlists.JoinChatlistUpdates");
assert.ok(joinCall, "Current folder updates should still be joined");
assert.equal(joinCall.request.peers.length, 1, "Only peers confirmed by GetChatlistUpdates should be joined");
assert.equal(String(joinCall.request.peers[0].channelId), "1001");

const emptyFilter = new FakeClient();
emptyFilter.missingPeers = [{ channelId: 2002 }];
emptyFilter.failJoin = true;
const emptyFilterResult = await emptyFilter.invoke({
  className: "chatlists.JoinChatlistUpdates",
  chatlist: { filterId: 9 },
  peers: [{ channelId: 2002 }],
});
assert.equal(emptyFilterResult, null, "FILTER_INCLUDE_EMPTY should not fail an Addlist that is already present");

const passthrough = new FakeClient();
const passResult = await passthrough.invoke({ className: "messages.GetDialogs" });
assert.equal(passResult?.passthrough, true);
assert.deepEqual(passthrough.calls.map(call => call.name), ["messages.GetDialogs"]);

console.log("TelePilot Addlist already-imported compatibility checks passed");
