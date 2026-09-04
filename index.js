import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import QRCode from "qrcode";
import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions/index.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";

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
  } catch (err) {
    console.error("Failed to load settings:", err?.message || err);
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
let postingTimer = null;
let posting = false;
let awaiting = null;
let qrLoginRunning = false;
let loginAbortController = null;
let loginStatus = null;

function saveSettings() {
  const payload = { ownerId, adMessage, groups, intervalMinutes };
  const temp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(temp, SETTINGS_FILE);
}

const bot = new Bot(BOT_TOKEN);

function createUserClient() {
  return new TelegramClient(new StoreSession(SESSION_NAME), API_ID, API_HASH, {
    connectionRetries: 5,
  });
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
    console.log(`Restored Telegram account ${me?.username ? `@${me.username}` : "session"}`);
  } catch (err) {
    console.error("Could not restore Telegram session:", err?.message || err);
    try { await client.disconnect(); } catch {}
  }
}

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
    if (ctx.callbackQuery?.message) await ctx.editMessageText(dashboard(), options);
    else await ctx.reply(dashboard(), options);
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

function accountKeyboard() {
  const keyboard = new InlineKeyboard();
  if (connectedUsername) {
    keyboard.text("✅ Connected", "account_status").row();
  } else if (qrLoginRunning) {
    keyboard.text("✖️ Cancel login", "cancel_login").row();
  } else {
    keyboard.text("➕ Connect account", "connect_account").row();
  }
  return keyboard.text("⬅️ Back", "home");
}

async function safeEditLoginMedia(media, replyMarkup) {
  if (!loginStatus) return;
  try {
    await bot.api.editMessageMedia(
      loginStatus.chatId,
      loginStatus.messageId,
      media,
      { reply_markup: replyMarkup },
    );
  } catch (err) {
    console.error("Failed to refresh QR card:", err?.message || err);
  }
}

async function safeEditLoginCaption(caption, replyMarkup) {
  if (!loginStatus) return;
  try {
    await bot.api.editMessageCaption(loginStatus.chatId, loginStatus.messageId, {
      caption,
      reply_markup: replyMarkup,
    });
  } catch (err) {
    console.error("Failed to update login card:", err?.message || err);
  }
}

async function connectAccount(ctx) {
  if (qrLoginRunning) {
    await ctx.reply("⏳ A Telegram login is already in progress.");
    return;
  }
  if (userClient && connectedUsername) {
    await ctx.reply(`✅ Already connected as @${connectedUsername}.`);
    return;
  }

  qrLoginRunning = true;
  const client = createUserClient();
  const abortController = new AbortController();
  loginAbortController = abortController;
  const timeout = setTimeout(() => abortController.abort(), 120_000);

  try {
    await client.connect();

    if (await client.checkAuthorization()) {
      const me = await client.getMe();
      userClient = client;
      connectedUsername = me?.username || String(me?.id || "connected");
      await ctx.reply(`✅ Connected as ${me?.username ? `@${me.username}` : "your Telegram account"}.`);
      return;
    }

    const placeholder = Buffer.from(
      await QRCode.toBuffer("tg://login", { type: "png", width: 420, margin: 2, errorCorrectionLevel: "M" }),
    );
    const firstKeyboard = new InlineKeyboard().text("✖️ Cancel", "cancel_login");
    const sent = await ctx.replyWithPhoto(new InputFile(placeholder, "telepilot-login.png"), {
      caption: "🔐 CONNECT TELEGRAM\n\nPreparing your one-time login QR…",
      reply_markup: firstKeyboard,
    });
    loginStatus = { chatId: sent.chat.id, messageId: sent.message_id };

    const me = await client.signInUserWithQrCode(
      { apiId: API_ID, apiHash: API_HASH },
      {
        qrCode: async ({ token }) => {
          const url = `tg://login?token=${token.toString("base64url")}`;
          const png = await QRCode.toBuffer(url, {
            type: "png",
            width: 520,
            margin: 2,
            errorCorrectionLevel: "M",
          });
          const keyboard = new InlineKeyboard().text("✖️ Cancel", "cancel_login");
          const media = InputMediaBuilder.photo(new InputFile(png, "telepilot-login.png"), {
            caption:
              "🔐 CONNECT TELEGRAM\n\n" +
              "On another device already signed into this Telegram account:\n" +
              "Settings → Devices → Link Desktop Device → scan this QR.\n\n" +
              "✅ TelePilot finishes automatically after approval.\n" +
              "⏳ Login expires after 2 minutes.",
          });
          await safeEditLoginMedia(media, keyboard);
        },
        onError: async (err) => {
          console.error("QR login error:", err?.message || err);
          return false;
        },
        abortSignal: abortController.signal,
      },
    );

    userClient = client;
    connectedUsername = me?.username || String(me?.id || "connected");
    await safeEditLoginCaption(
      `✅ CONNECTED\n\n${me?.username ? `@${me.username}` : "Telegram account"}\n\n🔒 Session saved. You do not need to reconnect after normal restarts or deploys.`,
      new InlineKeyboard().text("⬅️ Back to account", "account"),
    );
  } catch (err) {
    console.error("Account connection failed:", err?.message || err);
    try { await client.disconnect(); } catch {}

    if (err?.name === "AbortError") {
      await safeEditLoginCaption(
        "⌛ LOGIN ENDED\n\nThe login was cancelled or expired. No account was connected.",
        new InlineKeyboard().text("🔄 Try again", "connect_account").row().text("⬅️ Back", "account"),
      );
    } else {
      await safeEditLoginCaption(
        "❌ LOGIN FAILED\n\nTelegram could not complete the account connection. You can safely try again.",
        new InlineKeyboard().text("🔄 Try again", "connect_account").row().text("⬅️ Back", "account"),
      );
    }
  } finally {
    clearTimeout(timeout);
    if (loginAbortController === abortController) loginAbortController = null;
    qrLoginRunning = false;
  }
}

