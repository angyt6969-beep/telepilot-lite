import assert from "node:assert/strict";
import { cleanupTelePilotUi } from "./telepilot-ui-cleanup.js";

const dashboardMarkup = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "▶ Start", callback_data: "start", icon_custom_emoji_id: "1" }, { text: "⏹ Stop", callback_data: "stop", icon_custom_emoji_id: "2" }],
      [{ text: "👀 Smart Preview", callback_data: "v1_preview", icon_custom_emoji_id: "3" }],
      [{ text: "📝 Posting Setup", callback_data: "v1_posting_setup_v13", icon_custom_emoji_id: "4" }, { text: "📊 Activity", callback_data: "v1_activity_v13", icon_custom_emoji_id: "5" }],
      [{ text: "🔑 Get / Renew Key", url: "https://example.test/checkout" }],
    ],
  },
  entities: [{ type: "bold", offset: 0, length: 9 }],
};

const dashboard = cleanupTelePilotUi([
  "✈️ TelePilot",
  "💡 SETUP",
  "",
  "✓ Sender  @vvschrome",
  "✓ Message  Ready · 595 chars",
  "! Destinations  0 ready / 0 total",
  "✓ Timing  every 30 min",
  "",
  "✓ No destination issues",
  "Complete the missing setup items above.",
  "",
  "🔑 Key / renewal: — TelePilot Checkout or @vvschrome.",
].join("\n"), dashboardMarkup);

assert.match(dashboard.text, /<b><i>TelePilot<\/i><\/b>/);
assert.match(dashboard.text, /<b>Status:<\/b> — <b>SETUP<\/b>/);
assert.match(dashboard.text, /<b>Sender:<\/b> — @vvschrome/);
assert.match(dashboard.text, /<b>Message:<\/b> — Ready/);
assert.doesNotMatch(dashboard.text, /595 chars/);
assert.match(dashboard.text, /<b>Destinations:<\/b> — Not set/);
assert.match(dashboard.text, /<b>Timing:<\/b> — Every 30 min/);
assert.match(dashboard.text, /<i>Add a destination to continue\.<\/i>/);
assert.match(dashboard.text, new RegExp(`emoji-id="5307843983102204243"`));
assert.match(dashboard.text, /<b>Access:<\/b> — TelePilot Checkout or @vvschrome\./);
assert.doesNotMatch(dashboard.text, /No destination issues/);
assert.doesNotMatch(dashboard.text, /✓|! Destinations/);
assert.equal(dashboard.other.parse_mode, "HTML");
assert.equal("entities" in dashboard.other, false);
assert.equal(dashboard.other.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "v1_preview"), false);
assert.equal(dashboard.other.reply_markup.inline_keyboard.flat().some(button => button.url?.includes("checkout")), true);
assert.equal(dashboard.other.reply_markup.inline_keyboard.flat().find(button => button.callback_data === "start")?.text, "Start");
assert.equal(dashboard.other.reply_markup.inline_keyboard.flat().find(button => button.url?.includes("checkout"))?.icon_custom_emoji_id, "5307843983102204243");

