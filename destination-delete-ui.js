export function installDestinationDeleteControls(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotDestinationDeleteControlsInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for destination delete controls");

  Object.defineProperty(BotClass.prototype, "__telepilotDestinationDeleteControlsInstalled", { value: true });
  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotDestinationDeleteHandlersRegistered) {
      Object.defineProperty(this, "__telepilotDestinationDeleteHandlersRegistered", { value: true });
      this.callbackQuery("v1_delete_groups_v13", async ctx => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
          [
            "🗑 Delete Groups",
            "",
            "Choose how you want to remove saved destinations.",
            "",
            "Delete manually lets you pick individual groups one at a time.",
            "Delete all removes every saved destination and requires confirmation.",
          ].join("\n"),
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🗑 Delete manually", callback_data: "remove_group_menu" }],
                [{ text: "⚠️ Delete all", callback_data: "clear_groups" }],
                [{ text: "📁 Destinations", callback_data: "v1_destinations_v13" }],
              ],
            },
          },
        );
      });
    }
    return originalStart.apply(this, args);
  };
}

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

function addDeleteGroupsButton(text, other) {
  if (!String(text || "").startsWith("📁 Destinations")) return other;
  const next = cloneMarkup(other) || { reply_markup: { inline_keyboard: [] } };
  const rows = next.reply_markup.inline_keyboard || [];
  if (rows.some(row => row.some(button => button.callback_data === "v1_delete_groups_v13"))) return next;

  const deleteRow = [{ text: "🗑 Delete Groups", callback_data: "v1_delete_groups_v13" }];
  const dashboardIndex = rows.findIndex(row => row.some(button => button.callback_data === "v1_dashboard_v13"));
  if (dashboardIndex >= 0) rows.splice(dashboardIndex, 0, deleteRow);
  else rows.push(deleteRow);
  next.reply_markup.inline_keyboard = rows;
  return next;
}

export function installDestinationDeleteUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotDestinationDeleteUiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for destination delete UI");
  }

  Object.defineProperty(ApiClass.prototype, "__telepilotDestinationDeleteUiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    return originalSendMessage.call(this, chatId, text, addDeleteGroupsButton(text, other), ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    return originalEditMessageText.call(this, chatId, messageId, text, addDeleteGroupsButton(text, other), ...rest);
  };
}
