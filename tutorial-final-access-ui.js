import { Api } from "grammy";
import { checkoutUrlForUid } from "./crypto-checkout-web.js";
import { FREE_TRIAL_EMOJI_ID, freeTrialUrlForUid } from "./free-trial.js";

const SUPPORT_USERNAME = String(process.env.TELEPILOT_SUPPORT_USERNAME || "noahxrp").replace(/^@+/, "");
const SUPPORT_URL = `https://t.me/${SUPPORT_USERNAME}`;
const TUTORIAL_GET_KEY_EMOJI_ID = "5307843983102204243";
const TUTORIAL_CHECK_EMOJI_ID = "5206607081334906820";
const TUTORIAL_ACTION_EMOJI_ID = "5411590687663608498";

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

function isFinalTutorial(text) {
  return /Slide\s+5\s+of\s+5/i.test(String(text || ""));
}

function replaceClosingCopy(text) {
  const value = String(text || "");
  const closing = `<i>Redeem an existing key, purchase a key, claim your free 1-day tutorial key, or contact @${SUPPORT_USERNAME}.</i>`;
  if (/<i>Open Dashboard to start building your setup\.<\/i>/i.test(value)) {
    return value.replace(/<i>Open Dashboard to start building your setup\.<\/i>/i, closing);
  }
  if (/<i>Redeem a key to continue\.[\s\S]*?<\/i>/i.test(value)) {
    return value.replace(/<i>Redeem a key to continue\.[\s\S]*?<\/i>/i, closing);
  }
  return `${value}\n\n${closing}`;
}

export function finalTutorialAccessPayload(chatId, text, other, options = {}) {
  const uid = String(chatId || "");
  if (!/^\d+$/.test(uid) || !isFinalTutorial(text)) return { text, other };

  const checkoutUrl = String(options.checkoutUrl || checkoutUrlForUid(uid, options));
  const trialUrl = String(options.freeTrialUrl || freeTrialUrlForUid(uid, options));
  const next = cloneOther(other);
  next.parse_mode = "HTML";
  next.reply_markup = {
    ...(next.reply_markup || {}),
    inline_keyboard: [
      [{
        text: "Redeem a Key",
        callback_data: "redeem_key",
        icon_custom_emoji_id: TUTORIAL_CHECK_EMOJI_ID,
        style: "success",
      }],
      [{
        text: "Purchase a Key",
        url: checkoutUrl,
        icon_custom_emoji_id: TUTORIAL_GET_KEY_EMOJI_ID,
      }],
      [{
        text: "Claim your Free 1 day key!",
        url: trialUrl,
        icon_custom_emoji_id: FREE_TRIAL_EMOJI_ID,
      }],
      [{
        text: `Contact @${SUPPORT_USERNAME}`,
        url: SUPPORT_URL,
        icon_custom_emoji_id: TUTORIAL_ACTION_EMOJI_ID,
      }],
      [{
        text: "Back",
        callback_data: "linear_tutorial:4",
        icon_custom_emoji_id: TUTORIAL_ACTION_EMOJI_ID,
      }],
    ],
  };
  return { text: replaceClosingCopy(text), other: next };
}

export function installTutorialFinalAccessUi(ApiClass = Api) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotTutorialFinalAccessUiInstalled) return false;
  const originalSend = ApiClass.prototype.sendMessage;
  const originalEdit = ApiClass.prototype.editMessageText;
  if (typeof originalSend !== "function" || typeof originalEdit !== "function") {
    throw new Error("Unsupported grammY Api shape for final tutorial access UI");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotTutorialFinalAccessUiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = finalTutorialAccessPayload(chatId, text, other);
    return originalSend.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = finalTutorialAccessPayload(chatId, text, other);
    return originalEdit.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
  return true;
}

installTutorialFinalAccessUi(Api);
