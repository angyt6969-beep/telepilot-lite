import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard } from "grammy";

const DATA_DIR = process.env.DATA_DIR || "/data";
let appStartHandler = null;

function uidOf(ctx) { return ctx?.from?.id ? String(ctx.from.id) : ""; }
function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function settingsPath(uid) { return path.join(userDir(uid), "settings.json"); }
function onboardingPath(uid) { return path.join(userDir(uid), "onboarding.json"); }
function personalSessionPath(uid) { return path.join(userDir(uid), "personal-session.enc"); }

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function onboardingState(uid) {
  const saved = readJson(onboardingPath(uid), {});
  return {
    version: 2,
    welcomeSeen: saved.welcomeSeen === true,
    completed: saved.completed === true,
    step: Number.isInteger(Number(saved.step)) ? Math.max(1, Math.min(7, Number(saved.step))) : 1,
    completedAt: Number(saved.completedAt || 0) || null,
  };
}

function saveOnboarding(uid, patch) {
  const current = onboardingState(uid);
  writeJson(onboardingPath(uid), { ...current, ...patch, version: 2 });
}

function tutorialSeen(uid) { return onboardingState(uid).completed === true; }
function markWelcomeSeen(uid) { saveOnboarding(uid, { welcomeSeen: true }); }
function setTutorialStep(uid, step) { saveOnboarding(uid, { welcomeSeen: true, step: Math.max(1, Math.min(7, Number(step) || 1)) }); }
function markTutorialSeen(uid) { saveOnboarding(uid, { welcomeSeen: true, completed: true, step: 7, completedAt: Date.now() }); }

function settingsFor(uid) { return readJson(settingsPath(uid), {}); }
function accessActive(uid) {
  const saved = settingsFor(uid);
  if (saved.accessRevoked === true) return false;
  if (saved.accessLifetime === true) return true;
  return Number(saved.accessUntil || 0) > Date.now();
}
function hasPersonalSession(uid) {
  try { return fs.existsSync(personalSessionPath(uid)) && fs.statSync(personalSessionPath(uid)).size > 20; }
  catch { return false; }
}
function formatInterval(minutes) {
  const n = Number(minutes || 30);
  if (n === 60) return "1 hour";
  if (n === 90) return "1 hour 30 min";
  if (n === 120) return "2 hours";
  return `${n} min`;
}

