import { Api } from "grammy";

export const TUTORIAL_GET_KEY_EMOJI_ID = "5307843983102204243";

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

function tutorialSlide(text) {
  const match = String(text || "").match(/Slide\s+([1-5])\s+of\s+5/i);
  return match ? Number(match[1]) : 0;
}

export function isolateTutorialPayload(text, other) {
  const slide = tutorialSlide(text);
  if (!slide || !other?.reply_markup?.inline_keyboard) return { text, other };

  const next = cloneOther(other);
  const rows = [];
  for (const row of next.reply_markup.inline_keyboard) {
    const fixed = [];
    for (const source of row) {
      const button = { ...source };
      const data = String(button.callback_data || "");
      const label = String(button.text || "");

      // v1.3's generic back-button router turns tutorial Back into Dashboard.
      // Restore the tutorial's own previous-slide navigation instead.
      if (data === "v1_dashboard_v13" && slide > 1) {
        button.text = "Back";
        button.callback_data = `linear_tutorial:${slide - 1}`;
      } else if ((data === "v1_dashboard_v13" || data === "home" || /dashboard/i.test(label)) && slide < 5) {
        continue;
      }

      if (slide === 5 && /^Get a Key$/i.test(String(button.text || ""))) {
        button.icon_custom_emoji_id = TUTORIAL_GET_KEY_EMOJI_ID;
      }
      fixed.push(button);
    }
    if (fixed.length) rows.push(fixed);
  }
  next.reply_markup.inline_keyboard = rows;
  return { text, other: next };
}

export function installTutorialUiIsolation(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotTutorialUiIsolationInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for tutorial UI isolation");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotTutorialUiIsolationInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = isolateTutorialPayload(text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = isolateTutorialPayload(text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
  return true;
}

installTutorialUiIsolation(Api);
