import assert from "node:assert/strict";
import { decorateV13ForwardedPostMenu } from "./forwarded-post-v13-ui-fix.js";

const currentMessageScreen = {
  text: [
    "📝 Message",
    "● Ready · 7 characters",
    "",
    "Your formatting, links and custom emoji are preserved.",
  ].join("\n"),
  reply_markup: {
    inline_keyboard: [
      [
        { text: "Preview", callback_data: "message_preview" },
        { text: "Edit message", callback_data: "message_change" },
      ],
      [
        { text: "Templates", callback_data: "v1_templates" },
        { text: "Test send", callback_data: "v1_test_send" },
      ],
      [{ text: "← Posting Setup", callback_data: "v1_posting_setup_v13" }],
    ],
  },
};

const normal = decorateV13ForwardedPostMenu("12345", currentMessageScreen, {
  readConfig: () => ({ enabled: false, sourcePeer: "", sourceMessageId: 0 }),
});
const normalFlat = normal.reply_markup.inline_keyboard.flat();
assert.equal(normalFlat.some(button => button.callback_data === "fp_setup"), true);
assert.equal(normalFlat.findIndex(button => button.callback_data === "fp_setup") < normalFlat.findIndex(button => button.callback_data === "v1_posting_setup_v13"), true);
assert.match(normal.text, /Mode — Normal Post/);

const enabled = decorateV13ForwardedPostMenu("12345", currentMessageScreen, {
  readConfig: () => ({
    enabled: true,
    sourcePeer: "@premiumsource",
    sourceMessageId: 91,
    sourceLabel: "Premium Source",
  }),
});
const enabledFlat = enabled.reply_markup.inline_keyboard.flat();
assert.equal(enabledFlat.some(button => button.callback_data === "fp_setup" && button.text === "Forwarded Post ✓"), true);
assert.equal(enabledFlat.some(button => button.callback_data === "fp_normal"), true);
assert.match(enabled.text, /Mode — Forwarded Post · Premium Source/);

const secondPass = decorateV13ForwardedPostMenu("12345", enabled, {
  readConfig: () => ({
    enabled: true,
    sourcePeer: "@premiumsource",
    sourceMessageId: 91,
    sourceLabel: "Premium Source",
  }),
});
assert.equal(secondPass.reply_markup.inline_keyboard.flat().filter(button => String(button.callback_data || "").startsWith("fp_")).length, 2);


const messyModePass = decorateV13ForwardedPostMenu("12345", {
  ...enabled,
  text: `${enabled.text.replace("Mode —", "Mode: —")}\n\n<b>Mode:</b> — Normal Post`,
}, {
  readConfig: () => ({
    enabled: true,
    sourcePeer: "@premiumsource",
    sourceMessageId: 91,
    sourceLabel: "Premium Source",
  }),
});
const messyPlain = messyModePass.text.replace(/<[^>]+>/g, "").replace(/[*_`~]/g, "");
assert.equal((messyPlain.match(/^Mode\s*:?\s*[—-]/gmi) || []).length, 1);
assert.match(messyModePass.text, /Mode — Forwarded Post · Premium Source/);

const unrelated = decorateV13ForwardedPostMenu("12345", {
  text: "📝 Posting Setup",
  reply_markup: currentMessageScreen.reply_markup,
}, {
  readConfig: () => ({ enabled: false }),
});
assert.equal(unrelated.reply_markup.inline_keyboard.flat().some(button => String(button.callback_data || "").startsWith("fp_")), false);

console.log("forwarded post v1.3 UI fix tests passed");
