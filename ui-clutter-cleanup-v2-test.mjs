import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-ui-cleanup-v2-"));
process.env.DATA_DIR = root;
process.env.TELEPILOT_ADMIN_ID = "42";

const mod = await import(`./ui-clutter-cleanup-v2.js?test=${Date.now()}`);
const { cleanupUiClutterV2, __test } = mod;

function button(text, callback_data, extra = {}) { return { text, callback_data, ...extra }; }
function other(rows) { return { reply_markup: { inline_keyboard: rows } }; }
function callbacks(result) { return (result.other?.reply_markup?.inline_keyboard || []).flat().map(item => item.callback_data).filter(Boolean); }
function buttons(result) { return (result.other?.reply_markup?.inline_keyboard || []).flat(); }
function lastRow(result) { return result.other?.reply_markup?.inline_keyboard?.at(-1) || []; }
function actionCount(result) { return buttons(result).filter(item => item.text !== __test.BACK_TEXT).length; }

const dashboardOther = other([
  [button("▶ Start", "start", { style: "success" }), button("⏹ Stop", "stop", { style: "danger" })],
  [button("📝 Posting Setup", "v1_posting_setup_v13"), button("📊 Activity", "v1_activity_v13")],
  [button("👤 Accounts", "v1_accounts_v13"), button("📁 Destinations", "v1_destinations_v13")],
  [button("⚙️ Settings", "v1_settings_v13")],
  [button("🛡 Admin", "admin", { style: "primary" })],
  [button("🔑 Get / Renew Key", "redeem_key", { style: "primary" })],
  [button("👀 Smart Preview", "v1_preview")],
]);

const activeDashboard = cleanupUiClutterV2(42, "✈️ TelePilot\n\nStatus: — READY\nAccess: — Active\nSender: — @sender\nDestinations: — 4 ready\nTiming: — Every 30 min", dashboardOther);
assert.deepEqual(callbacks(activeDashboard), ["start", "v1_posting_setup_v13", "v1_activity_v13", "v1_accounts_v13", "v1_destinations_v13", "v1_settings_v13"]);
assert.equal(actionCount(activeDashboard), 6, "active dashboard should have six visible actions");
assert.equal(callbacks(activeDashboard).includes("admin"), false, "Admin must leave Dashboard");
assert.equal(callbacks(activeDashboard).includes("v1_preview"), false, "Smart Preview must never survive cleanup");
assert.equal(buttons(activeDashboard).find(item => item.callback_data === "v1_settings_v13")?.style, "primary", "Settings should use blue primary styling");

const liveDashboard = cleanupUiClutterV2(42, "✈️ TelePilot\n\nStatus: — LIVE\nAccess: — Active\nSender: — @sender\nDestinations: — 4 ready", dashboardOther);
assert.equal(callbacks(liveDashboard).includes("stop"), true);
assert.equal(callbacks(liveDashboard).includes("start"), false);
assert.equal(buttons(liveDashboard).find(item => item.callback_data === "stop")?.style, "danger");

const inactiveDashboard = cleanupUiClutterV2(99, "✈️ TelePilot\n\nStatus: — SETUP\nAccess: — Inactive\nSender: — @sender\nDestinations: — Not set", dashboardOther);
assert.equal(callbacks(inactiveDashboard).includes("start"), false, "Start should hide when access is inactive");
assert.equal(callbacks(inactiveDashboard).includes("v1_activity_v13"), false, "Activity should hide when access is inactive");
assert.equal(callbacks(inactiveDashboard).includes("redeem_key"), true, "access action should show when it is useful");
assert.ok(actionCount(inactiveDashboard) <= 6);

