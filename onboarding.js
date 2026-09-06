import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard } from "grammy";
import { hasAnyAccount, listAccounts, normalizeAccountSelection, senderSummary } from "./account-store.js";
import { reloadUserState } from "./runtime-hooks.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
let appStartHandler = null;

function uidOf(ctx) { return ctx?.from?.id ? String(ctx.from.id) : ""; }
function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function settingsPath(uid) { return path.join(userDir(uid), "settings.json"); }
function onboardingPath(uid) { return path.join(userDir(uid), "onboarding.json"); }

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
    version: 3,
    welcomeSeen: saved.welcomeSeen === true,
    completed: saved.completed === true,
    step: Number.isInteger(Number(saved.step)) ? Math.max(1, Math.min(7, Number(saved.step))) : 1,
    completedAt: Number(saved.completedAt || 0) || null,
  };
}

function saveOnboarding(uid, patch) {
  const current = onboardingState(uid);
  writeJson(onboardingPath(uid), { ...current, ...patch, version: 3 });
}

function tutorialSeen(uid) { return onboardingState(uid).completed === true; }
function markWelcomeSeen(uid) { saveOnboarding(uid, { welcomeSeen: true }); }
function setTutorialStep(uid, step) { saveOnboarding(uid, { welcomeSeen: true, step: Math.max(1, Math.min(7, Number(step) || 1)) }); }
function markTutorialSeen(uid) { saveOnboarding(uid, { welcomeSeen: true, completed: true, step: 7, completedAt: Date.now() }); }

function settingsFor(uid) { return readJson(settingsPath(uid), {}); }
function setTutorialSenderMode(uid, mode) {
  const id = String(uid || "");
  if (!id) return;
  const saved = settingsFor(id);
  const accounts = listAccounts(id);
  if (mode === "bot") {
    writeJson(settingsPath(id), { ...saved, senderMode: "bot", selectedAccountIds: [] });
  } else {
    const selection = normalizeAccountSelection({ ...saved, senderMode: "selected" }, accounts);
    writeJson(settingsPath(id), { ...saved, senderMode: "selected", selectedAccountIds: selection.selected });
  }
  reloadUserState(id);
}
function accessActive(uid) {
  const saved = settingsFor(uid);
  if (saved.accessRevoked === true) return false;
  if (saved.accessLifetime === true) return true;
  return Number(saved.accessUntil || 0) > Date.now();
}
function hasPersonalSession(uid) { return hasAnyAccount(uid); }
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
      "Set up automated Telegram posting without digging through a crowded control panel.",
      "",
      "The main app is organized into Home, Posting Setup, Accounts, Destinations and Settings.",
      "",
      "Continue to activate your access and build your first posting setup."
    ].join("\n"),
    keyboard: new InlineKeyboard().text("Continue →", "onboarding:access").row().text("What can TelePilot do?", "onboarding:features"),
  };
}

function featuresPage() {
  return {
    text: [
      "✨ TelePilot",
      "",
      "• Personal-account or TelePilot Bot sending",
      "• Automatic destination joining for selected personal accounts",
      "• Telegram Addlist / shared-folder importing",
      "• Forum topic selection",
      "• Repeating and exact-time posting",
      "• Multi-account routing, preview and activity history",
      "",
      "Advanced controls stay out of the way until you need them."
    ].join("\n"),
    keyboard: new InlineKeyboard().text("← Back", "onboarding:welcome").text("Continue →", "onboarding:access"),
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
      "This setup uses the same controls you will use every day. TelePilot saves your place if you leave and /start resumes the tutorial.",
      "",
      "We will configure Accounts → Destinations → Posting Setup → Preview."
    ].join("\n"),
    keyboard: new InlineKeyboard().text("Start Setup →", "tutorial:2").row().text("Skip tutorial", "tutorial:skip"),
  };
}

function setupPage2(uid) {
  const saved = settingsFor(uid);
  const accounts = listAccounts(uid);
  const connected = accounts.length > 0;
  const currentSender = senderSummary(saved, accounts);
  return {
    text: [
      "👤 Step 1 of 5 — Accounts",
      "",
      connected ? `Connected accounts: ${accounts.length}` : "Choose who should send your posts.",
      connected ? `Current sender: ${currentSender}` : "",
      "",
      "Personal accounts can automatically join pasted destinations and Addlists. TelePilot Bot works too, but you must add the bot to its destinations yourself."
    ].filter(Boolean).join("\n"),
    keyboard: connected
      ? new InlineKeyboard().text("👤 Use Connected Account", "tutorial:personal").row().text("🤖 Use TelePilot Bot", "tutorial:bot").row().text("Open Accounts", "account").row().text("Next →", "tutorial:3").text("Skip", "tutorial:skip")
      : new InlineKeyboard().text("👤 Connect Personal Account", "account").row().text("🤖 Use TelePilot Bot", "tutorial:bot").row().text("Skip", "tutorial:skip"),
  };
}

