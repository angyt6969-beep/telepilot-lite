import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard } from "grammy";

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

function isExistingProfile(uid) {
  try { return fs.existsSync(settingsPath(uid)) && fs.statSync(settingsPath(uid)).size > 2; }
  catch { return false; }
}

function tutorialSeen(uid) {
  return readJson(onboardingPath(uid), {}).completed === true;
}

function markTutorialSeen(uid) {
  writeJson(onboardingPath(uid), { version: 1, completed: true, completedAt: Date.now() });
}

function page1() {
  return {
    text: [
      "👋 Welcome to TelePilot",
      "Your Telegram posting control panel.",
      "",
      "TelePilot can automatically send a saved post to the groups and channels you choose.",
      "",
      "Setup is only four things:",
      "Sender — who sends the post",
      "Message — what gets posted",
      "Destinations — where it goes",
      "Schedule — when it posts",
      "",
      "This quick tutorial takes about 30 seconds.",
    ].join("\n"),
    keyboard: new InlineKeyboard().text("Next →", "tutorial:2").row().text("Skip tutorial", "tutorial:finish"),
  };
}

function page2() {
  return {
    text: [
      "📱 Sender & Message",
      "Step 1 of 3",
      "",
      "Sender — choose TelePilot Bot or connect your own Telegram account.",
      "",
      "If your account is connected, posts come from that account. Your saved setup stays even if you reconnect later.",
      "",
      "Message — save the text/media you want to post. You can also keep templates and test a post before going LIVE.",
    ].join("\n"),
    keyboard: new InlineKeyboard().text("← Back", "tutorial:1").text("Next →", "tutorial:3"),
  };
}

function page3() {
  return {
    text: [
      "📁 Destinations & Schedule",
      "Step 2 of 3",
      "",
      "Destinations — the groups/channels TelePilot is allowed to post to.",
      "",
      "You can paste many public destinations at once — one @username or t.me link per line.",
      "",
      "Schedule — choose a repeating interval, posting hours, exact times, or a one-time future post.",
      "",
      "You can disable a destination without deleting it whenever you want.",
    ].join("\n"),
    keyboard: new InlineKeyboard().text("← Back", "tutorial:2").text("Next →", "tutorial:4"),
  };
}

function page4() {
  return {
    text: [
      "⚙️ Tools & Safety",
      "Step 3 of 3",
      "",
      "Test Send — preview a post before publishing.",
      "Templates — save reusable messages and rotate them automatically.",
      "Health — see which destinations can post successfully.",
      "Activity — sent, failed and skipped posting history.",
      "Pause / Emergency Stop — immediately prevent future scheduled sends.",
      "",
      "When Message + Destination are ready, the dashboard gives you a green Start posting button.",
      "",
      "You can replay this tutorial from Tools at any time.",
    ].join("\n"),
    keyboard: new InlineKeyboard().text("← Back", "tutorial:3").row().text("✅ Open TelePilot", "tutorial:finish"),
  };
}

function tutorialPage(page) {
  if (Number(page) === 2) return page2();
  if (Number(page) === 3) return page3();
  if (Number(page) === 4) return page4();
  return page1();
}

async function showTutorial(ctx, page = 1, edit = false) {
  const screen = tutorialPage(page);
  if (edit && ctx.callbackQuery) {
    try { return await ctx.editMessageText(screen.text, { reply_markup: screen.keyboard }); } catch {}
  }
  return ctx.reply(screen.text, { reply_markup: screen.keyboard });
}

async function finishTutorial(ctx) {
  const uid = uidOf(ctx);
  if (uid) markTutorialSeen(uid);
  try { await ctx.answerCallbackQuery({ text: "Tutorial complete" }); } catch {}
  if (ctx?.chat?.id && ctx?.callbackQuery?.message?.message_id) {
    try { await ctx.api.deleteMessage(ctx.chat.id, ctx.callbackQuery.message.message_id); } catch {}
  }
  if (typeof appStartHandler === "function") return appStartHandler(ctx, async () => undefined);
  return ctx.reply("✅ Tutorial complete. Send /start to open TelePilot.");
}

function registerHandlers(bot) {
  bot.callbackQuery(/^tutorial:([1-4])$/, async ctx => {
    await ctx.answerCallbackQuery();
    await showTutorial(ctx, Number(ctx.match[1]), true);
  });
  bot.callbackQuery("tutorial:finish", finishTutorial);
  bot.callbackQuery("tutorial_restart", async ctx => {
    await ctx.answerCallbackQuery();
    await showTutorial(ctx, 1, true);
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
      if (uid && !tutorialSeen(uid) && !isExistingProfile(uid)) return showTutorial(ctx, 1, false);
      return handler.call(this, ctx, next);
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
