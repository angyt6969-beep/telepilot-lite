import assert from "node:assert/strict";
import { installTelegramJoinPacing, requiredJoinDelay, __test } from "./telegram-join-pacing.js";

assert.equal(requiredJoinDelay(0, 1000, 2000), 0);
assert.equal(requiredJoinDelay(1000, 1500, 2000), 1500);
assert.equal(requiredJoinDelay(1000, 3000, 2000), 0);
assert.equal(__test.DEFAULT_MIN_GAP_MS, 2000);

// Test double: minimal TelegramClient-like class so pacing can be verified
// without making any Telegram network calls.
let clock = 1000;
const sleeps = [];
const calls = [];
class FakeTelegramClient {
  async joinChannel(value) { calls.push(["join", value, clock]); return value; }
  async importChatInvite(value) { calls.push(["invite", value, clock]); return value; }
}
installTelegramJoinPacing(FakeTelegramClient, {
  minGapMs: 2000,
  now: () => clock,
  sleep: async ms => { sleeps.push(ms); clock += ms; },
});
const client = new FakeTelegramClient();
await client.joinChannel("@one");
clock += 500;
await client.joinChannel("@two");
clock += 250;
await client.importChatInvite("abc");
assert.deepEqual(sleeps, [1500, 1750]);
assert.deepEqual(calls.map(row => row[2]), [1000, 3000, 5000]);

console.log("TelePilot Telegram join pacing regression test passed");
