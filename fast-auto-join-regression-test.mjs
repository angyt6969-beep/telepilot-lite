import assert from "node:assert/strict";
import fs from "node:fs";
import { Api } from "teleproto";

const source = fs.readFileSync(new URL("./destination-automation.js", import.meta.url), "utf8");

assert.match(source, /const TELEGRAM_ARCHIVE_FOLDER_ID = 1;/, "Telegram archive folder ID should be explicit");
assert.match(source, /folderId:\s*TELEGRAM_ARCHIVE_FOLDER_ID/, "Auto-joined chats should be moved to Telegram's archive folder");
assert.match(source, /UpdateNotifySettings/, "Auto-joined chats should have notification settings updated");
assert.match(source, /const MUTE_FOREVER_UNIX = 2147483647;/, "Permanent mute cutoff should be explicit");
assert.match(source, /muteUntil:\s*MUTE_FOREVER_UNIX/, "Auto-joined chats should be muted indefinitely");
assert.match(source, /parsedIdentity/, "Importer should normalize duplicate source inputs");
assert.match(source, /seenResolvedIds/, "Importer should detect duplicate destinations by resolved Telegram chat ID");
assert.doesNotMatch(source, /const JOIN_GAP_MS = 1400/, "Fixed 1.4 second join delay should be removed");
assert.match(source, /floodWaitSeconds/, "Telegram FLOOD_WAIT responses should be parsed for adaptive cooldowns");
assert.match(source, /joinCooldowns/, "Join cooldowns should be persisted per Telegram account");
assert.match(source, /joinQueue/, "Deferred joins should survive FLOOD_WAIT and resume automatically");

const peer = new Api.InputPeerSelf();
const archiveRequest = new Api.folders.EditPeerFolders({
  folderPeers: [new Api.InputFolderPeer({ peer, folderId: 1 })],
});
assert.equal(archiveRequest.className, "folders.EditPeerFolders");

const muteRequest = new Api.account.UpdateNotifySettings({
  peer: new Api.InputNotifyPeer({ peer }),
  settings: new Api.InputPeerNotifySettings({ silent: true, muteUntil: 2147483647 }),
});
assert.equal(muteRequest.className, "account.UpdateNotifySettings");

console.log("TelePilot fast auto-join checks passed");
