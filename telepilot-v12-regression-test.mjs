import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-v12-"));
process.env.DATA_DIR = temp;
process.env.TELEPILOT_SECURITY_SECRET ||= "v12-regression-security-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
process.env.TELEPILOT_SESSION_KEY_B64 ||= Buffer.alloc(32, 9).toString("base64");

const {
  parseDestinationInput,
  suggestTopic,
  destinationAccountReady,
  queueRoutingSync,
  processRoutingQueue,
} = await import("./destination-automation.js");

assert.deepEqual(parseDestinationInput("https://t.me/addlist/LBw-ofcpUfhjN2Uy")?.kind, "addlist");
assert.equal(parseDestinationInput("https://t.me/addlist/LBw-ofcpUfhjN2Uy")?.slug, "LBw-ofcpUfhjN2Uy");
assert.equal(parseDestinationInput("https://t.me/+AbCd_123")?.kind, "invite");
assert.equal(parseDestinationInput("https://t.me/joinchat/AbCd_123")?.kind, "invite");
assert.equal(parseDestinationInput("@telepilot_test")?.kind, "public");
assert.equal(parseDestinationInput("https://t.me/telepilot_test")?.username, "telepilot_test");
assert.equal(parseDestinationInput("not a telegram destination"), null);

const suggested = suggestTopic([
  { id: 1, title: "General" },
  { id: 2, title: "Rules" },
  { id: 9, title: "Advertising" },
  { id: 10, title: "Support" },
]);
assert.equal(suggested?.id, 9);
assert.equal(suggestTopic([{ id: 2, title: "Rules" }, { id: 3, title: "Support" }]), null);

assert.equal(destinationAccountReady({ id: "-1001" }, "a"), true, "legacy destinations stay compatible");
assert.equal(destinationAccountReady({ id: "-1001", topicRequired: true, topicId: null, joinStatus: "needs_topic" }, "a"), false);
assert.equal(destinationAccountReady({ id: "-1001", topicRequired: true, topicId: 1, accountJoin: { a: { status: "ready" } } }, "a"), true);
assert.equal(destinationAccountReady({ id: "-1001", accountJoin: { a: { status: "pending" } } }, "a"), false);
assert.equal(destinationAccountReady({ id: "-1001", accountJoin: { a: { status: "verification" } } }, "a"), false);
assert.equal(typeof queueRoutingSync, "function");
assert.equal(typeof processRoutingQueue, "function");

const app = fs.readFileSync("app.js", "utf8");
const startup = fs.readFileSync("startup.js", "utf8");
const worker = fs.readFileSync("v1-worker.js", "utf8");
const onboarding = fs.readFileSync("onboarding.js", "utf8");
const ux = fs.readFileSync("ux-v12.js", "utf8");

for (const marker of ["parseDestinationInput", "handleDestinationText", "destinationAccountReady"]) {
  assert.ok(app.includes(marker), `app.js missing ${marker}`);
}
assert.ok(app.includes("message_thread_id"), "Bot API forum-topic routing missing in interval sender");
assert.ok(app.includes("InputReplyToMessage"), "personal MTProto forum-topic routing missing in interval sender");
assert.ok(worker.includes("message_thread_id"), "Bot API forum-topic routing missing in scheduled worker");
assert.ok(worker.includes("InputReplyToMessage"), "personal MTProto forum-topic routing missing in scheduled worker");
assert.ok(worker.includes("destinationAccountReady"), "scheduled worker must respect per-account destination readiness");
assert.ok(!app.includes('text("▶️ Confirm start", "start_confirm")'), "normal Start still requires a second confirmation");
assert.ok(app.includes("topicId") && app.includes("accountJoin"), "destination v1.2 fields are not preserved");
assert.ok(startup.includes("installUxNavigation") && startup.includes("installDestinationAutomation"), "v1.2 bot modules not installed");
assert.ok(startup.includes("startDestinationAutomationWorker"), "destination approval worker not started");
for (const label of ["▶ Start", "⏹ Stop", "⌂ Home", "🧩 Posting Setup", "👤 Accounts", "📍 Destinations", "⚙️ Settings"]) {
  assert.ok(ux.includes(label), `new home layout missing ${label}`);
}
assert.ok(onboarding.includes("Addlist") || onboarding.includes("addlist"), "tutorial does not explain Addlist destination setup");
assert.ok(onboarding.includes("Posting Setup"), "tutorial does not use the simplified Posting Setup navigation");

console.log("TelePilot v1.2 regression checks passed");

assert.ok(app.includes("readyDestinationCount"), "Home/start readiness must use ready destinations, not just saved destinations");
assert.ok(app.includes("scheduleRoutingSync"), "sender routing changes must queue destination membership preparation");
assert.ok(ux.includes("private t.me/+ invites") && ux.includes("t.me/addlist/..."), "normalized Add Destination screen lost v1.2 import guidance");
assert.ok(onboarding.includes("needsTopic") && onboarding.includes("Choose Topics"), "tutorial must wait for forum-topic selection");
