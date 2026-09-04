import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions/index.js";
import { createConnectService } from "./connect-server.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || "https://telepilot-lite-production.up.railway.app";

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!API_ID) throw new Error("Missing API_ID");
if (!API_HASH) throw new Error("Missing API_HASH");

fs.mkdirSync(DATA_DIR, { recursive: true });
const SETTINGS_FILE = path.join(DATA_DIR, "telepilot-settings.json");
const sessionDirectory = path.join(DATA_DIR, "telepilot-user-session");
const SESSION_NAME = path.relative(process.cwd(), sessionDirectory) || "telepilot-user-session";

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

const saved = loadSettings();
let ownerId = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : (Number(saved.ownerId) || null);
let userClient = null;
let connectedUsername = null;
let adMessage = typeof saved.adMessage === "string" ? saved.adMessage : "";
let groups = Array.isArray(saved.groups) ? saved.groups.filter((x) => typeof x === "string") : [];
let intervalMinutes = [15, 30, 60, 120].includes(Number(saved.intervalMinutes)) ? Number(saved.intervalMinutes) : 30;
let totalSent = Number.isFinite(Number(saved.totalSent)) ? Number(saved.totalSent) : 0;
let lastRunAt = Number.isFinite(Number(saved.lastRunAt)) ? Number(saved.lastRunAt) : null;
let lastCycleSuccess = Number.isFinite(Number(saved.lastCycleSuccess)) ? Number(saved.lastCycleSuccess) : 0;
let lastCycleFailed = Number.isFinite(Number(saved.lastCycleFailed)) ? Number(saved.lastCycleFailed) : 0;
let postingTimer = null;
let posting = false;
let nextRunAt = null;
let awaiting = null;

function saveSettings() {
  const temp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({
    ownerId,
    adMessage,
    groups,
    intervalMinutes,
    totalSent,
    lastRunAt,
    lastCycleSuccess,
    lastCycleFailed,
  }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, SETTINGS_FILE);
}

const bot = new Bot(BOT_TOKEN);

function createUserClient() {
  return new TelegramClient(new StoreSession(SESSION_NAME), API_ID, API_HASH, { connectionRetries: 5 });
}

function accountDisplay() {
  if (!connectedUsername) return "Not connected";
  return /^\d+$/.test(String(connectedUsername)) ? "Connected" : `@${connectedUsername}`;
}

async function restoreUserSession() {
  const client = createUserClient();
  try {
    await client.connect();
    if (!(await client.checkAuthorization())) {
      await client.disconnect();
      return;
    }
    const me = await client.getMe();
    userClient = client;
    connectedUsername = me?.username || String(me?.id || "connected");
    console.log(`Restored Telegram user session for ${connectedUsername}`);
  } catch (err) {
    console.error("Could not restore Telegram session:", err?.message || err);
    try { await client.disconnect(); } catch {}
  }
}

const connectService = createConnectService({
  botToken: BOT_TOKEN,
  apiId: API_ID,
  apiHash: API_HASH,
  sessionName: SESSION_NAME,
  publicUrl: PUBLIC_URL,
  onConnected: async (uid, client, me) => {
    if (!ownerId || Number(uid) !== Number(ownerId)) {
      try { await client.disconnect(); } catch {}
      throw new Error("Connection does not belong to this TelePilot owner");
    }
    if (userClient && userClient !== client) {
      try { await userClient.disconnect(); } catch {}
    }
    userClient = client;
    connectedUsername = me?.username || String(me?.id || "connected");
    try {
      await bot.api.sendMessage(ownerId, `✅ Telegram account connected${me?.username ? ` as @${me.username}` : ""}.\n\nOpen /start to continue setting up TelePilot.`);
    } catch {}
  },
});
connectService.listen(PORT);

function isOwner(ctx) {
  const id = ctx.from?.id;
  if (!id) return false;
  if (!ownerId) {
    ownerId = id;
    saveSettings();
    console.log(`TelePilot owner locked to Telegram user ${id}`);
  }
  return id === ownerId;
}

