import assert from "node:assert/strict";
import { cleanupTelePilotUi } from "./telepilot-ui-cleanup.js";

const dashboardMarkup = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "▶ Start", callback_data: "start", icon_custom_emoji_id: "1" }, { text: "⏹ Stop", callback_data: "stop", icon_custom_emoji_id: "2" }],
      [{ text: "👀 Smart Preview", callback_data: "v1_preview", icon_custom_emoji_id: "3" }],
      [{ text: "📝 Posting Setup", callback_data: "v1_posting_setup_v13" }, { text: "📊 Activity", callback_data: "v1_activity_v13" }],
      [{ text: "🔑 Get / Renew Key", url: "https://example.test/checkout" }],
    ],
  },
  entities: [{ type: "bold", offset: 0, length: 9 }],
};

const dashboard = cleanupTelePilotUi([
  "✈️ TelePilot",
  "💡 SETUP",
  "",
  "✓ Sender  @noahxrp",
  "✓ Message  Ready · 595 chars",
  "! Destinations  0 ready / 0 total",
  "✓ Timing  every 30 min",
  "",
  "✓ No destination issues",
  "Complete the missing setup items above.",
  "",
  "🔑 Key / renewal: — TelePilot Checkout or @noahxrp.",
].join("\n"), dashboardMarkup);

assert.match(dashboard.text, /TelePilot/);
assert.match(dashboard.text, /SETUP/);
assert.match(dashboard.text, /Sender: — @noahxrp/);
assert.match(dashboard.text, /Message: — Ready/);
assert.doesNotMatch(dashboard.text, /595 chars/);
assert.match(dashboard.text, /Destinations: — Not set/);
assert.match(dashboard.text, /Timing: — Every 30 min/);
assert.match(dashboard.text, /Add a destination to continue\./);
assert.match(dashboard.text, /Access: — TelePilot Checkout or @noahxrp\./);
assert.doesNotMatch(dashboard.text, /No destination issues/);
assert.doesNotMatch(dashboard.text, /✓|! Destinations/);
assert.equal(dashboard.other.parse_mode, "HTML");
assert.equal("entities" in dashboard.other, false);
assert.equal(dashboard.other.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "v1_preview"), false);
assert.equal(dashboard.other.reply_markup.inline_keyboard.flat().some(button => button.url?.includes("checkout")), true);

const smartPreview = cleanupTelePilotUi([
  "👁 Smart preview",
  "Sender — @noahxrp",
  "Message — 595 chars",
  "Destinations — 3 active / 3 saved",
  "Interval — 30 min",
  "Rotation — cycle",
  "Posting window — 24/7",
  "Next exact job — None",
  "",
  "Message preview:",
  "Hello from TelePilot",
  "",
  "Everything required to start interval posting is ready.",
].join("\n"), {
  reply_markup: { inline_keyboard: [
    [{ text: "▶ Start posting", callback_data: "start", icon_custom_emoji_id: "a" }],
    [{ text: "Open message preview", callback_data: "message_preview", icon_custom_emoji_id: "b" }],
    [{ text: "🧭 Posting queue", callback_data: "v1_queue" }, { text: "⚡ Power Tools", callback_data: "v1_tools" }],
    [{ text: "⬅️ Dashboard", callback_data: "home", icon_custom_emoji_id: "c" }],
  ] },
});
const previewButtons = smartPreview.other.reply_markup.inline_keyboard.flat();
assert.match(smartPreview.text, /Smart Preview/);
assert.doesNotMatch(smartPreview.text, /Rotation|Posting window|Next exact job/);
assert.match(smartPreview.text, /Hello from TelePilot/);
assert.equal(previewButtons.some(button => button.callback_data === "v1_queue"), false);
assert.equal(previewButtons.some(button => button.callback_data === "v1_tools"), false);
assert.equal(previewButtons.some(button => button.callback_data === "v1_posting_setup_v13"), true);
assert.equal(previewButtons.find(button => button.callback_data === "v1_posting_setup_v13")?.icon_custom_emoji_id, "c");

const advanced = cleanupTelePilotUi([
  "⚡ TelePilot Power Tools",
  "Rotation — off",
  "Exact schedules — 2",
  "One-time posts — 1",
  "",
  "Advanced controls stay here so the main dashboard remains simple.",
].join("\n"), {
  reply_markup: { inline_keyboard: [
    [{ text: "🔄 Message rotation", callback_data: "v1_rotation", icon_custom_emoji_id: "r" }, { text: "🕒 Exact times", callback_data: "v1_exact", icon_custom_emoji_id: "e" }],
    [{ text: "📅 Dates & limits", callback_data: "v1_limits" }, { text: "🧭 Posting queue", callback_data: "v1_queue", icon_custom_emoji_id: "q" }],
    [{ text: "📁 Folders", callback_data: "v1_folders" }, { text: "🎯 Overrides", callback_data: "v1_overrides" }],
    [{ text: "🔎 Search", callback_data: "v1_search" }, { text: "✨ Variables", callback_data: "v1_variables" }],
    [{ text: "📊 Statistics", callback_data: "v1_stats" }, { text: "🔔 Notifications", callback_data: "v1_notifications" }],
    [{ text: "🩺 Sender health", callback_data: "v1_session" }, { text: "📦 Backup", callback_data: "v1_backup", icon_custom_emoji_id: "b" }],
    [{ text: "🛑 Emergency stop", callback_data: "v1_emergency", icon_custom_emoji_id: "x" }],
    [{ text: "❓ Tutorial", callback_data: "tutorial_restart" }, { text: "🆕 What's new", callback_data: "v1_changelog" }],
    [{ text: "⬅️ Tools", callback_data: "tools", icon_custom_emoji_id: "z" }],
  ] },
});
const advancedButtons = advanced.other.reply_markup.inline_keyboard.flat();
assert.match(advanced.text, /Advanced/);
assert.doesNotMatch(advanced.text, /Power Tools/);
for (const removed of ["v1_limits", "v1_folders", "v1_overrides", "v1_search", "v1_variables", "v1_stats", "v1_notifications", "v1_session", "tutorial_restart", "v1_changelog", "tools"]) {
  assert.equal(advancedButtons.some(button => button.callback_data === removed), false, `${removed} should be hidden from Advanced`);
}
for (const kept of ["v1_rotation", "v1_exact", "v1_queue", "v1_backup", "v1_emergency", "v1_posting_setup_v13"]) {
  assert.equal(advancedButtons.some(button => button.callback_data === kept), true, `${kept} should remain in Advanced`);
}
assert.equal(advancedButtons.find(button => button.callback_data === "v1_rotation")?.icon_custom_emoji_id, "r");
assert.equal(advancedButtons.find(button => button.callback_data === "v1_posting_setup_v13")?.icon_custom_emoji_id, "z");

const retiredTools = cleanupTelePilotUi("⚙️ TelePilot Tools\nOld tool menu", {
  reply_markup: { inline_keyboard: [[{ text: "⬅️ Home", callback_data: "home", icon_custom_emoji_id: "h" }]] },
});
assert.match(retiredTools.text, /Posting Setup/);
assert.equal(retiredTools.other.reply_markup.inline_keyboard.flat().length, 1);
assert.equal(retiredTools.other.reply_markup.inline_keyboard.flat()[0].callback_data, "v1_posting_setup_v13");

console.log("TelePilot UI cleanup regression tests passed");
