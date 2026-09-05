const premiumEmojiByAlt = new Map();
let premiumEnabled = true;

const UI_PREFIXES = [
  "✈️ TelePilot",
  "🔒 TelePilot Access",
  "🔑 Access",
  "👤 Sender",
  "👤 Connect account",
  "📝 Message",
  "📍 Destinations",
  "📍 Add destination",
  "⏱ Schedule",
  "📊 Activity",
  "🚀 Ready to launch",
  "📍 Manage destinations",
  "Clear destinations",
];

const BUTTON_ICONS = new Map([
  ["home", "⭐️"],
  ["account", "📱"],
  ["account_phone", "📱"],
  ["message", "📝"],
  ["message_change", "✍️"],
  ["groups", "📁"],
  ["add_group", "📁"],
  ["interval", "📆"],
  ["activity", "📈"],
  ["access", "💎"],
  ["redeem_key", "💎"],
  ["start", "⚡️"],
  ["start_confirm", "🔥"],
  ["stop", "❗️"],
  ["clear_groups", "❗️"],
  ["clear_groups_confirm", "❗️"],
  ["account_disconnect", "❗️"],
]);

const BUTTON_STYLES = new Map([
  ["start", "success"],
  ["start_confirm", "success"],
  ["stop", "danger"],
  ["clear_groups", "danger"],
  ["clear_groups_confirm", "danger"],
  ["account_disconnect", "danger"],
  ["account_phone", "primary"],
  ["message_change", "primary"],
  ["add_group", "primary"],
  ["redeem_key", "primary"],
]);

const FALLBACK_PREFIXES = new Map([
  ["home", ["↻ ", "← "]],
  ["account", ["👤 "]],
  ["account_phone", ["📱 "]],
  ["message", ["📝 "]],
  ["message_change", ["✏️ ", "✍️ "]],
  ["groups", ["📍 "]],
  ["add_group", ["＋ "]],
  ["interval", ["⏱ "]],
  ["activity", ["📊 "]],
  ["access", ["🔑 "]],
  ["start", ["▶ ", "▶️ "]],
  ["start_confirm", ["▶ ", "▶️ "]],
  ["stop", ["⏹ ", "⏹️ "]],
]);

const PREMIUM_TEXT_EMOJI = [
  "⭐️", "✅", "🔥", "💡", "📱", "📝", "📁", "📆", "📈", "💎", "⚡️", "❗️", "✍️", "👀",
];

function customEmojiId(alt) {
  return premiumEnabled ? premiumEmojiByAlt.get(alt) || "" : "";
}

export function configurePremiumEmojiStickers(stickers = []) {
  premiumEmojiByAlt.clear();
  for (const sticker of Array.isArray(stickers) ? stickers : []) {
    const alt = typeof sticker?.emoji === "string" ? sticker.emoji : "";
    const id = typeof sticker?.custom_emoji_id === "string" ? sticker.custom_emoji_id : "";
    if (alt && id && !premiumEmojiByAlt.has(alt)) premiumEmojiByAlt.set(alt, id);
  }
  premiumEnabled = premiumEmojiByAlt.size > 0;
  return {
    available: premiumEmojiByAlt.size,
    selected: PREMIUM_TEXT_EMOJI.filter(emoji => premiumEmojiByAlt.has(emoji)).length,
  };
}

function isUiText(text) {
  const value = String(text || "");
  return UI_PREFIXES.some(prefix => value.startsWith(prefix));
}

