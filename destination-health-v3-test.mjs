import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-destination-health-v3-"));
process.env.DATA_DIR = root;

const uid = "42";
const userDir = path.join(root, "users", uid);
fs.mkdirSync(userDir, { recursive: true });

const groups = [];
for (let i = 0; i < 38; i++) groups.push({ id: `-1001${String(i).padStart(3, "0")}`, label: `Ready ${i}`, accountJoin: { acc1: { status: "ready" } } });
for (let i = 0; i < 2; i++) groups.push({ id: `-1002${String(i).padStart(3, "0")}`, label: `Forum ${i}`, topicRequired: true, topicId: null, accountJoin: { acc1: { status: "ready" } } });
for (let i = 0; i < 40; i++) groups.push({ id: `-1003${String(i).padStart(3, "0")}`, label: `Not member ${i}`, accountJoin: { acc1: { status: "not_member", reason: "Join this group in Telegram first." } } });
for (let i = 0; i < 9; i++) groups.push({ id: `-1004${String(i).padStart(3, "0")}`, label: `Issue ${i}`, accountJoin: { acc1: { status: "read_only", reason: "Selected sender cannot post there." } } });

fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ version: 5, groups }, null, 2));

const mod = await import(`./destination-health-v3.js?test=${Date.now()}`);

const summary = mod.destinationHealthSummary(uid);
assert.equal(summary.counts.total, 89);
assert.equal(summary.counts.ready, 38);
assert.equal(summary.counts.topic, 2);
assert.equal(summary.counts.not_member, 40);
assert.equal(summary.counts.issue, 9);
assert.equal(summary.counts.attention, 51);

const issues = mod.destinationIssuesScreen(uid, 0);
assert.match(issues.text, /Needs attention\s+51 \/ 89/);
assert.match(issues.text, /Choose topic\s+2/);
assert.match(issues.text, /Join in Telegram\s+40/);
assert.match(issues.text, /Other issues\s+9/);
assert.equal(issues.rows.some(row => row.some(button => button.callback_data === "d2_refresh")), true);

const baseHub = {
  text: [
    "🗂 Destination Hub",
    "",
    "Saved  89",
    "Ready  38",
    "Choose topic  2",
    "Join in Telegram  40",
    "TelePilot only uses chats you already have access to.",
  ].join("\n"),
  rows: [[{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13" }]],
};
const enhanced = mod.__test.enhancedHub(uid, baseHub);
assert.match(enhanced.text, /Other issues\s+9/);
assert.match(enhanced.text, /Needs attention\s+51/);
assert.equal(enhanced.rows.some(row => row.some(button => button.callback_data === "d5_issues:0")), true);

const dashboardPayload = mod.__test.transformDashboardPayload({
  chat_id: 42,
  text: "✈️ TelePilot\n❗ 51 items need attention\nReady to start in one tap.",
  reply_markup: { inline_keyboard: [[{ text: "⚙ Settings", callback_data: "v1_settings_v13" }]] },
});
assert.match(dashboardPayload.text, /51 destinations need attention — tap Review Issues/);
assert.equal(dashboardPayload.reply_markup.inline_keyboard.some(row => row.some(button => button.callback_data === "d5_issues:0")), true);

class FakeBot {
  constructor() {
    this.handlers = [];
    this.transforms = [];
    this.api = { config: { use: fn => this.transforms.push(fn) } };
  }
  callbackQuery(pattern, handler) { this.handlers.push({ pattern, handler }); return this; }
  start() { return "started"; }
}

assert.equal(mod.installDestinationHealthV3(FakeBot, () => baseHub), true);
const fake = new FakeBot();
assert.equal(fake.start(), "started");
assert.equal(fake.transforms.length, 1, "dashboard transformer must install on the real bot API instance at start time");
assert.equal(fake.handlers.some(row => String(row.pattern).includes("d5_issues")), true);
assert.equal(fake.handlers.some(row => row.pattern === "v1_destinations_v13"), true);

console.log("TelePilot destination health v3 regression checks passed");
