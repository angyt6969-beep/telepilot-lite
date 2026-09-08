import assert from "node:assert/strict";
import {
  applyGoBackButton,
  cleanActivityControls,
  __test,
} from "./navigation-cleanup-v1.js";

const BACK_LABEL = __test.BACK_LABEL;

const activity = cleanActivityControls("📊 Activity\n\nPosting: — Running", {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "Pause", callback_data: "v1_pause_menu_v13", style: "primary" },
        { text: "History", callback_data: "v1_history", style: "primary", icon_custom_emoji_id: "history-icon" },
      ],
      [
        { text: "Accounts", callback_data: "v1_accounts_v13" },
        { text: "Destinations", callback_data: "v1_destinations_v13" },
      ],
      [{ text: "Dashboard", callback_data: "v1_dashboard_v13", style: "primary", icon_custom_emoji_id: "dashboard-icon" }],
    ],
  },
});
const activityButtons = activity.other.reply_markup.inline_keyboard.flat();
const postingHistory = activityButtons.find(button => button.callback_data === "v1_history");
assert.ok(postingHistory);
assert.equal(postingHistory.text, "Posting History");
assert.equal(postingHistory.style, undefined, "Posting History must not be blue/primary");
assert.equal(postingHistory.icon_custom_emoji_id, "history-icon", "existing premium icon should be preserved");
assert.equal(activityButtons.some(button => button.callback_data === "v1_accounts_v13"), false);
assert.equal(activityButtons.some(button => button.callback_data === "v1_destinations_v13"), false);
assert.equal(activityButtons.some(button => button.callback_data === "v1_pause_menu_v13"), true);

const withBack = applyGoBackButton(activity.text, activity.other, true);
const withBackRows = withBack.other.reply_markup.inline_keyboard;
const bottom = withBackRows.at(-1);
assert.equal(bottom.length, 1);
assert.deepEqual(bottom[0], { text: BACK_LABEL, callback_data: "v1_dashboard_v13" });
assert.equal(bottom[0].style, undefined, "Back must never inherit a Telegram button color/style");
assert.equal(bottom[0].icon_custom_emoji_id, undefined, "Back must never inherit a premium emoji icon");
assert.equal(withBackRows.flat().some(button => button.callback_data === "telepilot_nav_back"), false, "a real parent callback should be preserved instead of replaced with volatile history");

// Dashboard is the root page and must never display Back, even when history exists
// or a stale Back button was carried over from an older render.
const root = applyGoBackButton("✈️ TelePilot\n\nStatus: — READY", {
  reply_markup: {
    inline_keyboard: [
      [{ text: "⚙️ Settings", callback_data: "v1_settings_v13", style: "primary" }],
      [{ text: "🪪 Go back", callback_data: "telepilot_nav_back", style: "primary", icon_custom_emoji_id: "stale-icon" }],
    ],
  },
}, true);
const rootButtons = root.other.reply_markup.inline_keyboard.flat();
assert.equal(rootButtons.some(button => button.callback_data === "telepilot_nav_back"), false);
assert.equal(rootButtons.some(button => String(button.text).includes("back")), false);
assert.equal(rootButtons.some(button => button.callback_data === "v1_settings_v13"), true, "dashboard Settings action must remain");
assert.equal(__test.isDashboardRoot("✈️ TelePilot\n\nStatus: — READY"), true);

// A completion/success action that intentionally opens the Dashboard is a forward
// action, not a parent Back link.
const activation = applyGoBackButton("✅ Access activated\n\nPlan: — 90 days\nAccess: — Active", {
  reply_markup: {
    inline_keyboard: [[{
      text: "Dashboard",
      callback_data: "v1_dashboard_v13",
      style: "success",
      icon_custom_emoji_id: "5206607081334906820",
    }]],
  },
}, false);
const activationButtons = activation.other.reply_markup.inline_keyboard.flat();
assert.equal(activationButtons.length, 1, "activation must retain its Dashboard completion action");
assert.equal(activationButtons[0].callback_data, "v1_dashboard_v13");
assert.equal(activationButtons[0].style, "success");
assert.equal(__test.isExplicitForwardNavigationButton(activationButtons[0]), true);

