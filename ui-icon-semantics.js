const premiumEmojiByAlt = new Map();
let semanticIconsEnabled = true;

const EMOJI_RE = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/gu;
const LEADING_EMOJI_RE = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)\s*/u;

const ALIASES = new Map([
  ["📚", ["📁"]], ["📂", ["📁"]], ["🗂", ["📁"]], ["🗂️", ["📁"]], ["📍", ["📁"]], ["📦", ["📁"]],
  ["💬", ["📝"]], ["✍", ["📝"]], ["✍️", ["📝"]], ["✏️", ["📝"]], ["📜", ["📝"]], ["🧾", ["📝"]],
  ["📊", ["📈"]], ["🩺", ["📈"]], ["📡", ["📈"]],
  ["📅", ["📆"]], ["🕒", ["📆"]], ["⏱", ["📆"]], ["⏱️", ["📆"]], ["⏳", ["📆"]], ["⌛", ["📆"]],
  ["👤", ["📱"]], ["👥", ["📱"]], ["🔌", ["📱"]],
  ["🔑", ["🪪"]], ["🔐", ["🪪"]], ["🔒", ["🪪"]], ["🛡", ["🪪"]], ["🛡️", ["🪪"]], ["🟣", ["🪪"]],
  ["🗑", ["❗"]], ["🗑️", ["❗"]], ["🚫", ["❗"]], ["❌", ["❗"]], ["🛑", ["❗"]], ["✖", ["❗"]], ["✖️", ["❗"]], ["⚠", ["❗"]], ["⚠️", ["❗"]],
  ["➕", ["✅"]], ["＋", ["✅"]], ["☑️", ["✅"]],
  ["👁", ["👀"]], ["👁️", ["👀"]], ["🔎", ["👀"]], ["🔍", ["👀"]],
  ["⚙", ["💡"]], ["⚙️", ["💡"]], ["✨", ["💡"]], ["🧪", ["💡"]], ["ℹ️", ["💡"]], ["❓", ["💡"]],
  ["🔄", ["👀"]], ["↻", ["👀"]], ["🔁", ["👀"]], ["♻️", ["👀"]],
  ["🚀", ["🔥"]],
  ["←", ["⬅️", "◀️", "↩️", "👀"]], ["⬅", ["⬅️", "◀️", "↩️", "👀"]], ["⬅️", ["⬅️", "◀️", "↩️", "👀"]],
  ["→", ["➡️", "▶️", "↪️", "👀"]], ["➡", ["➡️", "▶️", "↪️", "👀"]], ["➡️", ["➡️", "▶️", "↪️", "👀"]],
  ["◀", ["◀️", "⬅️", "↩️", "👀"]], ["◀️", ["◀️", "⬅️", "↩️", "👀"]],
  ["▶", ["▶️", "➡️", "↪️", "🔥"]], ["▶️", ["▶️", "➡️", "↪️", "🔥"]],
]);

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
  return premiumEmojiByAlt.get(String(emoji || "")) || premiumEmojiByAlt.get(normalizeEmoji(emoji)) || "";
}

function firstId(candidates = []) {
  for (const emoji of candidates) {
    const id = directId(emoji);
    if (id) return { id, emoji };
  }
  return null;
}

function isElectricPremiumId(id) {
  const electricId = directId("⚡️");
  return !!electricId && String(id || "") === String(electricId);
}

function candidatesForEmoji(emoji) {
  if (!emoji) return [];
  if (normalizeEmoji(emoji) === normalizeEmoji("⚡️")) return [];
  const direct = directId(emoji) ? [emoji] : [];
  const aliases = ALIASES.get(String(emoji)) || ALIASES.get(normalizeEmoji(emoji)) || [];
  return [...direct, ...aliases];
}

function navigationKind(label) {
  const value = String(label || "").trim();
  if (/^(?:◀|◀️|⬅|⬅️|←)$/.test(value)) return "previous";
  if (/^(?:▶|▶️|➡|➡️|→)$/.test(value)) return "next";
  if (/^previous$/i.test(value)) return "previous";
  if (/^next$/i.test(value)) return "next";
  return "";
}

