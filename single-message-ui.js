import fs from "node:fs";
import path from "node:path";
import { Api, Bot } from "grammy";

const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = path.join(DATA_DIR, "ui-message-state.json");
const ACTIVE_UI = new Map();
const REDEEM_BACK = new Map();

const PREMIUM_KEY = "5206607081334906820";
const PREMIUM_COPY = "5307843983102204243";
const PREMIUM_DONE = "4983746717313664194";
const PREMIUM_BACK = "5411590687663608498";

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const messages = parsed?.messages && typeof parsed.messages === "object" ? parsed.messages : {};
    for (const [chatId, messageId] of Object.entries(messages)) {
      if (/^\d+$/.test(chatId) && Number.isInteger(Number(messageId)) && Number(messageId) > 0) {
        ACTIVE_UI.set(chatId, Number(messageId));
      }
    }
  } catch {}
}

function persistState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, messages: Object.fromEntries(ACTIVE_UI) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}

readState();

function positivePrivateChat(chatId) {
  return /^\d+$/.test(String(chatId || "")) && Number(chatId) > 0;
}

function plain(value) {
  return String(value || "")
    .replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gis, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function hasInlineKeyboard(other) {
  return Array.isArray(other?.reply_markup?.inline_keyboard) && other.reply_markup.inline_keyboard.length > 0;
}

export function isStandaloneError(text) {
  const value = plain(text);
  if (!value) return false;
  if (/^[❌⚠️🚫⛔🛑]/u.test(value)) return true;
  return /\b(?:error|failed|failure|couldn['’]?t|could not|cannot|can['’]?t|unable|invalid|denied|blocked|locked|rate limit|too many|try again|not found|expired|unavailable)\b/i.test(value);
}

export function isTelePilotScreen(text, other) {
  if (hasInlineKeyboard(other)) return true;
  const value = plain(text);
  if (!value) return false;
  if (/Slide\s+[1-5]\s+of\s+5/i.test(value)) return true;
  if (/^(?:✈️|🔑|🔐|📁|📂|👤|📝|⏱|⚙️|📊|📈|🧭|💎|🛡|📦|📅|🕒|▶️|⏸|⏹|✅|🟢|🟣)/u.test(value)) return true;
  return /^(?:TelePilot|Access|Destinations|Destination|Accounts|Account|Posting|Activity|Settings|Support|Tutorial|Redeem|Schedule|Message|Timing|Sender|Admin)\b/i.test(value);
}

function isMessageNotModified(err) {
  const value = String(err?.description || err?.message || err || "").toLowerCase();
  return value.includes("message is not modified");
}

function syntheticMessage(chatId, messageId, text) {
  return { message_id: Number(messageId), chat: { id: Number(chatId) }, text: String(text || "") };
}

function remember(chatId, messageId) {
  const id = String(chatId || "");
  const mid = Number(messageId || 0);
  if (!positivePrivateChat(id) || !Number.isInteger(mid) || mid <= 0) return;
  if (ACTIVE_UI.get(id) === mid) return;
  ACTIVE_UI.set(id, mid);
  persistState();
}

function forget(chatId, messageId) {
  const id = String(chatId || "");
  if (!ACTIVE_UI.has(id)) return;
  if (messageId && Number(ACTIVE_UI.get(id)) !== Number(messageId)) return;
  ACTIVE_UI.delete(id);
  persistState();
}

export function redeemKeyPromptPayload(backCallback = "access") {
  const back = String(backCallback || "access");
  return {
    text: [
      `<tg-emoji emoji-id="${PREMIUM_KEY}">🔑</tg-emoji> <b><i>Redeem your TelePilot key</i></b>`,
      "",
      `<tg-emoji emoji-id="${PREMIUM_COPY}">📋</tg-emoji> <b>Key format:</b> — <code>TP-XXXXX-XXXXX-XXXXX-XXXXX</code>`,
      "",
      `<b>Redeem:</b> — paste your <b><i>full key</i></b> directly into this chat.`,
      `<b>Activation:</b> — TelePilot checks it automatically and activates your access.`,
      "",
      `<tg-emoji emoji-id="${PREMIUM_DONE}">✅</tg-emoji> <i>No command is needed — just send the key by itself.</i>`,
    ].join("\n"),
    other: {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{
          text: "Back",
          callback_data: back,
          icon_custom_emoji_id: PREMIUM_BACK,
        }]],
      },
    },
  };
}

