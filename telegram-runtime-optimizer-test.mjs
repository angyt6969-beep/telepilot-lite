import assert from "node:assert/strict";
import { installTelegramRuntimeOptimizer } from "./telegram-runtime-optimizer.js";

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

let getMeCalls = 0;
let dialogCalls = 0;
let dialogActive = 0;
let dialogMaxActive = 0;
let connectCalls = 0;
let connectActive = 0;
let connectMaxActive = 0;

class FakeTelegramClient {
  constructor(sessionValue) {
    this.session = { save: () => sessionValue };
  }

  async getMe() {
    getMeCalls++;
    return { id: 123, username: "telepilot_test" };
  }

  async getDialogs() {
    dialogCalls++;
    dialogActive++;
    dialogMaxActive = Math.max(dialogMaxActive, dialogActive);
    const call = dialogCalls;
    await sleep(15);
    dialogActive--;
    return [`dialogs-${call}`];
  }

  async connect() {
    connectCalls++;
    connectActive++;
    connectMaxActive = Math.max(connectMaxActive, connectActive);
    await sleep(15);
    connectActive--;
    return true;
  }
}

const installed = installTelegramRuntimeOptimizer(FakeTelegramClient, {
  getMeTtlMs: 60_000,
  dialogMinGapMs: 0,
  connectMinGapMs: 0,
});
assert.equal(installed.enabled, true);

const first = new FakeTelegramClient("same-session");
const second = new FakeTelegramClient("same-session");

const [me1, me2] = await Promise.all([first.getMe(), second.getMe()]);
assert.equal(getMeCalls, 1, "getMe should be shared for the same saved session inside the TTL");
assert.deepEqual(me1, me2);

const [dialogs1, dialogs2] = await Promise.all([first.getDialogs(), second.getDialogs()]);
assert.equal(dialogCalls, 2, "dialog results must stay fresh and must not be cached");
assert.equal(dialogMaxActive, 1, "same-account dialog scans must be serialized");
assert.notDeepEqual(dialogs1, dialogs2, "each dialog request should keep its own fresh result");

await Promise.all([first.connect(), second.connect()]);
assert.equal(connectCalls, 2, "each client still needs its own actual connection");
assert.equal(connectMaxActive, 1, "same-account connection handshakes must be serialized");

const third = new FakeTelegramClient("different-session");
await Promise.all([first.getDialogs(), third.getDialogs()]);
assert.ok(dialogMaxActive >= 2, "different accounts should remain independent and may scan concurrently");

console.log("TelePilot Telegram runtime optimizer regression checks passed");