function semanticCandidates(button) {
  const label = String(button?.text || "");
  const data = String(button?.callback_data || "");
  const nav = navigationKind(label);
  if (nav === "previous") return ["◀️", "⬅️", "↩️", "👀"];
  if (nav === "next") return ["▶️", "➡️", "↪️", "👀"];

  const leading = label.match(LEADING_EMOJI_RE)?.[0] || "";
  if (leading) {
    const emoji = leading.match(EMOJI_RE)?.[0] || "";
    const mapped = candidatesForEmoji(emoji);
    if (mapped.length) return mapped;
  }

  const haystack = `${label} ${data}`.toLowerCase();
  const rules = [
    [/previous|\bprev\b|back|return/, ["⬅️", "◀️", "↩️", "👀"]],
    [/\bnext\b|forward/, ["➡️", "▶️", "↪️", "👀"]],
    [/dashboard|\bhome\b/, ["📈"]],
    [/stop|delete|remove|clear|revoke|disconnect|reset|cancel|close|disable|discard|expire|block/, ["❗"]],
    [/confirm|save|done|apply|approve|redeem|finish|complete|select|choose|enable|accept/, ["✅"]],
    [/refresh|retry|sync|recheck|reload|check access|check status|scan/, ["👀"]],
    [/start|join|prepar|run|launch|continue|resume|activate|go live/, ["🔥"]],
    [/account|sender|profile|phone|connect|user|member/, ["📱"]],
    [/access|key|security|admin|owner|staff|permission|login|session/, ["🪪"]],
    [/destination|group|folder|import|export|backup|restore|browse|library|archive/, ["📁"]],
    [/message|template|post|copy|announcement|audit|log|topic|caption|text|edit|rename|note/, ["📝"]],
    [/schedule|time|date|interval|timing|calendar|pause|expiry|delay/, ["📆"]],
    [/activity|stat|analytics|health|status|performance|report|history/, ["📈"]],
    [/preview|view|show|search|inspect|details|open|read/, ["👀"]],
    [/settings|tools|advanced|power|automation|help|support|learn|info|guide|about|tips/, ["💡"]],
    [/add|create|new/, ["✅"]],
  ];
  for (const [pattern, candidates] of rules) if (pattern.test(haystack)) return candidates;
  if (/^\d+\s*\/\s*\d+$/.test(label.trim()) || data === "d2_noop") return ["📄", "📑", "👀"];
  return ["💡"];
}

