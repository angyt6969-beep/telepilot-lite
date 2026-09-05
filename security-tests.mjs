import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-security-"));
process.env.DATA_DIR = temp;
process.env.TELEPILOT_SECURITY_SECRET = "ci-security-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
process.env.TELEPILOT_SESSION_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

const security = await import("./security-core.js");

const sampleKey = "TP-ABCDE-FGHJK-MNPQR-STUVW";
const legacy = security.legacyLicenseHash(sampleKey);
const secure = security.secureLicenseHash(sampleKey);
assert.match(legacy, /^[a-f0-9]{64}$/);
assert.match(secure, /^[a-f0-9]{64}$/);
assert.notEqual(legacy, secure, "key pepper must change the persisted hash");
assert.equal(security.licenseRecordMatches({ hashVersion: 1, hash: legacy }, sampleKey), true);
assert.equal(security.licenseRecordMatches({ hashVersion: 2, hash: secure }, sampleKey), true);
assert.equal(security.licenseRecordMatches({ hashVersion: 2, hash: secure }, "TP-AAAAA-AAAAA-AAAAA-AAAAA"), false);

const r1 = security.takeRateLimit("test", "user", 2, 60_000);
const r2 = security.takeRateLimit("test", "user", 2, 60_000);
const r3 = security.takeRateLimit("test", "user", 2, 60_000);
assert.equal(r1.ok, true);
assert.equal(r2.ok, true);
assert.equal(r3.ok, false);
security.resetRateLimit("test", "user");
assert.equal(security.takeRateLimit("test", "user", 2, 60_000).ok, true);

const payload = { kind: "TelePilotConfig", version: 2, ownerUid: "123", data: { a: 1, b: [2, 3] } };
const sig = security.signBackupPayload(payload);
assert.equal(security.verifyBackupSignature(payload, sig), true);
assert.equal(security.verifyBackupSignature({ ...payload, ownerUid: "999" }, sig), false, "tampered backups must fail signature validation");

security.assertSafeObject(JSON.parse('{"safe":{"value":1}}'));
assert.throws(() => security.assertSafeObject(JSON.parse('{"__proto__":{"admin":true}}')), /Unsafe configuration field/);

assert.equal(security.isSecurityLockdown(), false);
security.setSecurityLockdown(true, "1");
assert.equal(security.isSecurityLockdown(), true);
security.setSecurityLockdown(false, "1");
assert.equal(security.isSecurityLockdown(), false);
assert.equal(security.isUserFrozen("77"), false);
security.setUserFrozen("77", true, "1");
assert.equal(security.isUserFrozen("77"), true);
security.setUserFrozen("77", false, "1");
assert.equal(security.isUserFrozen("77"), false);

const token = security.issueConfirmationToken("1", "import", "1", 60_000);
assert.equal(security.consumeConfirmationToken(token, "1", "import", "1"), true);
assert.equal(security.consumeConfirmationToken(token, "1", "import", "1"), false, "confirmation must be one-time");

assert.equal(security.getExternalSessionKey()?.length, 32);
const redacted = security.redactSecrets('token=abc123 TP-ABCDE-FGHJK-MNPQR-STUVW +37120000000 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi');
assert.equal(redacted.includes("abc123"), false);
assert.equal(redacted.includes("TP-ABCDE"), false);
assert.equal(redacted.includes("+37120000000"), false);

const events = security.readSecurityEvents(20);
assert.ok(events.some(event => event.type === "user_frozen"));
assert.ok(events.some(event => event.type === "lockdown_enabled"));

console.log("TelePilot security regression tests passed");
