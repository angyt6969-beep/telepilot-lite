import assert from "node:assert/strict";
import {
  decorateLinearOnboardingPayload,
  redeemPromptScreen,
  replayTutorialScreen,
  tutorialScreen,
  TUTORIAL_PLANE_EMOJI_ID,
  TUTORIAL_SLIDES,
} from "./linear-onboarding-v4.js";

assert.equal(TUTORIAL_SLIDES, 5);
assert.equal(TUTORIAL_PLANE_EMOJI_ID, "5231361378748472914");

const slides = Array.from({ length: TUTORIAL_SLIDES }, (_, index) => tutorialScreen({
  supportUsername: "noahxrp",
  mainChannelUsername: "TelePilotUpdates",
  accessActive: false,
  slide: index + 1,
}));

for (let index = 0; index < slides.length; index += 1) {
  const slide = slides[index];
  assert.equal(slide.other.parse_mode, "HTML");
  assert.match(slide.text, new RegExp(`Slide ${index + 1} of ${TUTORIAL_SLIDES}`));
  assert.match(slide.text, new RegExp(`<tg-emoji emoji-id="${TUTORIAL_PLANE_EMOJI_ID}">`));
  const buttons = slide.other.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.some(button => /skip/i.test(button.text || "")), false);
  assert.equal(buttons.every(button => button.icon_custom_emoji_id), true);
}

assert.match(slides[0].text, /Welcome to TelePilot/);
assert.match(slides[0].text, /✨ <b>TelePilot:<\/b> —/);
assert.deepEqual(slides[0].other.reply_markup.inline_keyboard.flat().map(button => button.callback_data), ["linear_tutorial:2"]);
assert.equal(slides[0].other.reply_markup.inline_keyboard.flat()[0].icon_custom_emoji_id, TUTORIAL_PLANE_EMOJI_ID);

assert.match(slides[1].text, /Choose your sender/);
assert.match(slides[1].text, /👤 <b>Personal account:<\/b> —/);
assert.match(slides[1].text, /🤖 <b>TelePilot Bot:<\/b> —/);
assert.deepEqual(slides[1].other.reply_markup.inline_keyboard.flat().map(button => button.callback_data), ["linear_tutorial:1", "linear_tutorial:3"]);

assert.match(slides[2].text, /Add destinations/);
assert.match(slides[2].text, /🗂 <b>Addlists:<\/b> —/);
assert.match(slides[2].text, /💬 <b>Forum topics:<\/b> —/);
assert.deepEqual(slides[2].other.reply_markup.inline_keyboard.flat().map(button => button.callback_data), ["linear_tutorial:2", "linear_tutorial:4"]);

assert.match(slides[3].text, /Build your post/);
assert.match(slides[3].text, /📝 <b>Normal Post:<\/b> —/);
assert.match(slides[3].text, /↪️ <b>Forwarded Post:<\/b> —/);
assert.match(slides[3].text, /⏱ <b>Timing:<\/b> —/);
assert.deepEqual(slides[3].other.reply_markup.inline_keyboard.flat().map(button => button.callback_data), ["linear_tutorial:3", "linear_tutorial:5"]);

assert.match(slides[4].text, /You're ready/);
assert.match(slides[4].text, /✅ <b>Tutorial:<\/b> — Complete/);
assert.match(slides[4].text, /🔑 <b>Access:<\/b> — Key required/);
const finalButtons = slides[4].other.reply_markup.inline_keyboard.flat();
assert.equal(finalButtons.some(button => button.callback_data === "redeem_key"), true);
assert.equal(finalButtons.find(button => button.callback_data === "redeem_key").style, "success");
assert.equal(finalButtons.some(button => button.url === "https://t.me/noahxrp"), true);
assert.equal(finalButtons.some(button => button.url === "https://t.me/TelePilotUpdates"), true);

const activeFinal = tutorialScreen({ supportUsername: "noahxrp", accessActive: true, slide: 5 });
assert.match(activeFinal.text, /🟢 <b>Access:<\/b> — Active/);
assert.equal(activeFinal.other.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "linear_onboarding_complete"), true);
assert.equal(activeFinal.other.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "redeem_key"), false);

const clampedLow = tutorialScreen({ slide: -50 });
const clampedHigh = tutorialScreen({ slide: 99 });
assert.match(clampedLow.text, /Slide 1 of 5/);
assert.match(clampedHigh.text, /Slide 5 of 5/);

