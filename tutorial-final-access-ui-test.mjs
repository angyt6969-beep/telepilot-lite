import assert from "node:assert/strict";
import { accessStartPayload, isInactiveAccessScreen, TELEPILOT_OWNER_USERNAME } from "./tutorial-final-access-ui.js";

const inactiveOther = {
  reply_markup: { inline_keyboard: [[{ text: "Redeem Key", callback_data: "redeem_key" }]] },
};
const realInactiveText = "🔐 TELEPILOT ACCESS\n\nAn access key is required to use TelePilot.\n\nNeed a key? Message @vvschrome to get yours.";
assert.equal(isInactiveAccessScreen(realInactiveText, inactiveOther), true, "the renderer must recognize app.js's real inactive /start screen");
assert.equal(isInactiveAccessScreen("🔑 ACCESS\n\nInactive", inactiveOther), true, "legacy inactive access wording remains supported");

const screen = accessStartPayload(
  "123456789",
  realInactiveText,
  inactiveOther,
  {
    checkoutUrl: "https://telepilot.example/checkout?t=signed-checkout",
    freeTrialUrl: "https://telepilot.example/free-trial?t=signed-trial",
  },
);
const rows = screen.other.reply_markup.inline_keyboard;
assert.deepEqual(rows.map(row => row[0].text), ["Redeem Key", "Buy Key", "Free 1-Day Key"]);
assert.equal(rows[0][0].callback_data, "redeem_key");
assert.equal(rows[1][0].url, "https://telepilot.example/checkout?t=signed-checkout");
assert.equal(rows[2][0].url, "https://telepilot.example/free-trial?t=signed-trial");
assert.equal(rows[2][0].icon_custom_emoji_id, "4983746717313664194");
assert.equal(TELEPILOT_OWNER_USERNAME, "vvschrome");
assert.match(screen.text, /Owner & support: @vvschrome/);
assert.doesNotMatch(screen.text, /tutorial/i);

const activeOther = {
  reply_markup: { inline_keyboard: [
    [{ text: "Redeem another key", callback_data: "redeem_key" }],
    [{ text: "Back", callback_data: "home" }],
  ] },
};
const active = accessStartPayload("123456789", "🔑 ACCESS\n\n✅ Active", activeOther, {
  checkoutUrl: "https://telepilot.example/checkout",
  freeTrialUrl: "https://telepilot.example/free-trial",
});
assert.equal(active.other, activeOther, "active access screen must not be replaced");
assert.equal(active.text, "🔑 ACCESS\n\n✅ Active");

console.log("TelePilot access start UI regression tests passed");
