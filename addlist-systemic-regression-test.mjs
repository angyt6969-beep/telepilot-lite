import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bigInt from "big-integer";
import { Api } from "teleproto";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-addlist-systemic-"));
process.env.DATA_DIR = temp;

const { installAddlistSafety, recentAddlistCapacity } = await import("./addlist-safety.js");

const TOTAL = 144;
const peerRows = Array.from({ length: TOTAL }, (_, i) => ({ className: "PeerChannel", channelId: bigInt(i + 1) }));
const chatRows = Array.from({ length: TOTAL }, (_, i) => ({ className: "Channel", id: bigInt(i + 1), accessHash: bigInt(10000 + i), megagroup: true, title: `Group ${i + 1}` }));
let joined = 0;
let joinInvitePeerCount = 0;
let getUpdatesCalls = 0;

class FakeClient {
  constructor() {
    this.__telepilotOwnerUid = "123";
    this.__telepilotAccountId = "a1";
  }
  async getMe() { return { premium: false }; }
  async invoke(request) {
    if (request?.className === "chatlists.CheckChatlistInvite") {
      if (!joined) return { className: "ChatlistInvite", peers: peerRows.slice(), chats: chatRows.slice() };
      return {
        className: "ChatlistInviteAlready",
        filterId: 7,
        alreadyPeers: peerRows.slice(0, joined),
        missingPeers: peerRows.slice(joined),
        chats: chatRows.slice(),
      };
    }
    if (request?.className === "chatlists.JoinChatlistInvite") {
      joinInvitePeerCount = request.peers.length;
      joined = request.peers.length;
      return { ok: true };
    }
    if (request?.className === "chatlists.GetChatlistUpdates") {
      getUpdatesCalls++;
      return { missingPeers: peerRows.slice(joined), chats: chatRows.slice(), users: [] };
    }
    if (request?.className === "chatlists.JoinChatlistUpdates") {
      joined += request.peers.length;
      return { ok: true };
    }
    return { ok: true };
  }
}

installAddlistSafety(FakeClient);
const client = new FakeClient();
const preview = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug: "large_test" }));
assert.equal(preview.chats.length, TOTAL, "Before import, the full preview is needed for peer resolution");
const inputs = peerRows.map((peer, i) => new Api.InputPeerChannel({ channelId: peer.channelId, accessHash: chatRows[i].accessHash }));
await client.invoke(new Api.chatlists.JoinChatlistInvite({ slug: "large_test", peers: inputs }));
assert.equal(joinInvitePeerCount, 100, "A standard account must not send more than Telegram's 100-chat folder capacity in one import");
assert.equal(preview.chats.length, 100, "After the join, the caller's preview must contain only Telegram-confirmed joined chats");

const capacity = recentAddlistCapacity("123");
assert.equal(capacity.total, 144);
assert.equal(capacity.limit, 100);
assert.equal(capacity.confirmed, 100);
assert.equal(capacity.premium, false);

const already = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug: "large_test" }));
assert.equal(already.chats.length, 100, "Already-imported Addlists must expose only confirmed member chats to the saver");
assert.equal(already.missingPeers.length, 44);

const filter = new Api.InputChatlistDialogFilter({ filterId: 7 });
const firstUpdates = await client.invoke(new Api.chatlists.GetChatlistUpdates({ chatlist: filter }));
const secondUpdates = await client.invoke(new Api.chatlists.GetChatlistUpdates({ chatlist: filter }));
assert.equal(firstUpdates, secondUpdates, "Repeated update checks within the Telegram cadence window should use the cached result");
assert.equal(getUpdatesCalls, 1, "getChatlistUpdates must not be hammered repeatedly inside the one-hour update period");

const source = fs.readFileSync("addlist-safety.js", "utf8");
assert.match(source, /CHATLIST_UPDATE_PERIOD_MS = 60 \* 60_000/);
assert.match(source, /STANDARD_FOLDER_CHAT_LIMIT = 100/);
assert.match(source, /PREMIUM_FOLDER_CHAT_LIMIT = 200/);

console.log("Addlist systemic reliability regression test passed");
