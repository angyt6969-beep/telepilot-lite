import fs from "node:fs";
import path from "node:path";
import { Api as GrammyApi } from "grammy";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const SUPPORT_USERNAME = String(process.env.TELEPILOT_SUPPORT_USERNAME || "noahxrp").replace(/^@+/, "");
const MAIN_CHANNEL_USERNAME = String(process.env.TELEPILOT_MAIN_CHANNEL_USERNAME || "").replace(/^@+/, "");

// Known-good custom emoji IDs already supplied/used for TelePilot.
export const TUTORIAL_PLANE_EMOJI_ID = "5231361378748472914";
export const TUTORIAL_CHECK_EMOJI_ID = "5206607081334906820";
export const TUTORIAL_ACTION_EMOJI_ID = "5411590687663608498";
export const TUTORIAL_SLIDES = 5;

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
  return {
    version: 4,
    completed: saved.completed === true,
    completedAt: saved.completed === true ? (Number(saved.completedAt || 0) || null) : null,
  };
}
export function markLinearOnboardingComplete(uid) {
  const id = String(uid || "");
  if (!/^\d+$/.test(id)) return;
  const current = readJson(onboardingPath(id), {});
  writeJson(onboardingPath(id), {
    ...current,
    version: 4,
    completed: true,
    completedAt: Number(current.completedAt || 0) || Date.now(),
  });
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
function premiumCallback(text, callback_data, emojiId, extra = {}) {
  return { text, callback_data, icon_custom_emoji_id: emojiId, ...extra };
}
function premiumUrl(text, url, emojiId) {
  return { text, url, icon_custom_emoji_id: emojiId };
}
function addEntity(entities, entity) {
  if (!entities.some(row => row?.type === entity.type && row?.offset === entity.offset && row?.length === entity.length)) {
    entities.push(entity);
  }
}
function emphasizeAppendedLabel(text, entities, label) {
  const offset = String(text).lastIndexOf(label);
  if (offset < 0) return;
  addEntity(entities, { type: "bold", offset, length: label.length });
  addEntity(entities, { type: "italic", offset, length: label.length });
}
function slideNumber(value) {
  return Math.max(1, Math.min(TUTORIAL_SLIDES, Number(value) || 1));
}
function telePilotHeading(title, slide) {
  return [
    `<tg-emoji emoji-id="${TUTORIAL_PLANE_EMOJI_ID}">✈️</tg-emoji> <b><i>${title}</i></b>`,
    `<i>Slide ${slide} of ${TUTORIAL_SLIDES}</i>`,
  ];
}
function navigationRows(slide, alreadyActive, support, channel) {
  const rows = [];
  if (slide < TUTORIAL_SLIDES) {
    const row = [];
    if (slide > 1) row.push(premiumCallback("Back", `linear_tutorial:${slide - 1}`, TUTORIAL_ACTION_EMOJI_ID));
    row.push(premiumCallback("Next", `linear_tutorial:${slide + 1}`, TUTORIAL_PLANE_EMOJI_ID, { style: "primary" }));
    rows.push(row);
    return rows;
  }

  rows.push([premiumCallback("Back", `linear_tutorial:${TUTORIAL_SLIDES - 1}`, TUTORIAL_ACTION_EMOJI_ID)]);
  rows.push([
    alreadyActive
      ? premiumCallback("Open Dashboard", "linear_onboarding_complete", TUTORIAL_CHECK_EMOJI_ID, { style: "success" })
      : premiumCallback("Redeem Key", "redeem_key", TUTORIAL_CHECK_EMOJI_ID, { style: "success" }),
  ]);
  if (!alreadyActive) {
    const links = [premiumUrl("Get a Key", sellerUrl(support), TUTORIAL_ACTION_EMOJI_ID)];
    if (channel) links.push(premiumUrl("Main Channel", channelUrl(channel), TUTORIAL_PLANE_EMOJI_ID));
    rows.push(links);
  }
  return rows;
}

export function tutorialScreen(options = {}) {
  const support = String(options.supportUsername || SUPPORT_USERNAME).replace(/^@+/, "");
  const channel = String(options.mainChannelUsername ?? MAIN_CHANNEL_USERNAME).replace(/^@+/, "");
  const alreadyActive = options.accessActive === true;
  const slide = slideNumber(options.slide);
  let body;

  if (slide === 2) {
    body = [
      ...telePilotHeading("Choose your sender", slide),
      "",
      "👤 <b>Personal account:</b> — Post as your own Telegram account and use TelePilot's destination automation.",
      "",
      "🤖 <b>TelePilot Bot:</b> — Use the bot as the sender when it has access to the destinations you configure.",
      "",
      "🔐 <b>Account connection:</b> — Personal login details use TelePilot's protected connection flow.",
      "",
      "<i>You choose or change the active sender later from Accounts.</i>",
    ];
  } else if (slide === 3) {
    body = [
      ...telePilotHeading("Add destinations", slide),
      "",
      "📍 <b>Groups & channels:</b> — Add the Telegram destinations where your sender is allowed to post.",
      "",
      "🗂 <b>Addlists:</b> — Import supported Telegram shared folders without adding destinations one by one.",
      "",
      "💬 <b>Forum topics:</b> — Choose the exact topic when a destination uses Telegram topics.",
      "",
      "<i>Destination Health helps surface access, restriction and routing issues.</i>",
    ];
  } else if (slide === 4) {
    body = [
      ...telePilotHeading("Build your post", slide),
      "",
      "📝 <b>Normal Post:</b> — Create your message with formatting, links and supported media.",
      "",
      "↪️ <b>Forwarded Post:</b> — Use a real Telegram forward from a selected source message.",
      "",
      "⏱ <b>Timing:</b> — Choose a repeat interval or use exact-time scheduling when needed.",
      "",
      "👀 <b>Smart Preview:</b> — Check sender, message, destinations and timing before going live.",
    ];
  } else if (slide === 5) {
    body = [
      ...telePilotHeading("You're ready", slide),
      "",
      "✅ <b>Tutorial:</b> — Complete",
      alreadyActive ? "🟢 <b>Access:</b> — Active" : "🔑 <b>Access:</b> — Key required",
      "",
      "Once inside the dashboard, the normal flow is simple:",
      "",
      "<b>Sender:</b> — Choose who posts",
      "<b>Destinations:</b> — Choose where to post",
      "<b>Message:</b> — Choose what to post",
      "<b>Timing:</b> — Choose when to post",
      "",
      alreadyActive
        ? "<i>Open your dashboard and start building your setup.</i>"
        : `<i>Redeem your key to unlock TelePilot. Need one? Message @${support}.</i>`,
    ];
  } else {
    body = [
      ...telePilotHeading("Welcome to TelePilot", slide),
      "",
      "✨ <b>TelePilot:</b> — A clean control panel for automated Telegram posting.",
      "",
      "⚡ Set up your sender, destinations, message and timing once — then manage everything from one dashboard.",
      "",
      "🛡 <b>Built for control:</b> — Preview what will happen, review destination issues and keep posting settings organized.",
      "",
      "<i>This tutorial is short. Each slide covers one part of the setup.</i>",
    ];
  }

  return {
    text: body.join("\n"),
    other: {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: navigationRows(slide, alreadyActive, support, channel) },
    },
  };
}