function styleForButton(button) {
  if (button?.style) return button.style;
  const value = `${button?.text || ""} ${button?.callback_data || ""}`.toLowerCase();
  if (/stop|delete|remove|clear|revoke|disconnect|reset|cancel|discard|disable/.test(value)) return "danger";
  if (/confirm|save|done|apply|approve|redeem|finish|complete|start|launch|enable/.test(value)) return "success";
  if (/add|create|new|connect|join|prepar|settings|tools|advanced|open|browse|preview/.test(value)) return "primary";
  return undefined;
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

function premiumizeButtons(other) {
  if (!semanticIconsEnabled || !other?.reply_markup?.inline_keyboard) return other;
  const next = cloneOther(other);
  next.reply_markup.inline_keyboard = next.reply_markup.inline_keyboard.map(row => row.map(source => {
    const button = { ...source };
    const originalLabel = String(button.text || "");
    const nav = navigationKind(originalLabel);
    const match = firstId(semanticCandidates(button));

    // Preserve existing premium buttons unless the inherited icon is specifically
    // the old generic electricity fallback. In that one case, replace it with the
    // button's actual semantic icon.
    if (button.icon_custom_emoji_id && !isElectricPremiumId(button.icon_custom_emoji_id)) return button;
    if (!match) return button;

    button.icon_custom_emoji_id = match.id;
    if (nav === "previous") button.text = "Previous";
    else if (nav === "next") button.text = "Next";
    else {
      const leading = originalLabel.match(LEADING_EMOJI_RE)?.[0] || "";
      if (leading) button.text = originalLabel.slice(leading.length).trimStart() || "Open";
    }
    const style = styleForButton(button);
    if (style && !button.style) button.style = style;
    return button;
  }));
  return next;
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

function customEmojiAt(entities, offset, length) {
  return entities.find(entity => entity?.type === "custom_emoji"
    && Number(entity.offset) === offset
    && Number(entity.length) === length) || null;
}

function lineForOffset(text, offset) {
  const value = String(text || "");
  const start = value.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const end = value.indexOf("\n", offset);
  return value.slice(start, end < 0 ? value.length : end);
}

function textEmojiCandidates(emoji, line) {
  if (normalizeEmoji(emoji) === normalizeEmoji("⚡️")) {
    const fake = { text: String(line || "").replace(EMOJI_RE, " "), callback_data: "" };
    const candidates = semanticCandidates(fake).filter(item => normalizeEmoji(item) !== normalizeEmoji("⚡️"));
    return candidates.length ? candidates : ["💡"];
  }
  return candidatesForEmoji(emoji);
}

function premiumizeText(text, other) {
  if (!semanticIconsEnabled || other?.parse_mode) return other;
  const next = cloneOther(other) || {};
  const entities = Array.isArray(next.entities) ? next.entities : [];
  const ranges = protectedRanges(text);
  EMOJI_RE.lastIndex = 0;
  for (const match of String(text || "").matchAll(EMOJI_RE)) {
    const emoji = match[0];
    const offset = Number(match.index || 0);
    if (overlaps(ranges, offset, emoji.length)) continue;
    const resolved = firstId(textEmojiCandidates(emoji, lineForOffset(text, offset)));
    if (!resolved) continue;
    const existing = customEmojiAt(entities, offset, emoji.length);
    if (existing) {
      if (isElectricPremiumId(existing.custom_emoji_id) && !isElectricPremiumId(resolved.id)) {
        existing.custom_emoji_id = resolved.id;
      }
      continue;
    }
    entities.push({ type: "custom_emoji", offset, length: emoji.length, custom_emoji_id: resolved.id });
  }
  if (entities.length) {
    entities.sort((a, b) => Number(a.offset || 0) - Number(b.offset || 0) || Number(a.length || 0) - Number(b.length || 0));
    next.entities = entities;
  }
  return next;
}

export function configureUiIconSemanticsStickers(stickers = []) {
  premiumEmojiByAlt.clear();
  for (const sticker of Array.isArray(stickers) ? stickers : []) {
    const emoji = typeof sticker?.emoji === "string" ? sticker.emoji : "";
    const id = typeof sticker?.custom_emoji_id === "string" ? sticker.custom_emoji_id : "";
    mapSticker(emoji, id);
  }
  semanticIconsEnabled = premiumEmojiByAlt.size > 0;
  return { enabled: semanticIconsEnabled, available: premiumEmojiByAlt.size };
}

export function correctUiIconPayload(text, other) {
  if (!String(text || "").trim() || !other?.reply_markup?.inline_keyboard?.length) return { text, other };
  let next = premiumizeButtons(other);
  next = premiumizeText(String(text || ""), next);
  return { text, other: next };
}

function looksLikePremiumPermissionError(err) {
  const message = String(err?.description || err?.message || err || "").toUpperCase();
  return message.includes("CUSTOM_EMOJI") || message.includes("CUSTOM EMOJI") || message.includes("ICON_CUSTOM_EMOJI") || message.includes("BUTTON STYLE") || message.includes("BUTTON_STYLE");
}

export function installUiIconSemantics(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotUiIconSemanticsInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for TelePilot UI icon semantics");
  Object.defineProperty(ApiClass.prototype, "__telepilotUiIconSemanticsInstalled", { value: true });

  ApiClass.prototype.sendMessage = async function(chatId, text, other, signal) {
    const corrected = correctUiIconPayload(text, other);
    try { return await originalSendMessage.call(this, chatId, corrected.text, corrected.other, signal); }
    catch (err) {
      if (!looksLikePremiumPermissionError(err)) throw err;
      return originalSendMessage.call(this, chatId, text, other, signal);
    }
  };

  ApiClass.prototype.editMessageText = async function(chatId, messageId, text, other, signal) {
    const corrected = correctUiIconPayload(text, other);
    try { return await originalEditMessageText.call(this, chatId, messageId, corrected.text, corrected.other, signal); }
    catch (err) {
      if (!looksLikePremiumPermissionError(err)) throw err;
      return originalEditMessageText.call(this, chatId, messageId, text, other, signal);
    }
  };

  console.log("TelePilot UI icon semantics enabled (meaning-first; no generic electricity fallback)");
}

export const __test = { navigationKind, semanticCandidates, styleForButton, textEmojiCandidates, isElectricPremiumId };
