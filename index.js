import { Bot, InlineKeyboard } from "grammy";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!API_ID) throw new Error("Missing API_ID");
if (!API_HASH) throw new Error("Missing API_HASH");

const bot = new Bot(BOT_TOKEN);

let ownerId = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;
let userClient = null;
let connectedUsername = null;
let adMessage = "";
let groups = [];
let intervalMinutes = 30;
let postingTimer = null;
let posting = false;
let awaiting = null;
let qrLoginRunning = false;

function isOwner(ctx) {
  const id = ctx.from?.id;
  if (!id) return false;
  if (!ownerId) ownerId = id;
  return id === ownerId;
}

function mainKeyboard() {
  return new InlineKeyboard()
    .text("👤 Account", "account").text("📝 Message", "message").row()
    .text("👥 Groups", "groups").text("⏱ Interval", "interval").row()
    .text("▶️ START", "start").text("⏹ STOP", "stop").row()
    .text("🔄 Refresh", "home");
}

function dashboard() {
  return [
    "✈️ TELEPILOT LITE",
    "",
    posting ? "🟢 Running" : "⚪ Stopped",
    "",
    `👤 Account: ${connectedUsername ? `@${connectedUsername}` : "Not connected"}`,
    `📝 Message: ${adMessage ? "✅ Set" : "❌ Not set"}`,
    `👥 Groups: ${groups.length}`,
    `⏱ Interval: ${intervalMinutes} min`,
  ].join("\n");
}

async function showHome(ctx) {
  const options = { reply_markup: mainKeyboard() };
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(dashboard(), options);
    } else {
      await ctx.reply(dashboard(), options);
    }
  } catch {
    await ctx.reply(dashboard(), options);
  }
}

function normalizeTarget(input) {
  let value = input.trim();
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

  for (const target of groups) {
    if (!posting) break;
    try {
      await userClient.sendMessage(target, { message: adMessage });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (err) {
      console.error(`Failed to post to ${target}:`, err?.message || err);
    }
  }
}

function startPostingLoop() {
  if (postingTimer) clearInterval(postingTimer);
  posting = true;
  void sendCycle();
  postingTimer = setInterval(() => void sendCycle(), intervalMinutes * 60_000);
}

function stopPostingLoop() {
  posting = false;
  if (postingTimer) clearInterval(postingTimer);
  postingTimer = null;
}

async function connectAccount(ctx) {
  if (qrLoginRunning) {
    await ctx.reply("A login is already in progress.");
    return;
  }

  qrLoginRunning = true;
  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
    connectionRetries: 5,
  });

  try {
    await client.connect();
    await ctx.reply("🔐 Opening Telegram account connection…\n\nTap the newest login button below and approve the new session in Telegram.");

    const me = await client.signInUserWithQrCode(
      { apiId: API_ID, apiHash: API_HASH },
      {
        qrCode: async ({ token }) => {
          const url = `tg://login?token=${token.toString("base64url")}`;
          const keyboard = new InlineKeyboard().url("✅ Connect this Telegram account", url);
          await ctx.reply("This login link expires quickly. Tap it now:", { reply_markup: keyboard });
        },
        onError: async (err) => {
          console.error("QR login error:", err?.message || err);
          return false;
        },
      }
    );

    userClient = client;
    connectedUsername = me?.username || String(me?.id || "connected");
    await ctx.reply(`✅ Connected as ${me?.username ? `@${me.username}` : "your Telegram account"}.`);
    await showHome(ctx);
  } catch (err) {
    console.error("Account connection failed:", err);
    try { await client.disconnect(); } catch {}
    await ctx.reply("❌ Account connection failed. If your account uses Telegram 2-step verification, this Lite login flow may need one extra step. Try again first; if it repeats, send me the exact error from Railway logs.");
  } finally {
    qrLoginRunning = false;
  }
}

bot.command("start", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("🔒 This Telepilot bot is private.");
  awaiting = null;
  await showHome(ctx);
});

