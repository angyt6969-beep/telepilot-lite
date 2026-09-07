import assert from "node:assert/strict";
import {
  accessScreen,
  decorateLinearOnboardingPayload,
  replayTutorialScreen,
  tutorialScreen,
} from "./linear-onboarding-v4.js";

const tutorial = tutorialScreen({ supportUsername: "noahxrp" });
assert.match(tutorial.text, /Welcome to TelePilot/);
assert.match(tutorial.text, /<b>Sender:<\/b> —/);
assert.match(tutorial.text, /<b>Destinations:<\/b> —/);
assert.match(tutorial.text, /<b>Message:<\/b> —/);
assert.match(tutorial.text, /<b>Timing:<\/b> —/);
assert.equal(tutorial.other.parse_mode, "HTML");
const tutorialButtons = tutorial.other.reply_markup.inline_keyboard.flat();
assert.deepEqual(tutorialButtons.map(button => button.callback_data), ["linear_onboarding_continue"]);
assert.equal(tutorialButtons.some(button => /skip/i.test(button.text || "")), false);
assert.ok(tutorialButtons[0].icon_custom_emoji_id);

const access = accessScreen({ supportUsername: "noahxrp", mainChannelUsername: "TelePilotUpdates" });
assert.match(access.text, /Tutorial:<\/b> — Complete/);
assert.match(access.text, /Access:<\/b> — Key required/);
assert.match(access.text, /@noahxrp/);
assert.match(access.text, /@TelePilotUpdates/);
const accessButtons = access.other.reply_markup.inline_keyboard.flat();
assert.equal(accessButtons.some(button => button.callback_data === "redeem_key"), true);
assert.equal(accessButtons.some(button => button.url === "https://t.me/noahxrp"), true);
assert.equal(accessButtons.some(button => button.url === "https://t.me/TelePilotUpdates"), true);
assert.equal(accessButtons.some(button => /skip/i.test(button.text || "")), false);

const accessWithoutChannel = accessScreen({ supportUsername: "noahxrp", mainChannelUsername: "" });
assert.equal(accessWithoutChannel.other.reply_markup.inline_keyboard.flat().some(button => /Main Channel/i.test(button.text || "")), false);

const replay = replayTutorialScreen();
assert.deepEqual(replay.other.reply_markup.inline_keyboard.flat().map(button => button.callback_data), ["v1_dashboard_v13"]);
assert.doesNotMatch(replay.text, /Redeem your TelePilot access key/);

const activationMarkup = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "Start Tutorial", callback_data: "tutorial:begin" }],
      [{ text: "Skip tutorial", callback_data: "tutorial:skip" }],
    ],
  },
};
let markedUid = "";
const activated = decorateLinearOnboardingPayload(
  "12345",
  "✅ ACCESS ACTIVATED\n\nPlan: 30 days\nExpires: 2026-10-07\n\nYour TelePilot account is ready to set up.",
  activationMarkup,
  {
    markComplete: uid => { markedUid = uid; },
    supportUsername: "noahxrp",
    mainChannelUsername: "TelePilotUpdates",
  },
);
assert.equal(markedUid, "12345");
assert.match(activated.text, /<b>Plan:<\/b> — 30 days/);
assert.match(activated.text, /<b>Expires:<\/b> — 2026-10-07/);
assert.equal(activated.other.parse_mode, "HTML");
assert.deepEqual(
  activated.other.reply_markup.inline_keyboard.flat().map(button => button.callback_data),
  ["v1_dashboard_v13"],
);
assert.equal(activated.other.reply_markup.inline_keyboard.flat().some(button => /skip/i.test(button.text || "")), false);

const dashboardPayload = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "Posting Setup", callback_data: "v1_posting_setup_v13" }, { text: "Activity", callback_data: "v1_activity_v13" }],
      [{ text: "ADMIN PANEL", callback_data: "admin" }],
    ],
  },
};
const dashboard = decorateLinearOnboardingPayload(
  "12345",
  "✈️ TelePilot\n● READY\n\n✓ Sender  @example",
  dashboardPayload,
  { supportUsername: "noahxrp", mainChannelUsername: "TelePilotUpdates", markComplete: () => {} },
);
assert.match(dashboard.text, /Need a key \/ renewal\? — Message @noahxrp\./);
assert.match(dashboard.text, /Main channel: — Join @TelePilotUpdates/);
const dashboardButtons = dashboard.other.reply_markup.inline_keyboard.flat();
assert.equal(dashboardButtons.some(button => button.url === "https://t.me/noahxrp"), true);
assert.equal(dashboardButtons.some(button => button.url === "https://t.me/TelePilotUpdates"), true);
const adminRow = dashboard.other.reply_markup.inline_keyboard.findIndex(row => row.some(button => button.callback_data === "admin"));
const purchaseRow = dashboard.other.reply_markup.inline_keyboard.findIndex(row => row.some(button => button.url === "https://t.me/noahxrp"));
assert.equal(purchaseRow < adminRow, true);

const secondPass = decorateLinearOnboardingPayload(
  "12345",
  dashboard.text,
  dashboard.other,
  { supportUsername: "noahxrp", mainChannelUsername: "TelePilotUpdates", markComplete: () => {} },
);
assert.equal((secondPass.text.match(/Need a key \/ renewal\?/g) || []).length, 1);
assert.equal(secondPass.other.reply_markup.inline_keyboard.flat().filter(button => button.url === "https://t.me/noahxrp").length, 1);

console.log("linear onboarding v4 regression tests passed");
