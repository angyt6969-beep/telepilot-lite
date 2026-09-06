import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-v11-"));
process.env.DATA_DIR = tempDir;
process.env.TELEPILOT_SECURITY_SECRET = "test-only-v11-security-secret-012345678901234567890";
process.env.TELEPILOT_SESSION_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

const accounts = await import(`./account-store.js?v11=${Date.now()}`);
const loginStore = await import(`./login-attempt-store.js?v11=${Date.now()}`);

const uid = "900000001";
const first = accounts.saveAccountSession(uid, { id: 101, username: "alpha_sender", firstName: "Alpha" }, "session-alpha");
const second = accounts.saveAccountSession(uid, { id: 202, username: "beta_sender", firstName: "Beta" }, "session-beta");

assert.notEqual(first.id, second.id);
assert.equal(accounts.countAccounts(uid), 2);
assert.equal(accounts.loadAccountSession(uid, first.id), "session-alpha");
assert.equal(accounts.loadAccountSession(uid, second.id), "session-beta");

let listed = accounts.listAccounts(uid);
assert.equal(listed.length, 2);
assert.deepEqual(
  accounts.effectiveAccountIds({ senderMode: "all", selectedAccountIds: [] }, null, listed).sort(),
  listed.map(item => item.id).sort(),
);
assert.deepEqual(
  accounts.effectiveAccountIds({ senderMode: "selected", selectedAccountIds: [second.id] }, null, listed),
  [second.id],
);
assert.deepEqual(
  accounts.effectiveAccountIds({ senderMode: "selected", selectedAccountIds: [first.id] }, { accountMode: "all" }, listed).sort(),
  listed.map(item => item.id).sort(),
);
assert.deepEqual(
  accounts.effectiveAccountIds({ senderMode: "all", selectedAccountIds: [] }, { accountMode: "selected", accountIds: [first.id] }, listed),
  [first.id],
);

// Explicit TelePilot Bot mode remains available even while accounts stay connected.
assert.equal(accounts.usesBotSender({ senderMode: "bot", selectedAccountIds: [first.id] }, null, listed), true);
assert.deepEqual(accounts.effectiveAccountIds({ senderMode: "bot", selectedAccountIds: [first.id] }, null, listed), []);
assert.equal(accounts.senderSummary({ senderMode: "bot", selectedAccountIds: [first.id] }, listed), "TelePilot Bot");
assert.equal(accounts.usesBotSender({ senderMode: "all", selectedAccountIds: [] }, { accountMode: "bot" }, listed), true);
assert.deepEqual(accounts.effectiveAccountIds({ senderMode: "all", selectedAccountIds: [] }, { accountMode: "bot" }, listed), []);
// An explicit destination account route overrides global Bot mode.
assert.equal(accounts.usesBotSender({ senderMode: "bot", selectedAccountIds: [] }, { accountMode: "all" }, listed), false);
assert.deepEqual(
  accounts.effectiveAccountIds({ senderMode: "bot", selectedAccountIds: [] }, { accountMode: "all" }, listed).sort(),
  listed.map(item => item.id).sort(),
);

// Reconnecting the same Telegram account updates it instead of creating a duplicate.
const firstAgain = accounts.saveAccountSession(uid, { id: 101, username: "alpha_sender", firstName: "Alpha Updated" }, "session-alpha-new");
assert.equal(firstAgain.id, first.id);
assert.equal(accounts.countAccounts(uid), 2);
assert.equal(accounts.loadAccountSession(uid, first.id), "session-alpha-new");

// Disconnecting one account must leave the other intact.
assert.equal(accounts.removeAccount(uid, first.id), true);
listed = accounts.listAccounts(uid);
assert.equal(listed.length, 1);
assert.equal(listed[0].id, second.id);
assert.equal(accounts.loadAccountSession(uid, second.id), "session-beta");

// Pending Telegram login state is encrypted on disk and recoverable after a process-style reload.
const loginUid = "900000002";
const createdAt = Date.now();
loginStore.persistLoginAttempt({
  uid: Number(loginUid),
  token: "url-token-test",
  browserToken: "browser-token-test",
  phone: "+37120000000",
  stage: "code",
  error: "",
  createdAt,
  phoneCodeHash: "phone-code-hash-test",
  isCodeViaApp: true,
  codeFailures: 1,
  passwordFailures: 0,
  client: { session: { save: () => "temporary-login-session" } },
});
let restored = loginStore.loadPersistedLogins(10 * 60_000);
assert.equal(restored.length, 1);
assert.equal(restored[0].uid, loginUid);
assert.equal(restored[0].token, "url-token-test");
assert.equal(restored[0].browserToken, "browser-token-test");
assert.equal(restored[0].stage, "code");
assert.equal(restored[0].sessionString, "temporary-login-session");
loginStore.removePersistedLogin(loginUid);
assert.equal(loginStore.loadPersistedLogins(10 * 60_000).length, 0);

const source = name => fs.readFileSync(name, "utf8");
const app = source("app.js");
const engine = source("v1-engine.js");
const worker = source("v1-worker.js");
const controls = source("v1-controls.js");
const pro = source("pro-controls.js");
const support = source("support-center.js");
const security = source("security-core.js");
const extras = source("v1-extras.js");
const senderUi = source("sender-destination-ui.js");

assert.match(app, /TELEPILOT_MULTI_ACCOUNT_V11/);
assert.match(app, /postingEnabled/);
assert.match(app, /accessGrants/);
assert.match(app, /loadPersistedLogins/);
assert.match(app, /selectedAccountIds/);
assert.match(app, /accountMode/);
assert.match(app, /account_mode_bot/);
assert.match(app, /inherit\|bot\|all/);
assert.match(app, /split\(\/\\r\?\\n\//);
assert.match(engine, /transientCount/);
assert.match(engine, /permanentCount/);
assert.match(engine, /__telepilotSkipped/);
assert.match(worker, /EXACT_CATCHUP_MS/);
assert.match(worker, /deliveryKey/);
assert.match(worker, /nextAttemptAt/);
assert.match(worker, /usesBotSender/);
assert.match(extras, /senderSummary/);
assert.match(extras, /listAccounts/);
assert.doesNotMatch(senderUi, /personal-session\.enc/);
assert.match(controls, /strictDateParts/);
assert.match(controls, /What's new in TelePilot 1\.1/);
assert.match(pro, /version:3/);
assert.match(security, /sweepEphemeralSecurityState/);
assert.match(support, /User directory still exists after deletion/);

for (const sourceText of [app, pro, worker]) assert.ok(!sourceText.includes("getDialogs({ limit: 500 })"));

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("TelePilot 1.1 routing/persistence regression checks passed");
