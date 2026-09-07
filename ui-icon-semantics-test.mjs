import assert from "node:assert/strict";

const ui = await import(`./ui-icon-semantics.js?test=${Date.now()}`);

ui.configureUiIconSemanticsStickers([
  { emoji: "⚡️", custom_emoji_id: "electric" },
  { emoji: "🔥", custom_emoji_id: "fire" },
  { emoji: "💡", custom_emoji_id: "idea" },
  { emoji: "📱", custom_emoji_id: "account" },
  { emoji: "📝", custom_emoji_id: "message" },
  { emoji: "📁", custom_emoji_id: "folder" },
  { emoji: "📆", custom_emoji_id: "calendar" },
  { emoji: "📈", custom_emoji_id: "stats" },
  { emoji: "❗", custom_emoji_id: "danger" },
  { emoji: "👀", custom_emoji_id: "view" },
  { emoji: "🪪", custom_emoji_id: "access" },
  { emoji: "✅", custom_emoji_id: "done" },
  { emoji: "⬅️", custom_emoji_id: "previous" },
  { emoji: "➡️", custom_emoji_id: "next" },
]);

const corrected = ui.correctUiIconPayload(
  "⚡ Preparing destinations…\n\n↻ Check access when ready.",
  {
    entities: [{ type: "custom_emoji", offset: 0, length: "⚡".length, custom_emoji_id: "electric" }],
    reply_markup: {
      inline_keyboard: [
        [{ text: "◀", callback_data: "d2_browse:0" }, { text: "2/10", callback_data: "d2_noop" }, { text: "▶", callback_data: "d2_browse:2" }],
        [{ text: "⚡ Join + prepare all", callback_data: "d3_prepare:token" }],
        [{ text: "📚 Browse", callback_data: "d2_browse:0" }],
        [{ text: "⚙️ Settings", callback_data: "v1_settings_v13" }],
        [{ text: "Cancel", callback_data: "cancel" }],
        [{ text: "Mystery action", callback_data: "mystery_action" }],
        [{ text: "Settings", callback_data: "v1_settings_v13", icon_custom_emoji_id: "electric" }],
        [{ text: "Already premium", callback_data: "keep", icon_custom_emoji_id: "existing", style: "primary" }],
      ],
    },
  },
);

const buttons = corrected.other.reply_markup.inline_keyboard.flat();
assert.equal(buttons[0].text, "Previous");
assert.equal(buttons[0].icon_custom_emoji_id, "previous");
assert.equal(buttons[2].text, "Next");
assert.equal(buttons[2].icon_custom_emoji_id, "next");
assert.equal(buttons[3].text, "Join + prepare all");
assert.equal(buttons[3].icon_custom_emoji_id, "fire", "Join must use action/fire semantics, not electricity");
assert.equal(buttons[4].text, "Browse");
assert.equal(buttons[4].icon_custom_emoji_id, "folder");
assert.equal(buttons[5].text, "Settings");
assert.equal(buttons[5].icon_custom_emoji_id, "idea");
assert.equal(buttons[6].icon_custom_emoji_id, "danger");
assert.equal(buttons[7].icon_custom_emoji_id, "idea", "Unknown actions use a neutral premium action icon, never electricity");
assert.equal(buttons[8].icon_custom_emoji_id, "idea", "An inherited generic electricity icon must be replaced by the button's real meaning");
assert.deepEqual(buttons[9], { text: "Already premium", callback_data: "keep", icon_custom_emoji_id: "existing", style: "primary" });
assert.equal(buttons.some(button => button.icon_custom_emoji_id === "electric"), false, "Generic electricity icon must not leak into corrected buttons");

const entities = corrected.other.entities || [];
assert.ok(entities.some(entity => entity.type === "custom_emoji" && entity.offset === 0 && entity.custom_emoji_id === "fire"), "Inherited electricity heading icon should be replaced by action/fire semantics");
const refreshOffset = corrected.text.indexOf("↻");
assert.equal(
  entities.some(entity => entity.type === "custom_emoji" && entity.offset === refreshOffset && entity.custom_emoji_id === "electric"),
  false,
  "Plain refresh symbol must never inherit the generic electricity premium icon",
);

const previewText = "👀 Smart preview\n\nMessage preview:\n⚡ user content";
const preview = ui.correctUiIconPayload(previewText, { reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "home" }]] } });
const userEmojiOffset = previewText.lastIndexOf("⚡");
assert.equal((preview.other.entities || []).some(entity => entity.type === "custom_emoji" && entity.offset === userEmojiOffset), false, "User message preview content must remain untouched");

assert.equal(ui.__test.navigationKind("◀"), "previous");
assert.equal(ui.__test.navigationKind("▶"), "next");
console.log("TelePilot UI icon semantic correction checks passed");
