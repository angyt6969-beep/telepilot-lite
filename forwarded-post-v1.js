import fs from "node:fs";
import path from "node:path";
import { currentDispatchContext } from "./dispatch-context.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const CONFIG_NAME = "forwarded-post.json";
const sourceEntityCache = new WeakMap();
const configCache = new Map();
const awaitingSource = new Map();
const appMessageHandlers = new WeakMap();

function userConfigFile(uid) {
  return path.join(USERS_DIR, String(uid), CONFIG_NAME);
}

function normalizeConfig(value) {
  const sourceMessageId = Number(value?.sourceMessageId || 0);
  const sourcePeer = String(value?.sourcePeer || "").trim();
  return {
    version: 1,
    enabled: value?.enabled === true && sourceMessageId > 0 && !!sourcePeer,
    sourcePeer,
    sourceMessageId: Number.isInteger(sourceMessageId) && sourceMessageId > 0 ? sourceMessageId : 0,
    sourceLabel: String(value?.sourceLabel || sourcePeer || "Source post").slice(0, 140),
    sourceUrl: String(value?.sourceUrl || "").slice(0, 500),
    configuredAt: Number(value?.configuredAt || 0) || 0,
  };
}

export function readForwardedPostConfig(uid) {
  const key = String(uid || "");
  if (!key) return normalizeConfig({});
  if (configCache.has(key)) return { ...configCache.get(key) };
  let value = {};
  try {
    const file = userConfigFile(key);
    if (fs.existsSync(file)) value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const normalized = normalizeConfig(value);
  configCache.set(key, normalized);
  return { ...normalized };
}

export function writeForwardedPostConfig(uid, patch) {
  const key = String(uid || "");
  if (!/^\d+$/.test(key)) throw new Error("Invalid TelePilot user ID");
  const current = readForwardedPostConfig(key);
  const next = normalizeConfig({ ...current, ...(patch || {}) });
  const dir = path.dirname(userConfigFile(key));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = userConfigFile(key);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  configCache.set(key, next);
  return { ...next };
}

export function parseTelegramMessageLink(input) {
  const text = String(input || "");
  const match = text.match(/https?:\/\/(?:www\.)?t\.me\/([^\s<>]+)/i);
  if (!match) return null;
  const rawPath = String(match[1] || "").split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
  if (!rawPath) return null;
  const parts = rawPath.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  if (!/^\d+$/.test(last) || Number(last) < 1) return null;
  const sourceMessageId = Number(last);

  if (parts[0].toLowerCase() === "c" && /^\d+$/.test(parts[1] || "")) {
    const internalId = parts[1];
    return normalizeConfig({
      enabled: true,
      sourcePeer: `-100${internalId}`,
      sourceMessageId,
      sourceLabel: `Private source · ${sourceMessageId}`,
      sourceUrl: match[0],
      configuredAt: Date.now(),
    });
  }

  let usernameIndex = 0;
  if (parts[0].toLowerCase() === "s") usernameIndex = 1;
  const username = String(parts[usernameIndex] || "").replace(/^@/, "");
  if (!["joinchat", "addlist", "share"].includes(username.toLowerCase()) && /^[A-Za-z0-9_]{5,32}$/.test(username)) {
    return normalizeConfig({
      enabled: true,
      sourcePeer: `@${username}`,
      sourceMessageId,
      sourceLabel: `@${username} · ${sourceMessageId}`,
      sourceUrl: match[0],
      configuredAt: Date.now(),
    });
  }
  return null;
}

export function sourceFromForwardedMessage(message) {
  const origin = message?.forward_origin;
  if (origin?.type === "channel" && origin?.chat && Number(origin?.message_id || 0) > 0) {
    const username = String(origin.chat.username || "").replace(/^@/, "");
    const sourcePeer = username ? `@${username}` : String(origin.chat.id || "");
    if (!sourcePeer) return null;
    return normalizeConfig({
      enabled: true,
      sourcePeer,
      sourceMessageId: Number(origin.message_id),
      sourceLabel: String(origin.chat.title || (username ? `@${username}` : sourcePeer)).slice(0, 140),
      configuredAt: Date.now(),
    });
  }

  const legacyChat = message?.forward_from_chat;
  const legacyMessageId = Number(message?.forward_from_message_id || 0);
  if (legacyChat && legacyMessageId > 0) {
    const username = String(legacyChat.username || "").replace(/^@/, "");
    const sourcePeer = username ? `@${username}` : String(legacyChat.id || "");
    if (!sourcePeer) return null;
    return normalizeConfig({
      enabled: true,
      sourcePeer,
      sourceMessageId: legacyMessageId,
      sourceLabel: String(legacyChat.title || (username ? `@${username}` : sourcePeer)).slice(0, 140),
      configuredAt: Date.now(),
    });
  }
  return null;
}

function messageMenuPayload(uid, payload) {
  const markup = payload?.reply_markup;
  if (!markup || !Array.isArray(markup.inline_keyboard)) return payload;
  const flat = markup.inline_keyboard.flat();
  const hasMessageChange = flat.some(button => button?.callback_data === "message_change");
  const hasHome = flat.some(button => button?.callback_data === "home");
  if (!hasMessageChange || !hasHome) return payload;

  const cfg = readForwardedPostConfig(uid);
  const rows = markup.inline_keyboard
    .map(row => row.filter(button => !String(button?.callback_data || "").startsWith("fp_")))
    .filter(row => row.length);
  const homeIndex = rows.findIndex(row => row.some(button => button?.callback_data === "home"));
  const insertAt = homeIndex >= 0 ? homeIndex : rows.length;
  const controls = [];

  if (cfg.sourceMessageId > 0 && cfg.sourcePeer) {
    if (cfg.enabled) {
      controls.push([
        { text: "Forwarded Post ✓", callback_data: "fp_setup", style: "success" },
        { text: "Normal Post", callback_data: "fp_normal" },
      ]);
    } else {
      controls.push([
        { text: "Use Forwarded Post", callback_data: "fp_enable", style: "success" },
        { text: "Change Source", callback_data: "fp_setup" },
      ]);
    }
  } else {
    controls.push([{ text: "Forwarded Post", callback_data: "fp_setup" }]);
  }
  rows.splice(insertAt, 0, ...controls);

  let text = String(payload.text || "");
  if (text && !/\nMode\s+[—-]/i.test(text)) {
    const mode = cfg.enabled
      ? `Forwarded Post · ${cfg.sourceLabel || cfg.sourcePeer}`
      : "Normal Post";
    text += `\n\nMode — ${mode}`;
  }
  return {
    ...payload,
    text,
    reply_markup: { ...markup, inline_keyboard: rows },
  };
}

function uidOf(ctx) {
  return ctx?.from?.id ? String(ctx.from.id) : "";
}

function setupPromptKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Cancel", callback_data: "fp_cancel" }],
    ],
  };
}

