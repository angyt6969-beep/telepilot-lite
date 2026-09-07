// Membership v4 uses its own compact issue-row tokens. The established topic
// picker owns d2_topic_open tokens, so issue-detail topic buttons should enter
// the existing topic queue rather than hand a foreign token to that picker.
export function installDestinationTopicButtonRepairV4(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotTopicButtonRepairV4Installed) return false;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for topic button repair v4");
  Object.defineProperty(BotClass.prototype, "__telepilotTopicButtonRepairV4Installed", { value: true });
  BotClass.prototype.start = function(...args) {
    if (this?.api?.config?.use && !this.__telepilotTopicButtonRepairV4Transformer) {
      Object.defineProperty(this, "__telepilotTopicButtonRepairV4Transformer", { value: true });
      this.api.config.use((prev, method, payload, signal) => {
        if ((method === "sendMessage" || method === "editMessageText") && payload?.reply_markup?.inline_keyboard) {
          payload = {
            ...payload,
            reply_markup: {
              ...payload.reply_markup,
              inline_keyboard: payload.reply_markup.inline_keyboard.map(row => row.map(source => {
                const button = { ...source };
                const match = String(button.callback_data || "").match(/^d2_topic_open:([a-z0-9]+):0$/i);
                // Native Destinations v2 tokens are 11 chars. Shorter tokens are
                // membership-v4 issue tokens; route those to the existing Topics list.
                if (match && match[1].length < 11) button.callback_data = "d2_topics:0";
                return button;
              })),
            },
          };
        }
        return prev(method, payload, signal);
      });
    }
    return originalStart.apply(this, args);
  };
  return true;
}
