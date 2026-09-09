import { checkoutUrlForUid } from "./crypto-checkout-web.js";

const SUPPORT_USERNAME = "vvschrome";
const SUPPORT_URL = `https://t.me/${SUPPORT_USERNAME}`;
export const CHECKOUT_GET_KEY_EMOJI_ID = "5307843983102204243";

function cloneOther(other) {
  if (!other?.reply_markup?.inline_keyboard) return other;
  return {
    ...(other || {}),
    reply_markup: {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    },
  };
}
function isGetKeyButton(button) {
  const text = String(button?.text || "");
  const url = String(button?.url || "");
  return url === SUPPORT_URL && /get(?:\s*\/\s*renew)?\s+(?:a\s+)?key/i.test(text);
}
export function decorateCryptoCheckoutLinks(chatId, text, other, options = {}) {
  const uid = String(chatId || "");
  if (!/^\d+$/.test(uid) || !other?.reply_markup?.inline_keyboard) return { text, other };
  const next = cloneOther(other);
  const checkoutUrl = checkoutUrlForUid(uid, options);
  let changed = false;
  let manualExists = false;
  for (const row of next.reply_markup.inline_keyboard) {
    for (const button of row) {
      if (String(button?.url || "") === SUPPORT_URL && /message/i.test(String(button?.text || ""))) manualExists = true;
      if (!isGetKeyButton(button)) continue;
      button.url = checkoutUrl;
      button.icon_custom_emoji_id = CHECKOUT_GET_KEY_EMOJI_ID;
      changed = true;
    }
  }
  if (!changed) return { text, other: next };
  if (!manualExists) {
    next.reply_markup.inline_keyboard.push([{ text: `Message @${SUPPORT_USERNAME}`, url: SUPPORT_URL }]);
  }
  let value = String(text || "");
  value = value.replace(new RegExp(`Need one\\? Message @${SUPPORT_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?`, "i"), `Need one? Use TelePilot Checkout, or message @${SUPPORT_USERNAME} for a manual key.`);
  value = value.replace(new RegExp(`<b>Need a key\\?</b> — Message @${SUPPORT_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?`, "i"), `<b>Need a key?</b> — Use TelePilot Checkout or message @${SUPPORT_USERNAME}.`);
  value = value.replace(new RegExp(`Key / renewal: — Message @${SUPPORT_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?`, "i"), `Key / renewal: — TelePilot Checkout or @${SUPPORT_USERNAME}.`);
  return { text: value, other: next };
}

export function installCryptoCheckoutBotUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotCryptoCheckoutBotUiInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for crypto checkout UI");
  Object.defineProperty(ApiClass.prototype, "__telepilotCryptoCheckoutBotUiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = decorateCryptoCheckoutLinks(chatId, text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = decorateCryptoCheckoutLinks(chatId, text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
  return true;
}