async function renderAppMessageMenu(bot, ctx) {
  const handler = appMessageHandlers.get(bot);
  if (typeof handler === "function") return handler.call(bot, ctx, async () => undefined);
  try { await ctx.answerCallbackQuery(); } catch {}
  return ctx.editMessageText("Open Message again from the TelePilot dashboard.", {
    reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "home" }]] },
  });
}

async function handleSourceInput(bot, ctx) {
  const uid = uidOf(ctx);
  if (!uid || !awaitingSource.has(uid) || ctx?.chat?.type !== "private") return false;
  const pending = awaitingSource.get(uid);
  let source = sourceFromForwardedMessage(ctx.message);
  if (!source && ctx.message?.text) source = parseTelegramMessageLink(ctx.message.text);

  if (!source) {
    await ctx.reply(
      "I could not identify the original Telegram message ID. Forward a channel post with its source visible, or paste the exact t.me message link. The personal sender account must also be able to open that source post.",
      { reply_markup: setupPromptKeyboard() },
    );
    return true;
  }

  const saved = writeForwardedPostConfig(uid, { ...source, enabled: true, configuredAt: Date.now() });
  awaitingSource.delete(uid);
  const text = [
    "Forwarded Post saved",
    "",
    `Source — ${saved.sourceLabel || saved.sourcePeer}`,
    `Message ID — ${saved.sourceMessageId}`,
    "",
    "TelePilot will now use Telegram's real forward operation for personal-account posting. The original forward attribution will remain visible, and the source post must stay accessible to each sender account.",
  ].join("\n");
  const options = { reply_markup: { inline_keyboard: [[{ text: "Message Settings", callback_data: "message" }], [{ text: "Dashboard", callback_data: "home" }]] } };
  try {
    if (pending?.chatId && pending?.messageId) {
      await bot.api.editMessageText(pending.chatId, pending.messageId, text, options);
    } else {
      await ctx.reply(text, options);
    }
  } catch {
    await ctx.reply(text, options);
  }
  return true;
}

