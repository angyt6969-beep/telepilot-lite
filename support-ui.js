function cloneMarkup(other) {
  if (!other?.reply_markup?.inline_keyboard) return other;
  return {
    ...(other || {}),
    reply_markup: {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    },
  };
}

function hasCallback(other, callbackData) {
  return !!other?.reply_markup?.inline_keyboard?.some(row => row.some(button => button?.callback_data === callbackData));
}

function insertBeforeBack(other, button) {
  const next = cloneMarkup(other);
  if (!next?.reply_markup?.inline_keyboard) return other;
  const rows = next.reply_markup.inline_keyboard;
  const backIndex = rows.findIndex(row => row.some(item => ["home", "admin"].includes(String(item?.callback_data || ""))));
  const index = backIndex >= 0 ? backIndex : rows.length;
  rows.splice(index, 0, [button]);
  return next;
}

function enhanceSupportUi(text, other) {
  const value = String(text || "");
  let next = other;
  if (value.startsWith("⚙️ TelePilot Tools") && !hasCallback(next, "support")) {
    next = insertBeforeBack(next, { text: "💬 Support", callback_data: "support" });
  }
  if (value.startsWith("🟣 TELEPILOT ADMIN") && !hasCallback(next, "support_admin")) {
    next = insertBeforeBack(next, { text: "💬 Support Cases", callback_data: "support_admin" });
  }
  return next;
}

export function installSupportUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotSupportUiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for TelePilot support UI");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotSupportUiInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    return originalSendMessage.call(this, chatId, text, enhanceSupportUi(text, other), ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    return originalEditMessageText.call(this, chatId, messageId, text, enhanceSupportUi(text, other), ...rest);
  };
}
