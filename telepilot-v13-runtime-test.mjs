import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-v13-runtime-"));
process.env.DATA_DIR = temp;
process.env.TELEPILOT_SECURITY_SECRET ||= "v13-runtime-security-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
process.env.TELEPILOT_SESSION_KEY_B64 ||= Buffer.alloc(32, 13).toString("base64");
process.env.TELEPILOT_SUPPORT_USERNAME ||= "noahxrp";

// Test double: prevent network polling while preserving the real grammY middleware router.
Bot.prototype.start = async function startForTest() { return undefined; };

const { installUxV13Navigation } = await import("./ux-v13.js");
const { readQolState } = await import("./qol-store.js");
installUxV13Navigation(Bot);

const bot = new Bot("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", {
  botInfo: {
    id: 123456,
    is_bot: true,
    first_name: "TelePilot",
    username: "TelePilottBot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  },
});

let fallbackTextCalls = 0;
bot.on("message:text", async () => { fallbackTextCalls++; });
await bot.start();

const calls = [];
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (method === "answerCallbackQuery") return { ok: true, result: true };
  if (method === "deleteMessage") return { ok: true, result: true };
  if (method === "editMessageText") return { ok: true, result: { message_id: Number(payload.message_id || 1), date: 0, chat: { id: Number(payload.chat_id || 777), type: "private" }, text: String(payload.text || "") } };
  if (method === "sendMessage") return { ok: true, result: { message_id: 2, date: 0, chat: { id: Number(payload.chat_id || 777), type: "private" }, text: String(payload.text || "") } };
  return { ok: true, result: true };
});

function callbackUpdate(id, data, uid = 777) {
  return {
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      from: { id: uid, is_bot: false, first_name: "Tester", username: "telepilot_test" },
      chat_instance: "v13-ci",
      data,
      message: { message_id: 1, date: 0, chat: { id: uid, type: "private" }, text: "screen" },
    },
  };
}
function messageUpdate(id, text, uid = 777) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      from: { id: uid, is_bot: false, first_name: "Tester", username: "telepilot_test" },
      chat: { id: uid, type: "private", first_name: "Tester", username: "telepilot_test" },
      text,
    },
  };
}

calls.length = 0;
await bot.handleUpdate(callbackUpdate(1, "v1_dashboard_v13"));
const dashboardEdit = calls.find(call => call.method === "editMessageText");
assert.ok(dashboardEdit, "Dashboard callback did not render");
assert.ok(String(dashboardEdit.payload.text || "").startsWith("✈️ TelePilot"), "Dashboard text missing");
const dashboardButtons = (dashboardEdit.payload.reply_markup?.inline_keyboard || []).flat();
assert.ok(dashboardButtons.some(button => button.callback_data === "v1_activity_v13"), "Activity button missing from dashboard");
assert.ok(dashboardButtons.some(button => button.callback_data === "v1_posting_setup_v13"), "Posting Setup button missing from dashboard");
assert.ok(!dashboardButtons.some(button => button.callback_data === "home"), "Redundant Home callback remains on dashboard");

calls.length = 0;
await bot.handleUpdate(callbackUpdate(2, "v1_dest_search_v13"));
assert.equal(readQolState("777").pendingInput?.type, "destination_search", "Destination search did not persist its input state");
await bot.handleUpdate(messageUpdate(3, "marketplace"));
assert.equal(fallbackTextCalls, 0, "QOL text input leaked into the legacy text handler");
assert.equal(readQolState("777").destinationSearch, "marketplace", "Destination search text was not persisted");
assert.equal(readQolState("777").pendingInput, null, "Destination search pending input was not cleared");
assert.ok(calls.some(call => call.method === "deleteMessage"), "Consumed QOL input was not cleaned up");
assert.ok(calls.some(call => call.method === "editMessageText" && String(call.payload.text || "").includes("Browse Destinations")), "Search result screen was not rendered");

// Normal text must still reach the app after QOL input state is complete.
await bot.handleUpdate(messageUpdate(4, "normal text"));
assert.equal(fallbackTextCalls, 1, "Normal text did not continue to the app handler after QOL input completed");

console.log("TelePilot v1.3 runtime navigation checks passed");
