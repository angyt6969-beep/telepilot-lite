import assert from "node:assert/strict";
import fs from "node:fs";

process.env.TELEPILOT_SECURITY_SECRET ||= "core-audit-security-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
process.env.TELEPILOT_SESSION_KEY_B64 ||= Buffer.alloc(32, 17).toString("base64");

const worker = await import(`./v1-worker.js?audit=${Date.now()}`);
const { exactCycleComplete, applyOneTimeOutcome } = worker.__test;

assert.equal(exactCycleComplete({ failed: 0, skipped: 0 }), true);
assert.equal(exactCycleComplete({ failed: 0, skipped: 1 }), false, "an exact run with skipped deliveries must remain retryable");
assert.equal(exactCycleComplete({ failed: 1, skipped: 0 }), false);

const waiting = { status: "pending" };
applyOneTimeOutcome(waiting, { attempts: 2, delivered: ["already"] }, { failed: 0, skipped: 1, delivered: ["new"], errors: [] }, 1_000);
assert.equal(waiting.status, "pending");
assert.equal(waiting.attempts, 2, "a skip must not consume a hard retry attempt");
assert.equal(waiting.nextAttemptAt, 61_000);
assert.deepEqual(waiting.delivered, ["already", "new"]);

const failed = { status: "pending" };
applyOneTimeOutcome(failed, { attempts: 2, delivered: [] }, { failed: 1, skipped: 0, delivered: [], errors: ["boom"] }, 2_000);
assert.equal(failed.status, "failed");
assert.equal(failed.attempts, 3);

const done = { status: "pending" };
applyOneTimeOutcome(done, { attempts: 1, delivered: ["old"] }, { failed: 0, skipped: 0, delivered: ["last"], errors: [] }, 3_000);
assert.equal(done.status, "done");
assert.deepEqual(done.delivered, []);

const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
assert.match(app, /accessHash: String\(item\.accessHash \|\| ""\)\.slice\(0, 100\)/, "app state must preserve Telegram access hashes");
const resolverStart = app.indexOf("async function resolvePersonalTarget");
const resolverEnd = app.indexOf("function isFatalPersonalSessionError", resolverStart);
const resolver = app.slice(resolverStart, resolverEnd);
assert.ok(resolver.indexOf("new Api.InputPeerChannel") >= 0);
assert.ok(resolver.indexOf("new Api.InputPeerChannel") < resolver.indexOf("destination?.username"), "live posting must prefer the saved peer before username fallback");
assert.match(app, /for \(const accountId of ids\) \{\n\s*if \(!state\.posting \|\| !hasAccess\(state\)\) break;/, "Stop/Pause must interrupt multi-account delivery before the next sender");
assert.match(app, /target\.intervalSeconds = 30 \* 60;\n\s*target\.intervalMinutes = 30;/, "admin reset must reset the scheduler's real interval field");

const workerSource = fs.readFileSync(new URL("./v1-worker.js", import.meta.url), "utf8");
const targetStart = workerSource.indexOf("async function personalTarget");
const targetEnd = workerSource.indexOf("function isPartialDeliveryError", targetStart);
const targetResolver = workerSource.slice(targetStart, targetEnd);
assert.ok(targetResolver.indexOf("savedInputPeer(destination)") < targetResolver.indexOf("destination?.username"), "scheduled posting must prefer the saved Telegram peer");

console.log("TelePilot core audit regression checks passed");
