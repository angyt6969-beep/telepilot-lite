import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-addlist-reimport-"));
process.env.DATA_DIR = root;
process.env.API_ID ||= "1";
process.env.API_HASH ||= "test-hash";

const source = fs.readFileSync(new URL("./destination-addlist-reimport-bulk.js", import.meta.url), "utf8");
const startup = fs.readFileSync(new URL("./startup.js", import.meta.url), "utf8");
const module = await import(`./destination-addlist-reimport-bulk.js?test=${Date.now()}`);

assert.match(source, /chatlists\.leaveChatlist/);
assert.match(source, /leaveChatlist\(\{ chatlist, peers: \[\] \}\)/, "Detaching the imported folder must not leave any Telegram chats");
assert.match(source, /chatlists\.joinChatlistInvite/);
assert.match(source, /chatlists\.getChatlistUpdates/);
assert.equal(source.includes("client.joinChannel"), false, "Full reimport must not use one-by-one joining");
assert.match(startup, /installAddlistBulkReimport/);

const candidates = [
  { id: "-100123", sourceKind: "addlist", sourceSlug: "folder" },
  { id: "-100456", sourceKind: "addlist", sourceSlug: "folder" },
];
const chats = [
  { className: "Channel", id: 123, accessHash: 999, megagroup: true },
  { className: "Channel", id: 456, accessHash: 888, megagroup: true },
];
const peers = [{ channelId: 123 }, { channelId: 456 }];

const calls = [];
let checkCount = 0;
const fakeClient = {
  api: {
    chatlists: {
      async checkChatlistInvite() {
        checkCount++;
        calls.push(`check:${checkCount}`);
        if (checkCount === 1) {
          return {
            className: "ChatlistInviteAlready",
            filterId: 77,
            missingPeers: [],
            alreadyPeers: [],
            chats,
          };
        }
        return {
          className: "ChatlistInvite",
          peers,
          chats,
        };
      },
      async getChatlistUpdates() {
        calls.push("updates");
        return { missingPeers: [], chats };
      },
      async leaveChatlist({ peers: leavePeers }) {
        calls.push(`leave:${leavePeers.length}`);
        assert.deepEqual(leavePeers, [], "No chat may be passed to leaveChatlist");
        return {};
      },
      async joinChatlistInvite({ peers: joinPeers }) {
        calls.push(`join:${joinPeers.length}`);
        assert.equal(joinPeers.length, 2);
        return {};
      },
    },
  },
};

const result = await module.reimportStaleAddlist(fakeClient, "folder", candidates);
assert.deepEqual(result, { handled: true, mode: "reimport", accepted: 2, offered: 2 });
assert.deepEqual(calls, ["check:1", "updates", "leave:0", "check:2", "join:2"], "Stale imported Addlist should detach the folder, refresh it, then bulk join all missing peers once");

const updateCalls = [];
const updatesAvailableClient = {
  api: {
    chatlists: {
      async checkChatlistInvite() {
        updateCalls.push("check");
        return { className: "ChatlistInviteAlready", filterId: 88, chats };
      },
      async getChatlistUpdates() {
        updateCalls.push("updates");
        return { missingPeers: [{ channelId: 123 }], chats };
      },
      async leaveChatlist() { updateCalls.push("leave"); },
      async joinChatlistInvite() { updateCalls.push("join"); },
    },
  },
};
const ordinaryUpdates = await module.reimportStaleAddlist(updatesAvailableClient, "folder", candidates);
assert.equal(ordinaryUpdates.handled, false);
assert.equal(ordinaryUpdates.reason, "updates_available");
assert.deepEqual(updateCalls, ["check", "updates"], "Normal shared-folder updates must remain on the existing safe path");

console.log("TelePilot full Addlist reimport regression checks passed");
