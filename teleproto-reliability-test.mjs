import fs from "node:fs";
import assert from "node:assert/strict";
import { floodWaitSeconds, retryDelayMs, isRetryable } from "./posting-engine-enhancements.js";

const app = fs.readFileSync("app.js", "utf8");
const pro = fs.readFileSync("pro-controls.js", "utf8");
const worker = fs.readFileSync("v1-worker.js", "utf8");

assert.equal(floodWaitSeconds({ errorMessage: "FLOOD_WAIT_300" }), 300);
assert.equal(retryDelayMs({ errorMessage: "FLOOD_WAIT_300" }), 301000);
assert.equal(floodWaitSeconds({ seconds: 75 }), 75);
assert.equal(isRetryable({ errorMessage: "FLOOD_WAIT_300" }), true);
assert.equal(isRetryable({ message: "ECONNRESET" }), true);

// Mobile/in-app-browser login handoff and restart-safe pending-login state.
assert.ok(app.includes("location: `/connect#${encodeURIComponent(browserToken)}`"));
assert.ok(app.includes("getAttemptByBrowserToken(fallbackToken)"));
assert.ok(app.includes("history.replaceState"));
assert.match(app, /loadPersistedLogins/);
assert.match(app, /persistLoginAttempt/);
assert.match(app, /removePersistedLogin/);
assert.match(app, /login_finalize_failed/);

// Multi-account clients are explicitly owned; no single-account fatal-state heuristic remains.
assert.match(app, /__telepilotOwnerUid/);
assert.match(app, /__telepilotAccountId/);
assert.match(app, /listAccounts/);
assert.match(app, /isFatalSessionError/);
assert.doesNotMatch(app, /personalRestoreFatal/);

// The old first-500-dialog ceiling must not survive in any posting path.
for (const [name, source] of [["app.js", app], ["pro-controls.js", pro], ["v1-worker.js", worker]]) {
  assert.ok(!source.includes("getDialogs({ limit: 500 })"), `${name} still contains the 500-dialog ceiling`);
}

console.log("TelePilot MTProto/login reliability regression checks passed");
