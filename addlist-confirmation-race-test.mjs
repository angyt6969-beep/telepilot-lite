import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bigInt from "big-integer";
import { Api } from "teleproto";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-addlist-race-"));
process.env.DATA_DIR = temp;

const { installAddlistSafety } = await import("./addlist-safety.js");

const TOTAL = 91;
const peers = Array.from({ length: TOTAL }, (_, i) => ({ className: "PeerChannel", channelId: bigInt(i + 1) }));
const chats = Array.from({ length: TOTAL }, (_, i) => ({
  className: "Channel",
  id: bigInt(i + 1),
  accessHash: bigInt(50000 + i),
  megagroup: true,
  title: `Race Group ${i + 1}`,
}));
let joined = false;
let checkCount = 0;

class LaggingTelegramClient {
  constructor() {
    this.__telepilotOwnerUid = "555";
    this.__telepilotAccountId = "sender1";
  }
  async getMe() { return { premium: false }; }
  async invoke(request) {
    if (request?.className === "chatlists.CheckChatlistInvite") {
      checkCount++;
      if (!joined) return { className: "ChatlistInvite", peers: peers.slice(), chats: chats.slice() };
      // Reproduce the real race: Telegram accepts the folder join, but the
      // immediate refresh has not populated alreadyPeers yet.
      return {
        className: "ChatlistInviteAlready",
        filterId: 9,
        alreadyPeers: [],
        missingPeers: peers.slice(),
        chats: chats.slice(),
      };
    }
    if (request?.className === "chatlists.JoinChatlistInvite") {
      assert.equal(request.peers.length, TOTAL);
      joined = true;
      return { className: "Updates", updates: [] };
    }
    return { ok: true };
  }
}

installAddlistSafety(LaggingTelegramClient);
const client = new LaggingTelegramClient();
const preview = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug: "race_test" }));
assert.equal(preview.chats.length, TOTAL);

const inputs = peers.map((peer, i) => new Api.InputPeerChannel({
  channelId: peer.channelId,
  accessHash: chats[i].accessHash,
}));
await client.invoke(new Api.chatlists.JoinChatlistInvite({ slug: "race_test", peers: inputs }));

assert.equal(checkCount, 2, "The join path should perform one post-join refresh");
assert.equal(
  preview.chats.length,
  TOTAL,
  "A lagging alreadyPeers refresh must not erase peers from a successful Addlist join",
);
assert.equal(
  preview.alreadyPeers.length,
  TOTAL,
  "Successfully submitted peers must remain exposed as confirmed while Telegram catches up",
);

const reconciliationSource = fs.readFileSync("addlist-reconciliation.js", "utf8");
assert.match(reconciliationSource, /__telepilotOwnerUid = String\(uid\)/);
assert.match(reconciliationSource, /__telepilotAccountId = String\(account\.id\)/);
assert.match(reconciliationSource, /acceptedChats/);
assert.match(reconciliationSource, /confirmed 0\/\$\{initialPeers\.length\}/);

console.log("Addlist delayed-confirmation regression test passed");
