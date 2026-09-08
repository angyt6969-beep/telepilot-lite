import assert from "node:assert/strict";
import {
  importResultScreen,
  parseImportLines,
  postingBlockReason,
  __test,
} from "./destination-import-result-v3.js";

assert.match(postingBlockReason({ broadcast: true, megagroup: false }), /Read-only channel/i);
assert.match(postingBlockReason({ gigagroup: true, creator: false, adminRights: null }), /only admins/i);
assert.match(postingBlockReason({ defaultBannedRights: { sendMessages: true }, creator: false, adminRights: null }), /normal members cannot send messages/i);
assert.match(postingBlockReason({ defaultBannedRights: { sendPlain: true }, creator: false, adminRights: null }), /normal members cannot send messages/i);
assert.equal(postingBlockReason({ defaultBannedRights: { sendMessages: true }, creator: true }), "", "group creator must not be discarded by normal-member restrictions");
assert.equal(postingBlockReason({ defaultBannedRights: { sendMessages: true }, adminRights: { postMessages: true } }), "", "admins must not be discarded by normal-member restrictions");
assert.equal(postingBlockReason({ megagroup: true, defaultBannedRights: { sendMessages: false, sendPlain: false } }), "");

const parsed = parseImportLines([
  "@writeablegroup",
  "@writeablegroup",
  "https://t.me/addlist/Folder_123",
  "https://t.me/addlist/Folder_123",
  "not-a-telegram-source",
].join("\n"));
assert.equal(parsed.sources.length, 2);
assert.equal(parsed.duplicates.length, 2);
assert.equal(parsed.invalid.length, 1);
assert.equal(parsed.duplicates[0].source, "@writeablegroup");

const chats = [
  { id: 101n, accessHash: 1001n, username: "writable101", megagroup: true, defaultBannedRights: { sendMessages: false } },
  { id: 202n, accessHash: 2002n, username: "readonly202", megagroup: true, defaultBannedRights: { sendMessages: true } },
  { id: 303n, accessHash: 3003n, username: "admin303", megagroup: true, defaultBannedRights: { sendMessages: true }, adminRights: { postMessages: true } },
];
const peers = [{ channelId: 101n }, { channelId: 202n }, { channelId: 303n }];
const filtered = __test.filterAddlistPeers(chats, peers);
assert.equal(filtered.allowedPeers.length, 2, "writable and admin-postable Addlist chats should remain in the native bulk import");
assert.equal(filtered.discarded.length, 1, "read-only Addlist chats should be removed before Telegram bulk import");
assert.equal(filtered.discarded[0].label, "@readonly202");

const result = importResultScreen({
  postReview: {
    accessible: [
      { id: "-1001", username: "@newgroup", forum: false },
      { id: "-1002", username: "@oldgroup", forum: false },
      { id: "-1003", username: "@forumgroup", forum: true },
    ],
    notJoined: [], invalid: [], unavailable: [],
  },
  saved: { added: 2, existing: 1, topics: 1 },
  cleanup: { pending: 2 },
  newNames: ["@newgroup", "@forumgroup"],
  existingNames: ["@oldgroup"],
  outcomes: [
    { source: "@newgroup", status: "already", reason: "Already joined." },
    { source: "@oldgroup", status: "already", reason: "Already joined." },
    { source: "@dupe", status: "duplicate", reason: "Duplicate skipped." },
    { source: "@readonly", status: "discarded", reason: "Read-only group — normal members cannot send messages. Discarded without joining." },
  ],
});
assert.equal(result.parse_mode, "HTML");
assert.match(result.text, /<b><i>Import complete<\/i><\/b>/);
assert.match(result.text, /Already joined:<\/b> — 2/);
assert.match(result.text, /Already added:<\/b> — 1/);
assert.match(result.text, /Duplicates skipped:<\/b> — 1/);
assert.match(result.text, /Discarded:<\/b> — 1/);
assert.match(result.text, /@newgroup<\/b> — Already joined — added to TelePilot/);
assert.match(result.text, /@oldgroup<\/b> — Already added to TelePilot/);
assert.match(result.text, /@readonly<\/b> — Read-only group/);
assert.match(result.text, /@forumgroup<\/b> — Added — topic required/);
assert.match(result.text, /Read-only destinations were discarded before joining/);

console.log("TelePilot destination result/read-only v3 regression test passed");
