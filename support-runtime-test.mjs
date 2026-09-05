import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Bot } from "grammy";
import { installInteractionEnhancements } from "./interaction-enhancements.js";
import { installMediaClearControl } from "./media-clear-control.js";
import { installOnboarding } from "./onboarding.js";
import { installProControls } from "./pro-controls.js";
import { installV1Controls } from "./v1-controls.js";
import { installV1Extras } from "./v1-extras.js";
import { installSupportCenter } from "./support-center.js";
import { installSupportCenterEarly } from "./support-bootstrap.js";

const MODE = process.env.SUPPORT_TEST_MODE || "all";
const DATA_DIR = process.env.DATA_DIR || "/tmp/telepilot-support-runtime";
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, "telepilot-admin.json"), JSON.stringify({ version: 1, adminIds: ["123"] }));

Bot.prototype.start = async function startForTest() { return undefined; };

if (MODE !== "support-only") {
  installInteractionEnhancements(Bot);
  installProControls(Bot);
  installMediaClearControl(Bot);
  installV1Controls(Bot);
  installV1Extras(Bot);
}
installSupportCenterEarly(Bot, installSupportCenter);
if (MODE !== "support-only") installOnboarding(Bot);

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

bot.command("start", async ctx => {
  await ctx.reply("APP START");
});

bot.callbackQuery("baseline", async ctx => {
  if (ctx.chat?.type !== "private" || String(ctx.from?.id || "") !== "123") {
    throw new Error(`${MODE}: callback context is not private/user-bound`);
  }
  await ctx.answerCallbackQuery();
});

if (MODE === "all-use" || MODE === "all-handlers" || MODE === "all") {
  bot.use(async (ctx, next) => next());
}
if (MODE === "all-handlers" || MODE === "all") {
  bot.callbackQuery("tools", async ctx => { await ctx.answerCallbackQuery(); });
  bot.callbackQuery("admin", async ctx => { await ctx.answerCallbackQuery(); });
}

await bot.start();
if (!bot.__telepilotSupportHandlersRegistered) throw new Error(`${MODE}: support handlers did not register`);

const calls = [];
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (method === "answerCallbackQuery") return { ok: true, result: true };
  if (method === "editMessageText") return { ok: true, result: { message_id: 1, date: 0, chat: { id: Number(payload.chat_id || 123), type: "private" }, text: String(payload.text || "") } };
  if (method === "sendMessage") return { ok: true, result: { message_id: 2, date: 0, chat: { id: Number(payload.chat_id || 123), type: "private" }, text: String(payload.text || "") } };
  return { ok: true, result: true };
});

function callbackUpdate(id, data, uid = 123, username = "noahxrp") {
  return {
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      from: { id: uid, is_bot: false, first_name: uid === 123 ? "Admin" : "Alt", username },
      chat_instance: "ci",
      data,
      message: { message_id: 1, date: 0, chat: { id: uid, type: "private" }, text: "screen" },
    },
  };
}

function messageUpdate(id, uid, text) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      from: { id: uid, is_bot: false, first_name: "Alt", username: "telepilot_alt" },
      chat: { id: uid, type: "private", first_name: "Alt", username: "telepilot_alt" },
      text,
      entities: [{ offset: 0, length: text.length, type: "bot_command" }],
    },
  };
}

function deletedHash(uid) {
  return crypto.createHash("sha256").update(`telepilot-deleted-user:${String(uid)}`).digest("hex");
}

await bot.handleUpdate(callbackUpdate(0, "baseline"));
if (!calls.some(call => call.method === "answerCallbackQuery")) throw new Error(`${MODE}: baseline callback was not answered`);

calls.length = 0;
await bot.handleUpdate(callbackUpdate(1, "support"));
if (!calls.some(call => call.method === "answerCallbackQuery")) throw new Error(`${MODE}: support callback was not answered`);
if (!calls.some(call => call.method === "editMessageText" && String(call.payload.text || "").includes("TelePilot Support"))) throw new Error(`${MODE}: support screen was not rendered`);

calls.length = 0;
await bot.handleUpdate(callbackUpdate(2, "support_admin"));
if (!calls.some(call => call.method === "answerCallbackQuery")) throw new Error(`${MODE}: support_admin callback was not answered`);
if (!calls.some(call => call.method === "editMessageText" && String(call.payload.text || "").includes("SUPPORT CASES"))) throw new Error(`${MODE}: support admin cases screen was not rendered`);

// A completed data deletion must remove the old profile without permanently banning that
// Telegram ID. A later private /start explicitly begins a brand-new TelePilot profile.
const altUid = 456;
const altHash = deletedHash(altUid);
fs.writeFileSync(path.join(DATA_DIR, "deleted-users.json"), JSON.stringify({
  version: 1,
  users: { [altHash]: { deletedAt: Date.now(), caseId: "TP-SUP-TEST123" } },
}, null, 2));

calls.length = 0;
await bot.handleUpdate(messageUpdate(3, altUid, "/start"));
const startMessages = calls.filter(call => call.method === "sendMessage").map(call => String(call.payload.text || ""));
if (startMessages.some(text => text.includes("TelePilot account data deleted"))) {
  throw new Error(`${MODE}: deleted user was permanently blocked from /start`);
}
if (MODE === "support-only") {
  if (!startMessages.some(text => text.includes("APP START"))) throw new Error(`${MODE}: fresh /start did not reach the app handler`);
} else if (!startMessages.some(text => text.includes("Welcome to TelePilot"))) {
  throw new Error(`${MODE}: fresh /start did not reach onboarding`);
}
const deletedAfterStart = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "deleted-users.json"), "utf8"));
if (deletedAfterStart?.users?.[altHash]) throw new Error(`${MODE}: deletion marker was not cleared by fresh /start`);

if (MODE !== "support-only") {
  calls.length = 0;
  await bot.handleUpdate(callbackUpdate(4, "tutorial:2", altUid, "telepilot_alt"));
  if (!calls.some(call => call.method === "editMessageText" && String(call.payload.text || "").includes("Sender & Message"))) {
    throw new Error(`${MODE}: fresh user tutorial callbacks remained blocked after /start`);
  }
}

console.log(`${MODE}: support runtime callbacks ok`);