function setupPage3(uid) {
  const saved = settingsFor(uid);
  const groups = Array.isArray(saved.groups) ? saved.groups : [];
  const needsTopic = groups.filter(group => group?.topicRequired === true && !Number(group?.topicId || 0)).length;
  return {
    text: [
      "📍 Step 2 of 5 — Destinations",
      "",
      groups.length ? `Configured: ${groups.length}` : "Add where TelePilot should post.",
      "",
      "Paste public links, private invite links or a t.me/addlist/... shared folder. With a personal sender selected, TelePilot automatically joins missing groups.",
      "",
      "If a group uses forum topics, TelePilot asks you to choose the exact topic. Join requests and verification stay Pending instead of blocking the rest of your setup.",
      needsTopic ? `\n💬 ${needsTopic} forum destination${needsTopic === 1 ? " still needs" : "s still need"} a posting topic before this tutorial continues.` : ""
    ].filter(Boolean).join("\n"),
    keyboard: groups.length && needsTopic === 0
      ? new InlineKeyboard().text("📍 Destinations", "groups").row().text("← Back", "tutorial:2").text("Next →", "tutorial:4").row().text("Skip", "tutorial:skip")
      : groups.length
        ? new InlineKeyboard().text("💬 Choose Topics", "dest_topics").row().text("📍 Destinations", "groups").row().text("← Back", "tutorial:2").text("Skip", "tutorial:skip")
        : new InlineKeyboard().text("＋ Add Destinations", "groups").row().text("← Back", "tutorial:2").text("Skip", "tutorial:skip"),
  };
}

function setupPage4(uid) {
  const saved = settingsFor(uid);
  const ready = typeof saved.adMessage === "string" && saved.adMessage.trim().length > 0;
  return {
    text: [
      "📝 Step 3 of 5 — Posting Setup",
      "",
      ready ? `Message ready · ${saved.adMessage.length} characters` : "Create the message TelePilot should send.",
      "",
      "Message and timing live together under Posting Setup. Advanced templates and exact schedules stay hidden under Advanced."
    ].join("\n"),
    keyboard: ready
      ? new InlineKeyboard().text("🧩 Posting Setup", "posting_setup").row().text("← Back", "tutorial:3").text("Next →", "tutorial:5").row().text("Skip", "tutorial:skip")
      : new InlineKeyboard().text("📝 Create Message", "message").row().text("← Back", "tutorial:3").text("Skip", "tutorial:skip"),
  };
}

function setupPage5(uid) {
  const saved = settingsFor(uid);
  const interval = formatInterval(saved.intervalMinutes || 30);
  return {
    text: [
      "⏱ Step 4 of 5 — Timing",
      "",
      `Current interval: ${interval}`,
      "",
      "Choose a normal repeat interval now. Exact times, one-time posts and other advanced scheduling remain available from Posting Setup → Advanced."
    ].join("\n"),
    keyboard: new InlineKeyboard().text("⏱ Choose Timing", "interval").row().text("← Back", "tutorial:4").text("Next →", "tutorial:6").row().text("Skip", "tutorial:skip"),
  };
}

function setupPage6() {
  return {
    text: [
      "👀 Step 5 of 5 — Preview",
      "",
      "Smart Preview shows the sender, message, active destinations and timing before you go live.",
      "",
      "Starting from Home is now one tap — there is no extra confirmation for normal posting actions."
    ].join("\n"),
    keyboard: new InlineKeyboard().text("👀 Smart Preview", "v1_preview").row().text("← Back", "tutorial:5").text("Finish →", "tutorial:7").row().text("Skip", "tutorial:skip"),
  };
}

function setupPage7(uid) {
  const saved = settingsFor(uid);
  const groups = Array.isArray(saved.groups) ? saved.groups.length : 0;
  const messageReady = typeof saved.adMessage === "string" && saved.adMessage.trim().length > 0;
  const sender = hasPersonalSession(uid) ? senderSummary(saved, listAccounts(uid)) : "TelePilot Bot";
  return {
    text: [
      "🎉 TelePilot is ready",
      "",
      `Sender  ${sender}`,
      `Message  ${messageReady ? "Ready" : "Not set"}`,
      `Destinations  ${groups}`,
      `Timing  ${formatInterval(saved.intervalMinutes || 30)}`,
      "",
      "Home now stays simple: Start/Stop, Posting Setup, Accounts, Destinations and Settings. Advanced tools remain available without crowding the main screen."
    ].join("\n"),
    keyboard: new InlineKeyboard().text("← Back", "tutorial:6").row().text("✅ Open TelePilot", "tutorial:finish"),
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
  bot.callbackQuery("tutorial:bot", async ctx => {
    const uid = uidOf(ctx);
    if (uid) setTutorialSenderMode(uid, "bot");
    await ctx.answerCallbackQuery({ text: "TelePilot Bot selected" });
    await showTutorial(ctx, 3, true);
  });
  bot.callbackQuery("tutorial:personal", async ctx => {
    const uid = uidOf(ctx);
    if (uid) setTutorialSenderMode(uid, "selected");
    await ctx.answerCallbackQuery({ text: "Personal account selected" });
    await showTutorial(ctx, 3, true);
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
