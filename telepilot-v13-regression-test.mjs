import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-v13-"));
process.env.DATA_DIR = temp;
process.env.TELEPILOT_SECURITY_SECRET ||= "v13-regression-security-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
process.env.TELEPILOT_SESSION_KEY_B64 ||= Buffer.alloc(32, 11).toString("base64");

const {
  appendImportHistory,
  defaultQolState,
  makePresetId,
  nextPresetName,
  patchQolState,
  readQolState,
  setDestinationNote,
  setPendingInput,
} = await import("./qol-store.js");
const {
  accountDisplayLabel,
  listAccounts,
  saveAccountSession,
  setAccountAlias,
} = await import("./account-store.js");

const uid = "123456";
assert.equal(defaultQolState().topicPreference.mode, "suggest");
assert.match(makePresetId("setup"), /^setup_[a-f0-9]{10}$/);
assert.equal(nextPresetName([{ name: "Posting Setup 1" }], "Posting Setup"), "Posting Setup 2");
setPendingInput(uid, { type: "destination_search", createdAt: Date.now() });
assert.equal(readQolState(uid).pendingInput.type, "destination_search");
setDestinationNote(uid, "-1001", "Advertising topic only");
assert.equal(readQolState(uid).destinationNotes["-1001"], "Advertising topic only");
appendImportHistory(uid, { source: "Addlist TEST", added: 5, duplicates: 2, attention: 1, failed: 0, destinationIds: ["-1001"] });
assert.equal(readQolState(uid).importHistory.length, 1);
patchQolState(uid, { topicPreference: { mode: "auto_exact", words: ["Advertising", "Marketplace"] } });
assert.equal(readQolState(uid).topicPreference.mode, "auto_exact");
assert.deepEqual(readQolState(uid).topicPreference.words, ["advertising", "marketplace"]);

const aliasUid = "654321";
const savedAccount = saveAccountSession(aliasUid, { id: "998877", username: "original_name", firstName: "Test" }, "test-session-string-long-enough-for-encrypted-storage");
assert.equal(listAccounts(aliasUid).length, 1, "Account-store alias test session was not persisted");
setAccountAlias(aliasUid, savedAccount.id, "Shop Account");
const aliased = listAccounts(aliasUid)[0];
assert.equal(aliased.alias, "Shop Account", "Account alias did not persist");
assert.equal(accountDisplayLabel(aliased), "Shop Account", "Account alias is not preferred in display labels");

const ux = fs.readFileSync("ux-v13.js", "utf8");
const polish = fs.readFileSync("ux-v13-polish.js", "utf8");
const startup = fs.readFileSync("startup.js", "utf8");
const accountStore = fs.readFileSync("account-store.js", "utf8");
const destinationBridge = fs.readFileSync("destination-automation.js", "utf8");
const destinationsV2 = fs.readFileSync("destinations-v2.js", "utf8");
const destinationCopy = fs.readFileSync("destinations-v2-copy.js", "utf8");
const v1Engine = fs.readFileSync("v1-engine.js", "utf8");

for (const marker of [
  "📝 Posting Setup",
  "📊 Activity",
  "👤 Accounts",
  "📁 Destinations",
  "⚙️ Settings",
  "v1_account_presets_v13",
  "v1_destination_presets_v13",
  "v1_setups_v13",
  "v1_pause_menu_v13",
  "v1_import_history_v13",
  "v1_dest_search_v13",
  "v1_dest_note_v13",
  "v1_alias_v13",
]) assert.ok(ux.includes(marker), `v1.3 UX missing ${marker}`);

assert.ok(!ux.includes('inline("⌂ Home"'), "Dashboard still contains a redundant Home control");
assert.ok(ux.includes('inline("📝 Posting Setup", "v1_posting_setup_v13")'), "Posting Setup main button is not on a premium-aware v1 callback");
assert.ok(ux.includes('inline("📊 Activity", "v1_activity_v13")'), "Activity main button is not on a premium-aware v1 callback");
assert.ok(ux.includes("ready / ${summary.total}"), "Destination readiness summary missing");
assert.ok(ux.includes("Automatic retry  On") && ux.includes("Broken-destination auto-skip  On"), "Activity does not surface automatic posting-failure handling");
assert.ok(ux.includes("Applying a saved setup is blocked while interval posting is running"), "Saved setup safety guard copy missing");
assert.ok(ux.includes("__telepilotUxV13TextPatched"), "v1.3 restart-safe text-input interception is not installed");

for (const marker of [
  "v1_send_once_v13",
  "v1_import_undo_v13",
  "v1_dest_browse_v13",
  "Dashboard, Posting Setup, Activity",
]) assert.ok(polish.includes(marker), `v1.3 polish missing ${marker}`);
assert.ok(polish.includes("normally within about 30 seconds"), "Send Once does not disclose scheduler timing");
assert.ok(polish.includes("This is destructive, so it requires this one confirmation"), "Import undo is missing destructive-action confirmation");
assert.ok(polish.includes("readyDestinationCount"), "Send Once is missing a readiness preflight");

assert.ok(accountStore.includes("alias: cleanAlias"), "Account aliases are not persisted");
assert.ok(accountStore.includes("export function setAccountAlias"), "Account alias setter missing");
assert.ok(accountStore.includes("if (cleanAlias(account.alias))"), "Account aliases are not used in display labels");

assert.ok(startup.includes("installUxV13Navigation(Bot)"), "v1.3 bot navigation not installed");
assert.ok(startup.includes("installUxV13PolishNavigation(Bot)"), "v1.3 polish callbacks not installed");
assert.ok(startup.includes("installDestinationsV2(Bot)"), "Destinations v2 bot navigation not installed");
assert.ok(startup.indexOf("installDestinationsV2(Bot)") > startup.indexOf("installUxV13Navigation(Bot)"), "Destinations v2 must be installed last so it owns destination callbacks");
assert.ok(startup.includes("installDestinationsV2Copy(Api);\ninstallUxV13(Api);"), "Destinations v2 copy guard must sit under the v1.3 API transformer");
assert.ok(startup.includes("startQolV13Worker()"), "v1.3 QOL worker not started before app import");
assert.ok(!startup.includes("startDestinationAutomationWorker();"), "legacy destination background worker must stay removed");

for (const marker of [
  "🗂 Destination Hub",
  "＋ Add destinations",
  "🔎 Review scan",
  "Join in Telegram first",
  "No chats were joined, muted or archived.",
  "chatlists.checkChatlistInvite",
  "getForumTopics",
]) assert.ok(destinationsV2.includes(marker), `Destinations v2 missing ${marker}`);
assert.ok(destinationBridge.includes("Intentionally no background worker"), "legacy destination bridge is not inert");
assert.ok(destinationCopy.includes("TelePilot never joins chats from this screen"), "legacy copy guard does not remove auto-join claims");
assert.ok(!destinationsV2.includes("suggestTopic"), "Destinations v2 must not suggest or auto-pick topics");
for (const forbidden of [".joinChannel(", ".importChatInvite(", "joinChatlistInvite(", "joinChatlistUpdates(", "UpdateNotifySettings", "EditPeerFolders"]) {
  assert.equal(destinationsV2.includes(forbidden), false, `Destinations v2 must not perform automatic Telegram mutation: ${forbidden}`);
}

assert.ok(v1Engine.includes("withRetry"), "Smart retry support regressed");
assert.ok(v1Engine.includes("disabledDestinationIds"), "Inactive/auto-disabled destination support regressed");

console.log("TelePilot v1.3 regression checks passed");
