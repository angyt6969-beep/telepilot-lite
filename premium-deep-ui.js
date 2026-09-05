const premiumEmojiByAlt = new Map();
let deepPremiumEnabled = true;
let fallbackPremiumIds = [];

const DEEP_PAGE_PREFIXES = [
  // Main Tools / Smart Preview.
  "⚙️ TelePilot Tools",
  "⚡ TelePilot Power Tools",
  "👁 Smart preview",

  // Pro tools.
  "📝 Templates",
  "📝 Manage templates",
  "📆 Advanced schedule",
  "⏱ Destination spacing",
  "✨ Dynamic placeholders",
  "📁 Destination switches",
  "🩺 Destination health",
  "📜 Posting history",
  "🧪 Test send",

  // v1 tools.
  "🔄 Message rotation",
  "🕒 Exact-time scheduling",
  "🕒 Add exact time",
  "🕒 One-time post",
  "📅 Dates & limits",
  "📅 Active dates",
  "📅 Message expiry",
  "📅 Post limit",
  "🧭 Posting queue",
  "📁 Destination folders",
  "📁 Assign destination folder",
  "🎯 Destination message overrides",
  "🎯 Destination override",
  "✨ Custom variables",
  "✨ Add custom variable",
  "✨ Remove variable",
  "🔎 Search TelePilot",
  "🔎 Search destinations",
  "🔎 Search templates",
  "⭐ Template favorites",
  "📊 TelePilot statistics",
  "🩺 Automatic failure handling",
  "🔔 Notifications",
  "🩺 Sender health",
  "📦 Backup & restore",
  "🆕 What's new in TelePilot 1.0",
  "🛑 Emergency stop",
  "🛡 TelePilot user management",
  "🛡 User details",
  "👁 Smart preview",

  // Admin panel and its child screens.
  "🟣 TELEPILOT ADMIN",
  "👥 USERS",
  "👤 ",
  "➕ EXTEND ACCESS",
  "🔑 KEY MANAGEMENT",
  "🔑 ALL KEYS",
  "🔑 UNUSED KEYS",
  "🔑 REDEEMED KEYS",
  "🔑 REVOKED KEYS",
  "🔑 KEY DETAILS",
  "➕ GENERATE KEY",
  "🔑 NEW KEY",
  "▶️ ACTIVE POSTS",
  "⏳ EXPIRING ACCESS",
  "⏳ WITHIN ",
  "⏳ EXPIRED",
  "📊 TELEPILOT STATISTICS",
  "🧾 ACTIVITY & AUDIT LOG",
  "📢 ANNOUNCEMENT",
  "📢 NEW ANNOUNCEMENT",
  "📢 ANNOUNCEMENT READY",
  "📢 SENDING ANNOUNCEMENT",
  "📢 ANNOUNCEMENT COMPLETE",
  "🔐 SECURITY & ADMIN",
  "🔒 REVOKE ACCESS",
  "🔌 DISCONNECT ACCOUNT",
  "♻️ RESET CONFIGURATION",
  "🚫 REVOKE KEY",
  "🛑 STOP ALL POSTING",
  "✖️ CANCEL LOGIN LINKS",
  "🔎 SEARCH USERS",
  "✏️ CUSTOM EXTENSION",
  "✏️ CUSTOM KEY",
];

const ALWAYS_PREMIUM_BUTTON_CALLBACKS = new Set([
  "admin",
  "tools",
  "v1_preview",
]);

