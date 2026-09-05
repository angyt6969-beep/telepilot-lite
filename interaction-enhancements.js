const groupAwaiting = new Map();
const phoneAwaiting = new Set();
let addGroupHandler = null;

function userId(ctx) {
  return ctx?.from?.id ? String(ctx.from.id) : "";
}

function screenMeta(ctx) {
  return {
    chatId: ctx?.chat?.id || null,
    messageId: ctx?.callbackQuery?.message?.message_id || null,
  };
}

function makeSilentCallbackContext(ctx, meta) {
  const fake = Object.create(ctx);
  Object.defineProperty(fake, "update", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {
      callback_query: {
        id: "telepilot-batch",
        from: ctx.from,
        chat_instance: "telepilot-batch",
        data: "add_group",
        message: {
          message_id: meta?.messageId || 0,
          chat: ctx.chat,
          date: Math.floor(Date.now() / 1000),
          text: "",
        },
      },
    },
  });
  Object.defineProperty(fake, "answerCallbackQuery", {
    configurable: true,
    value: async () => undefined,
  });
  Object.defineProperty(fake, "editMessageText", {
    configurable: true,
    value: async () => undefined,
  });
  return fake;
}

async function rearmDestinationInput(ctx, meta) {
  if (typeof addGroupHandler !== "function") return;
  const fake = makeSilentCallbackContext(ctx, meta);
  await addGroupHandler(fake, async () => undefined);
}

async function withTemporaryText(ctx, text, fn) {
  const message = ctx?.update?.message;
  if (!message) return fn();
  const originalText = message.text;
  const originalEntities = message.entities;
  message.text = text;
  message.entities = [];
  try {
    return await fn();
  } finally {
    message.text = originalText;
    message.entities = originalEntities;
  }
}

function cleanBatchLines(text) {
  const seen = new Set();
  const lines = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= 50) break;
  }
  return lines;
}

const RESET_TRIGGERS = new Set([
  "home", "groups", "account", "message", "interval", "activity", "access",
  "start", "start_confirm", "stop", "account_disconnect", "account_cancel_login",
]);

export function installInteractionEnhancements(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotInteractionEnhancementsInstalled) return;

  const originalCallbackQuery = BotClass.prototype.callbackQuery;
  const originalOn = BotClass.prototype.on;
  if (typeof originalCallbackQuery !== "function" || typeof originalOn !== "function") {
    throw new Error("Unsupported grammY Bot shape for TelePilot interaction enhancements");
  }

  Object.defineProperty(BotClass.prototype, "__telepilotInteractionEnhancementsInstalled", { value: true });

  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    const wrapped = middleware.map(handler => {
      if (typeof handler !== "function") return handler;

      if (trigger === "add_group") {
        addGroupHandler = handler;
        return async function(ctx, next) {
          const uid = userId(ctx);
          if (uid) {
            groupAwaiting.set(uid, screenMeta(ctx));
            phoneAwaiting.delete(uid);
          }
          return handler.call(this, ctx, next);
        };
      }

      if (trigger === "account_phone") {
        return async function(ctx, next) {
          const uid = userId(ctx);
          if (uid) {
            phoneAwaiting.add(uid);
            groupAwaiting.delete(uid);
          }
          return handler.call(this, ctx, next);
        };
      }

      if (typeof trigger === "string" && RESET_TRIGGERS.has(trigger)) {
        return async function(ctx, next) {
          const uid = userId(ctx);
          if (uid) {
            groupAwaiting.delete(uid);
            phoneAwaiting.delete(uid);
          }
          return handler.call(this, ctx, next);
        };
      }

      return handler;
    });

    return originalCallbackQuery.call(this, trigger, ...wrapped);
  };

  BotClass.prototype.on = function(filter, ...middleware) {
    if (filter !== "message:text") return originalOn.call(this, filter, ...middleware);

    const wrapped = middleware.map(handler => {
      if (typeof handler !== "function") return handler;

      return async function(ctx, next) {
        const uid = userId(ctx);
        const text = String(ctx?.message?.text || "");

        if (uid && phoneAwaiting.has(uid) && /^\+[\d\s()\-]{7,24}$/.test(text.trim())) {
          phoneAwaiting.delete(uid);
          let notice = null;
          try {
            notice = await ctx.reply(
              "⏳ Connecting account…\n\nThis may take a few seconds while TelePilot contacts Telegram.",
            );
          } catch {}

          try {
            return await handler.call(this, ctx, next);
          } finally {
            if (notice?.message_id && ctx?.chat?.id) {
              setTimeout(() => {
                void ctx.api.deleteMessage(ctx.chat.id, notice.message_id).catch(() => {});
              }, 1800);
            }
          }
        }

        const batchMeta = uid ? groupAwaiting.get(uid) : null;
        if (!batchMeta) return handler.call(this, ctx, next);

        groupAwaiting.delete(uid);
        const lines = cleanBatchLines(text);
        if (lines.length <= 1) return handler.call(this, ctx, next);

        for (let index = 0; index < lines.length; index++) {
          if (index > 0) await rearmDestinationInput(ctx, batchMeta);
          await withTemporaryText(ctx, lines[index], () => handler.call(this, ctx, async () => undefined));
        }

        try {
          const summary = await ctx.reply(`✅ Processed ${lines.length} destination entries.`);
          setTimeout(() => {
            void ctx.api.deleteMessage(ctx.chat.id, summary.message_id).catch(() => {});
          }, 6000);
        } catch {}
      };
    });

    return originalOn.call(this, filter, ...wrapped);
  };
}