function welcomePage() {
  return {
    text: [
      "👋 Welcome to TelePilot",
      "",
      "Automate your Telegram posting from one clean control panel.",
      "",
      "• Post to multiple groups and channels",
      "• Schedule and repeat posts",
      "• Post from TelePilot Bot or your personal Telegram account",
      "• Preview, manage and monitor everything from the bot",
      "",
      "Continue to activate your TelePilot access.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("Continue →", "onboarding:access").row()
      .text("✨ What do I get?", "onboarding:features"),
  };
}

function featuresPage() {
  return {
    text: [
      "✨ What you get with TelePilot",
      "",
      "📱 Personal-account or bot posting",
      "👥 Multiple Telegram destinations",
      "📝 Saved messages, media and templates",
      "⏱ Repeating intervals and scheduling",
      "👀 Smart Preview before you publish",
      "📊 Activity and destination health",
      "⚙️ Posting tools and safety controls",
      "💬 Built-in support",
      "",
      "When you're ready, continue to the access-key screen.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("← Back", "onboarding:welcome")
      .text("Continue →", "onboarding:access"),
  };
}

function setupPage1(uid) {
  const saved = settingsFor(uid);
  const plan = saved.accessLifetime === true ? "Lifetime" : "Active";
  return {
    text: [
      "✅ Access activated",
      "",
      `Access: ${plan}`,
      "",
      "Now we'll set up TelePilot together.",
      "",
      "The tutorial is interactive: each step opens the real TelePilot control you need. TelePilot will continue the tutorial automatically after setup actions; if anything is interrupted, /start resumes your saved step.",
      "",
      "Setup takes just a few minutes.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("🚀 Start Setup", "tutorial:2").row()
      .text("Skip tutorial", "tutorial:skip"),
  };
}

function setupPage2(uid) {
  const connected = hasPersonalSession(uid);
  return {
    text: [
      "📱 Step 1 of 5 — Choose your sender",
      "",
      connected
        ? "✅ Your personal Telegram account is connected."
        : "Choose who should send your posts.",
      "",
      "TelePilot Bot is the simplest option. A personal account lets posts appear from your own Telegram account.",
      "",
      connected ? "You're ready for the next step." : "You can connect a personal account now, or use TelePilot Bot and continue.",
    ].join("\n"),
    keyboard: connected
      ? new InlineKeyboard().text("← Back", "tutorial:1").text("Next →", "tutorial:3").row().text("Skip tutorial", "tutorial:skip")
      : new InlineKeyboard()
          .text("👤 Connect Personal Account", "account").row()
          .text("🤖 Use TelePilot Bot", "tutorial:3").row()
          .text("← Back", "tutorial:1").text("Skip tutorial", "tutorial:skip"),
  };
}

function setupPage3(uid) {
  const saved = settingsFor(uid);
  const count = Array.isArray(saved.groups) ? saved.groups.length : 0;
  return {
    text: [
      "👥 Step 2 of 5 — Add a destination",
      "",
      count > 0 ? `✅ ${count} destination${count === 1 ? "" : "s"} configured.` : "Add at least one group or channel where TelePilot should post.",
      "",
      "Public destinations can be added by @username or t.me link. Private groups can also use /addhere from inside the group.",
      "",
      count > 0 ? "Destination setup is ready." : "Tap Add Destination, configure it, then send /start to continue the tutorial.",
    ].join("\n"),
    keyboard: count > 0
      ? new InlineKeyboard().text("← Back", "tutorial:2").text("Next →", "tutorial:4").row().text("👥 Manage Destinations", "groups").row().text("Skip tutorial", "tutorial:skip")
      : new InlineKeyboard().text("👥 Add Destination", "groups").row().text("← Back", "tutorial:2").text("Skip tutorial", "tutorial:skip"),
  };
}

function setupPage4(uid) {
  const saved = settingsFor(uid);
  const ready = typeof saved.adMessage === "string" && saved.adMessage.trim().length > 0;
  return {
    text: [
      "📝 Step 3 of 5 — Create your message",
      "",
      ready ? `✅ Your message is ready (${saved.adMessage.length} characters).` : "Create the message TelePilot should post.",
      "",
      "You can use text, formatting and media, then reuse the message later with Templates and other Tools.",
      "",
      ready ? "Message setup is complete." : "Tap Create Message, save it, then send /start to resume here.",
    ].join("\n"),
    keyboard: ready
      ? new InlineKeyboard().text("← Back", "tutorial:3").text("Next →", "tutorial:5").row().text("📝 Edit Message", "message").row().text("Skip tutorial", "tutorial:skip")
      : new InlineKeyboard().text("📝 Create Message", "message").row().text("← Back", "tutorial:3").text("Skip tutorial", "tutorial:skip"),
  };
}

function setupPage5(uid) {
  const saved = settingsFor(uid);
  const interval = formatInterval(saved.intervalMinutes || 30);
  return {
    text: [
      "⏱ Step 4 of 5 — Choose timing",
      "",
      `Current repeating interval: ${interval}`,
      "",
      "You can keep this interval, change it from 1 minute up to 2 hours, or use TelePilot's scheduling tools for exact times and future posts.",
      "",
      "You can always change timing later.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("⏱ Choose Interval", "interval").row()
      .text("← Back", "tutorial:4").text("Next →", "tutorial:6").row()
      .text("Skip tutorial", "tutorial:skip"),
  };
}

function setupPage6() {
  return {
    text: [
      "👀 Step 5 of 5 — Preview before posting",
      "",
      "Smart Preview lets you check how your post will look before you start sending it to destinations.",
      "",
      "This step is optional, but it's a good habit before your first LIVE run.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("👀 Open Smart Preview", "v1_preview").row()
      .text("← Back", "tutorial:5").text("Finish →", "tutorial:7").row()
      .text("Skip tutorial", "tutorial:skip"),
  };
}

function setupPage7(uid) {
  const saved = settingsFor(uid);
  const groups = Array.isArray(saved.groups) ? saved.groups.length : 0;
  const messageReady = typeof saved.adMessage === "string" && saved.adMessage.trim().length > 0;
  const sender = hasPersonalSession(uid)
    ? (saved.personalUsername ? `@${saved.personalUsername}` : "Personal account")
    : "TelePilot Bot";
  return {
    text: [
      "🎉 TelePilot is ready",
      "",
      `✅ Access active`,
      `✅ Sender: ${sender}`,
      `${groups > 0 ? "✅" : "⚠️"} Destinations: ${groups}`,
      `${messageReady ? "✅" : "⚠️"} Message: ${messageReady ? "Ready" : "Not set yet"}`,
      `✅ Interval: ${formatInterval(saved.intervalMinutes || 30)}`,
      "",
      groups > 0 && messageReady
        ? "Everything needed for your first posting run is configured."
        : "You can finish the missing items from the dashboard before starting a posting run.",
      "",
      "You can replay this tutorial from Tools whenever you want.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("← Back", "tutorial:6").row()
      .text("✅ Open TelePilot", "tutorial:finish"),
  };
}

function tutorialPage(uid, page) {
  if (Number(page) === 2) return setupPage2(uid);
  if (Number(page) === 3) return setupPage3(uid);
  if (Number(page) === 4) return setupPage4(uid);
  if (Number(page) === 5) return setupPage5(uid);
  if (Number(page) === 6) return setupPage6(uid);
  if (Number(page) === 7) return setupPage7(uid);
  return setupPage1(uid);
}

export function advanceTutorialAfterAction(uid, expectedStep, nextStep) {
  const id = String(uid || "");
  if (!id) return null;
  const current = onboardingState(id);
  if (current.completed || current.step !== Number(expectedStep)) return null;
  setTutorialStep(id, Number(nextStep));
  return tutorialPage(id, Number(nextStep));
}

async function renderScreen(ctx, screen, edit = false) {
  if (edit && ctx.callbackQuery) {
    try { return await ctx.editMessageText(screen.text, { reply_markup: screen.keyboard }); } catch {}
  }
  return ctx.reply(screen.text, { reply_markup: screen.keyboard });
}

async function showTutorial(ctx, page = 1, edit = false, persistStep = true) {
  const uid = uidOf(ctx);
  if (uid && persistStep && !tutorialSeen(uid)) setTutorialStep(uid, page);
  return renderScreen(ctx, tutorialPage(uid, page), edit);
}

async function openApp(ctx) {
  if (typeof appStartHandler === "function") return appStartHandler(ctx, async () => undefined);
  return ctx.reply("Send /start to open TelePilot.");
}

async function finishTutorial(ctx) {
  const uid = uidOf(ctx);
  if (uid) markTutorialSeen(uid);
  try { await ctx.answerCallbackQuery({ text: "Tutorial complete" }); } catch {}
  if (ctx?.chat?.id && ctx?.callbackQuery?.message?.message_id) {
    try { await ctx.api.deleteMessage(ctx.chat.id, ctx.callbackQuery.message.message_id); } catch {}
  }
  return openApp(ctx);
}

async function skipTutorial(ctx) {
  const uid = uidOf(ctx);
  if (uid) markTutorialSeen(uid);
  try { await ctx.answerCallbackQuery({ text: "Tutorial skipped" }); } catch {}
  return openApp(ctx);
}

function registerHandlers(bot) {
  bot.callbackQuery("onboarding:welcome", async ctx => {
    await ctx.answerCallbackQuery();
    await renderScreen(ctx, welcomePage(), true);
  });
  bot.callbackQuery("onboarding:features", async ctx => {
    await ctx.answerCallbackQuery();
    await renderScreen(ctx, featuresPage(), true);
  });
  bot.callbackQuery("onboarding:access", async ctx => {
    const uid = uidOf(ctx);
    if (uid) markWelcomeSeen(uid);
    await ctx.answerCallbackQuery();
    await openApp(ctx);
  });
  bot.callbackQuery("tutorial:begin", async ctx => {
    await ctx.answerCallbackQuery();
    await showTutorial(ctx, 1, true);
  });
  bot.callbackQuery(/^tutorial:([1-7])$/, async ctx => {
    await ctx.answerCallbackQuery();
    await showTutorial(ctx, Number(ctx.match[1]), true);
  });
  bot.callbackQuery("tutorial:finish", finishTutorial);
  bot.callbackQuery("tutorial:skip", skipTutorial);
  bot.callbackQuery("tutorial_restart", async ctx => {
    await ctx.answerCallbackQuery();
    await showTutorial(ctx, 1, true, false);
  });
}

export function installOnboarding(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotOnboardingInstalled) return;
  const originalCommand = BotClass.prototype.command;
  const originalStart = BotClass.prototype.start;
  if (typeof originalCommand !== "function" || typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for TelePilot onboarding");
  Object.defineProperty(BotClass.prototype, "__telepilotOnboardingInstalled", { value: true });

  BotClass.prototype.command = function(command, ...middleware) {
    if (command !== "start") return originalCommand.call(this, command, ...middleware);
    for (const handler of middleware) if (typeof handler === "function") appStartHandler = handler;
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const uid = uidOf(ctx);
      if (!uid || tutorialSeen(uid)) return handler.call(this, ctx, next);

      const state = onboardingState(uid);
      if (!accessActive(uid)) {
        if (!state.welcomeSeen) return renderScreen(ctx, welcomePage(), false);
        return handler.call(this, ctx, next);
      }

      return showTutorial(ctx, state.step || 1, false);
    });
    return originalCommand.call(this, command, ...wrapped);
  };

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotOnboardingHandlersRegistered) {
      Object.defineProperty(this, "__telepilotOnboardingHandlersRegistered", { value: true });
      registerHandlers(this);
    }
    return originalStart.apply(this, args);
  };
}
