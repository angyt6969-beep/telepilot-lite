const ISSUE_EMOJI_ID = "5280957715462505291";

function isReviewIssuesCallback(value) {
  const data = String(value || "");
  return data.startsWith("d5_issues:")
    || data.startsWith("d6_issues:")
    || data === "v1_dest_issues_v13";
}

export function cleanReviewIssuesButton(source) {
  const button = source && typeof source === "object" ? { ...source } : source;
  if (!button || !isReviewIssuesCallback(button.callback_data)) return button;
  button.icon_custom_emoji_id = ISSUE_EMOJI_ID;
  button.text = String(button.text || "Review Issues")
    .replace(/^[⚠❗]\uFE0F?\s*/u, "")
    .trimStart();
  return button;
}

export function cleanReviewIssuesPayload(payload) {
  const markup = payload?.reply_markup;
  if (!markup || !Array.isArray(markup.inline_keyboard)) return payload;
  return {
    ...payload,
    reply_markup: {
      ...markup,
      inline_keyboard: markup.inline_keyboard.map(row =>
        Array.isArray(row) ? row.map(cleanReviewIssuesButton) : row
      ),
    },
  };
}

export function installReviewIssuesIconCleanup(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotReviewIssuesIconCleanupInstalled) return false;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for Review Issues icon cleanup");
  Object.defineProperty(BotClass.prototype, "__telepilotReviewIssuesIconCleanupInstalled", { value: true });

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotReviewIssuesIconCleanupRuntime && this?.api?.config?.use) {
      Object.defineProperty(this, "__telepilotReviewIssuesIconCleanupRuntime", { value: true });
      this.api.config.use((prev, method, payload, signal) => {
        if (method === "sendMessage" || method === "editMessageText") {
          return prev(method, cleanReviewIssuesPayload(payload), signal);
        }
        return prev(method, payload, signal);
      });
    }
    return originalStart.apply(this, args);
  };
  return true;
}

export const __test = { isReviewIssuesCallback };