// A normal parent footer becomes a clean Back button and any inherited style/icon
// is deliberately discarded.
const ordinaryFooter = applyGoBackButton("⚙️ Settings", {
  reply_markup: { inline_keyboard: [[{
    text: "Dashboard",
    callback_data: "v1_dashboard_v13",
    style: "primary",
    icon_custom_emoji_id: "dashboard-icon",
  }]] },
}, false);
assert.deepEqual(ordinaryFooter.other.reply_markup.inline_keyboard.at(-1)[0], { text: BACK_LABEL, callback_data: "v1_dashboard_v13" });

// Back must be physically moved to the bottom even if another control was rendered
// after the parent row by a different UI layer.
const settingsParent = applyGoBackButton("💬 Topic Preferences", {
  reply_markup: {
    inline_keyboard: [
      [{ text: "Settings", callback_data: "v1_settings_v13", style: "primary", icon_custom_emoji_id: "settings-icon" }],
      [{ text: "Contact support", url: "https://t.me/example" }],
    ],
  },
}, false);
assert.deepEqual(settingsParent.other.reply_markup.inline_keyboard.at(-1)[0], { text: BACK_LABEL, callback_data: "v1_settings_v13" });
assert.equal(settingsParent.other.reply_markup.inline_keyboard.at(-2)[0].url, "https://t.me/example");

const tutorial = applyGoBackButton(
  '<tg-emoji emoji-id="5231361378748472914">✈️</tg-emoji> <b><i>Build your post</i></b>\n<i>Slide 4 of 5</i>',
  { reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "linear_tutorial:3" }, { text: "Next", callback_data: "linear_tutorial:5" }]] } },
  true,
);
assert.deepEqual(tutorial.other.reply_markup.inline_keyboard.flat().map(button => button.callback_data), ["linear_tutorial:3", "linear_tutorial:5"]);

// Reproduce a real navigation: Dashboard -> Activity. The incoming Dashboard is
// captured first; Activity keeps its real Dashboard callback underneath Back.
const chatId = 8646767923;
const messageId = 101;
const dashboardText = "✈️ TelePilot\n\nStatus: — READY\nSender: — @noahxrp";
const dashboardMarkup = {
  inline_keyboard: [
    [{ text: "Posting Setup", callback_data: "v1_posting_setup_v13" }, { text: "Activity", callback_data: "v1_activity_v13" }],
  ],
};
__test.captureIncoming({
  callbackQuery: {
    data: "v1_activity_v13",
    message: { message_id: messageId, chat: { id: chatId }, text: dashboardText, reply_markup: dashboardMarkup },
  },
});

const activityRendered = __test.prepareOutgoing(chatId, messageId, "📊 Activity\n\nPosting: — Running", {
  reply_markup: {
    inline_keyboard: [
      [{ text: "Pause", callback_data: "v1_pause_menu_v13" }, { text: "History", callback_data: "v1_history", style: "primary" }],
      [{ text: "Accounts", callback_data: "v1_accounts_v13" }, { text: "Destinations", callback_data: "v1_destinations_v13" }],
      [{ text: "Dashboard", callback_data: "v1_dashboard_v13", style: "primary", icon_custom_emoji_id: "dashboard-icon" }],
    ],
  },
});
const state = __test.stateFor(__test.keyOf(chatId, messageId));
assert.equal(state.stack.length, 1);
assert.match(state.stack[0].text, /TelePilot/);
const renderedButtons = activityRendered.other.reply_markup.inline_keyboard.flat();
assert.equal(renderedButtons.find(button => button.callback_data === "v1_history")?.text, "Posting History");
assert.equal(renderedButtons.find(button => button.callback_data === "v1_history")?.style, undefined);
assert.equal(renderedButtons.some(button => button.callback_data === "v1_accounts_v13"), false);
assert.equal(renderedButtons.some(button => button.callback_data === "v1_destinations_v13"), false);
assert.deepEqual(activityRendered.other.reply_markup.inline_keyboard.at(-1)[0], { text: BACK_LABEL, callback_data: "v1_dashboard_v13" });

// Same-page updates must not create duplicate history entries.
__test.captureIncoming({
  callbackQuery: {
    data: "v1_pause_menu_v13",
    message: {
      message_id: messageId,
      chat: { id: chatId },
      text: activityRendered.text,
      reply_markup: activityRendered.other.reply_markup,
      entities: activityRendered.other.entities,
    },
  },
});
__test.prepareOutgoing(chatId, messageId, "📊 Activity\n\nPosting: — Paused", activityRendered.other);
assert.equal(state.stack.length, 1, "same Activity page must not be added to history again");

console.log("TelePilot navigation history and Activity cleanup regression tests passed");
