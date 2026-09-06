import fs from "node:fs";
import assert from "node:assert/strict";
import { floodWaitSeconds, retryDelayMs, isRetryable } from "./posting-engine-enhancements.js";

const app = fs.readFileSync("app.js", "utf8");

assert.equal(floodWaitSeconds({ errorMessage: "FLOOD_WAIT_300" }), 300);
assert.equal(retryDelayMs({ errorMessage: "FLOOD_WAIT_300" }), 301000);
assert.equal(floodWaitSeconds({ seconds: 75 }), 75);
assert.equal(isRetryable({ errorMessage: "FLOOD_WAIT_300" }), true);
assert.equal(isRetryable({ message: "ECONNRESET" }), true);

assert.ok(app.includes("location: `/connect#${encodeURIComponent(browserToken)}`"));
assert.ok(app.includes("getAttemptByBrowserToken(fallbackToken)"));
assert.ok(app.includes("history.replaceState"));
assert.ok(!app.includes("client.getDialogs({ limit: 500 })"));
assert.match(app, /personalRestoreFatal/);
assert.match(app, /will retry automatically/);
assert.match(app, /__telepilotOwnerUid/);
assert.match(app, /login_finalize_failed/);

console.log("TelePilot MTProto/login reliability regression checks passed");
