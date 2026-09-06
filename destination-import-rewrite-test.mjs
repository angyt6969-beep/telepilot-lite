import assert from "node:assert/strict";
import fs from "node:fs";
import {
  importAddlistWithClient,
  parseDestinationInput,
} from "./destination-automation.js";

assert.deepEqual(parseDestinationInput("@RareHandle")?.kind, "public");
assert.equal(parseDestinationInput("t.me/RareHandle")?.username, "RareHandle");
assert.equal(parseDestinationInput("https://t.me/RareHandle")?.username, "RareHandle");
assert.equal(parseDestinationInput("[group](https://t.me/RareHandle)")?.username, "RareHandle");
assert.equal(parseDestinationInput("https://t.me/+PrivateHash")?.kind, "invite");
assert.equal(parseDestinationInput("t.me/addlist/FolderSlug")?.kind, "addlist");
assert.equal(parseDestinationInput("not a telegram destination"), null);

function channel(id, title) {
  return { className: "Channel", id, accessHash: BigInt(id * 100), megagroup: true, title };
}
function peer(id) { return { className: "PeerChannel", channelId: id }; }

{
  const chats = [channel(11, "A"), channel(12, "B"), channel(13, "C"), channel(14, "D")];
  const joined = [];
  const client = {
    api: {
      chatlists: {
        async checkChatlistInvite() {
          return { className: "ChatlistInvite", peers: chats.map(chat => peer(chat.id)), chats };
        },
        async joinChatlistInvite({ peers }) { joined.push(...peers); return { className: "Updates" }; },
      },
    },
    async getInputEntity(chat) { return { className: "InputPeerChannel", channelId: chat.id, accessHash: chat.accessHash }; },
  };
  const result = await importAddlistWithClient(client, "FreshFolder");
  assert.equal(joined.length, 4, "fresh Addlist must submit every resolved peer exactly once");
  assert.equal(result.chats.length, 4, "fresh Addlist must return the chats Telegram accepted");
  assert.equal(result.joinedNow, 4);
}

{
  const alreadyChats = [channel(21, "Already A"), channel(22, "Already B")];
  const updateChats = [channel(23, "New C"), channel(24, "New D")];
  let getUpdatesCalls = 0;
  let joinedUpdates = [];
  const client = {
    api: {
      chatlists: {
        async checkChatlistInvite() {
          return {
            className: "ChatlistInviteAlready",
            filterId: 7,
            alreadyPeers: alreadyChats.map(chat => peer(chat.id)),
            missingPeers: updateChats.map(chat => peer(chat.id)),
            chats: [...alreadyChats, ...updateChats],
          };
        },
        async getChatlistUpdates() {
          getUpdatesCalls++;
          return { missingPeers: updateChats.map(chat => peer(chat.id)), chats: updateChats };
        },
        async joinChatlistUpdates({ peers }) { joinedUpdates = peers; return { className: "Updates" }; },
      },
    },
    async getInputEntity(chat) { return { className: "InputPeerChannel", channelId: chat.id, accessHash: chat.accessHash }; },
  };
  const result = await importAddlistWithClient(client, "ExistingFolder");
  assert.equal(getUpdatesCalls, 1, "already-imported Addlists with missing peers must use getChatlistUpdates");
  assert.equal(joinedUpdates.length, 2, "only Telegram-reported missing peers should be joined through joinChatlistUpdates");
  assert.equal(result.chats.length, 4, "existing and newly joined chats must both be returned as confirmed destinations");
}

{
  const chats = [channel(31, "Already")];
  let getUpdatesCalls = 0;
  const client = {
    api: { chatlists: {
      async checkChatlistInvite() { return { className: "ChatlistInviteAlready", filterId: 9, alreadyPeers: [peer(31)], missingPeers: [], chats }; },
      async getChatlistUpdates() { getUpdatesCalls++; throw new Error("must not be called"); },
    } },
    async getInputEntity(chat) { return { className: "InputPeerChannel", channelId: chat.id, accessHash: chat.accessHash }; },
  };
  const result = await importAddlistWithClient(client, "NoChanges");
  assert.equal(getUpdatesCalls, 0, "an Addlist with no missing peers must not poll updates unnecessarily");
  assert.equal(result.chats.length, 1);
}

const startup = fs.readFileSync("startup.js", "utf8");
for (const legacy of [
  "addlist-reconciliation",
  "addlist-join-compat",
  "addlist-peer-resolution",
  "addlist-import-ui",
  "archive-mute-queue",
  "archive-mute-coverage",
  "forum-general-fallback",
]) {
  assert.ok(!startup.includes(legacy), `startup must not load legacy destination subsystem: ${legacy}`);
}
assert.match(startup, /startDestinationAutomationWorker\(\)/);

const fresh = fs.readFileSync("destination-automation.js", "utf8");
assert.match(fresh, /fresh destination importer enabled/);
assert.match(fresh, /folders\.EditPeerFolders/);
assert.match(fresh, /account\.UpdateNotifySettings/);
assert.match(fresh, /getForumTopics/);

console.log("Fresh destination importer rewrite checks passed");