function mainKeyboard() {
  return new InlineKeyboard()
    .text("👤 Account", "account").text("📝 Message", "message").row()
    .text("👥 Groups", "groups").text("⏱ Interval", "interval").row()
    .text("▶️ START", "start").text("⏹ STOP", "stop").row()
    .text("📊 Activity", "activity").text("🔄 Refresh", "home");
}

function formatAgo(timestamp) {
  if (!timestamp) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatUntil(timestamp) {
  if (!timestamp || !posting) return "—";
  const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
  if (seconds < 60) return "<1 min";
  return `${Math.ceil(seconds / 60)} min`;
}

function dashboard() {
  return [
    "✈️ TELEPILOT",
    "",
    posting ? "🟢 Running" : "⚪ Stopped",
    "",
    `👤 Account: ${accountDisplay()}`,
    `📝 Message: ${adMessage ? `✅ Set (${adMessage.length} chars)` : "❌ Not set"}`,
    `👥 Groups: ${groups.length}`,
    `⏱ Interval: ${intervalMinutes} min`,
    posting ? `⏳ Next post: ${formatUntil(nextRunAt)}` : null,
  ].filter(Boolean).join("\n");
}

async function showHome(ctx) {
  awaiting = null;
  const options = { reply_markup: mainKeyboard() };
  try {
    if (ctx.callbackQuery?.message) await ctx.editMessageText(dashboard(), options);
    else await ctx.reply(dashboard(), options);
  } catch {
    await ctx.reply(dashboard(), options);
  }
}

function normalizeTarget(input) {
  let value = String(input || "").trim();
  value = value.replace(/^https?:\/\/(www\.)?t\.me\//i, "");
  value = value.split(/[/?#]/)[0];
  if (!value) return null;
  if (/^-?\d+$/.test(value)) return value;
  value = value.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{5,}$/.test(value)) return null;
  return `@${value}`;
}

async function sendCycle() {
  if (!posting || !userClient || !adMessage || groups.length === 0) return;
  let success = 0;
  let failed = 0;

  for (const target of groups) {
    if (!posting) break;
    try {
      await userClient.sendMessage(target, { message: adMessage });
      success += 1;
      totalSent += 1;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (err) {
      failed += 1;
      console.error(`Failed to post to ${target}:`, err?.message || err);
    }
  }

  lastRunAt = Date.now();
  lastCycleSuccess = success;
  lastCycleFailed = failed;
  saveSettings();
}

function scheduleNextCycle() {
  if (postingTimer) clearTimeout(postingTimer);
  if (!posting) {
    nextRunAt = null;
    return;
  }
  const delay = intervalMinutes * 60_000;
  nextRunAt = Date.now() + delay;
  postingTimer = setTimeout(async () => {
    await sendCycle();
    if (posting) scheduleNextCycle();
  }, delay);
}

function startPostingLoop() {
  if (posting) return;
  posting = true;
  void sendCycle();
  scheduleNextCycle();
}

function stopPostingLoop() {
  posting = false;
  nextRunAt = null;
  if (postingTimer) clearTimeout(postingTimer);
  postingTimer = null;
}

bot.command("start", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("🔒 This TelePilot test bot is currently private.");
  await showHome(ctx);
});

bot.callbackQuery("home", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  await showHome(ctx);
});

bot.callbackQuery("account", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;

  if (connectedUsername) {
    const keyboard = new InlineKeyboard()
      .text("🔌 Disconnect account", "disconnect_account").row()
      .text("⬅️ Back", "home");
    return ctx.editMessageText(`👤 ACCOUNT\n\n✅ Connected: ${accountDisplay()}\n🔒 Session saved on TelePilot`, { reply_markup: keyboard });
  }

  const url = connectService.makeConnectUrl(ctx.from.id);
  const keyboard = new InlineKeyboard()
    .url("🔐 Connect account on this phone", url).row()
    .text("⬅️ Back", "home");
  await ctx.editMessageText(
    "👤 ACCOUNT\n\nConnect your Telegram account using TelePilot Connect.\n\nYou’ll enter your phone number and Telegram’s login steps on the secure connection page, then return here when it says Connected.",
    { reply_markup: keyboard },
  );
});

bot.callbackQuery("disconnect_account", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const keyboard = new InlineKeyboard()
    .text("⚠️ Yes, disconnect", "disconnect_confirm").row()
    .text("⬅️ Keep account", "account");
  await ctx.editMessageText(
    "🔌 DISCONNECT ACCOUNT\n\nThis will log TelePilot out of the connected Telegram account and stop posting. Your ad message and group list will stay saved.",
    { reply_markup: keyboard },
  );
});

