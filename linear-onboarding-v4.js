import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const SUPPORT_USERNAME = String(process.env.TELEPILOT_SUPPORT_USERNAME || "noahxrp").replace(/^@+/, "");
const MAIN_CHANNEL_USERNAME = String(process.env.TELEPILOT_MAIN_CHANNEL_USERNAME || "").replace(/^@+/, "");

// Known-good TelePilot custom emoji IDs already used by the project/owner.
export const TUTORIAL_PLANE_EMOJI_ID = "5231361378748472914";
export const TUTORIAL_CHECK_EMOJI_ID = "5206607081334906820";
export const TUTORIAL_ACTION_EMOJI_ID = "5411590687663608498";

let appStartHandler = null;

function uidOf(ctx) { return ctx?.from?.id ? String(ctx.from.id) : ""; }
function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function settingsPath(uid) { return path.join(userDir(uid), "settings.json"); }
function onboardingPath(uid) { return path.join(userDir(uid), "onboarding.json"); }

function readJson(file, fallback = {}) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function adminIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) if (/^\d+$/.test(part)) ids.add(part);
  }
  const persisted = readJson(ADMIN_FILE, {});
  for (const id of Array.isArray(persisted?.adminIds) ? persisted.adminIds : []) {
    if (/^\d+$/.test(String(id))) ids.add(String(id));
  }
  return ids;
}
function isAdmin(uid) { return adminIds().has(String(uid || "")); }

export function readLinearOnboarding(uid) {
  const saved = readJson(onboardingPath(uid), {});
  if (saved.completed === true) {
    return { version: 4, stage: "complete", completed: true, completedAt: Number(saved.completedAt || 0) || null };
  }
  const stage = saved.stage === "access" ? "access" : "tutorial";
  return { version: 4, stage, completed: false, completedAt: null };
}
function writeLinearOnboarding(uid, patch = {}) {
  const id = String(uid || "");
  if (!/^\d+$/.test(id)) return;
  const current = readJson(onboardingPath(id), {});
  const next = {
    ...current,
    version: 4,
    stage: patch.completed === true ? "complete" : (patch.stage === "access" ? "access" : (patch.stage || current.stage || "tutorial")),
    completed: patch.completed === true ? true : current.completed === true,
    completedAt: patch.completed === true ? (Number(patch.completedAt || 0) || Date.now()) : (Number(current.completedAt || 0) || null),
  };
  writeJson(onboardingPath(id), next);
}
export function markLinearOnboardingComplete(uid) {
  writeLinearOnboarding(uid, { completed: true, completedAt: Date.now(), stage: "complete" });
}
function accessActive(uid) {
  if (isAdmin(uid)) return true;
  const saved = readJson(settingsPath(uid), {});
  if (saved.accessRevoked === true) return false;
  if (saved.accessLifetime === true) return true;
  return Number(saved.accessUntil || 0) > Date.now();
}

function sellerUrl(username = SUPPORT_USERNAME) {
  return `https://t.me/${String(username || "noahxrp").replace(/^@+/, "")}`;
}
function channelUrl(username = MAIN_CHANNEL_USERNAME) {
  const clean = String(username || "").replace(/^@+/, "");
  return clean ? `https://t.me/${clean}` : "";
}
function premiumButton(text, callback_data, emojiId, extra = {}) {
  return { text, callback_data, icon_custom_emoji_id: emojiId, ...extra };
}
function premiumUrlButton(text, url, emojiId) {
  return { text, url, icon_custom_emoji_id: emojiId };
}

export function tutorialScreen(options = {}) {
  const support = String(options.supportUsername || SUPPORT_USERNAME).replace(/^@+/, "");
  return {
    text: [
      "✈️ <b><i>Welcome to TelePilot</i></b>",
      "",
      "<i>Read this once before activating your access.</i>",
      "",
      "<b>Sender:</b> — Connect the Telegram account that will publish your posts.",
      "<b>Destinations:</b> — Add the groups/channels where that account is allowed to post.",
      "<b>Message:</b> — Create a normal post or use Forwarded Post.",
      "<b>Timing:</b> — Choose an interval or an exact schedule.",
      "<b>Go live:</b> — Start once; TelePilot handles the posting cycles and tracks issues.",
      "",
      "<b>Useful tools:</b> — Addlists, forum-topic routing, multiple accounts, Smart Preview, activity history and destination health are available from the dashboard.",
      "",
      `<i>Need help or an access key later? Message @${support}.</i>`,
      "",
      "<b>Next:</b> — Redeem your TelePilot access key."
    ].join("\n"),
    other: {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[premiumButton("Continue", "linear_onboarding_continue", TUTORIAL_PLANE_EMOJI_ID, { style: "primary" })]],
      },
    },
  };
}