const postingOther = other([
  [button("📝 Message", "message"), button("⏱ Timing", "interval")],
  [button("👀 Smart Preview", "v1_preview")],
  [button("📁 Saved Setups", "v1_setups_v13"), button("⚡ Advanced", "v1_tools")],
  [button("📊 Dashboard", "v1_dashboard_v13")],
]);
const posting = cleanupUiClutterV2(42, "📝 Posting Setup\n\nSender: — @sender\nMessage: — Ready\nDestinations: — 4 active\nTiming: — Every 30 min", postingOther);
assert.deepEqual(callbacks(posting), ["message", "interval", "v1_setups_v13", "v1_tools", "v1_dashboard_v13"]);
assert.equal(plain(posting.text).includes("Smart Preview"), false);
assert.equal(buttons(posting).find(item => item.callback_data === "v1_tools")?.text, "Advanced");
assert.equal(buttons(posting).find(item => item.callback_data === "v1_tools")?.style, "primary");
assert.equal(lastRow(posting)[0]?.text, __test.BACK_TEXT);
assert.equal(lastRow(posting)[0]?.style, undefined);
assert.equal(lastRow(posting)[0]?.icon_custom_emoji_id, undefined);

const retiredPreview = cleanupUiClutterV2(42, "👀 Smart Preview\n\nSender: — @sender\nMessage: — Ready\nDestinations: — 4 active\nTiming: — Every 30 min", postingOther);
assert.match(plain(retiredPreview.text), /Posting Setup/);
assert.equal(plain(retiredPreview.text).includes("Smart Preview"), false, "retired screen must redirect invisibly to Posting Setup");
assert.equal(callbacks(retiredPreview).includes("v1_preview"), false);

const activityOther = other([
  [button("⚡ Fix Issues", "v1_fix_issues_v13"), button("↻ Retry Failed", "v1_retry_failed_v13")],
  [button("⏸ Pause", "v1_pause_menu_v13"), button("📜 Posting History", "v1_history")],
  [button("📁 Destinations", "v1_destinations_v13"), button("👤 Accounts", "v1_accounts_v13")],
  [button("📊 Dashboard", "v1_dashboard_v13")],
]);
const activity = cleanupUiClutterV2(42, "📊 Activity\n\nPosting: — 🟢 Running\nNext: — 12m\nDestination health: — 4 ready / 6 total\nNeeds attention: — 2\n\nRecent\n✅ @group · 2m ago", activityOther);
assert.deepEqual(callbacks(activity), ["v1_pause_menu_v13", "history", "d5_issues:0", "v1_dashboard_v13"]);
assert.equal(callbacks(activity).includes("v1_retry_failed_v13"), false);
assert.equal(callbacks(activity).includes("v1_fix_issues_v13"), false);
assert.match(plain(activity.text), /Attention: — 2 destinations need review/);
assert.match(plain(activity.text), /Open Issues to fix them/);
assert.equal(buttons(activity).find(item => item.callback_data === "history")?.style, "primary");
assert.equal(lastRow(activity)[0]?.text, __test.BACK_TEXT);

const cleanActivity = cleanupUiClutterV2(42, "📊 Activity\n\nPosting: — ⚪ Stopped\nNext: — —\nDestination health: — 6 ready / 6 total\nNeeds attention: — 0\n\nRecent\nNo posting history yet.", activityOther);
assert.deepEqual(callbacks(cleanActivity), ["history", "v1_dashboard_v13"]);
assert.match(plain(cleanActivity.text), /Everything looks normal/);

const destinationOther = other([
  [button("＋ Add destinations", "d2_add"), button("📚 Browse", "d2_browse:0")],
  [button("💬 Topics", "d2_topics:0"), button("↻ Check access", "d2_refresh")],
  [button("🗑 Manage", "d2_manage:0")],
  [button("⚠ Review Issues · 3", "d5_issues:0")],
  [button("📊 Dashboard", "v1_dashboard_v13")],
]);
const destinations = cleanupUiClutterV2(42, "🗂 Destination Hub\n\nSaved: — 12\nReady: — 9\nChoose topic: — 1\nNeeds attention: — 3\n\nTelePilot only uses chats you already have access to.", destinationOther);
assert.deepEqual(callbacks(destinations), ["d2_add", "d2_browse:0", "d2_topics:0", "d5_issues:0", "v1_dest_more_v2", "v1_dashboard_v13"]);
assert.equal(buttons(destinations).find(item => item.callback_data === "d2_add")?.text, "Add / Import");
assert.equal(buttons(destinations).find(item => item.callback_data === "d2_add")?.style, "primary");
assert.equal(callbacks(destinations).includes("d2_refresh"), false, "less-used Check Access moves under More");
assert.equal(callbacks(destinations).includes("d2_manage:0"), false, "Manage moves under More");
assert.match(plain(destinations.text), /Open Issues to fix them/);
assert.ok(actionCount(destinations) <= 5);
assert.equal(lastRow(destinations)[0]?.text, __test.BACK_TEXT);

