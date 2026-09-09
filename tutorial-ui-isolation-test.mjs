import assert from "node:assert/strict";
import { isolateTutorialPayload, TUTORIAL_GET_KEY_EMOJI_ID } from "./tutorial-ui-isolation.js";

const slide2 = isolateTutorialPayload(
  '<tg-emoji emoji-id="5231361378748472914">✈️</tg-emoji> <b><i>Choose your sender</i></b>\n<i>Slide 2 of 5</i>',
  {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 Dashboard", callback_data: "v1_dashboard_v13" },
          { text: "Next", callback_data: "linear_tutorial:3" },
        ],
      ],
    },
  },
);
const slide2Buttons = slide2.other.reply_markup.inline_keyboard.flat();
assert.equal(slide2Buttons.some(button => button.callback_data === "v1_dashboard_v13"), false);
assert.equal(slide2Buttons.some(button => /dashboard/i.test(button.text || "")), false);
assert.equal(slide2Buttons.some(button => button.callback_data === "linear_tutorial:1" && button.text === "Back"), true);
assert.equal(slide2Buttons.some(button => button.callback_data === "linear_tutorial:3"), true);
assert.match(slide2.text, /Personal account:<\/b> — Post as your Telegram account\./);
assert.match(slide2.text, /Connection:<\/b> — Personal account login uses TelePilot's protected flow\./);

const slide4 = isolateTutorialPayload(
  '<tg-emoji emoji-id="5231361378748472914">✈️</tg-emoji> <b><i>Build your post</i></b>\n<i>Slide 4 of 5</i>',
  {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13" }, { text: "Next", callback_data: "linear_tutorial:5" }],
      ],
    },
  },
);
assert.equal(slide4.other.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "linear_tutorial:3"), true);
assert.equal(slide4.other.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "v1_dashboard_v13"), false);
assert.match(slide4.text, /Normal Post:<\/b> — Create a message or media post\./);
assert.match(slide4.text, /Smart Preview:<\/b> — Review everything before going live\./);
assert.doesNotMatch(slide4.text, /supported media|selected source message|when needed/);

const slide5 = isolateTutorialPayload(
  '<tg-emoji emoji-id="5231361378748472914">✈️</tg-emoji> <b><i>You\'re ready</i></b>\n<i>Slide 5 of 5</i>\n🔑 <b>Access:</b> — Key required',
  {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13" }],
        [{ text: "Redeem Key", callback_data: "redeem_key" }],
        [{ text: "Get a Key", url: "https://t.me/vvschrome", icon_custom_emoji_id: "old" }],
      ],
    },
  },
);
const slide5Buttons = slide5.other.reply_markup.inline_keyboard.flat();
assert.equal(slide5Buttons.some(button => button.callback_data === "linear_tutorial:4" && button.text === "Back"), true);
assert.equal(slide5Buttons.some(button => button.callback_data === "linear_onboarding_complete"), false);
const getKey = slide5Buttons.find(button => button.text === "Get a Key");
assert.ok(getKey);
assert.equal(getKey.icon_custom_emoji_id, TUTORIAL_GET_KEY_EMOJI_ID);
assert.equal(getKey.icon_custom_emoji_id, "5307843983102204243");
assert.match(slide5.text, /Setup flow/);
assert.match(slide5.text, /Sender:<\/b> — Who posts/);

// v1.3's generic router changes both Back and Open Dashboard to the same
// Dashboard callback before the tutorial isolation layer sees them. The success
// style/check icon identifies the real final action and must be restored.
const activeSlide5 = isolateTutorialPayload(
  '<tg-emoji emoji-id="5231361378748472914">✈️</tg-emoji> <b><i>You\'re ready</i></b>\n<i>Slide 5 of 5</i>\n🟢 <b>Access:</b> — Active',
  {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13", icon_custom_emoji_id: "5411590687663608498" }],
        [{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13", icon_custom_emoji_id: "5206607081334906820", style: "success" }],
      ],
    },
  },
);
const activeRows = activeSlide5.other.reply_markup.inline_keyboard;
const activeButtons = activeRows.flat();
assert.equal(activeRows.length, 1);
assert.equal(activeButtons.length, 2);
assert.equal(activeButtons.filter(button => button.callback_data === "linear_tutorial:4" && button.text === "Back").length, 1);
assert.equal(activeButtons.filter(button => button.callback_data === "linear_onboarding_complete" && button.text === "Open Dashboard").length, 1);
assert.equal(activeButtons.find(button => button.callback_data === "linear_onboarding_complete")?.style, "success");
assert.equal(activeButtons.find(button => button.callback_data === "linear_onboarding_complete")?.icon_custom_emoji_id, "5206607081334906820");
assert.match(activeSlide5.text, /Access:<\/b> — Active/);
assert.match(activeSlide5.text, /Open Dashboard to start building your setup\./);

const nonTutorial = isolateTutorialPayload("📊 Dashboard", {
  reply_markup: { inline_keyboard: [[{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13" }]] },
});
assert.equal(nonTutorial.other.reply_markup.inline_keyboard[0][0].callback_data, "v1_dashboard_v13");

console.log("tutorial UI isolation regression tests passed");
