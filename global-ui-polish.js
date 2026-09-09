const premiumEmojiByAlt = new Map();
let globalPolishEnabled = true;

const TELEPILOT_DUCK_CUSTOM_EMOJI_ID = "5231361378748472914";

const FALLBACK_PREMIUM = ["⚡️", "✅", "💡", "📱", "📝", "📁", "📆", "📈", "❗", "👀", "🔥", "🪪", "🎟"];

const SEMANTIC_ALIASES = new Map([
  ["✈️", ["✈️"]],
  ["✈", ["✈️"]],
  ["⚙️", ["⚡️"]],
  ["⚙", ["⚡️"]],
  ["🔄", ["⚡️"]],
  ["↻", ["⚡️"]],
  ["🔁", ["⚡️"]],
  ["♻️", ["⚡️", "✅"]],
  ["←", ["⚡️"]],
  ["⬅️", ["⚡️"]],
  ["▶", ["⚡️"]],
  ["▶️", ["⚡️"]],
  ["⏹", ["❗"]],
  ["⏹️", ["❗"]],
  ["🛑", ["❗"]],
  ["🚫", ["❗"]],
  ["❌", ["❗"]],
  ["⚠️", ["❗"]],
  ["⚠", ["❗"]],
  ["🗑", ["❗"]],
  ["🗑️", ["❗"]],
  ["✖", ["❗"]],
  ["✖️", ["❗"]],
  ["✅", ["✅"]],
  ["☑️", ["✅"]],
  ["➕", ["✅"]],
  ["＋", ["✅"]],
  ["🔥", ["🔥"]],
  ["🚀", ["🔥", "⚡️"]],
  ["✨", ["💡"]],
  ["💡", ["💡"]],
  ["🧪", ["💡"]],
  ["❓", ["💡"]],
  ["ℹ️", ["💡"]],
  ["👤", ["📱", "🪪"]],
  ["👥", ["📱", "🪪"]],
  ["📱", ["📱"]],
  ["🔌", ["📱"]],
  ["🪪", ["🪪", "🎟"]],
  ["🔑", ["🪪", "🎟"]],
  ["🔐", ["🪪", "🎟"]],
  ["🔒", ["🪪", "🎟"]],
  ["🛡", ["🪪", "🎟"]],
  ["🛡️", ["🪪", "🎟"]],
  ["🟣", ["🪪", "⚡️"]],
  ["📁", ["📁"]],
  ["📂", ["📁"]],
  ["🗂", ["📁"]],
  ["🗂️", ["📁"]],
  ["📚", ["📁"]],
  ["📦", ["📁"]],
  ["📥", ["📁"]],
  ["📤", ["📁"]],
  ["📍", ["📁"]],
  ["📝", ["📝"]],
  ["✍", ["📝"]],
  ["✍️", ["📝"]],
  ["✏️", ["📝"]],
  ["📜", ["📝"]],
  ["🧾", ["📝"]],
  ["💬", ["📝"]],
  ["📢", ["📝", "🔥"]],
  ["📣", ["📝", "🔥"]],
  ["📆", ["📆"]],
  ["📅", ["📆"]],
  ["🕒", ["📆"]],
  ["⏱", ["📆"]],
  ["⏱️", ["📆"]],
  ["⏳", ["📆"]],
  ["⌛", ["📆"]],
  ["📈", ["📈"]],
  ["📊", ["📈"]],
  ["🩺", ["📈"]],
  ["📡", ["📈", "⚡️"]],
  ["👀", ["👀"]],
  ["👁", ["👀"]],
  ["👁️", ["👀"]],
  ["🔎", ["👀"]],
  ["🔍", ["👀"]],
]);

const EMOJI_RE = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/gu;
const LEADING_EMOJI_RE = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)\s*/u;

function normalizeEmoji(value) {
  return String(value || "").replace(/[\uFE0E\uFE0F]/g, "");
}

function mapSticker(emoji, id) {
  if (!emoji || !id) return;
  if (!premiumEmojiByAlt.has(emoji)) premiumEmojiByAlt.set(emoji, id);
  const normalized = normalizeEmoji(emoji);
  if (normalized && !premiumEmojiByAlt.has(normalized)) premiumEmojiByAlt.set(normalized, id);
}