function candidatePeerIds(dialog) {
  return [dialog?.id, dialog?.entity?.id, dialog?.inputEntity?.chatId, dialog?.inputEntity?.channelId]
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value));
}

function peerDigits(value) {
  return String(value || "").replace(/^-100/, "").replace(/^-/, "").replace(/\D/g, "");
}

async function resolveForwardSourcePeer(client, cfg) {
  let cache = sourceEntityCache.get(client);
  if (!cache) {
    cache = new Map();
    sourceEntityCache.set(client, cache);
  }
  const key = `${cfg.sourcePeer}:${cfg.sourceMessageId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached.entity;

  if (String(cfg.sourcePeer).startsWith("@")) {
    const entity = await client.getInputEntity(cfg.sourcePeer);
    cache.set(key, { at: Date.now(), entity });
    return entity;
  }

  try {
    const entity = await client.getInputEntity(cfg.sourcePeer);
    cache.set(key, { at: Date.now(), entity });
    return entity;
  } catch {}

  const wanted = peerDigits(cfg.sourcePeer);
  const dialogs = await client.getDialogs({ limit: 500 });
  for (const dialog of dialogs) {
    if (candidatePeerIds(dialog).some(value => peerDigits(value) === wanted)) {
      const entity = dialog?.inputEntity || dialog?.entity || dialog;
      cache.set(key, { at: Date.now(), entity });
      return entity;
    }
  }
  throw new Error("Forward source is not accessible to this sender account. Open or join the source chat with that account and try again.");
}

export function threadIdFromSendParams(params) {
  const direct = Number(params?.topMsgId || 0);
  if (direct > 1) return direct;
  if (typeof params?.replyTo === "number" && params.replyTo > 1) return Number(params.replyTo);
  const reply = Number(params?.replyTo?.replyToMsgId || 0);
  return reply > 1 ? reply : 0;
}

export function installForwardedPostSend(TelegramClientClass, options = {}) {
  if (!TelegramClientClass?.prototype || TelegramClientClass.prototype.__telepilotForwardedPostSendInstalled) return false;
  const originalSendMessage = TelegramClientClass.prototype.sendMessage;
  if (typeof originalSendMessage !== "function") throw new Error("Unsupported TelegramClient shape for Forwarded Post");
  const readConfig = typeof options.readConfig === "function" ? options.readConfig : readForwardedPostConfig;
  const resolveSource = typeof options.resolveSource === "function" ? options.resolveSource : resolveForwardSourcePeer;
  Object.defineProperty(TelegramClientClass.prototype, "__telepilotForwardedPostSendInstalled", { value: true });

  TelegramClientClass.prototype.sendMessage = async function(entity, params = {}, ...rest) {
    const dispatch = currentDispatchContext();
    const uid = String(dispatch?.uid || "");
    if (!uid || dispatch?.senderType !== "personal") {
      return originalSendMessage.call(this, entity, params, ...rest);
    }
    const cfg = readConfig(uid);
    if (!cfg?.enabled || !cfg?.sourcePeer || Number(cfg?.sourceMessageId || 0) < 1) {
      return originalSendMessage.call(this, entity, params, ...rest);
    }

    const source = await resolveSource(this, cfg);
    const threadId = threadIdFromSendParams(params);
    const forwarded = await this.forwardMessages(entity, {
      messages: Number(cfg.sourceMessageId),
      fromPeer: source,
      ...(threadId > 1 ? { topMsgId: threadId, replyTo: params?.replyTo || threadId } : {}),
    });
    const result = Array.isArray(forwarded) ? forwarded.find(Boolean) : forwarded;
    if (!result) throw new Error("Telegram did not confirm the forwarded post.");
    return result;
  };
  return true;
}

export function installForwardedPostUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotForwardedPostUiInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for Forwarded Post UI");
  Object.defineProperty(ApiClass.prototype, "__telepilotForwardedPostUiInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const dispatch = currentDispatchContext();
    const uid = String(dispatch?.uid || "");
    if (uid && dispatch?.senderType === "bot" && readForwardedPostConfig(uid).enabled) {
      throw new Error("Forwarded Post requires a personal Telegram sender. Route this destination through a connected personal account.");
    }
    const payload = messageMenuPayload(String(chatId), { text, ...(other || {}) });
    const { text: nextText, ...nextOther } = payload;
    return originalSendMessage.call(this, chatId, nextText, nextOther, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const payload = messageMenuPayload(String(chatId), { text, ...(other || {}) });
    const { text: nextText, ...nextOther } = payload;
    return originalEditMessageText.call(this, chatId, messageId, nextText, nextOther, ...rest);
  };
  return true;
}

export function installForwardedPostBot(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotForwardedPostBotInstalled) return false;
  const originalCallbackQuery = BotClass.prototype.callbackQuery;
  const originalOn = BotClass.prototype.on;
  const originalStart = BotClass.prototype.start;
  if (typeof originalCallbackQuery !== "function" || typeof originalOn !== "function" || typeof originalStart !== "function") {
    throw new Error("Unsupported grammY Bot shape for Forwarded Post");
  }
  Object.defineProperty(BotClass.prototype, "__telepilotForwardedPostBotInstalled", { value: true });

  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    if (trigger === "message") {
      const handler = middleware.find(value => typeof value === "function");
      if (handler) appMessageHandlers.set(this, handler);
    }
    return originalCallbackQuery.call(this, trigger, ...middleware);
  };

  BotClass.prototype.on = function(filter, ...middleware) {
    if (filter === "message:text" && !this.__telepilotForwardedPostCaptureInstalled) {
      Object.defineProperty(this, "__telepilotForwardedPostCaptureInstalled", { value: true });
      originalOn.call(this, "message", async (ctx, next) => {
        if (await handleSourceInput(this, ctx)) return;
        return next();
      });
    }
    return originalOn.call(this, filter, ...middleware);
  };

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotForwardedPostCallbacksInstalled) {
      Object.defineProperty(this, "__telepilotForwardedPostCallbacksInstalled", { value: true });

      this.callbackQuery("fp_setup", async ctx => {
        const uid = uidOf(ctx);
        if (!uid) return;
        awaitingSource.set(uid, {
          chatId: ctx.chat?.id || null,
          messageId: ctx.callbackQuery?.message?.message_id || null,
        });
        await ctx.answerCallbackQuery({ text: "Send the source post" });
        await ctx.editMessageText([
          "Forwarded Post",
          "",
          "Forward the exact source post to this chat, or paste its Telegram message link.",
          "",
          "TelePilot will use Telegram's real forward operation, so the original forward attribution stays visible and custom/premium emoji entities are preserved when Telegram allows them.",
          "",
          "The source post must remain accessible to every personal sender account you use. Protected no-forward posts cannot be used.",
        ].join("\n"), { reply_markup: setupPromptKeyboard() });
      });

      this.callbackQuery("fp_cancel", async ctx => {
        awaitingSource.delete(uidOf(ctx));
        return renderAppMessageMenu(this, ctx);
      });

      this.callbackQuery("fp_normal", async ctx => {
        const uid = uidOf(ctx);
        const cfg = readForwardedPostConfig(uid);
        writeForwardedPostConfig(uid, { ...cfg, enabled: false });
        return renderAppMessageMenu(this, ctx);
      });

      this.callbackQuery("fp_enable", async ctx => {
        const uid = uidOf(ctx);
        const cfg = readForwardedPostConfig(uid);
        if (!cfg.sourcePeer || cfg.sourceMessageId < 1) {
          await ctx.answerCallbackQuery({ text: "Choose a source post first.", show_alert: true });
          return;
        }
        writeForwardedPostConfig(uid, { ...cfg, enabled: true });
        return renderAppMessageMenu(this, ctx);
      });
    }
    return originalStart.apply(this, args);
  };
  return true;
}

export const __test = {
  messageMenuPayload,
  normalizeConfig,
  peerDigits,
};