const smartPreview = cleanupTelePilotUi([
  "👁 Smart preview",
  "Sender — @vvschrome",
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
    [{ text: "🧭 Posting queue", callback_data: "v1_queue", icon_custom_emoji_id: "q" }, { text: "⚡ Power Tools", callback_data: "v1_tools", icon_custom_emoji_id: "p" }],
    [{ text: "⬅️ Dashboard", callback_data: "home", icon_custom_emoji_id: "c" }],
  ] },
  entities: [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "preview-title" }],
});
const previewButtons = smartPreview.other.reply_markup.inline_keyboard.flat();
assert.match(smartPreview.text, /emoji-id="preview-title"/);
assert.match(smartPreview.text, /<b><i>Smart Preview<\/i><\/b>/);
assert.doesNotMatch(smartPreview.text, /Rotation|Posting window|Next exact job/);
assert.match(smartPreview.text, /Hello from TelePilot/);
assert.equal(previewButtons.some(button => button.callback_data === "v1_queue"), false);
assert.equal(previewButtons.some(button => button.callback_data === "v1_tools"), false);
assert.equal(previewButtons.some(button => button.callback_data === "v1_posting_setup_v13"), true);
assert.equal(previewButtons.find(button => button.callback_data === "v1_posting_setup_v13")?.icon_custom_emoji_id, "c");
assert.equal(previewButtons.find(button => button.callback_data === "v1_posting_setup_v13")?.text, "Posting Setup");

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
assert.match(advanced.text, /<b><i>Advanced<\/i><\/b>/);
assert.match(advanced.text, /<b>Rotation:<\/b> — off/);
assert.doesNotMatch(advanced.text, /Power Tools/);
for (const removed of ["v1_limits", "v1_folders", "v1_overrides", "v1_search", "v1_variables", "v1_stats", "v1_notifications", "v1_session", "tutorial_restart", "v1_changelog", "tools"]) {
  assert.equal(advancedButtons.some(button => button.callback_data === removed), false, `${removed} should be hidden from Advanced`);
}
for (const kept of ["v1_rotation", "v1_exact", "v1_queue", "v1_backup", "v1_emergency", "v1_posting_setup_v13"]) {
  assert.equal(advancedButtons.some(button => button.callback_data === kept), true, `${kept} should remain in Advanced`);
}
assert.equal(advancedButtons.find(button => button.callback_data === "v1_rotation")?.icon_custom_emoji_id, "r");
assert.equal(advancedButtons.find(button => button.callback_data === "v1_rotation")?.text, "Message Rotation");
assert.equal(advancedButtons.find(button => button.callback_data === "v1_posting_setup_v13")?.icon_custom_emoji_id, "z");
assert.equal(advancedButtons.find(button => button.callback_data === "v1_posting_setup_v13")?.text, "Posting Setup");

const retiredTools = cleanupTelePilotUi("⚙️ TelePilot Tools\nOld tool menu", {
  reply_markup: { inline_keyboard: [[{ text: "⬅️ Home", callback_data: "home", icon_custom_emoji_id: "h" }]] },
  entities: [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "tools-title" }],
});
assert.match(retiredTools.text, /Posting Setup/);
assert.equal(retiredTools.other.reply_markup.inline_keyboard.flat().length, 1);
assert.equal(retiredTools.other.reply_markup.inline_keyboard.flat()[0].callback_data, "v1_posting_setup_v13");
assert.equal(retiredTools.other.reply_markup.inline_keyboard.flat()[0].text, "Posting Setup");

