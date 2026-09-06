import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-v13-visual-"));
process.env.DATA_DIR = temp;
fs.writeFileSync(path.join(temp, "telepilot-settings.json"), JSON.stringify({ ownerId: "777" }));

const {
  SETTINGS_BUTTON_CUSTOM_EMOJI_ID,
  START_BUTTON_CUSTOM_EMOJI_ID,
  polishTelePilotPayload,
} = await import("./ux-v13-visual-polish.js");

const dashboard = polishTelePilotPayload(777, [
  "✈️ TelePilot",
  "● READY",
  "",
  "✓ Sender  Main account",
].join("\n"), {
  reply_markup: {
    inline_keyboard: [
      [{ text: "▶ Start", callback_data: "start" }, { text: "⏹ Stop", callback_data: "stop" }],
      [{ text: "⚙️ Settings", callback_data: "v1_settings_v13" }],
    ],
  },
});

const dashboardButtons = dashboard.other.reply_markup.inline_keyboard.flat();
const start = dashboardButtons.find(button => button.callback_data === "start");
const settings = dashboardButtons.find(button => button.callback_data === "v1_settings_v13");
const admin = dashboardButtons.find(button => button.callback_data === "admin");
assert.equal(start?.icon_custom_emoji_id, START_BUTTON_CUSTOM_EMOJI_ID, "Start must use the owner-selected premium emoji ID");
assert.equal(start?.text, "Start", "Start must not render a duplicate Unicode icon beside its premium icon");
assert.equal(settings?.icon_custom_emoji_id, SETTINGS_BUTTON_CUSTOM_EMOJI_ID, "Settings must use the owner-selected premium emoji ID");
assert.equal(settings?.text, "Settings", "Settings must not render a duplicate Unicode icon beside its premium icon");
assert.ok(admin, "Legacy ownerId must still receive the ADMIN PANEL button on the v1.3 Dashboard");
assert.equal(dashboard.other.reply_markup.inline_keyboard.at(-1)?.[0]?.callback_data, "admin", "ADMIN PANEL should remain the final Dashboard row");

const nonAdmin = polishTelePilotPayload(888, "✈️ TelePilot\n○ SETUP", {
  reply_markup: { inline_keyboard: [[{ text: "⚙️ Settings", callback_data: "v1_settings_v13" }]] },
});
assert.ok(!nonAdmin.other.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "admin"), "ADMIN PANEL must never be added for non-admin users");

const posting = polishTelePilotPayload(888, [
  "📝 Posting Setup",
  "",
  "Sender  2 personal accounts",
  "Message  Ready · 123 chars",
  "Destinations  18 active / 20 saved",
  "Timing  every 10 min",
].join("\n"), {
  entities: [{ type: "bold", offset: 0, length: 2 }],
  reply_markup: {
    inline_keyboard: [
      [{ text: "📊 Dashboard", callback_data: "v1_dashboard_v13" }],
      [{ text: "📝 Message", callback_data: "message" }],
    ],
  },
});

assert.ok(posting.text.includes("Sender: — 2 personal accounts"), "Posting Setup summary must use colon + em-dash formatting");
assert.ok(posting.text.includes("Message: — Ready · 123 chars"), "Posting Setup message row must use colon + em-dash formatting");
assert.ok(posting.text.includes("Destinations: — 18 active / 20 saved"), "Posting Setup destination row must use colon + em-dash formatting");
assert.ok(posting.text.includes("Timing: — every 10 min"), "Posting Setup timing row must use colon + em-dash formatting");
const titleOffset = posting.text.indexOf("Posting Setup");
assert.ok(posting.other.entities.some(entity => entity.type === "bold" && entity.offset === titleOffset && entity.length === "Posting Setup".length), "Posting Setup header must be bold");
assert.ok(posting.other.entities.some(entity => entity.type === "italic" && entity.offset === titleOffset && entity.length === "Posting Setup".length), "Posting Setup header must be italic");
const senderOffset = posting.text.indexOf("Sender:");
assert.ok(posting.other.entities.some(entity => entity.type === "bold" && entity.offset === senderOffset && entity.length === "Sender".length), "Overview labels must be bold");
assert.ok(posting.other.entities.some(entity => entity.type === "italic" && entity.offset === senderOffset && entity.length === "Sender".length), "Overview labels must be italic");
assert.equal(posting.other.reply_markup.inline_keyboard.at(-1)?.[0]?.callback_data, "v1_dashboard_v13", "Back/Dashboard navigation must always be below action buttons");

for (const [title, sample] of [
  ["📈 Activity", "Last post  2m ago"],
  ["👤 Accounts", "Connected  2 accounts"],
  ["📁 Destinations", "Ready  18 / 20"],
  ["⚙️ Settings", "Access  Lifetime"],
]) {
  const result = polishTelePilotPayload(888, `${title}\n\n${sample}`, { reply_markup: { inline_keyboard: [] } });
  assert.ok(result.text.includes(": — "), `${title} must use colon + em-dash summary formatting`);
  const label = title.replace(/^[^\p{L}\p{N}]+/u, "");
  const offset = result.text.indexOf(label);
  assert.ok(result.other.entities.some(entity => entity.type === "bold" && entity.offset === offset), `${title} must have a bold header`);
  assert.ok(result.other.entities.some(entity => entity.type === "italic" && entity.offset === offset), `${title} must have an italic header`);
}

const child = polishTelePilotPayload(888, "🔎 Destination Details", {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📁 Destinations", callback_data: "v1_destinations_v13" }],
      [{ text: "📝 Add Note", callback_data: "v1_dest_note_v13" }],
      [{ text: "Disable", callback_data: "v1_dest_disable_v13:x" }],
    ],
  },
});
assert.equal(child.other.reply_markup.inline_keyboard.at(-1)?.[0]?.callback_data, "v1_destinations_v13", "Parent-section navigation must be the final row on child screens");

console.log("TelePilot v1.3 visual polish checks passed");