const cleanDestinationOther = other([
  [button("＋ Add destinations", "d2_add"), button("📚 Browse", "d2_browse:0")],
  [button("💬 Topics", "d2_topics:0"), button("↻ Check access", "d2_refresh")],
  [button("🗑 Manage", "d2_manage:0")],
  [button("📊 Dashboard", "v1_dashboard_v13")],
]);
const cleanDestinations = cleanupUiClutterV2(42, "🗂 Destination Hub\n\nSaved: — 12\nReady: — 12", cleanDestinationOther);
assert.deepEqual(callbacks(cleanDestinations), ["d2_add", "d2_browse:0", "v1_dest_more_v2", "v1_dashboard_v13"]);
assert.equal(callbacks(cleanDestinations).includes("d2_topics:0"), false, "Topics hides when no topic needs selection");
assert.equal(callbacks(cleanDestinations).includes("d5_issues:0"), false, "Issues hides when nothing needs attention");

const settingsOther = other([
  [button("🔑 Access", "access"), button("💬 Support", "support")],
  [button("❓ Tutorial", "tutorial_restart"), button("💬 Topic Preferences", "v1_topic_preferences_v13")],
  [button("🔔 Notifications", "v1_notifications"), button("🔥 Referrals", "referrals")],
  [button("📊 Dashboard", "v1_dashboard_v13")],
]);
const settings = cleanupUiClutterV2(42, "⚙️ Settings\n\nAccess: — Lifetime\nTopic selection: — Manual", settingsOther);
assert.deepEqual(callbacks(settings), ["access", "v1_notifications", "referrals", "support", "tutorial_restart", "admin", "v1_dashboard_v13"]);
assert.equal(callbacks(settings).includes("v1_topic_preferences_v13"), false, "topic preferences move out of Settings");
assert.equal(buttons(settings).find(item => item.callback_data === "admin")?.style, "primary");
assert.equal(lastRow(settings)[0]?.text, __test.BACK_TEXT);
assert.equal(lastRow(settings)[0]?.style, undefined);

const normalSettings = cleanupUiClutterV2(99, "⚙️ Settings\n\nAccess: — Active", settingsOther);
assert.equal(callbacks(normalSettings).includes("admin"), false);
assert.ok(actionCount(normalSettings) <= 5);

const moreRows = __test.destinationMoreRows();
assert.deepEqual(moreRows.flat().map(item => item.callback_data), ["d2_refresh", "d2_manage:0", "v1_dest_filters_v13", "v1_destination_presets_v13", "v1_import_history_v13", "v1_dest_advanced_v2", "v1_destinations_v13"]);
assert.equal(moreRows.at(-1)[0].text, __test.BACK_TEXT);
const advancedRows = __test.destinationAdvancedRows();
assert.deepEqual(advancedRows.flat().map(item => item.callback_data), ["route_groups:0", "v1_topic_preferences_v13", "v1_dest_more_v2"]);
assert.equal(advancedRows.at(-1)[0].text, __test.BACK_TEXT);

for (const result of [posting, activity, cleanActivity, destinations, cleanDestinations, settings, normalSettings]) {
  const back = lastRow(result)[0];
  assert.equal(back?.text, __test.BACK_TEXT, "Back must always be the final row on cleaned subpages");
  assert.equal(back?.style, undefined, "Back must stay neutral");
  assert.equal(back?.icon_custom_emoji_id, undefined, "Back must not carry an emoji icon");
}

function plain(value) { return String(value || "").replace(/<tg-emoji\b[^>]*>/gi, "").replace(/<\/tg-emoji>/gi, "").replace(/<[^>]+>/g, ""); }

console.log("TelePilot UI clutter cleanup v2 checks passed");