// Generic v1.3 pages should receive the same title/label hierarchy without
// losing premium custom-emoji IDs that were assigned by the semantic layer.
const activityText = [
  "📊 Activity",
  "",
  "Posting  Running",
  "Senders  @vvschrome",
  "Next  10 min",
  "Recent  4 successful",
].join("\n");
const activity = cleanupTelePilotUi(activityText, {
  reply_markup: { inline_keyboard: [[{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13", icon_custom_emoji_id: "dash-icon" }]] },
  entities: [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "activity-title" }],
});
assert.match(activity.text, /Posting: — Running/);
assert.match(activity.text, /Senders: — @vvschrome/);
assert.match(activity.text, /Next: — 10 min/);
assert.equal(activity.other.parse_mode, undefined);
assert.equal(activity.other.reply_markup.inline_keyboard[0][0].text, "Dashboard");
assert.equal(activity.other.entities.some(entity => entity.type === "custom_emoji" && entity.custom_emoji_id === "activity-title" && entity.offset === 0), true);
const activityTitleStart = activity.text.indexOf("Activity");
assert.equal(activity.other.entities.some(entity => entity.type === "bold" && entity.offset === activityTitleStart && entity.length === "Activity".length), true);
assert.equal(activity.other.entities.some(entity => entity.type === "italic" && entity.offset === activityTitleStart && entity.length === "Activity".length), true);
const postingLabelStart = activity.text.indexOf("Posting:");
assert.equal(activity.other.entities.some(entity => entity.type === "bold" && entity.offset === postingLabelStart && entity.length === "Posting:".length), true);

const settings = cleanupTelePilotUi([
  "⚙️ Settings",
  "Access  Active",
  "Topic suggestions  Suggest only",
  "Preferred topic words  deals, promo",
  "",
  "Choose how TelePilot suggests forum topics.",
].join("\n"), {
  reply_markup: { inline_keyboard: [[{ text: "❓ Tutorial", callback_data: "tutorial_restart", icon_custom_emoji_id: "tutorial-icon" }]] },
});
assert.match(settings.text, /Access: — Active/);
assert.match(settings.text, /Topic suggestions: — Suggest only/);
assert.match(settings.text, /Preferred topic words: — deals, promo/);
assert.equal(settings.other.reply_markup.inline_keyboard[0][0].text, "Tutorial");

const destination = cleanupTelePilotUi([
  "📁 Example Group",
  "",
  "Status  ✅ ready",
  "Topic  General",
  "Source  addlist · example",
  "Note  Main advertising group",
].join("\n"), {
  reply_markup: { inline_keyboard: [[{ text: "⬅️ Destinations", callback_data: "v1_destinations_v13", icon_custom_emoji_id: "back-icon" }]] },
  entities: [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "folder-title" }],
});
assert.match(destination.text, /Status: — ✅ ready/);
assert.match(destination.text, /Topic: — General/);
assert.match(destination.text, /Source: — addlist · example/);
assert.match(destination.text, /Note: — Main advertising group/);
assert.equal(destination.other.entities.some(entity => entity.type === "custom_emoji" && entity.custom_emoji_id === "folder-title"), true);

const admin = cleanupTelePilotUi([
  "👑 ADMIN TEAM",
  "",
  "Owners: 1",
  "Active admins: 2",
  "",
  "Admins can manage customers and request keys.",
].join("\n"), {
  reply_markup: { inline_keyboard: [[{ text: "⬅️ Admin", callback_data: "admin", icon_custom_emoji_id: "admin-back" }]] },
});
assert.match(admin.text, /^👑 Admin Team/m);
assert.match(admin.text, /Owners: — 1/);
assert.match(admin.text, /Active admins: — 2/);
const adminTitleStart = admin.text.indexOf("Admin Team");
assert.equal(admin.other.entities.some(entity => entity.type === "bold" && entity.offset === adminTitleStart && entity.length === "Admin Team".length), true);
assert.equal(admin.other.entities.some(entity => entity.type === "italic" && entity.offset === adminTitleStart && entity.length === "Admin Team".length), true);

const keyApproval = cleanupTelePilotUi([
  "⏳ KEY APPROVAL PENDING",
  "",
  "Requested: 30 days",
  "Expires in: 15 minutes",
].join("\n"), {
  reply_markup: { inline_keyboard: [[{ text: "⬅️ Keys", callback_data: "admin_keys", icon_custom_emoji_id: "key-back" }]] },
});
assert.match(keyApproval.text, /Key Approval Pending/);
assert.match(keyApproval.text, /Requested: — 30 days/);
assert.match(keyApproval.text, /Expires in: — 15 minutes/);

// If a page contains a semantic entity such as a text link, leave its text and
// offsets intact while still adding the consistent title hierarchy.
const linkedText = "💬 Support\nRead documentation";
const linked = cleanupTelePilotUi(linkedText, {
  reply_markup: { inline_keyboard: [[{ text: "⬅️ Dashboard", callback_data: "home", icon_custom_emoji_id: "back" }]] },
  entities: [{ type: "text_link", offset: linkedText.indexOf("documentation"), length: "documentation".length, url: "https://example.test" }],
});
assert.equal(linked.text, linkedText);
assert.equal(linked.other.entities.some(entity => entity.type === "text_link" && entity.url === "https://example.test"), true);
const supportTitleStart = linked.text.indexOf("Support");
assert.equal(linked.other.entities.some(entity => entity.type === "bold" && entity.offset === supportTitleStart && entity.length === "Support".length), true);
assert.equal(linked.other.entities.some(entity => entity.type === "italic" && entity.offset === supportTitleStart && entity.length === "Support".length), true);

// Existing HTML tutorial/onboarding pages are preserved rather than escaped or
// double-formatted; only their buttons receive the final navigation cleanup.
const tutorialHtml = cleanupTelePilotUi('<tg-emoji emoji-id="5231361378748472914">✈️</tg-emoji> <b><i>Welcome to TelePilot</i></b>\n<i>Slide 1 of 5</i>', {
  parse_mode: "HTML",
  reply_markup: { inline_keyboard: [[{ text: "➡️ Next", callback_data: "linear_tutorial:2", icon_custom_emoji_id: "next-icon" }]] },
});
assert.match(tutorialHtml.text, /<tg-emoji/);
assert.match(tutorialHtml.text, /<b><i>Welcome to TelePilot<\/i><\/b>/);
assert.equal(tutorialHtml.other.parse_mode, "HTML");
assert.equal(tutorialHtml.other.reply_markup.inline_keyboard[0][0].text, "Next");

console.log("TelePilot full UI cleanup regression tests passed");
