import { readAppSettings } from "./posting-engine-enhancements.js";
import { readV1, writeV1 } from "./v1-engine.js";

let appStartHandler = null;
let appStopHandler = null;
let appHomeHandler = null;

function uidOf(ctx) { return ctx?.from?.id ? String(ctx.from.id) : ""; }

function setPaused(uid, paused) {
  if (!uid) return false;
  const pro = readV1(uid);
  const changed = pro.paused !== (paused === true);
  pro.paused = paused === true;
  if (paused) pro.skipNext = false;
  writeV1(uid, pro);
  return changed;
}

function isControlPage(text) {
  const value = String(text || "");
  return value.startsWith("✈️ TelePilot") || value.startsWith("⚙️ TelePilot Tools") || value.startsWith("⚡ TelePilot Power Tools");
}

function controlButtonForState({ paused, postingEnabled, text }) {
  if (paused) return { text: "Resume posting", callback_data: "v7_resume", style: "success" };
  if (postingEnabled || /\bLIVE\b/.test(String(text || ""))) return { text: "Pause posting", callback_data: "v7_pause" };
  return null;
}

function transformControlUi(chatId, text, other) {
  if (!isControlPage(text) || !other?.reply_markup?.inline_keyboard || !/^\d+$/.test(String(chatId || ""))) return { text, other };
  const uid = String(chatId);
  let paused = false;
  let postingEnabled = false;
  try { paused = readV1(uid).paused === true; } catch {}
  try { postingEnabled = readAppSettings(uid)?.postingEnabled === true; } catch {}

  let value = String(text || "");
  if (paused && value.startsWith("✈️ TelePilot")) {
    value = value.replace(/Status\s+[—-]\s+(?:READY|LIVE)/i, "Status — PAUSED");
  }

  const rows = other.reply_markup.inline_keyboard
    .map(row => row.filter(button => !["v7_pause", "v7_resume"].includes(String(button?.callback_data || ""))).map(button => ({ ...button })))
    .filter(row => row.length);
  const control = controlButtonForState({ paused, postingEnabled, text: value });
  if (control) {
    const backIndex = rows.findIndex(row => row.some(button => ["home", "v1_dashboard_v13"].includes(String(button?.callback_data || ""))));
    rows.splice(backIndex >= 0 ? backIndex : rows.length, 0, [control]);
  }
  return { text: value, other: { ...other, reply_markup: { ...other.reply_markup, inline_keyboard: rows } } };
}

export function installPauseResumeBot(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotPauseResumeV1Installed) return false;
  const originalCallbackQuery = BotClass.prototype.callbackQuery;
  const originalStart = BotClass.prototype.start;
  if (typeof originalCallbackQuery !== "function" || typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for pause/resume control");
  Object.defineProperty(BotClass.prototype, "__telepilotPauseResumeV1Installed", { value: true });

  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    if (trigger === "start" || trigger === "start_confirm") {
      middleware = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
        const uid = uidOf(ctx);
        if (uid) setPaused(uid, false);
        return handler.call(this, ctx, next);
      });
    }
    for (const handler of middleware) {
      if (typeof handler !== "function") continue;
      if (trigger === "start" && !appStartHandler) appStartHandler = handler;
      else if (trigger === "stop" && !appStopHandler) appStopHandler = handler;
      else if (trigger === "home" && !appHomeHandler) appHomeHandler = handler;
    }
    return originalCallbackQuery.call(this, trigger, ...middleware);
  };

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotPauseResumeV1Handlers) {
      Object.defineProperty(this, "__telepilotPauseResumeV1Handlers", { value: true });
      this.callbackQuery("v7_pause", async ctx => {
        const uid = uidOf(ctx);
        setPaused(uid, true);
        if (typeof appStopHandler === "function") return appStopHandler.call(this, ctx, async () => undefined);
        await ctx.answerCallbackQuery({ text: "Posting paused" });
      });
      this.callbackQuery("v7_resume", async ctx => {
        const uid = uidOf(ctx);
        const wasPosting = readAppSettings(uid)?.postingEnabled === true;
        setPaused(uid, false);
        if (!wasPosting && typeof appStartHandler === "function") return appStartHandler.call(this, ctx, async () => undefined);
        if (typeof appHomeHandler === "function") return appHomeHandler.call(this, ctx, async () => undefined);
        await ctx.answerCallbackQuery({ text: "Posting resumed" });
      });
    }
    return originalStart.apply(this, args);
  };
  return true;
}

export function installPauseResumeUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotPauseResumeUiV1Installed) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for pause/resume UI");
  Object.defineProperty(ApiClass.prototype, "__telepilotPauseResumeUiV1Installed", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = transformControlUi(chatId, text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = transformControlUi(chatId, text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
  return true;
}

export const __test = { controlButtonForState, isControlPage };