function isLegacyRedeemPrompt(text) {
  const value = plain(text);
  return /^🔑\s*REDEEM KEY\b/i.test(value)
    || /Send your TelePilot access key below/i.test(value);
}

export function transformTelePilotOutgoing(chatId, text, other) {
  if (!isLegacyRedeemPrompt(text)) return { text, other };
  const back = REDEEM_BACK.get(String(chatId || "")) || "access";
  return redeemKeyPromptPayload(back);
}

function captureCallback(ctx) {
  const message = ctx?.callbackQuery?.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  if (positivePrivateChat(chatId) && messageId) remember(chatId, messageId);

  const data = String(ctx?.callbackQuery?.data || "");
  if (data === "redeem_key" && positivePrivateChat(chatId)) {
    const sourceText = String(message?.text || message?.caption || "");
    REDEEM_BACK.set(String(chatId), /Slide\s+5\s+of\s+5/i.test(sourceText) ? "linear_tutorial:5" : "access");
  }
}

export function installSingleMessageUiBot(BotClass = Bot) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotSingleMessageUiBotInstalled) return false;
  const originalCallbackQuery = BotClass.prototype.callbackQuery;
  if (typeof originalCallbackQuery !== "function") throw new Error("Unsupported grammY Bot shape for single-message UI");
  Object.defineProperty(BotClass.prototype, "__telepilotSingleMessageUiBotInstalled", { value: true });

  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    if (!this.__telepilotSingleMessageCaptureBound) {
      Object.defineProperty(this, "__telepilotSingleMessageCaptureBound", { value: true });
      this.on("callback_query:data", async (ctx, next) => {
        captureCallback(ctx);
        return next();
      });
    }
    return originalCallbackQuery.call(this, trigger, ...middleware);
  };
  return true;
}

export function installSingleMessageUiApi(ApiClass = Api) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotSingleMessageUiApiInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  const originalDeleteMessage = ApiClass.prototype.deleteMessage;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for single-message UI");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotSingleMessageUiApiInstalled", { value: true });

  async function retireActivePanel(api, chatId, activeId) {
    let removed = false;
    if (typeof originalDeleteMessage === "function") {
      try {
        await originalDeleteMessage.call(api, chatId, activeId);
        removed = true;
      } catch {}
    }
    if (!removed) {
      try {
        await originalEditMessageText.call(api, chatId, activeId, "\u2063", {
          reply_markup: { inline_keyboard: [] },
        });
      } catch {}
    }
    forget(chatId, activeId);
  }

  ApiClass.prototype.sendMessage = async function(chatId, text, other, ...rest) {
    const prepared = transformTelePilotOutgoing(chatId, text, other);
    const singlePanel = positivePrivateChat(chatId) && !isStandaloneError(prepared.text);
    const activeId = singlePanel ? ACTIVE_UI.get(String(chatId)) : null;

    // A sendMessage call follows a fresh user action or a flow that intentionally
    // creates a new screen. Editing a persisted panel can make the reply appear
    // far above the user's newest message, which looks like the bot did nothing.
    // Retire the previous UI panel and send the replacement at the bottom instead.
    if (activeId) await retireActivePanel(this, chatId, activeId);

    const response = await originalSendMessage.call(this, chatId, prepared.text, prepared.other, ...rest);
    if (singlePanel) remember(chatId, response?.message_id);
    return response;
  };

  ApiClass.prototype.editMessageText = async function(chatId, messageId, text, other, ...rest) {
    const prepared = transformTelePilotOutgoing(chatId, text, other);
    try {
      const response = await originalEditMessageText.call(this, chatId, messageId, prepared.text, prepared.other, ...rest);
      if (positivePrivateChat(chatId) && !isStandaloneError(prepared.text)) {
        remember(chatId, response?.message_id || messageId);
      }
      return response;
    } catch (err) {
      if (isMessageNotModified(err)) {
        if (positivePrivateChat(chatId)) remember(chatId, messageId);
        return syntheticMessage(chatId, messageId, prepared.text);
      }
      throw err;
    }
  };

  return true;
}

export const __test = {
  ACTIVE_UI,
  REDEEM_BACK,
  captureCallback,
  remember,
  forget,
  transformTelePilotOutgoing,
};
