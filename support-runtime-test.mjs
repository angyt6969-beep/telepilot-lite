import fs from "node:fs";
import path from "node:path";
import { Bot } from "grammy";
import { installInteractionEnhancements } from "./interaction-enhancements.js";
import { installMediaClearControl } from "./media-clear-control.js";
import { installOnboarding } from "./onboarding.js";
import { installProControls } from "./pro-controls.js";
import { installV1Controls } from "./v1-controls.js";
import { installV1Extras } from "./v1-extras.js";
import { installSupportCenter } from "./support-center.js";

const DATA_DIR = process.env.DATA_DIR || "/tmp/telepilot-support-runtime";
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, "telepilot-admin.json"), JSON.stringify({ version: 1, adminIds: ["123"] }));

// Replace grammY polling startup so the wrapper chain can register handlers without network access.
Bot.prototype.start = async function startForTest() { return undefined; };

installInteractionEnhancements(Bot);
installProControls(Bot);
installMediaClearControl(Bot);
installV1Controls(Bot);
installV1Extras(Bot);
installOnboarding(Bot);
installSupportCenter(Bot);

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

// Mirror the important shape of app middleware/handlers that exist before bot.start().
bot.use(async (ctx, next) => next());
bot.callbackQuery("tools", async ctx => { await ctx.answerCallbackQuery(); });
bot.callbackQuery("admin", async ctx => { await ctx.answerCallbackQuery(); });

await bot.start();

const calls = [];
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (method === "answerCallbackQuery") return true;
  if (method === "editMessageText") return { message_id: 1, date: 0, chat: { id: 123, type: "private" }, text: String(payload.text || "") };
  if (method === "sendMessage") return { message_id: 2, date: 0, chat: { id: 123, type: "private" }, text: String(payload.text || "") };
  return true;
});

function callbackUpdate(id, data) {
  return {
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      from: { id: 123, is_bot: false, first_name: "Admin", username: "noahxrp" },
      chat_instance: "ci",
      data,
      message: { message_id: 1, date: 0, chat: { id: 123, type: "private" }, text: "screen" },
    },
  };
}

await bot.handleUpdate(callbackUpdate(1, "support"));
if (!calls.some(call => call.method === "answerCallbackQuery")) throw new Error("support callback was not answered");
if (!calls.some(call => call.method === "editMessageText" && String(call.payload.text || "").includes("TelePilot Support"))) throw new Error("support screen was not rendered");

calls.length = 0;
await bot.handleUpdate(callbackUpdate(2, "support_admin"));
if (!calls.some(call => call.method === "answerCallbackQuery")) throw new Error("support_admin callback was not answered");
if (!calls.some(call => call.method === "editMessageText" && String(call.payload.text || "").includes("SUPPORT CASES"))) throw new Error("support admin cases screen was not rendered");

console.log("support runtime callbacks ok");