const redeem = redeemPromptScreen({ supportUsername: "noahxrp", mainChannelUsername: "TelePilotUpdates" });
assert.match(redeem.text, /Tutorial:<\/b> — Complete/);
assert.match(redeem.text, /Access:<\/b> — Waiting for key/);
assert.match(redeem.text, /@noahxrp/);
assert.match(redeem.text, /@TelePilotUpdates/);
const redeemButtons = redeem.other.reply_markup.inline_keyboard.flat();
assert.equal(redeemButtons.some(button => button.url === "https://t.me/noahxrp"), true);
assert.equal(redeemButtons.some(button => button.url === "https://t.me/TelePilotUpdates"), true);
assert.equal(redeemButtons.some(button => /skip/i.test(button.text || "")), false);
assert.ok(redeemButtons.every(button => button.icon_custom_emoji_id));

const redeemWithoutChannel = redeemPromptScreen({ supportUsername: "noahxrp", mainChannelUsername: "" });
assert.equal(redeemWithoutChannel.other.reply_markup.inline_keyboard.flat().some(button => /Main Channel/i.test(button.text || "")), false);

const polishedRedeem = decorateLinearOnboardingPayload(
  "12345",
  "🔑 REDEEM KEY\n\nSend your TelePilot access key below.\n\nNeed a key? Message @noahxrp to get yours.",
  { reply_markup: { inline_keyboard: [] } },
  { supportUsername: "noahxrp", mainChannelUsername: "TelePilotUpdates" },
);
assert.match(polishedRedeem.text, /<b><i>Redeem TelePilot Key<\/i><\/b>/);
assert.equal(polishedRedeem.other.parse_mode, "HTML");
assert.equal(polishedRedeem.other.reply_markup.inline_keyboard.flat().some(button => button.url === "https://t.me/noahxrp"), true);

const replay = replayTutorialScreen(3);
assert.match(replay.text, /Slide 3 of 5/);
assert.match(replay.text, /Add destinations/);
assert.deepEqual(replay.other.reply_markup.inline_keyboard.flat().map(button => button.callback_data), ["linear_tutorial:2", "linear_tutorial:4"]);

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
assert.match(activated.text, /<b>Tutorial:<\/b> — Complete/);
assert.equal(activated.other.parse_mode, "HTML");
assert.deepEqual(
  activated.other.reply_markup.inline_keyboard.flat().map(button => button.callback_data),
  ["v1_dashboard_v13"],
);
assert.equal(activated.other.reply_markup.inline_keyboard.flat().some(button => /skip/i.test(button.text || "")), false);

const dashboardPayload = {
  entities: [{ type: "bold", offset: 3, length: 9 }],
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
assert.match(dashboard.text, /Key \/ renewal: — Message @noahxrp\./);
assert.match(dashboard.text, /Main channel: — Join @TelePilotUpdates/);
const dashboardButtons = dashboard.other.reply_markup.inline_keyboard.flat();
assert.equal(dashboardButtons.some(button => button.url === "https://t.me/noahxrp"), true);
assert.equal(dashboardButtons.some(button => button.url === "https://t.me/TelePilotUpdates"), true);
assert.equal(dashboardButtons.filter(button => button.url).every(button => button.icon_custom_emoji_id), true);
const adminRow = dashboard.other.reply_markup.inline_keyboard.findIndex(row => row.some(button => button.callback_data === "admin"));
const purchaseRow = dashboard.other.reply_markup.inline_keyboard.findIndex(row => row.some(button => button.url === "https://t.me/noahxrp"));
assert.equal(purchaseRow < adminRow, true);
assert.equal(dashboard.other.entities.some(entity => entity.type === "bold" && dashboard.text.slice(entity.offset, entity.offset + entity.length) === "Key / renewal:"), true);
assert.equal(dashboard.other.entities.some(entity => entity.type === "italic" && dashboard.text.slice(entity.offset, entity.offset + entity.length) === "Main channel:"), true);

const secondPass = decorateLinearOnboardingPayload(
  "12345",
  dashboard.text,
  dashboard.other,
  { supportUsername: "noahxrp", mainChannelUsername: "TelePilotUpdates", markComplete: () => {} },
);
assert.equal((secondPass.text.match(/Key \/ renewal: —/g) || []).length, 1);
assert.equal(secondPass.other.reply_markup.inline_keyboard.flat().filter(button => button.url === "https://t.me/noahxrp").length, 1);

console.log("linear onboarding multi-slide regression tests passed");
