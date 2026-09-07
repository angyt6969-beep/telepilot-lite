import { readForwardedPostConfig } from "./forwarded-post-v1.js";

function copyRows(markup) {
  return (markup?.inline_keyboard || [])
    .map(row => Array.isArray(row) ? row.map(button => ({ ...button })) : [])
    .filter(row => row.length);
}

function isV13MessageScreen(text, markup) {
  const firstLine = String(text || "").split("\n", 1)[0].trim();
  if (firstLine !== "📝 Message") return false;
  return Array.isArray(markup?.inline_keyboard);
}

function controlRows(cfg) {
  if (cfg?.sourceMessageId > 0 && cfg?.sourcePeer) {
    if (cfg.enabled) {
      return [[
        { text: "Forwarded Post ✓", callback_data: "fp_setup", style: "success" },
        { text: "Normal Post", callback_data: "fp_normal" },
      ]];
    }
    return [[
      { text: "Use Forwarded Post", callback_data: "fp_enable", style: "success" },
      { text: "Change Source", callback_data: "fp_setup" },
    ]];
  }
  return [[{ text: "Forwarded Post", callback_data: "fp_setup" }]];
}

function withModeLine(text, cfg) {
  const value = String(text || "");
  const mode = cfg?.enabled
    ? `Forwarded Post · ${cfg.sourceLabel || cfg.sourcePeer}`
    : "Normal Post";
  if (/\nMode\s+[—-]\s*[^\n]*/i.test(value)) {
    return value.replace(/\nMode\s+[—-]\s*[^\n]*/i, `\nMode — ${mode}`);
  }
  return `${value}\n\nMode — ${mode}`;
}

export function decorateV13ForwardedPostMenu(uid, payload, options = {}) {
  const markup = payload?.reply_markup;
  if (!isV13MessageScreen(payload?.text, markup)) return payload;

  const readConfig = typeof options.readConfig === "function" ? options.readConfig : readForwardedPostConfig;
  const cfg = readConfig(String(uid || ""));
  const rows = copyRows(markup)
    .map(row => row.filter(button => !String(button?.callback_data || "").startsWith("fp_")))
    .filter(row => row.length);

  let insertAt = rows.findIndex(row => row.some(button => {
    const data = String(button?.callback_data || "");
    return data === "v1_posting_setup_v13" || data === "posting_setup";
  }));
  if (insertAt < 0) insertAt = rows.length;
  rows.splice(insertAt, 0, ...controlRows(cfg));

  return {
    ...payload,
    text: withModeLine(payload.text, cfg),
    reply_markup: {
      ...markup,
      inline_keyboard: rows,
    },
  };
}

export function installForwardedPostV13UiFix(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotForwardedPostV13UiFixInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for Forwarded Post v1.3 UI fix");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotForwardedPostV13UiFixInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const payload = decorateV13ForwardedPostMenu(String(chatId), { text, ...(other || {}) });
    const { text: nextText, ...nextOther } = payload;
    return originalSendMessage.call(this, chatId, nextText, nextOther, ...rest);
  };

  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const payload = decorateV13ForwardedPostMenu(String(chatId), { text, ...(other || {}) });
    const { text: nextText, ...nextOther } = payload;
    return originalEditMessageText.call(this, chatId, messageId, nextText, nextOther, ...rest);
  };
  return true;
}

export const __test = { isV13MessageScreen, withModeLine };
