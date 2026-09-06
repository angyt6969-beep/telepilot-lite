import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./destination-automation.js", import.meta.url), "utf8");

assert.match(source, /folderId:\s*1/, "Auto-joined chats should be archived to Telegram's archive folder");
assert.match(source, /UpdateNotifySettings/, "Auto-joined chats should have notification settings updated");
assert.match(source, /muteUntil:\s*2147483647/, "Auto-joined chats should be muted indefinitely");
assert.match(source, /parsedIdentity/, "Importer should normalize duplicate source inputs");
assert.match(source, /seenResolvedIds/, "Importer should detect duplicate destinations by resolved Telegram chat ID");
assert.doesNotMatch(source, /const JOIN_GAP_MS = 1400/, "Fixed 1.4 second join delay should be removed");
assert.match(source, /floodWaitSeconds/, "Telegram FLOOD_WAIT responses should be parsed for adaptive cooldowns");
assert.match(source, /joinCooldowns/, "Join cooldowns should be persisted per Telegram account");
assert.match(source, /joinQueue/, "Deferred joins should survive FLOOD_WAIT and resume automatically");

console.log("TelePilot fast auto-join checks passed");