bot.command("start", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("🔒 This TelePilot bot is private.");
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
  const text = connectedUsername
    ? `👤 ACCOUNT\n\n✅ Connected: @${connectedUsername}\n🔒 Session: Saved`
    : qrLoginRunning
      ? "👤 ACCOUNT\n\n⏳ Telegram login is waiting for approval."
      : "👤 ACCOUNT\n\nNo account connected.\n\nConnection is one-time; the session is saved after approval.";
  await ctx.editMessageText(text, { reply_markup: accountKeyboard() });
});

bot.callbackQuery("account_status", async (ctx) => {
  await ctx.answerCallbackQuery({ text: connectedUsername ? `Connected as @${connectedUsername}` : "Not connected" });
});

bot.callbackQuery("connect_account", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  void connectAccount(ctx).catch((err) => console.error("Background account login failed:", err?.message || err));
});

bot.callbackQuery("cancel_login", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Cancelling login…" });
  if (!isOwner(ctx)) return;
  if (loginAbortController) loginAbortController.abort();
});

bot.callbackQuery("message", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  awaiting = "message";
  const keyboard = new InlineKeyboard().text("⬅️ Cancel", "home");
  await ctx.editMessageText(
    `📝 AD MESSAGE\n\n${adMessage ? `Current:\n${adMessage}\n\n` : ""}Send the new message to this bot now.`,
    { reply_markup: keyboard },
  );
});

bot.callbackQuery("groups", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  const list = groups.length ? groups.map((g, i) => `${i + 1}. ${g}`).join("\n") : "No groups added.";
  const keyboard = new InlineKeyboard()
    .text("➕ Add group", "add_group").text("🗑 Clear all", "clear_groups").row()
    .text("⬅️ Back", "home");
  await ctx.editMessageText(
    `👥 GROUPS\n\n${list}\n\nOnly add groups/channels where this account is allowed to post.`,
    { reply_markup: keyboard },
  );
});

bot.callbackQuery("add_group", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  awaiting = "group";
  const keyboard = new InlineKeyboard().text("⬅️ Cancel", "home");
  await ctx.editMessageText(
    "➕ ADD GROUP\n\nSend a public @username or t.me link for a group/channel the connected account is already allowed to post in.",
    { reply_markup: keyboard },
  );
});

bot.callbackQuery("clear_groups", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isOwner(ctx)) return;
  groups = [];
  saveSettings();
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
    saveSettings();
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

console.log("TelePilot Lite starting…");
await restoreUserSession();
await bot.start({ onStart: (info) => console.log(`Control bot running as @${info.username}`) });
