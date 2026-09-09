import { Api } from "grammy";
import { checkoutUrlForUid } from "./crypto-checkout-web.js";
import { FREE_TRIAL_EMOJI_ID, freeTrialUrlForUid } from "./free-trial.js";

export const TELEPILOT_OWNER_USERNAME = "vvschrome";
const BUY_KEY_EMOJI_ID = "5307843983102204243";
const REDEEM_KEY_EMOJI_ID = "5206607081334906820";

function cloneOther(other) {
  const next = other && typeof other === "object" ? { ...other } : {};
  if (other?.reply_markup?.inline_keyboard) {
    next.reply_markup = {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    };
  }
  return next;
}

function callbackSet(other) {
  return new Set((other?.reply_markup?.inline_keyboard || []).flat().map(button => String(button?.callback_data || "")).filter(Boolean));
}

export function isInactiveAccessScreen(text, other) {
  const callbacks = callbackSet(other);
  if (!callbacks.has("redeem_key") || callbacks.has("home")) return false;
  return /(?:^|\n)\s*(?:🔑\s*ACCESS|🔐\s*TELEPILOT\s+ACCESS)\b/i.test(String(text || ""));
}

export function accessStartPayload(chatId, text, other, options = {}) {
  const uid = String(chatId || "");
  if (!/^\d+$/.test(uid) || !isInactiveAccessScreen(text, other)) return { text, other };

  const checkoutUrl = String(options.checkoutUrl || checkoutUrlForUid(uid, options));
  const freeTrialUrl = String(options.freeTrialUrl || freeTrialUrlForUid(uid, options));
  const next = cloneOther(other);
  next.parse_mode = "HTML";
  next.entities = undefined;
  next.reply_markup = {
    ...(next.reply_markup || {}),
    inline_keyboard: [
      [{
        text: "Redeem Key",
        callback_data: "redeem_key",
        icon_custom_emoji_id: REDEEM_KEY_EMOJI_ID,
        style: "success",
      }],
      [{
        text: "Buy Key",
        url: checkoutUrl,
        icon_custom_emoji_id: BUY_KEY_EMOJI_ID,
        style: "primary",
      }],
      [{
        text: "Free 1-Day Key",
        url: freeTrialUrl,
        icon_custom_emoji_id: FREE_TRIAL_EMOJI_ID,
      }],
    ],
  };

  return {
    text: [
      "✈️ <b><i>TelePilot Access</i></b>",
      "",
      "Choose how you want to unlock TelePilot.",
      "",
      "<b>Redeem Key</b> — use an existing access key.",
      "<b>Buy Key</b> — purchase TelePilot access.",
      "<b>Free 1-Day Key</b> — claim your one-time free key.",
      "",
      "<i>Owner & support: @" + TELEPILOT_OWNER_USERNAME + "</i>",
    ].join("\n"),
    other: next,
  };
}

// Compatibility export for the existing regression import name.
export const finalTutorialAccessPayload = accessStartPayload;

export function installTutorialFinalAccessUi(ApiClass = Api) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotTutorialFinalAccessUiInstalled) return false;
  const originalSend = ApiClass.prototype.sendMessage;
  const originalEdit = ApiClass.prototype.editMessageText;
  if (typeof originalSend !== "function" || typeof originalEdit !== "function") {
    throw new Error("Unsupported grammY Api shape for TelePilot access start UI");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotTutorialFinalAccessUiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = accessStartPayload(chatId, text, other);
    return originalSend.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = accessStartPayload(chatId, text, other);
    return originalEdit.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
  return true;
}

installTutorialFinalAccessUi(Api);