bot.callbackQuery("disconnect_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  stopPostingLoop();
  if (userClient) {
    try { await userClient.logOut(); }
    catch (err) { console.error("Telegram logout failed:", err?.message || err); }
  }
  userClient = null;
  connectedUsername = null;
  await ctx.reply("✅ Telegram account disconnected from TelePilot.");
  await showHome(ctx);
});

bot.callbackQuery("message", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  awaiting = null;
  const keyboard = new InlineKeyboard();
  if (adMessage) keyboard.text("👁 Preview", "message_preview").text("✏️ Change", "message_change").row();
  else keyboard.text("➕ Set message", "message_change").row();
  keyboard.text("⬅️ Back", "home");
  await ctx.editMessageText(
    `📝 AD MESSAGE\n\n${adMessage ? `✅ Saved • ${adMessage.length} characters` : "❌ No message set yet."}`,
    { reply_markup: keyboard },
  );
});

bot.callbackQuery("message_change", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  awaiting = "message";
  const keyboard = new InlineKeyboard().text("⬅️ Cancel", "message");
  await ctx.editMessageText("✏️ SET AD MESSAGE\n\nSend the message you want TelePilot to post. Formatting, links and emoji are okay.", { reply_markup: keyboard });
});

bot.callbackQuery("message_preview", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const keyboard = new InlineKeyboard().text("✏️ Change", "message_change").row().text("⬅️ Back", "message");
  await ctx.editMessageText(`👁 MESSAGE PREVIEW\n\n${adMessage || "No message set."}`, { reply_markup: keyboard });
});

bot.callbackQuery("groups", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const list = groups.length ? groups.map((g, i) => `${i + 1}. ${g}`).join("\n") : "No groups added.";
  const keyboard = new InlineKeyboard().text("➕ Add group", "add_group");
  if (groups.length) keyboard.text("➖ Remove", "remove_group_menu");
  keyboard.row();
  if (groups.length) keyboard.text("🗑 Clear all", "clear_groups").row();
  keyboard.text("⬅️ Back", "home");
  await ctx.editMessageText(`👥 GROUPS\n\n${list}\n\nOnly add groups/channels where the connected account is allowed to post.`, { reply_markup: keyboard });
});

bot.callbackQuery("add_group", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  awaiting = "group";
  const keyboard = new InlineKeyboard().text("⬅️ Cancel", "groups");
  await ctx.editMessageText("➕ ADD GROUP\n\nSend an @username or t.me link for a group/channel the connected account is already allowed to post in.", { reply_markup: keyboard });
});

bot.callbackQuery("remove_group_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const keyboard = new InlineKeyboard();
  groups.slice(0, 20).forEach((group, index) => keyboard.text(`❌ ${group}`, `remove_group:${index}`).row());
  keyboard.text("⬅️ Back", "groups");
  await ctx.editMessageText("➖ REMOVE GROUP\n\nChoose a destination to remove:", { reply_markup: keyboard });
});

bot.callbackQuery(/^remove_group:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const index = Number(ctx.match[1]);
  if (!Number.isInteger(index) || index < 0 || index >= groups.length) return ctx.reply("That group is no longer in your list.");
  const [removed] = groups.splice(index, 1);
  saveSettings();
  await ctx.reply(`✅ Removed ${removed}`);
  await showHome(ctx);
});