function enhanceUiText(text) {
  let value = String(text || "");
  if (!isUiText(value)) return value;

  value = value
    .replace(/^✈️ TelePilot$/m, "✈️ TelePilot  ⭐️")
    .replace(/^👤 Sender/m, "📱 Sender")
    .replace(/^👤 Connect account/m, "📱 Connect account")
    .replace(/^📍 Destinations/m, "📁 Destinations")
    .replace(/^📍 Add destination/m, "📁 Add destination")
    .replace(/^📍 Manage destinations/m, "📁 Manage destinations")
    .replace(/^⏱ Schedule/m, "📆 Schedule")
    .replace(/^📊 Activity/m, "📈 Activity")
    .replace(/^🔑 Access/m, "💎 Access")
    .replace(/^🔒 TelePilot Access/m, "💎 TelePilot Access")
    .replace(/^🚀 Ready to launch/m, "🔥 Ready to launch")
    .replace(/^● LIVE(?: ·)?/m, "🔥 LIVE ·")
    .replace(/^● READY(?: ·)?/m, "✅ READY ·")
    .replace(/^○ SETUP(?: ·)?/m, "💡 SETUP ·")
    .replace(/^● Connected$/m, "✅ Connected")
    .replace(/^● Active$/m, "✅ Active")
    .replace(/^○ Idle$/m, "👀 Idle")
    .replace(/^Sender\s{2,}/m, "Sender - ")
    .replace(/^Message\s{2,}/m, "Message - ")
    .replace(/^Destinations\s{2,}/m, "Destinations - ")
    .replace(/^Schedule\s{2,}/m, "Schedule - ")
    .replace(/^Next step\s+/m, "⚡️ Next step ")
    .replace(/^Access\s{2,}/m, "💎 Access - ")
    .replace(/^Ready when you are\./m, "✅ Ready when you are.");

  return value;
}

function pushEntityOnce(entities, entity) {
  const duplicate = entities.some(existing =>
    existing?.type === entity.type
    && existing?.offset === entity.offset
    && existing?.length === entity.length
    && existing?.custom_emoji_id === entity.custom_emoji_id
  );
  if (!duplicate) entities.push(entity);
}

function addStyle(entities, text, label, italic = false) {
  const offset = text.indexOf(label);
  if (offset < 0) return;
  pushEntityOnce(entities, { type: "bold", offset, length: label.length });
  if (italic) pushEntityOnce(entities, { type: "italic", offset, length: label.length });
}

function addTextFormatting(text, other) {
  if (!text.startsWith("✈️ TelePilot") || other?.parse_mode) return other;

  const entities = Array.isArray(other?.entities)
    ? other.entities.map(entity => ({ ...entity }))
    : [];

  addStyle(entities, text, "TelePilot");
  addStyle(entities, text, "SETUP");
  addStyle(entities, text, "READY");
  addStyle(entities, text, "LIVE");
  addStyle(entities, text, "Sender");
  addStyle(entities, text, "Message");
  addStyle(entities, text, "Destinations", true);
  addStyle(entities, text, "Schedule", true);
  addStyle(entities, text, "Next step", true);
  addStyle(entities, text, "Access", true);

  entities.sort((a, b) => a.offset - b.offset || a.length - b.length);
  return entities.length ? { ...(other || {}), entities } : other;
}

function addPremiumEntities(text, other) {
  if (!premiumEnabled || !isUiText(text) || other?.parse_mode) return other;

  const entities = Array.isArray(other?.entities)
    ? other.entities.map(entity => ({ ...entity }))
    : [];

  for (const emoji of PREMIUM_TEXT_EMOJI) {
    const id = customEmojiId(emoji);
    if (!id) continue;
    let from = 0;
    while (from < text.length) {
      const offset = text.indexOf(emoji, from);
      if (offset < 0) break;
      pushEntityOnce(entities, {
        type: "custom_emoji",
        offset,
        length: emoji.length,
        custom_emoji_id: id,
      });
      from = offset + emoji.length;
    }
  }

  entities.sort((a, b) => a.offset - b.offset || a.length - b.length);
  return entities.length ? { ...(other || {}), entities } : other;
}