// Prefer a premium emoji that matches the action. Only Keys intentionally fall back
// to the diamond; unrelated controls no longer share the same generic diamond icon.
const FALLBACK_EMOJI = new Map([
  ["🟣", ["🛡️", "🔐", "⚡️", "🔥"]],
  ["👥", ["📱", "👀", "✅"]],
  ["👤", ["📱", "👀"]],
  ["🔑", ["💎", "✅"]],
  ["▶️", ["⚡️", "🔥"]],
  ["▶", ["⚡️", "🔥"]],
  ["⏹", ["❗️", "⏳"]],
  ["⏹️", ["❗️", "⏳"]],
  ["📊", ["📈", "✅"]],
  ["📢", ["💡", "🔥"]],
  ["📣", ["💡", "🔥"]],
  ["🧾", ["📝", "📁"]],
  ["🔐", ["✅", "📱"]],
  ["🔒", ["✅", "📱"]],
  ["🛡", ["✅", "⚡️"]],
  ["🛡️", ["✅", "⚡️"]],
  ["🛑", ["❗️", "🔥"]],
  ["🚫", ["❗️", "⏳"]],
  ["⚠️", ["❗️", "🔥"]],
  ["🩺", ["✅", "👀"]],
  ["📦", ["📁", "📝"]],
  ["📥", ["📁", "📱"]],
  ["📤", ["📁", "⚡️"]],
  ["🔔", ["💡", "🔥"]],
  ["🔎", ["👀", "💡"]],
  ["✨", ["💡", "🔥"]],
  ["🎯", ["⚡️", "✅"]],
  ["🧭", ["📆", "👀"]],
  ["🕒", ["📆", "⏳"]],
  ["⏱", ["📆", "⏳"]],
  ["⏱️", ["📆", "⏳"]],
  ["📅", ["📆", "⏳"]],
  ["🔄", ["📆", "⚡️"]],
  ["♻️", ["📆", "✅"]],
  ["❓", ["💡", "👀"]],
  ["🆕", ["🔥", "⚡️"]],
  ["👁", ["👀", "💡"]],
  ["👁️", ["👀", "💡"]],
  ["👀", ["👀", "💡"]],
  ["⬅️", ["📆", "⚡️"]],
  ["⬅", ["📆", "⚡️"]],
  ["🗑", ["❗️", "🔥"]],
  ["🗑️", ["❗️", "🔥"]],
  ["⭐", ["🔥", "✅"]],
  ["⭐️", ["🔥", "✅"]],
  ["↩", ["📆", "✅"]],
  ["🔌", ["📱", "❗️"]],
  ["✖️", ["❗️", "🔥"]],
  ["✏️", ["✍️", "📝"]],
  ["➕", ["✅", "💡"]],
  ["🧪", ["✍️", "💡"]],
  ["🪄", ["✍️", "🔥"]],
  ["📜", ["📝", "📁"]],
  ["⏸", ["⏳", "❗️"]],
  ["⏸️", ["⏳", "❗️"]],
  ["⏭", ["⚡️", "📆"]],
  ["⏭️", ["⚡️", "📆"]],
  ["🟢", ["✅", "🔥"]],
  ["⌛", ["⏳", "📆"]],
  ["📡", ["⚡️", "📱"]],
  ["📈", ["📈", "✅"]],
  ["💡", ["💡", "🔥"]],
  ["📝", ["📝", "✍️"]],
  ["🔥", ["🔥", "⚡️"]],
  ["✅", ["✅", "📈"]],
]);

const GENERIC_FALLBACKS = ["⚡️", "✅", "💡", "📱", "📝", "📁", "📆", "📈", "❗️", "👀", "⏳", "🔥", "💎"];

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