bot.callbackQuery("clear_groups", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const keyboard = new InlineKeyboard().text("⚠️ Yes, clear all", "clear_groups_confirm").row().text("⬅️ Cancel", "groups");
  await ctx.editMessageText(`🗑 CLEAR GROUPS\n\nRemove all ${groups.length} saved destinations?`, { reply_markup: keyboard });
});

bot.callbackQuery("clear_groups_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  groups = [];
  saveSettings();
  await showHome(ctx);
});

bot.callbackQuery("interval", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const keyboard = new InlineKeyboard().text("15m", "i15").text("30m", "i30").text("1h", "i60").text("2h", "i120").row().text("⬅️ Back", "home");
  await ctx.editMessageText(`⏱ INTERVAL\n\nCurrent: ${intervalMinutes} minutes\n\nChanging the interval while running will reset the countdown without sending an extra post immediately.`, { reply_markup: keyboard });
});

for (const minutes of [15, 30, 60, 120]) {
  bot.callbackQuery(`i${minutes}`, async (ctx) => {
    await ctx.answerCallbackQuery({ text: `Set to ${minutes} min` });
    if (!isOwner(ctx)) return;
    intervalMinutes = minutes;
    saveSettings();
    if (posting) scheduleNextCycle();
    await showHome(ctx);
  });
}

bot.callbackQuery("activity", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const keyboard = new InlineKeyboard().text("🔄 Refresh", "activity").row().text("⬅️ Back", "home");
  await ctx.editMessageText([
    "📊 ACTIVITY",
    "",
    `Status: ${posting ? "🟢 Running" : "⚪ Stopped"}`,
    `Total successful posts: ${totalSent}`,
    `Last cycle: ${formatAgo(lastRunAt)}`,
    `Last result: ${lastRunAt ? `✅ ${lastCycleSuccess} sent • ❌ ${lastCycleFailed} failed` : "No runs yet"}`,
    `Next cycle: ${posting ? formatUntil(nextRunAt) : "—"}`,
  ].join("\n"), { reply_markup: keyboard });
});

bot.callbackQuery("start", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  if (posting) return ctx.reply("TelePilot is already running.");
  if (!userClient || !connectedUsername) return ctx.reply("Connect your Telegram account first.");
  if (!adMessage) return ctx.reply("Set an ad message first.");
  if (!groups.length) return ctx.reply("Add at least one authorized group first.");
  const keyboard = new InlineKeyboard().text("▶️ Confirm start", "start_confirm").row().text("⬅️ Cancel", "home");
  await ctx.editMessageText(
    `▶️ START TELEPILOT\n\nDestinations: ${groups.length}\nInterval: ${intervalMinutes} min\n\nTelePilot will post once immediately, then continue on the selected interval.`,
    { reply_markup: keyboard },
  );
});

bot.callbackQuery("start_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  if (!userClient || !connectedUsername || !adMessage || !groups.length) return showHome(ctx);
  startPostingLoop();
  await showHome(ctx);
});

bot.callbackQuery("stop", async (ctx) => {
  await ctx.answerCallbackQuery({ text: posting ? "Stopping TelePilot…" : "TelePilot is already stopped." });
  if (!isOwner(ctx)) return;
  if (!posting) return;
  stopPostingLoop();
  await showHome(ctx);
});

bot.on("message:text", async (ctx) => {
  if (!isOwner(ctx) || !awaiting) return;
  if (awaiting === "message") {
    adMessage = ctx.message.text;
    awaiting = null;
    saveSettings();
    await ctx.reply("✅ Message saved.");
    return showHome(ctx);
  }
  if (awaiting === "group") {
    const target = normalizeTarget(ctx.message.text);
    if (!target) return ctx.reply("I couldn't read that. Send an @username or a t.me/username link.");
    if (!groups.includes(target)) groups.push(target);
    awaiting = null;
    saveSettings();
    await ctx.reply(`✅ Added ${target}`);
    return showHome(ctx);
  }
});

bot.catch((err) => console.error("Bot error:", err.error));
process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

console.log("TelePilot starting…");
await restoreUserSession();
await bot.start({ onStart: (info) => console.log(`Control bot running as @${info.username}`) });
