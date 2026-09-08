import { Api, Bot } from "grammy";

const NAV_BACK = "telepilot_nav_back";
const MAX_HISTORY = 20;
const stateByMessage = new Map();
const restoring = new Set();
const LEADING_DECORATION_RE = /^(?:(?:\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?|[←→↩↪＋+✓✔◀▶])\s*)+/u;

function cloneOther(other) {
  const next = { ...(other || {}) };
  if (other?.reply_markup?.inline_keyboard) {
    next.reply_markup = {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    };
  }
  if (Array.isArray(other?.entities)) next.entities = other.entities.map(entity => ({ ...entity }));
  if (Array.isArray(other?.caption_entities)) next.caption_entities = other.caption_entities.map(entity => ({ ...entity }));
  return next;
}

function plain(value) {
  return String(value || "")
    .replace(/<tg-emoji[^>]*>.*?<\/tg-emoji>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function firstLine(text) {
  return plain(String(text || "").split("\n")[0]).replace(LEADING_DECORATION_RE, "").trim();
}

function allButtons(other) {
  return (other?.reply_markup?.inline_keyboard || []).flat();
}

function isTutorial(text, other) {
  if (/Slide\s+[1-5]\s+of\s+5/i.test(plain(text))) return true;
  return allButtons(other).some(button => /^linear_tutorial:/.test(String(button?.callback_data || "")));
}

function isTelePilotUi(text, other) {
  const title = firstLine(text);
  if (/TelePilot|Activity|Posting|Destination|Account|Message|Timing|Settings|Advanced|Preview|History|Admin|Key|Support|Backup|Import|Topic|Pause|Queue|Schedule|Sender|Access|Payment|Security/i.test(title)) return true;
  return allButtons(other).some(button => /^(?:v1_|d[2345]_|fp_|admin|account|message|interval|settings|support|redeem_key|start|stop|home|posting_setup)/i.test(String(button?.callback_data || "")));
}

function identity(text, other) {
  const title = firstLine(text).toLowerCase();
  const callbacks = allButtons(other)
    .map(button => String(button?.callback_data || ""))
    .filter(data => data && data !== NAV_BACK)
    .sort()
    .join("|");
  return `${title}|${callbacks}`;
}

function keyOf(chatId, messageId) {
  return `${String(chatId)}:${String(messageId)}`;
}

function snapshot(text, other) {
  return { text: String(text || ""), other: cloneOther(other), identity: identity(text, other) };
}

function stateFor(key) {
  let state = stateByMessage.get(key);
  if (!state) {
    state = { stack: [], current: null, pending: null };
    stateByMessage.set(key, state);
  }
  return state;
}

function isExplicitForwardNavigationButton(button) {
  const data = String(button?.callback_data || "");
  const label = String(button?.text || "");
  const dashboardTarget = data === "v1_dashboard_v13" || data === "home" || /dashboard/i.test(label);
  if (!dashboardTarget) return false;
  return String(button?.style || "") === "success" || /^open\s+dashboard$/i.test(label.trim());
}

function isParentNavigationButton(button) {
  const data = String(button?.callback_data || "");
  const label = String(button?.text || "");
  if (isExplicitForwardNavigationButton(button)) return false;
  if (data === NAV_BACK) return true;
  if (/back|go back|dashboard|home|posting setup|accounts|destinations|settings|activity|admin|keys|topics|cancel/i.test(label)) return true;
  return /^(?:home|v1_dashboard_v13|v1_posting_setup_v13|v1_accounts_v13|v1_destinations_v13|v1_settings_v13|v1_activity_v13|admin|admin_keys|v1_topics_v13)$/i.test(data);
}

export function applyGoBackButton(text, other, hasHistory) {
  if (!isTelePilotUi(text, other) || isTutorial(text, other)) return { text, other };
  const next = cloneOther(other);
  const rows = next?.reply_markup?.inline_keyboard ? [...next.reply_markup.inline_keyboard] : [];

  if (rows.length && rows.at(-1)?.length === 1 && isParentNavigationButton(rows.at(-1)[0])) rows.pop();
  if (hasHistory) rows.push([{ text: "Go back", callback_data: NAV_BACK }]);

  next.reply_markup = { ...(next.reply_markup || {}), inline_keyboard: rows };
  return { text, other: next };
}

export function cleanActivityControls(text, other) {
  if (!/^Activity$/i.test(firstLine(text))) return { text, other };
  const next = cloneOther(other);
  if (!next?.reply_markup?.inline_keyboard) return { text, other: next };

  const rows = [];
  for (const row of next.reply_markup.inline_keyboard) {
    const kept = [];
    for (const source of row) {
      const button = { ...source };
      const data = String(button.callback_data || "");
      if (data === "v1_accounts_v13" || data === "v1_destinations_v13") continue;
      if (data === "v1_history" || /^History$/i.test(String(button.text || ""))) {
        button.text = "Posting History";
        delete button.style;
      }
      kept.push(button);
    }
    if (kept.length) rows.push(kept);
  }
  next.reply_markup.inline_keyboard = rows;
  return { text, other: next };
}

function prepareOutgoing(chatId, messageId, text, other) {
  const result = cleanActivityControls(text, other);
  if (!isTelePilotUi(result.text, result.other) || isTutorial(result.text, result.other)) return result;

  const key = keyOf(chatId, messageId);
  const state = stateFor(key);
  const base = snapshot(result.text, result.other);

  if (restoring.has(key)) {
    restoring.delete(key);
    state.pending = null;
    state.current = base;
  } else if (state.pending) {
    if (state.pending.identity !== base.identity) {
      state.stack.push(state.pending);
      if (state.stack.length > MAX_HISTORY) state.stack.splice(0, state.stack.length - MAX_HISTORY);
    }
    state.pending = null;
    state.current = base;
  } else {
    state.current = base;
  }

  return applyGoBackButton(base.text, base.other, state.stack.length > 0);
}

function captureIncoming(ctx) {
  const message = ctx?.callbackQuery?.message;
  if (!message?.message_id || !message?.chat?.id) return;
  const data = String(ctx?.callbackQuery?.data || "");
  if (data === NAV_BACK) return;

  const text = String(message.text || message.caption || "");
  const other = {
    reply_markup: message.reply_markup,
    entities: message.entities,
    caption_entities: message.caption_entities,
  };
  if (!isTelePilotUi(text, other) || isTutorial(text, other)) return;

  const key = keyOf(message.chat.id, message.message_id);
  const state = stateFor(key);
  const current = snapshot(text, other);
  state.current = current;
  state.pending = current;
}

async function goBack(ctx) {
  const message = ctx?.callbackQuery?.message;
  if (!message?.message_id || !message?.chat?.id) return;

  const key = keyOf(message.chat.id, message.message_id);
  const state = stateFor(key);
  const previous = state.stack.pop();
  state.pending = null;

  if (!previous) {
    await ctx.answerCallbackQuery({ text: "No previous page." }).catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
  restoring.add(key);
  try {
    await ctx.editMessageText(previous.text, previous.other);
  } catch (err) {
    restoring.delete(key);
    const messageText = String(err?.description || err?.message || "").toLowerCase();
    if (!messageText.includes("message is not modified")) throw err;
  }
}

export function installNavigationHistoryBot(BotClass = Bot) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotNavigationHistoryBotInstalled) return;
  const originalCallbackQuery = BotClass.prototype.callbackQuery;
  if (typeof originalCallbackQuery !== "function") throw new Error("Unsupported grammY Bot shape for navigation history");
  Object.defineProperty(BotClass.prototype, "__telepilotNavigationHistoryBotInstalled", { value: true });

  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    if (!this.__telepilotNavigationHistoryBound) {
      Object.defineProperty(this, "__telepilotNavigationHistoryBound", { value: true });
      this.on("callback_query:data", async (ctx, next) => {
        captureIncoming(ctx);
        return next();
      });
      originalCallbackQuery.call(this, NAV_BACK, goBack);
    }
    return originalCallbackQuery.call(this, trigger, ...middleware);
  };
}

export function installNavigationHistoryApi(ApiClass = Api) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotNavigationHistoryApiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for navigation history");
  Object.defineProperty(ApiClass.prototype, "__telepilotNavigationHistoryApiInstalled", { value: true });

  ApiClass.prototype.sendMessage = async function(chatId, text, other, ...rest) {
    const response = await originalSendMessage.call(this, chatId, text, other, ...rest);
    const messageId = response?.message_id;
    if (messageId && isTelePilotUi(text, other) && !isTutorial(text, other)) {
      stateFor(keyOf(chatId, messageId)).current = snapshot(text, other);
    }
    return response;
  };

  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = prepareOutgoing(chatId, messageId, text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
}

export const __test = {
  NAV_BACK,
  identity,
  isTutorial,
  isTelePilotUi,
  isExplicitForwardNavigationButton,
  prepareOutgoing,
  snapshot,
  stateFor,
  keyOf,
  captureIncoming,
};

installNavigationHistoryBot(Bot);
installNavigationHistoryApi(Api);
