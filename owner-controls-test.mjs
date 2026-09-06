import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-owner-controls-"));
process.env.DATA_DIR = temp;
process.env.TELEPILOT_SECURITY_SECRET = "owner-controls-test-secret-owner-controls-test-secret-123456";
fs.writeFileSync(path.join(temp, "telepilot-settings.json"), JSON.stringify({ ownerId: "777" }));

const {
  ACCOUNTS_BUTTON_CUSTOM_EMOJI_ID,
  START_BUTTON_CUSTOM_EMOJI_ID,
  STOP_BUTTON_CUSTOM_EMOJI_ID,
  polishOwnerControlsPayload,
} = await import("./owner-controls.js");

const baseKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "▶ Start", callback_data: "start" }, { text: "⏹ Stop", callback_data: "stop" }],
      [{ text: "👤 Accounts", callback_data: "v1_accounts_v13" }, { text: "📁 Destinations", callback_data: "v1_destinations_v13" }],
      [{ text: "🟣 ADMIN PANEL", callback_data: "admin" }],
    ],
  },
};

const ready = polishOwnerControlsPayload(777, "✈️ TelePilot\n● READY\n\nReady to start in one tap.", baseKeyboard);
const readyButtons = ready.other.reply_markup.inline_keyboard.flat();
assert.equal(readyButtons.filter(button => button.callback_data === "start").length, 1, "Stopped dashboard must have exactly one Start button");
assert.equal(readyButtons.filter(button => button.callback_data === "stop").length, 0, "Stopped dashboard must not show Stop");
assert.equal(readyButtons.find(button => button.callback_data === "start")?.icon_custom_emoji_id, START_BUTTON_CUSTOM_EMOJI_ID, "Start premium emoji must stay explicit");
assert.equal(readyButtons.find(button => button.callback_data === "v1_accounts_v13")?.icon_custom_emoji_id, ACCOUNTS_BUTTON_CUSTOM_EMOJI_ID, "Accounts must use the requested premium emoji");
assert.equal(ready.other.reply_markup.inline_keyboard[0].length, 1, "Start must occupy its own full-width row");

const live = polishOwnerControlsPayload(777, "✈️ TelePilot\n● LIVE\n\nPosting is running. Changes apply to the next safe cycle.", baseKeyboard);
const liveButtons = live.other.reply_markup.inline_keyboard.flat();
assert.equal(liveButtons.filter(button => button.callback_data === "start").length, 0, "Live dashboard must not show Start");
assert.equal(liveButtons.filter(button => button.callback_data === "stop").length, 1, "Live dashboard must have exactly one Stop button");
assert.equal(liveButtons.find(button => button.callback_data === "stop")?.icon_custom_emoji_id, STOP_BUTTON_CUSTOM_EMOJI_ID, "Stop must use the requested premium emoji");
assert.equal(live.other.reply_markup.inline_keyboard[0].length, 1, "Stop must occupy its own full-width row");

fs.writeFileSync(path.join(temp, "telepilot-admin-team.json"), JSON.stringify({
  version: 1,
  owners: ["777"],
  admins: [{ id: "888", status: "active", addedAt: Date.now(), addedBy: "777" }],
}));

const adminPanel = polishOwnerControlsPayload(888, "🟣 TELEPILOT ADMIN\n\n🟢 Service: Online", {
  reply_markup: {
    inline_keyboard: [
      [{ text: "👥 Users", callback_data: "admin_users:0" }, { text: "🔑 Keys", callback_data: "admin_keys" }],
      [{ text: "🔐 Security", callback_data: "admin_security" }],
      [{ text: "👑 Admin Team", callback_data: "admin_team" }],
      [{ text: "🔌 Disconnect Account", callback_data: "admin_user_disconnect:123:0" }],
      [{ text: "♻️ Reset Configuration", callback_data: "admin_user_reset:123:0" }],
      [{ text: "⬅️ Back", callback_data: "home" }],
    ],
  },
});
const delegatedButtons = adminPanel.other.reply_markup.inline_keyboard.flat();
assert.ok(delegatedButtons.some(button => button.callback_data === "admin_users:0"), "Delegated admins must retain customer management");
assert.ok(delegatedButtons.some(button => button.callback_data === "admin_keys"), "Delegated admins must retain key management entry");
assert.ok(!delegatedButtons.some(button => button.callback_data === "admin_security"), "Security controls must remain owner-only");
assert.ok(!delegatedButtons.some(button => button.callback_data === "admin_team"), "Admin-team management must remain owner-only");
assert.ok(!delegatedButtons.some(button => String(button.callback_data || "").includes("_disconnect")), "Delegated admins must not disconnect customer accounts");
assert.ok(!delegatedButtons.some(button => String(button.callback_data || "").includes("_reset")), "Delegated admins must not reset customer configurations");

console.log("TelePilot owner/admin control checks passed");