function stripFallbackIcon(text, callbackData) {
  let value = String(text || "");
  for (const prefix of FALLBACK_PREFIXES.get(callbackData) || []) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

function enhanceMarkup(other) {
  const markup = other?.reply_markup;
  if (!markup?.inline_keyboard) return other;

  const inline_keyboard = markup.inline_keyboard.map(row => row.map(source => {
    const button = { ...source };
    const data = button.callback_data;
    if (data) {
      const iconAlt = BUTTON_ICONS.get(data);
      const id = iconAlt ? customEmojiId(iconAlt) : "";
      if (id) {
        button.icon_custom_emoji_id = id;
        button.text = stripFallbackIcon(button.text, data);
      }
      const style = BUTTON_STYLES.get(data);
      if (style) button.style = style;
    } else if (button.url && /continue securely/i.test(button.text || "")) {
      const id = customEmojiId("📱");
      if (id) button.icon_custom_emoji_id = id;
      button.style = "primary";
    }
    return button;
  }));

  return { ...(other || {}), reply_markup: { ...markup, inline_keyboard } };
}

function stripPremiumFeatures(other) {
  if (!other) return other;
  const clean = { ...other };
  if (Array.isArray(clean.entities)) {
    clean.entities = clean.entities.filter(entity => entity?.type !== "custom_emoji");
  }
  if (clean.reply_markup?.inline_keyboard) {
    clean.reply_markup = {
      ...clean.reply_markup,
      inline_keyboard: clean.reply_markup.inline_keyboard.map(row => row.map(source => {
        const button = { ...source };
        delete button.icon_custom_emoji_id;
        delete button.style;
        return button;
      })),
    };
  }
  return clean;
}

function looksLikePremiumPermissionError(err) {
  const message = String(err?.description || err?.message || err || "").toUpperCase();
  return message.includes("CUSTOM_EMOJI")
    || message.includes("CUSTOM EMOJI")
    || message.includes("ICON_CUSTOM_EMOJI")
    || message.includes("BUTTON STYLE")
    || message.includes("BUTTON_STYLE");
}

function enhancePayload(text, other) {
  const enhancedText = enhanceUiText(text);
  let enhancedOther = enhanceMarkup(other);
  enhancedOther = addTextFormatting(enhancedText, enhancedOther);
  enhancedOther = addPremiumEntities(enhancedText, enhancedOther);
  return { text: enhancedText, other: enhancedOther };
}

export function installPremiumEmojiEnhancements(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotPremiumEmojiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for TelePilot premium emoji enhancements");
  }

  Object.defineProperty(ApiClass.prototype, "__telepilotPremiumEmojiInstalled", { value: true });

  ApiClass.prototype.sendMessage = async function(chatId, text, other, ...rest) {
    const enhanced = enhancePayload(text, other);
    try {
      return await originalSendMessage.call(this, chatId, enhanced.text, enhanced.other, ...rest);
    } catch (err) {
      if (!premiumEnabled || !looksLikePremiumPermissionError(err)) throw err;
      premiumEnabled = false;
      console.warn("Telegram premium emoji UI disabled for this process; falling back to standard UI.");
      const fallbackText = enhanceUiText(text);
      let fallbackOther = stripPremiumFeatures(other);
      fallbackOther = addTextFormatting(fallbackText, fallbackOther);
      return originalSendMessage.call(this, chatId, fallbackText, fallbackOther, ...rest);
    }
  };

  ApiClass.prototype.editMessageText = async function(chatId, messageId, text, other, ...rest) {
    const enhanced = enhancePayload(text, other);
    try {
      return await originalEditMessageText.call(this, chatId, messageId, enhanced.text, enhanced.other, ...rest);
    } catch (err) {
      if (!premiumEnabled || !looksLikePremiumPermissionError(err)) throw err;
      premiumEnabled = false;
      console.warn("Telegram premium emoji UI disabled for this process; falling back to standard UI.");
      const fallbackText = enhanceUiText(text);
      let fallbackOther = stripPremiumFeatures(other);
      fallbackOther = addTextFormatting(fallbackText, fallbackOther);
      return originalEditMessageText.call(this, chatId, messageId, fallbackText, fallbackOther, ...rest);
    }
  };
}