function directId(emoji) {
  return premiumEmojiByAlt.get(String(emoji || ""))
    || premiumEmojiByAlt.get(normalizeEmoji(emoji))
    || "";
}

function firstAvailable(candidates = []) {
  for (const emoji of candidates) {
    const id = directId(emoji);
    if (id) return id;
  }
  return "";
}

function premiumIdForEmoji(emoji) {
  if (normalizeEmoji(emoji) === normalizeEmoji("✈️")) {
    return TELEPILOT_DUCK_CUSTOM_EMOJI_ID;
  }
  const exact = directId(emoji);
  if (exact) return exact;
  const aliases = SEMANTIC_ALIASES.get(String(emoji || ""))
    || SEMANTIC_ALIASES.get(normalizeEmoji(emoji))
    || [];
  return firstAvailable(aliases);
}

export function configureGlobalUiPolishStickers(stickers = []) {
  premiumEmojiByAlt.clear();
  for (const sticker of Array.isArray(stickers) ? stickers : []) {
    const emoji = typeof sticker?.emoji === "string" ? sticker.emoji : "";
    const id = typeof sticker?.custom_emoji_id === "string" ? sticker.custom_emoji_id : "";
    mapSticker(emoji, id);
  }
  globalPolishEnabled = premiumEmojiByAlt.size > 0;
  return {
    enabled: globalPolishEnabled,
    available: premiumEmojiByAlt.size,
    semantic: FALLBACK_PREMIUM.filter(emoji => directId(emoji)).length,
  };
}

function cloneOther(other) {
  if (!other) return other;
  const next = { ...other };
  if (Array.isArray(other.entities)) next.entities = other.entities.map(entity => ({ ...entity }));
  if (other.reply_markup?.inline_keyboard) {
    next.reply_markup = {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    };
  }
  return next;
}

function isUiPayload(text, other) {
  if (!String(text || "").trim()) return false;
  if (other?.reply_markup?.inline_keyboard?.length) return true;
  return false;
}

function hasEntity(entities, type, offset, length) {
  return entities.some(entity => entity?.type === type
    && Number(entity.offset) === Number(offset)
    && Number(entity.length) === Number(length));
}

function hasCoveringEntity(entities, type, offset, length) {
  const end = offset + length;
  return entities.some(entity => {
    if (entity?.type !== type) return false;
    const entityStart = Number(entity.offset || 0);
    const entityEnd = entityStart + Number(entity.length || 0);
    return entityStart <= offset && entityEnd >= end;
  });
}

function protectedRanges(text) {
  const value = String(text || "");
  const first = value.split("\n", 1)[0].toLowerCase();
  const previewLike = first.includes("preview") || first.includes("announcement ready") || first.includes("test send");
  if (!previewLike) return [];
  for (const marker of ["Message preview:\n", "Preview:\n", "Message:\n", "Current message:\n"]) {
    const index = value.indexOf(marker);
    if (index >= 0) return [{ start: index + marker.length, end: value.length }];
  }
  return [];
}

function overlaps(ranges, offset, length) {
  const end = offset + length;
  return ranges.some(range => offset < range.end && end > range.start);
}

function titleRange(text) {
  const value = String(text || "");
  const lineEnd = value.indexOf("\n");
  const firstLine = lineEnd >= 0 ? value.slice(0, lineEnd) : value;
  if (!firstLine.trim()) return null;
  const leading = firstLine.match(LEADING_EMOJI_RE)?.[0] || "";
  const start = leading.length;
  const title = firstLine.slice(start).trim();
  if (!title || title.length > 100) return null;
  const offset = firstLine.indexOf(title, start);
  return offset >= 0 ? { offset, length: title.length } : null;
}