export function accessScreen(options = {}) {
  const support = String(options.supportUsername || SUPPORT_USERNAME).replace(/^@+/, "");
  const channel = String(options.mainChannelUsername ?? MAIN_CHANNEL_USERNAME).replace(/^@+/, "");
  const rows = [
    [premiumButton("Redeem Key", "redeem_key", TUTORIAL_CHECK_EMOJI_ID, { style: "success" })],
    [premiumUrlButton("Get a Key", sellerUrl(support), TUTORIAL_ACTION_EMOJI_ID)],
  ];
  if (channel) rows.push([premiumUrlButton("Join Main Channel", channelUrl(channel), TUTORIAL_PLANE_EMOJI_ID)]);
  return {
    text: [
      "🔑 <b><i>TelePilot Access</i></b>",
      "",
      "<b>Tutorial:</b> — Complete",
      "<b>Access:</b> — Key required",
      "",
      "Tap <b>Redeem Key</b> and send the key you received.",
      "",
      `<b>Need a key?</b> — Message @${support}.`,
      channel ? `<b>Main channel:</b> — Join @${channel} for TelePilot updates and announcements.` : null,
      "",
      "<i>After a valid key is redeemed, TelePilot opens your dashboard.</i>",
    ].filter(Boolean).join("\n"),
    other: { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } },
  };
}

export function replayTutorialScreen() {
  const screen = tutorialScreen();
  screen.other.reply_markup.inline_keyboard = [[premiumButton("Dashboard", "v1_dashboard_v13", TUTORIAL_PLANE_EMOJI_ID, { style: "primary" })]];
  screen.text = screen.text.replace("<i>Read this once before activating your access.</i>", "<i>A quick reference for your TelePilot setup.</i>")
    .replace("<b>Next:</b> — Redeem your TelePilot access key.", "<b>Ready:</b> — Return to your dashboard when you are done reading.");
  return screen;
}

async function sendScreen(ctx, screen, edit = false) {
  if (edit && ctx.callbackQuery?.message) {
    try { return await ctx.editMessageText(screen.text, screen.other); } catch {}
  }
  return ctx.reply(screen.text, screen.other);
}
async function openApp(ctx) {
  if (typeof appStartHandler === "function") return appStartHandler(ctx, async () => undefined);
  return ctx.reply("Send /start to open TelePilot.");
}

function activationDetails(text) {
  const value = String(text || "");
  const plan = value.match(/Plan:\s*([^\n]+)/i)?.[1]?.trim() || "Active";
  const expires = value.match(/Expires:\s*([^\n]+)/i)?.[1]?.trim() || "Active";
  return { plan, expires };
}
function containsCallback(other, data) {
  return (other?.reply_markup?.inline_keyboard || []).flat().some(button => String(button?.callback_data || "") === data);
}
function copyOther(other) {
  const next = { ...(other || {}) };
  if (other?.reply_markup?.inline_keyboard) {
    next.reply_markup = {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    };
  }
  if (Array.isArray(other?.entities)) next.entities = other.entities.map(entity => ({ ...entity }));
  return next;
}

export function decorateLinearOnboardingPayload(chatId, text, other, options = {}) {
  const uid = String(chatId || "");
  const support = String(options.supportUsername || SUPPORT_USERNAME).replace(/^@+/, "");
  const channel = String(options.mainChannelUsername ?? MAIN_CHANNEL_USERNAME).replace(/^@+/, "");
  const markComplete = typeof options.markComplete === "function" ? options.markComplete : markLinearOnboardingComplete;
  let value = String(text || "");
  let next = copyOther(other);

  // app.js used to send Start Tutorial + Skip after first key redemption. Replace
  // that legacy fork with the mandatory Tutorial -> Redeem Key -> Dashboard flow.
  if (/^✅ ACCESS ACTIVATED/i.test(value)
      && (containsCallback(next, "tutorial:begin") || containsCallback(next, "tutorial:skip"))) {
    const details = activationDetails(value);
    if (/^\d+$/.test(uid)) markComplete(uid);
    value = [
      "✅ <b><i>Access activated</i></b>",
      "",
      `<b>Plan:</b> — ${details.plan}`,
      `<b>Expires:</b> — ${details.expires}`,
      "",
      "Your tutorial and access are complete.",
      "<i>Open the dashboard to connect your sender and build your first posting setup.</i>",
    ].join("\n");
    next = {
      ...next,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[premiumButton("Open Dashboard", "v1_dashboard_v13", TUTORIAL_CHECK_EMOJI_ID, { style: "success" })]],
      },
    };
    delete next.entities;
    return { text: value, other: next };
  }

  // Add lightweight purchase/community entry points to the current v1.3 dashboard.
  if (value.startsWith("✈️ TelePilot") && Array.isArray(next?.reply_markup?.inline_keyboard)) {
    const flat = next.reply_markup.inline_keyboard.flat();
    const looksLikeDashboard = flat.some(button => ["v1_posting_setup_v13", "v1_activity_v13"].includes(String(button?.callback_data || "")));
    if (looksLikeDashboard) {
      const marker = "Need a key / renewal?";
      if (!value.includes(marker)) {
        value += `\n\n🔑 ${marker} — Message @${support}.`;
        if (channel) value += `\n📢 Main channel: — Join @${channel} for updates.`;
      }
      const existing = new Set(flat.map(button => String(button?.url || "")));
      const row = [];
      const supportLink = sellerUrl(support);
      const mainLink = channelUrl(channel);
      if (!existing.has(supportLink)) row.push(premiumUrlButton("Get / Renew Key", supportLink, TUTORIAL_ACTION_EMOJI_ID));
      if (mainLink && !existing.has(mainLink)) row.push(premiumUrlButton("Main Channel", mainLink, TUTORIAL_PLANE_EMOJI_ID));
      if (row.length) {
        const adminIndex = next.reply_markup.inline_keyboard.findIndex(buttonRow => buttonRow.some(button => String(button?.callback_data || "") === "admin"));
        const insertAt = adminIndex >= 0 ? adminIndex : next.reply_markup.inline_keyboard.length;
        next.reply_markup.inline_keyboard.splice(insertAt, 0, row);
      }
    }
  }

  return { text: value, other: next };
}

