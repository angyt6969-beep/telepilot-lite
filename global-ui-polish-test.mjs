import assert from "node:assert/strict";

const ui = await import(`./global-ui-polish.js?test=${Date.now()}`);

ui.configureGlobalUiPolishStickers([
  { emoji: "⚡️", custom_emoji_id: "1001" },
  { emoji: "✅", custom_emoji_id: "1002" },
  { emoji: "💡", custom_emoji_id: "1003" },
  { emoji: "📱", custom_emoji_id: "1004" },
  { emoji: "📝", custom_emoji_id: "1005" },
  { emoji: "📁", custom_emoji_id: "1006" },
  { emoji: "📆", custom_emoji_id: "1007" },
  { emoji: "📈", custom_emoji_id: "1008" },
  { emoji: "❗", custom_emoji_id: "1009" },
  { emoji: "👀", custom_emoji_id: "1010" },
  { emoji: "🔥", custom_emoji_id: "1011" },
  { emoji: "🪪", custom_emoji_id: "1012" },
]);

const existingPremium = "999999";
const source = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🔄 Refresh", callback_data: "d3_join_status" }],
      [{ text: "Cancel", callback_data: "cancel" }],
      [{ text: "📚 Browse", callback_data: "d2_browse:0" }],
      [{ text: "Already premium", callback_data: "keep", icon_custom_emoji_id: existingPremium, style: "primary" }],
    ],
  },
};

const polished = ui.polishGlobalUiPayload(
  "⚡ Destination join queue\nQueued  91\nJoined  4/91\nTelegram cooldown  600s",
  source,
);

assert.match(polished.text, /^⚡ Destination join queue\n\n/);
const entities = polished.other.entities || [];
const titleOffset = polished.text.indexOf("Destination join queue");
assert.ok(entities.some(entity => entity.type === "bold" && entity.offset === titleOffset), "Plain page title should become bold");
assert.ok(entities.some(entity => entity.type === "custom_emoji" && entity.offset === 0), "Page heading emoji should become premium");
for (const label of ["Queued", "Joined", "Telegram cooldown"]) {
  const offset = polished.text.indexOf(label);
  assert.ok(entities.some(entity => entity.type === "bold" && entity.offset === offset), `${label} should be bold`);
}

const buttons = polished.other.reply_markup.inline_keyboard.flat();
assert.equal(buttons[0].text, "Refresh");
assert.equal(buttons[0].icon_custom_emoji_id, "1001");
assert.equal(buttons[1].icon_custom_emoji_id, "1009");
assert.equal(buttons[1].style, "danger");
assert.equal(buttons[2].text, "Browse");
assert.equal(buttons[2].icon_custom_emoji_id, "1006");
assert.deepEqual(
  buttons[3],
  { text: "Already premium", callback_data: "keep", icon_custom_emoji_id: existingPremium, style: "primary" },
  "Existing premium buttons must be left untouched",
);

const preStyledText = "✅ Already polished\n\nStatus  ready";
const preStyled = ui.polishGlobalUiPayload(preStyledText, {
  entities: [
    { type: "custom_emoji", offset: 0, length: "✅".length, custom_emoji_id: "existing-emoji" },
    { type: "bold", offset: "✅ ".length, length: "Already polished".length },
  ],
  reply_markup: {
    inline_keyboard: [[{ text: "Keep me", callback_data: "keep2", icon_custom_emoji_id: "existing-button" }]],
  },
});
assert.equal(preStyled.text, preStyledText, "Existing entity-rich layout must not be rewritten");
assert.equal(preStyled.other.entities.filter(entity => entity.type === "custom_emoji" && entity.offset === 0).length, 1, "Existing premium heading must not be duplicated");
assert.equal(preStyled.other.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, "existing-button");

const previewText = "👁 Smart preview\n\nMessage preview:\n🔥 user supplied emoji\nsecond line";
const preview = ui.polishGlobalUiPayload(previewText, {
  reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "home" }]] },
});
const userEmojiOffset = preview.text.indexOf("🔥", preview.text.indexOf("Message preview:"));
assert.equal(
  (preview.other.entities || []).some(entity => entity.type === "custom_emoji" && entity.offset === userEmojiOffset),
  false,
  "User-supplied preview content must not be premiumized",
);

assert.equal(ui.__test.semanticEmojiForButton({ text: "Delete all", callback_data: "delete_all" }), "❗");
assert.equal(ui.__test.semanticEmojiForButton({ text: "Choose topic", callback_data: "topic_pick" }), "📝");
assert.equal(ui.__test.semanticEmojiForButton({ text: "30 min", callback_data: "interval_30" }), "📆");

console.log("TelePilot global UI polish checks passed");