function looksLikeMetricLine(line) {
  const value = String(line || "");
  if (!value.trim() || /^https?:\/\//i.test(value.trim())) return null;
  const match = value.match(/^([^\n]{2,42}?)(?:\s{2,}|\s+[—–:]\s+)(.+)$/);
  if (!match) return null;
  const label = match[1].trim();
  if (!label || /^[\d\s./%-]+$/.test(label)) return null;
  const offset = value.indexOf(label);
  return { offset, length: label.length };
}

function addTypography(text, other) {
  if (other?.parse_mode) return other;
  const next = cloneOther(other) || {};
  const entities = Array.isArray(next.entities) ? next.entities : [];
  const title = titleRange(text);
  if (title && !hasCoveringEntity(entities, "bold", title.offset, title.length)) {
    entities.push({ type: "bold", offset: title.offset, length: title.length });
  }

  const ranges = protectedRanges(text);
  let cursor = 0;
  for (const line of String(text || "").split("\n")) {
    const metric = looksLikeMetricLine(line);
    if (metric) {
      const offset = cursor + metric.offset;
      if (!overlaps(ranges, offset, metric.length)
        && !hasCoveringEntity(entities, "bold", offset, metric.length)) {
        entities.push({ type: "bold", offset, length: metric.length });
      }
    }
    cursor += line.length + 1;
  }

  entities.sort((a, b) => Number(a.offset || 0) - Number(b.offset || 0) || Number(a.length || 0) - Number(b.length || 0));
  if (entities.length) next.entities = entities;
  return next;
}

function addPremiumTextEmoji(text, other) {
  if (!globalPolishEnabled || other?.parse_mode) return other;
  const next = cloneOther(other) || {};
  const entities = Array.isArray(next.entities) ? next.entities : [];
  const ranges = protectedRanges(text);
  EMOJI_RE.lastIndex = 0;
  for (const match of String(text || "").matchAll(EMOJI_RE)) {
    const emoji = match[0];
    const offset = Number(match.index || 0);
    if (overlaps(ranges, offset, emoji.length)) continue;
    const id = premiumIdForEmoji(emoji);
    if (!id || hasEntity(entities, "custom_emoji", offset, emoji.length)) continue;
    entities.push({
      type: "custom_emoji",
      offset,
      length: emoji.length,
      custom_emoji_id: id,
    });
  }
  entities.sort((a, b) => Number(a.offset || 0) - Number(b.offset || 0) || Number(a.length || 0) - Number(b.length || 0));
  if (entities.length) next.entities = entities;
  return next;
}

function semanticEmojiForButton(button) {
  const label = String(button?.text || "");
  const data = String(button?.callback_data || "");
  const leading = label.match(LEADING_EMOJI_RE)?.[0] || "";
  if (leading) {
    const emoji = leading.match(EMOJI_RE)?.[0] || "";
    if (emoji && premiumIdForEmoji(emoji)) return emoji;
  }

  const haystack = `${data} ${label}`.toLowerCase();
  const rules = [
    [/stop|delete|remove|clear|revoke|disconnect|reset|cancel|close|disable|discard|expire/, "❗"],
    [/confirm|save|done|apply|approve|redeem|finish|complete|select all|enable/, "✅"],
    [/start|join|prepare|run|launch|continue|resume|retry|refresh|sync|recheck|reload|activate/, "⚡️"],
    [/account|sender|profile|phone|connect|user|member/, "📱"],
    [/access|key|security|admin|owner|staff|permission|login/, "🪪"],
    [/destination|group|folder|import|export|backup|restore|browse|library/, "📁"],
    [/message|template|post|copy|announcement|audit|log|topic|caption|text/, "📝"],
    [/schedule|time|date|interval|timing|calendar|pause until|expiry/, "📆"],
    [/activity|stat|analytics|health|status|performance|report/, "📈"],
    [/preview|view|show|search|inspect|details|open/, "👀"],
    [/help|support|learn|info|guide|about|tips/, "💡"],
    [/settings|tools|advanced|power|automation/, "⚡️"],
    [/back|home|dashboard/, "⚡️"],
  ];
  for (const [pattern, emoji] of rules) if (pattern.test(haystack)) return emoji;
  return "⚡️";
}

function buttonStyle(button) {
  if (button?.style) return button.style;
  const callback = String(button?.callback_data || "").toLowerCase();
  // Ordinary navigation/setup controls stay neutral gray.
  if (callback === "v1_tools" || callback === "v1_dest_add_v13") return undefined;
  const haystack = `${button?.callback_data || ""} ${button?.text || ""}`.toLowerCase();
  if (/stop|delete|remove|clear|revoke|disconnect|reset|cancel|discard/.test(haystack)) return "danger";
  if (/confirm|save|done|apply|approve|start|launch|redeem|finish|complete/.test(haystack)) return "success";
  if (/add|create|new|connect|join|prepare|settings|tools|advanced|open|browse|preview/.test(haystack)) return "primary";
  return undefined;
}

function premiumizeButtons(other) {
  if (!globalPolishEnabled || !other?.reply_markup?.inline_keyboard) return other;
  const next = cloneOther(other);
  next.reply_markup.inline_keyboard = next.reply_markup.inline_keyboard.map(row => row.map(source => {
    const button = { ...source };
    // Existing premium buttons are deliberately preserved byte-for-byte.
    if (button.icon_custom_emoji_id) return button;

    const semantic = semanticEmojiForButton(button);
    const id = premiumIdForEmoji(semantic) || firstAvailable(FALLBACK_PREMIUM);
    if (!id) return button;

    button.icon_custom_emoji_id = id;
    const label = String(button.text || "");
    const leading = label.match(LEADING_EMOJI_RE)?.[0] || "";
    if (leading) button.text = label.slice(leading.length).trimStart() || "Open";
    const style = buttonStyle(button);
    if (style && !button.style) button.style = style;
    return button;
  }));
  return next;
}

function normalizePlainLayout(text, other) {
  if (other?.parse_mode || (Array.isArray(other?.entities) && other.entities.length)) return String(text || "");
  let value = String(text || "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trimEnd();
  const firstBreak = value.indexOf("\n");
  if (firstBreak > 0) {
    const first = value.slice(0, firstBreak);
    const secondStart = value.slice(firstBreak + 1);
    const titleish = first.length <= 100 && (LEADING_EMOJI_RE.test(first) || /^[A-Z0-9][^\n]{2,80}$/.test(first));
    if (titleish && secondStart && !secondStart.startsWith("\n")) {
      value = `${first}\n\n${secondStart}`;
    }
  }
  return value;
}

export function polishGlobalUiPayload(text, other) {
  if (!isUiPayload(text, other)) return { text, other };
  const originalText = String(text || "");
  const originalOther = cloneOther(other);
  const nextText = normalizePlainLayout(originalText, originalOther);
  let nextOther = premiumizeButtons(originalOther);
  nextOther = addTypography(nextText, nextOther);
  nextOther = addPremiumTextEmoji(nextText, nextOther);
  return { text: nextText, other: nextOther };
}

function looksLikePremiumPermissionError(err) {
  const message = String(err?.description || err?.message || err || "").toUpperCase();
  return message.includes("CUSTOM_EMOJI")
    || message.includes("CUSTOM EMOJI")
    || message.includes("ICON_CUSTOM_EMOJI")
    || message.includes("BUTTON STYLE")
    || message.includes("BUTTON_STYLE");
}

export function installGlobalUiPolish(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotGlobalUiPolishInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for TelePilot global UI polish");
  }

  Object.defineProperty(ApiClass.prototype, "__telepilotGlobalUiPolishInstalled", { value: true });

  ApiClass.prototype.sendMessage = async function(chatId, text, other, signal) {
    const polished = polishGlobalUiPayload(text, other);
    try {
      return await originalSendMessage.call(this, chatId, polished.text, polished.other, signal);
    } catch (err) {
      if (!looksLikePremiumPermissionError(err) || (polished.text === text && polished.other === other)) throw err;
      // Retry with exactly the payload received from the already-installed outer
      // layers. This removes only the enhancements added by this module.
      return originalSendMessage.call(this, chatId, text, other, signal);
    }
  };

  ApiClass.prototype.editMessageText = async function(chatId, messageId, text, other, signal) {
    const polished = polishGlobalUiPayload(text, other);
    try {
      return await originalEditMessageText.call(this, chatId, messageId, polished.text, polished.other, signal);
    } catch (err) {
      if (!looksLikePremiumPermissionError(err) || (polished.text === text && polished.other === other)) throw err;
      return originalEditMessageText.call(this, chatId, messageId, text, other, signal);
    }
  };

  console.log("TelePilot global UI polish enabled (gap-fill only; existing premium UI preserved)");
}

export const __test = {
  premiumIdForEmoji,
  semanticEmojiForButton,
  buttonStyle,
  protectedRanges,
};