function registerLinearHandlers(bot) {
  bot.callbackQuery("linear_onboarding_continue", async ctx => {
    const uid = uidOf(ctx);
    if (!uid) return;
    await ctx.answerCallbackQuery();
    if (accessActive(uid)) {
      markLinearOnboardingComplete(uid);
      return openApp(ctx);
    }
    writeLinearOnboarding(uid, { stage: "access" });
    return sendScreen(ctx, accessScreen(), true);
  });

  bot.callbackQuery("tutorial_restart", async ctx => {
    await ctx.answerCallbackQuery();
    return sendScreen(ctx, replayTutorialScreen(), true);
  });

  // Compatibility with old tutorial messages that may still exist in chat.
  // They no longer skip or branch into setup actions.
  bot.callbackQuery("tutorial:skip", async ctx => {
    await ctx.answerCallbackQuery({ text: "The TelePilot tutorial cannot be skipped.", show_alert: true });
    const uid = uidOf(ctx);
    return sendScreen(ctx, readLinearOnboarding(uid).stage === "access" ? accessScreen() : tutorialScreen(), true);
  });
  bot.callbackQuery("tutorial:begin", async ctx => {
    await ctx.answerCallbackQuery();
    return sendScreen(ctx, tutorialScreen(), true);
  });
  bot.callbackQuery(/^tutorial:(?:[1-7]|bot|personal|finish)$/, async ctx => {
    await ctx.answerCallbackQuery({ text: "The tutorial has been simplified." });
    const uid = uidOf(ctx);
    const state = readLinearOnboarding(uid);
    if (state.completed) return sendScreen(ctx, replayTutorialScreen(), true);
    return sendScreen(ctx, state.stage === "access" ? accessScreen() : tutorialScreen(), true);
  });
}

export function installLinearOnboardingV4(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotLinearOnboardingV4Installed) return false;
  const originalCommand = BotClass.prototype.command;
  const originalStart = BotClass.prototype.start;
  if (typeof originalCommand !== "function" || typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for linear onboarding v4");
  Object.defineProperty(BotClass.prototype, "__telepilotLinearOnboardingV4Installed", { value: true });

  BotClass.prototype.command = function(command, ...middleware) {
    if (command !== "start") return originalCommand.call(this, command, ...middleware);
    for (const handler of middleware) if (typeof handler === "function") appStartHandler = handler;
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const uid = uidOf(ctx);
      if (!uid) return handler.call(this, ctx, next);
      const state = readLinearOnboarding(uid);
      if (state.completed) return handler.call(this, ctx, next);
      if (state.stage === "access") {
        if (accessActive(uid)) {
          markLinearOnboardingComplete(uid);
          return handler.call(this, ctx, next);
        }
        return sendScreen(ctx, accessScreen(), false);
      }
      return sendScreen(ctx, tutorialScreen(), false);
    });
    return originalCommand.call(this, command, ...wrapped);
  };

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotLinearOnboardingV4HandlersRegistered) {
      Object.defineProperty(this, "__telepilotLinearOnboardingV4HandlersRegistered", { value: true });
      registerLinearHandlers(this);
    }
    return originalStart.apply(this, args);
  };
  return true;
}

export function installLinearOnboardingV4Ui(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotLinearOnboardingV4UiInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for linear onboarding v4 UI");
  Object.defineProperty(ApiClass.prototype, "__telepilotLinearOnboardingV4UiInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = decorateLinearOnboardingPayload(chatId, text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = decorateLinearOnboardingPayload(chatId, text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
  return true;
}