function stableFallbackId(key) {
  if (!fallbackPremiumIds.length) return "";
  let hash = 2166136261;
  for (const char of normalizeEmoji(key)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return fallbackPremiumIds[hash % fallbackPremiumIds.length] || "";
}

function premiumIdForEmoji(emoji) {
  const exact = directId(emoji);
  if (exact) return exact;
  const semantic = firstAvailable(FALLBACK_EMOJI.get(String(emoji || "")) || FALLBACK_EMOJI.get(normalizeEmoji(emoji)) || []);
  return semantic || stableFallbackId(emoji);
}

export function configureDeepPremiumEmojiStickers(stickers = []) {
  premiumEmojiByAlt.clear();
  for (const sticker of Array.isArray(stickers) ? stickers : []) {
    const emoji = typeof sticker?.emoji === "string" ? sticker.emoji : "";
    const id = typeof sticker?.custom_emoji_id === "string" ? sticker.custom_emoji_id : "";
    mapSticker(emoji, id);
  }

  const preferred = GENERIC_FALLBACKS
    .map(emoji => directId(emoji))
    .filter(Boolean);
  const all = [...new Set(premiumEmojiByAlt.values())];
  fallbackPremiumIds = [...new Set([...preferred, ...all])];

  deepPremiumEnabled = premiumEmojiByAlt.size > 0 && fallbackPremiumIds.length > 0;
  return {
    available: premiumEmojiByAlt.size,
    enabled: deepPremiumEnabled,
    fallbackPool: fallbackPremiumIds.length,
  };
}

function isDeepPage(text) {
  const value = String(text || "");
  return DEEP_PAGE_PREFIXES.some(prefix => value.startsWith(prefix));
}

function isDeepCallback(data) {
  const value = String(data || "");
  return ALWAYS_PREMIUM_BUTTON_CALLBACKS.has(value)
    || value.startsWith("admin_")
    || value.startsWith("v1_")
    || value.startsWith("tpl_")
    || value.startsWith("sched_")
    || value.startsWith("stagger")
    || value.startsWith("placeholders")
    || value.startsWith("dest_")
    || value === "tutorial_restart";
}

function smartPreviewProtectedRange(text) {
  if (!String(text).startsWith("👁 Smart preview")) return null;
  const marker = "Message preview:\n";
  const startMarker = text.indexOf(marker);
  if (startMarker < 0) return null;
  const start = startMarker + marker.length;
  const end = text.indexOf("\n\n", start);
  return { start, end: end < 0 ? text.length : end };
}

function overlaps(range, offset, length) {
  return !!range && offset < range.end && offset + length > range.start;
}

function addCustomEmojiEntities(text, other) {
  if (!deepPremiumEnabled || !isDeepPage(text) || other?.parse_mode) return other;
  const entities = Array.isArray(other?.entities) ? other.entities.map(entity => ({ ...entity })) : [];
  const protectedRange = smartPreviewProtectedRange(text);
  EMOJI_RE.lastIndex = 0;
  for (const match of String(text).matchAll(EMOJI_RE)) {
    const emoji = match[0];
    const offset = Number(match.index || 0);
    if (overlaps(protectedRange, offset, emoji.length)) continue;
    const id = premiumIdForEmoji(emoji);
    if (!id) continue;
    const duplicate = entities.some(entity =>
      entity?.type === "custom_emoji"
      && Number(entity.offset) === offset
      && Number(entity.length) === emoji.length
    );
    if (!duplicate) {
      entities.push({
        type: "custom_emoji",
        offset,
        length: emoji.length,
        custom_emoji_id: id,
      });
    }
  }
  entities.sort((a, b) => Number(a.offset || 0) - Number(b.offset || 0) || Number(a.length || 0) - Number(b.length || 0));
  return entities.length ? { ...(other || {}), entities } : other;
}

function fallbackButtonText(data) {
  const value = String(data || "").toLowerCase();
  if (value.includes("delete") || value.includes("_del")) return "Delete";
  if (value.includes("stop")) return "Stop";
  if (value.includes("revoke")) return "Revoke";
  if (value.includes("back") || value === "home") return "Back";
  return "Open";
}

function premiumizeButton(button, force = false) {
  const next = { ...button };
  const data = String(next.callback_data || "");
  if (!force && !isDeepCallback(data)) return next;
  const label = String(next.text || "");
  const match = label.match(LEADING_EMOJI_RE);
  if (!match) return next;
  const raw = match[0];
  const emojiMatch = raw.match(EMOJI_RE);
  const emoji = emojiMatch?.[0] || "";
  const id = premiumIdForEmoji(emoji);
  if (!id) return next;
  next.icon_custom_emoji_id = id;
  const stripped = label.slice(raw.length).trimStart();
  next.text = stripped || fallbackButtonText(data);
  return next;
}

function premiumizeMarkup(text, other) {
  if (!deepPremiumEnabled || !other?.reply_markup?.inline_keyboard) return other;
  const deep = isDeepPage(text);
  const inline_keyboard = other.reply_markup.inline_keyboard.map(row => row.map(button => {
    const data = String(button?.callback_data || "");
    if (deep || isDeepCallback(data)) return premiumizeButton(button, deep);
    return { ...button };
  }));
  return { ...(other || {}), reply_markup: { ...other.reply_markup, inline_keyboard } };
}

function stripDeepPremium(other) {
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
    || message.includes("ICON_CUSTOM_EMOJI");
}

function enhance(text, other) {
  if (!deepPremiumEnabled) return { text, other };
  let next = premiumizeMarkup(text, other);
  next = addCustomEmojiEntities(String(text || ""), next);
  return { text, other: next };
}

export function installDeepPremiumEmojiEnhancements(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotDeepPremiumInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for TelePilot deep premium emoji enhancements");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotDeepPremiumInstalled", { value: true });

  ApiClass.prototype.sendMessage = async function(chatId, text, other, ...rest) {
    const enhanced = enhance(text, other);
    try {
      return await originalSendMessage.call(this, chatId, enhanced.text, enhanced.other, ...rest);
    } catch (err) {
      if (!deepPremiumEnabled || !looksLikePremiumPermissionError(err)) throw err;
      deepPremiumEnabled = false;
      console.warn("TelePilot deep premium emoji layer disabled; falling back to the normal UI.");
      return originalSendMessage.call(this, chatId, text, stripDeepPremium(other), ...rest);
    }
  };

  ApiClass.prototype.editMessageText = async function(chatId, messageId, text, other, ...rest) {
    const enhanced = enhance(text, other);
    try {
      return await originalEditMessageText.call(this, chatId, messageId, enhanced.text, enhanced.other, ...rest);
    } catch (err) {
      if (!deepPremiumEnabled || !looksLikePremiumPermissionError(err)) throw err;
      deepPremiumEnabled = false;
      console.warn("TelePilot deep premium emoji layer disabled; falling back to the normal UI.");
      return originalEditMessageText.call(this, chatId, messageId, text, stripDeepPremium(other), ...rest);
    }
  };
}