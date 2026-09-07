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

const slide5 = isolateTutorialPayload(
  '<tg-emoji emoji-id="5231361378748472914">✈️</tg-emoji> <b><i>You\'re ready</i></b>\n<i>Slide 5 of 5</i>',
  {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13" }],
        [{ text: "Redeem Key", callback_data: "redeem_key" }],
        [{ text: "Get a Key", url: "https://t.me/noahxrp", icon_custom_emoji_id: "old" }],
      ],
    },
  },
);
const slide5Buttons = slide5.other.reply_markup.inline_keyboard.flat();
assert.equal(slide5Buttons.some(button => button.callback_data === "linear_tutorial:4" && button.text === "Back"), true);
const getKey = slide5Buttons.find(button => button.text === "Get a Key");
assert.ok(getKey);
assert.equal(getKey.icon_custom_emoji_id, TUTORIAL_GET_KEY_EMOJI_ID);
assert.equal(getKey.icon_custom_emoji_id, "5307843983102204243");

const nonTutorial = isolateTutorialPayload("📊 Dashboard", {
  reply_markup: { inline_keyboard: [[{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13" }]] },
});
assert.equal(nonTutorial.other.reply_markup.inline_keyboard[0][0].callback_data, "v1_dashboard_v13");

console.log("tutorial UI isolation regression tests passed");
