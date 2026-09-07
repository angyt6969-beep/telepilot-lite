import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-delete-all-"));
process.env.DATA_DIR = temp;

const source = fs.readFileSync(new URL("./destination-delete-all-v1.js", import.meta.url), "utf8");
const startup = fs.readFileSync(new URL("./startup.js", import.meta.url), "utf8");
const module = await import(`./destination-delete-all-v1.js?test=${Date.now()}`);

assert.match(source, /d4_delete_all_confirm/);
assert.match(source, /d4_delete_all_execute/);
assert.match(source, /Delete all destinations/);
assert.match(source, /Saved destinations: \$\{total\}/);
assert.match(source, /Telegram changes: none/);
assert.match(source, /—/u, "Delete-all copy should use an em dash");
assert.match(source, /type: "bold"/);
assert.match(source, /type: "italic"/);
assert.match(source, /inline\("Previous"/);
assert.match(source, /inline\("Next"/);
assert.match(source, /destination-join-v1\.json/);
assert.match(source, /destination-preparation-v1\.json/);
assert.doesNotMatch(source, /TelegramClient|from "teleproto"|\.joinChannel\(|UpdateNotifySettings|EditPeerFolders/, "Delete-all must not mutate Telegram");
assert.match(startup, /installDestinationDeleteAll/);

const rich = module.__test.buildRich([
  "🗑 ",
  { text: "Delete all", type: "bold" },
  " — ",
  { text: "carefully", type: "italic" },
]);
assert.equal(rich.text, "🗑 Delete all — carefully");
assert.deepEqual(rich.entities, [
  { type: "bold", offset: 3, length: 10 },
  { type: "italic", offset: 16, length: 9 },
]);

const uid = "42";
const userDir = path.join(temp, "users", uid);
fs.mkdirSync(userDir, { recursive: true });
const joinFile = path.join(userDir, "destination-join-v1.json");
const cleanupFile = path.join(userDir, "destination-preparation-v1.json");
fs.writeFileSync(joinFile, JSON.stringify({
  tasks: {
    a: { status: "pending" },
    b: { status: "done" },
    c: { status: "request_pending" },
  },
}));
fs.writeFileSync(cleanupFile, JSON.stringify({
  tasks: {
    a: { mute: { status: "pending" }, archive: { status: "pending" } },
    b: { mute: { status: "done" }, archive: { status: "pending" } },
    c: { mute: { status: "done" }, archive: { status: "done" } },
  },
}));

const cleared = module.__test.clearAutomationFiles(uid);
assert.deepEqual(cleared, {
  pendingJoins: 2,
  pendingCleanup: 2,
  joinRecords: 3,
  cleanupRecords: 3,
});
assert.equal(fs.existsSync(joinFile), false);
assert.equal(fs.existsSync(cleanupFile), false);

class FakeBot {
  constructor() { this.handlers = []; }
  callbackQuery(pattern, handler) { this.handlers.push({ pattern, handler }); return this; }
  start() { return "started"; }
}
module.installDestinationDeleteAll(FakeBot);
const bot = new FakeBot();
assert.equal(bot.start(), "started");
assert.ok(bot.handlers.length >= 3);
assert.match(String(bot.handlers[0].pattern), /d2_manage/, "Enhanced manage handler must register before the legacy renderer");

console.log("TelePilot destination delete-all regression checks passed");