bot.callbackQuery("home", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  awaiting = null;
  await showHome(ctx);
});

bot.callbackQuery("account", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const keyboard = new InlineKeyboard()
    .text(connectedUsername ? "🔄 Reconnect" : "➕ Connect account", "connect_account").row()
    .text("⬅️ Back", "home");
  await ctx.editMessageText(`👤 ACCOUNT\n\n${connectedUsername ? `Connected: @${connectedUsername}` : "No account connected."}`, { reply_markup: keyboard });
});

bot.callbackQuery("connect_account", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  await connectAccount(ctx);
});

bot.callbackQuery("message", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  awaiting = "message";
  const keyboard = new InlineKeyboard().text("⬅️ Cancel", "home");
  await ctx.editMessageText(`📝 AD MESSAGE\n\n${adMessage ? `Current:\n${adMessage}\n\n` : ""}Send the new message to this bot now.`, { reply_markup: keyboard });
});

bot.callbackQuery("groups", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const list = groups.length ? groups.map((g, i) => `${i + 1}. ${g}`).join("\n") : "No groups added.";
  const keyboard = new InlineKeyboard()
    .text("➕ Add group", "add_group").text("🗑 Clear all", "clear_groups").row()
    .text("⬅️ Back", "home");
  await ctx.editMessageText(`👥 GROUPS\n\n${list}\n\nOnly add groups/channels where this account is allowed to post.`, { reply_markup: keyboard });
});

bot.callbackQuery("add_group", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  awaiting = "group";
  const keyboard = new InlineKeyboard().text("⬅️ Cancel", "home");
  await ctx.editMessageText("➕ ADD GROUP\n\nSend a public @username or t.me link for a group/channel the connected account is already allowed to post in.", { reply_markup: keyboard });
});

bot.callbackQuery("clear_groups", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  groups = [];
  await showHome(ctx);
});

bot.callbackQuery("interval", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const keyboard = new InlineKeyboard()
    .text("15m", "i15").text("30m", "i30").text("1h", "i60").text("2h", "i120").row()
    .text("⬅️ Back", "home");
  await ctx.editMessageText(`⏱ INTERVAL\n\nCurrent: ${intervalMinutes} minutes`, { reply_markup: keyboard });
});

for (const minutes of [15, 30, 60, 120]) {
  bot.callbackQuery(`i${minutes}`, async (ctx) => {
    await ctx.answerCallbackQuery({ text: `Set to ${minutes} min` });
    if (!isOwner(ctx)) return;
    intervalMinutes = minutes;
    if (posting) startPostingLoop();
    await showHome(ctx);
  });
}

bot.callbackQuery("start", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  if (!userClient || !connectedUsername) return ctx.reply("Connect your Telegram account first.");
  if (!adMessage) return ctx.reply("Set an ad message first.");
  if (!groups.length) return ctx.reply("Add at least one authorized group first.");
  startPostingLoop();
  await showHome(ctx);
});

bot.callbackQuery("stop", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  stopPostingLoop();
  await showHome(ctx);
});

bot.on("message:text", async (ctx) => {
  if (!isOwner(ctx)) return;
  if (!awaiting) return;

  if (awaiting === "message") {
    adMessage = ctx.message.text;
    awaiting = null;
    await ctx.reply("✅ Message saved for this running session.");
    return showHome(ctx);
  }

  if (awaiting === "group") {
    const target = normalizeTarget(ctx.message.text);
    if (!target) return ctx.reply("I couldn't read that. Send an @username or a t.me/username link.");
    if (!groups.includes(target)) groups.push(target);
    awaiting = null;
    await ctx.reply(`✅ Added ${target}`);
    return showHome(ctx);
  }
});

bot.catch((err) => console.error("Bot error:", err.error));

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

console.log("Telepilot Lite starting…");
await bot.start({
  onStart: (info) => console.log(`Control bot running as @${info.username}`),
});
