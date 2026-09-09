import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-deep-audit-regression-"));
process.env.DATA_DIR = root;
process.env.TELEPILOT_SECURITY_SECRET = "deep-audit-regression-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
process.env.TELEPILOT_SESSION_KEY_B64 = Buffer.alloc(32, 23).toString("base64");
delete process.env.TELEPILOT_ADMIN_ID;
delete process.env.OWNER_ID;

const settingsMod = await import(`./posting-engine-enhancements.js?deep-audit=${Date.now()}`);
const engine = await import(`./v1-engine.js?deep-audit=${Date.now()}`);
const worker = await import(`./v1-worker.js?deep-audit=${Date.now()}`);
const security = await import(`./security-core.js?deep-audit=${Date.now()}`);

const { readAppSettings, writeAppSettings } = settingsMod;
const { readV1, writeV1, v1Stats } = engine;
const { sendCycle, scheduledBlockReason } = worker.__test;

// "Today" must mean the user's local calendar day, not a rolling 24-hour window.
const statsUid = "1001";
const statsNow = Date.parse("2026-09-09T00:30:00.000Z");
writeV1(statsUid, {
  schedule: { utcOffsetMinutes: 180 },
  history: [
    { ts: Date.parse("2026-09-08T22:30:00.000Z"), status: "sent" }, // Sep 9 01:30 local
    { ts: Date.parse("2026-09-08T20:30:00.000Z"), status: "failed" }, // Sep 8 23:30 local
    { ts: Date.parse("2026-09-09T00:10:00.000Z"), status: "skipped" },
  ],
});
const calendarStats = v1Stats(statsUid, statsNow);
assert.deepEqual(calendarStats.today, { sent: 1, failed: 0, skipped: 1 });
assert.equal(calendarStats.week.failed, 1, "7-day view remains a rolling seven-day window");

const uid = "2002";
const baseSettings = {
  version: 5,
  adMessage: "Audit test post",
  adEntities: [],
  groups: [
    { id: "-100101", label: "One", type: "supergroup", topicRequired: false, accountJoin: {} },
    { id: "-100102", label: "Two", type: "supergroup", topicRequired: false, accountJoin: {} },
  ],
  accessLifetime: false,
  accessRevoked: false,
  accessUntil: Date.now() + 86_400_000,
  senderMode: "bot",
  selectedAccountIds: [],
};
writeAppSettings(uid, baseSettings);
writeV1(uid, { paused: false });

// Missing scheduled configuration must remain retryable instead of being consumed as success.
const missing = await sendCycle(uid, { ...baseSettings, adMessage: "" }, { api: { sendMessage: async () => ({ message_id: 1 }) } }, { cycleId: "audit:missing" });
assert.equal(missing.sent, 0);
assert.equal(missing.failed, 0);
assert.ok(missing.skipped > 0, "missing message/destination must be represented as a skip");
assert.match(missing.errors.join(" "), /missing message or destination/i);

// A scheduled run must stop immediately if access is revoked between deliveries.
let accessSends = 0;
const accessBot = { api: { sendMessage: async () => {
  accessSends += 1;
  if (accessSends === 1) {
    const latest = readAppSettings(uid);
    writeAppSettings(uid, { ...latest, accessRevoked: true });
  }
  return { message_id: accessSends };
} } };
const accessResult = await sendCycle(uid, readAppSettings(uid), accessBot, { cycleId: "audit:access" });
assert.equal(accessSends, 1, "revoking access mid-cycle must prevent the next Telegram send");
assert.equal(accessResult.sent, 1);
assert.ok(accessResult.skipped >= 1);
assert.match(accessResult.errors.join(" "), /access/i);

// Restore access, then verify a pause toggled between deliveries also stops the cycle.
writeAppSettings(uid, { ...readAppSettings(uid), accessRevoked: false, accessUntil: Date.now() + 86_400_000 });
writeV1(uid, { ...readV1(uid), paused: false });
let pauseSends = 0;
const pauseBot = { api: { sendMessage: async () => {
  pauseSends += 1;
  if (pauseSends === 1) writeV1(uid, { ...readV1(uid), paused: true });
  return { message_id: pauseSends };
} } };
const pauseResult = await sendCycle(uid, readAppSettings(uid), pauseBot, { cycleId: "audit:pause" });
assert.equal(pauseSends, 1, "pausing mid-cycle must prevent the next Telegram send");
assert.equal(pauseResult.sent, 1);
assert.ok(pauseResult.skipped >= 1);
assert.match(pauseResult.errors.join(" "), /paused/i);
assert.equal(scheduledBlockReason(uid), "Posting is paused.");

// Railway provides the real client address in X-Real-IP. Do not let an XFF value override it.
assert.equal(security.requestAddress({
  headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9, 10.0.0.2" },
  socket: { remoteAddress: "10.0.0.3" },
}), "203.0.113.7");
assert.equal(security.requestAddress({
  headers: { "x-real-ip": "not-an-ip", "x-forwarded-for": "198.51.100.9" },
  socket: { remoteAddress: "::ffff:192.0.2.44" },
}), "192.0.2.44");
assert.equal(security.requestAddress({ headers: { "x-forwarded-for": "198.51.100.9, invalid" }, socket: {} }), "198.51.100.9");
assert.equal(security.requestAddress({ headers: {}, socket: {} }), "unknown");

console.log("TelePilot deep audit scheduler/security regressions passed");
