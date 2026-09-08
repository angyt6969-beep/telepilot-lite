import assert from "node:assert/strict";
import { finalTutorialAccessPayload } from "./tutorial-final-access-ui.js";

const active = finalTutorialAccessPayload(
  "123456789",
  [
    '<tg-emoji emoji-id="5231361378748472914">✈️</tg-emoji> <b><i>You\'re ready</i></b>',
    '<i>Slide 5 of 5</i>',
    '',
    '✅ <b>Tutorial:</b> — Complete',
    '🟢 <b>Access:</b> — Active',
    '',
    '<b><i>Setup flow</i></b>',
    '',
    '<b>Sender:</b> — Who posts',
    '<b>Destinations:</b> — Where it posts',
    '<b>Message:</b> — What gets posted',
    '<b>Timing:</b> — When it posts',
    '',
    '<i>Open Dashboard to start building your setup.</i>',
  ].join("\n"),
  {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "Back", callback_data: "linear_tutorial:4" },
        { text: "Open Dashboard", callback_data: "linear_onboarding_complete", style: "success" },
      ]],
    },
  },
  {
    checkoutUrl: "https://telepilot.example/checkout?t=signed-checkout",
    freeTrialUrl: "https://telepilot.example/free-trial?t=signed-trial",
  },
);

const rows = active.other.reply_markup.inline_keyboard;
assert.deepEqual(rows.map(row => row[0].text), [
  "Redeem a Key",
  "Purchase a Key",
  "Claim your Free 1 day key!",
  "Contact @noahxrp",
  "Back",
]);
assert.equal(rows[0][0].callback_data, "redeem_key");
assert.equal(rows[1][0].url, "https://telepilot.example/checkout?t=signed-checkout");
assert.equal(rows[2][0].url, "https://telepilot.example/free-trial?t=signed-trial");
assert.equal(rows[2][0].icon_custom_emoji_id, "4983746717313664194");
assert.equal(rows[3][0].url, "https://t.me/noahxrp");
assert.equal(rows[4][0].callback_data, "linear_tutorial:4");
assert.doesNotMatch(active.text, /Open Dashboard to start building/i);
assert.match(active.text, /purchase a key, claim your free 1-day tutorial key, or contact @noahxrp/i);

const locked = finalTutorialAccessPayload(
  "123456789",
  '<b><i>You\'re ready</i></b>\n<i>Slide 5 of 5</i>\n🔑 <b>Access:</b> — Key required\n\n<i>Redeem a key to continue. Need one? Message @noahxrp.</i>',
  { reply_markup: { inline_keyboard: [] } },
  {
    checkoutUrl: "https://telepilot.example/checkout?t=signed-checkout",
    freeTrialUrl: "https://telepilot.example/free-trial?t=signed-trial",
  },
);
assert.doesNotMatch(locked.text, /Need one\? Message/i);
assert.match(locked.text, /claim your free 1-day tutorial key/i);

const nonFinalOther = { reply_markup: { inline_keyboard: [[{ text: "Next", callback_data: "linear_tutorial:3" }]] } };
const nonFinal = finalTutorialAccessPayload("123456789", "<i>Slide 2 of 5</i>", nonFinalOther, {
  checkoutUrl: "https://telepilot.example/checkout",
  freeTrialUrl: "https://telepilot.example/free-trial",
});
assert.equal(nonFinal.other, nonFinalOther);
assert.equal(nonFinal.text, "<i>Slide 2 of 5</i>");

console.log("tutorial final access UI regression tests passed");