export function redeemPromptScreen(options = {}) {
  const support = String(options.supportUsername || SUPPORT_USERNAME).replace(/^@+/, "");
  const channel = String(options.mainChannelUsername ?? MAIN_CHANNEL_USERNAME).replace(/^@+/, "");
  const rows = [[premiumUrl("Get a Key", sellerUrl(support), TUTORIAL_ACTION_EMOJI_ID)]];
  if (channel) rows[0].push(premiumUrl("Main Channel", channelUrl(channel), TUTORIAL_PLANE_EMOJI_ID));
  return {
    text: [
      "🔑 <b><i>Redeem TelePilot Key</i></b>",
      "",
      "<b>Tutorial:</b> — Complete",
      "<b>Access:</b> — Waiting for key",
      "",
      "Send your TelePilot access key below.",
      "",
      `<b>Need a key?</b> — Message @${support}.`,
      channel ? `<b>Main channel:</b> — Join @${channel} for TelePilot updates and announcements.` : null,
      "",
      "<i>Your key message is processed by TelePilot's existing protected redemption flow.</i>",
    ].filter(Boolean).join("\n"),
    other: { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } },
  };
}

export function replayTutorialScreen(slide = 1) {
  return tutorialScreen({ accessActive: true, slide });
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

  // Polish the existing secure key-input screen while preserving app.js' actual
  // redemption state/rate limiting. Only its presentation is replaced.
  if (/^🔑 REDEEM KEY/i.test(value)) {
    const screen = redeemPromptScreen({ supportUsername: support, mainChannelUsername: channel });
    return { text: screen.text, other: screen.other };
  }

  // app.js historically offered Start Tutorial + Skip after first redemption.
  // A successful key now completes onboarding and exposes only the Dashboard.
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
      "<b>Tutorial:</b> — Complete",
      "<b>Access:</b> — Active",
      "",
      "<i>TelePilot is ready. Open the dashboard to connect your sender and build your posting setup.</i>",
    ].join("\n");
    return {
      text: value,
      other: {
        ...next,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[premiumCallback("Open Dashboard", "v1_dashboard_v13", TUTORIAL_CHECK_EMOJI_ID, { style: "success" })]],
        },
        entities: undefined,
      },
    };
  }

  // Add compact purchase/community entry points to the final v1.3 Dashboard.
  if (value.startsWith("✈️ TelePilot") && Array.isArray(next?.reply_markup?.inline_keyboard)) {
    const flat = next.reply_markup.inline_keyboard.flat();
    const looksLikeDashboard = flat.some(button => ["v1_posting_setup_v13", "v1_activity_v13"].includes(String(button?.callback_data || "")));
    if (looksLikeDashboard) {
      const keyLabel = "Key / renewal:";
      const channelLabel = "Main channel:";
      if (!value.includes("Key / renewal: —")) {
        value += `\n\n🔑 ${keyLabel} — Message @${support}.`;
        if (channel) value += `\n📢 ${channelLabel} — Join @${channel} for updates.`;
      }
      const entities = Array.isArray(next.entities) ? next.entities.map(entity => ({ ...entity })) : [];
      emphasizeAppendedLabel(value, entities, keyLabel);
      if (channel) emphasizeAppendedLabel(value, entities, channelLabel);
      if (entities.length) {
        delete next.parse_mode;
        next.entities = entities.sort((a, b) => Number(a.offset || 0) - Number(b.offset || 0) || Number(a.length || 0) - Number(b.length || 0));
      }

      const existing = new Set(flat.map(button => String(button?.url || "")));
      const row = [];
      const supportLink = sellerUrl(support);
      const mainLink = channelUrl(channel);
      if (!existing.has(supportLink)) row.push(premiumUrl("Get / Renew Key", supportLink, TUTORIAL_ACTION_EMOJI_ID));
      if (mainLink && !existing.has(mainLink)) row.push(premiumUrl("Main Channel", mainLink, TUTORIAL_PLANE_EMOJI_ID));
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
  // Active legacy/admin users still read the slides once, but never need to redeem
  // a second key just to migrate from the older onboarding state.
  bot.callbackQuery("linear_onboarding_complete", async ctx => {
    const uid = uidOf(ctx);
    if (!uid) return;
    if (!accessActive(uid)) {
      await ctx.answerCallbackQuery({ text: "Redeem an access key first.", show_alert: true });
      return sendScreen(ctx, tutorialScreen({ slide: TUTORIAL_SLIDES }), true);
    }
    markLinearOnboardingComplete(uid);
    await ctx.answerCallbackQuery({ text: "Tutorial complete" });
    return openApp(ctx);
  });

  bot.callbackQuery(/^linear_tutorial:([1-5])$/, async ctx => {
    const uid = uidOf(ctx);
    await ctx.answerCallbackQuery();
    return sendScreen(ctx, tutorialScreen({ slide: Number(ctx.match[1]), accessActive: accessActive(uid) }), true);
  });

  bot.callbackQuery("tutorial_restart", async ctx => {
    await ctx.answerCallbackQuery();
    return sendScreen(ctx, replayTutorialScreen(1), true);
  });

  // Compatibility only for old tutorial messages that may still exist in a chat.
  // These callbacks no longer mark onboarding complete or expose setup shortcuts.
  bot.callbackQuery("tutorial:skip", async ctx => {
    await ctx.answerCallbackQuery({ text: "The TelePilot tutorial cannot be skipped.", show_alert: true });
    return sendScreen(ctx, tutorialScreen({ slide: 1, accessActive: accessActive(uidOf(ctx)) }), true);
  });
  bot.callbackQuery("tutorial:begin", async ctx => {
    await ctx.answerCallbackQuery();
    return sendScreen(ctx, tutorialScreen({ slide: 1, accessActive: accessActive(uidOf(ctx)) }), true);
  });
  bot.callbackQuery(/^tutorial:(?:[1-7]|bot|personal|finish)$/, async ctx => {
    await ctx.answerCallbackQuery({ text: "The tutorial has been updated." });
    return sendScreen(ctx, tutorialScreen({ slide: 1, accessActive: accessActive(uidOf(ctx)) }), true);
  });
}

export function installLinearOnboardingV4(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotLinearOnboardingV4Installed) return false;
  const originalCommand = BotClass.prototype.command;
  const originalStart = BotClass.prototype.start;
  if (typeof originalCommand !== "function" || typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for linear onboarding v4");

  // Install against the raw grammY API before startup adds its normal UI wrappers.
  // Later wrappers build the v1.3 screen first; this layer then sees the final
  // payload and can append dashboard controls without them being overwritten.
  installLinearOnboardingV4Ui(GrammyApi);
  Object.defineProperty(BotClass.prototype, "__telepilotLinearOnboardingV4Installed", { value: true });

  BotClass.prototype.command = function(command, ...middleware) {
    if (command !== "start") return originalCommand.call(this, command, ...middleware);
    for (const handler of middleware) if (typeof handler === "function") appStartHandler = handler;
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const uid = uidOf(ctx);
      if (!uid || readLinearOnboarding(uid).completed) return handler.call(this, ctx, next);
      return sendScreen(ctx, tutorialScreen({ slide: 1, accessActive: accessActive(uid) }), false);
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
