import { readAppSettings, readProSettings, scheduleAllowsNow } from "./posting-engine-enhancements.js";

function uidFromChat(chatId) {
  const value = String(chatId ?? "");
  return /^\d+$/.test(value) ? value : "";
}

function cloneOther(other) {
  if (!other?.reply_markup?.inline_keyboard) return other;
  return {
    ...(other || {}),
    reply_markup: {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    },
  };
}

function cb(text, callback_data) { return { text, callback_data }; }

function hasCallback(other, data) {
  return (other?.reply_markup?.inline_keyboard || []).flat().some(button => button.callback_data === data);
}

function mediaLabel(media) {
  if (!media) return "";
  if (media.kind === "photo") return "Photo";
  if (media.kind === "video") return "Video";
  if (media.kind === "animation") return "GIF / animation";
  return "Document";
}

function enhanceDashboard(uid, text, other) {
  const pro = readProSettings(uid);
  const settings = readAppSettings(uid);
  let value = String(text);
  const total = Array.isArray(settings.groups) ? settings.groups.length : 0;
  const disabled = new Set(pro.disabledDestinationIds.map(String));
  const active = (settings.groups || []).filter(group => !disabled.has(String(group.id || group.username || ""))).length;

  if (total && active !== total) {
    value = value.replace(/^Destinations\s{2,}\d+/m, `Destinations  ${total} · ${active} active`);
  }
  if (pro.media) {
    value = value.replace(/^(Message\s{2,}[^\n]+)$/m, `$1 · ${mediaLabel(pro.media)}`);
  }

  if (value.includes("● LIVE")) {
    if (pro.paused) value = value.replace(/^● LIVE[^\n]*/m, "⏸ PAUSED · Autoposting is temporarily paused");
    else if (pro.schedule?.enabled && !scheduleAllowsNow(pro)) value = value.replace(/^● LIVE[^\n]*/m, "🌙 QUIET · Waiting for posting window");
    if (pro.skipNext) value += "\nSkip next  Queued";
  }

  const enhanced = cloneOther(other) || {};
  const rows = enhanced.reply_markup?.inline_keyboard || [];
  const refreshIndex = rows.findIndex(row => row.some(button => button.callback_data === "home" && /refresh/i.test(button.text || "")));
  const toolsRow = [cb("⚙️ Tools", "tools")];
  if (!hasCallback(enhanced, "tools")) {
    if (refreshIndex >= 0) rows.splice(refreshIndex, 0, toolsRow);
    else rows.push(toolsRow);
  }

  const live = text.includes("● LIVE");
  if (live && !hasCallback(enhanced, "posting_pause")) {
    const controlRow = [
      cb(pro.paused ? "▶ Resume" : "⏸ Pause", "posting_pause"),
      cb("⏭ Skip next", "posting_skip"),
    ];
    rows.splice(1, 0, controlRow);
  }

  return { text: value, other: enhanced };
}

function enhanceMessage(uid, text, other) {
  const pro = readProSettings(uid);
  let value = String(text);
  if (value.includes("Create your post")) {
    value = value.replace(
      "Send the exact message you want TelePilot to publish.\nFormatting, links and Telegram custom emoji are preserved.",
      "Send text, a photo, video, GIF or document.\nFormatting, links and Telegram custom emoji are preserved. Media is kept up to 20 MB so it works with both sender modes.",
    );
  }
  if (pro.media && !value.includes("Create your post")) {
    value += `\n\nMedia  ${mediaLabel(pro.media)}`;
  }

  const enhanced = cloneOther(other) || {};
  const rows = enhanced.reply_markup?.inline_keyboard || [];
  if (!value.includes("Create your post")) {
    const backIndex = rows.findIndex(row => row.some(button => button.callback_data === "home"));
    const extra = [cb("📝 Templates", "templates"), cb("🧪 Test send", "test_send")];
    if (!hasCallback(enhanced, "templates")) {
      if (backIndex >= 0) rows.splice(backIndex, 0, extra);
      else rows.push(extra);
    }
    if (pro.media && !hasCallback(enhanced, "media_clear")) {
      const index = rows.findIndex(row => row.some(button => button.callback_data === "templates"));
      rows.splice(index >= 0 ? index + 1 : rows.length, 0, [cb("Remove media", "media_clear")]);
    }
  }
  return { text: value, other: enhanced };
}

function enhanceDestinations(text, other) {
  const enhanced = cloneOther(other) || {};
  const rows = enhanced.reply_markup?.inline_keyboard || [];
  const backIndex = rows.findIndex(row => row.some(button => button.callback_data === "home"));
  if (!hasCallback(enhanced, "dest_health")) {
    const row = [cb("🩺 Health", "dest_health"), cb("✓ Enable / disable", "dest_switches")];
    if (backIndex >= 0) rows.splice(backIndex, 0, row);
    else rows.push(row);
  }
  return { text, other: enhanced };
}

function enhanceSchedule(text, other) {
  const enhanced = cloneOther(other) || {};
  const rows = enhanced.reply_markup?.inline_keyboard || [];
  const backIndex = rows.findIndex(row => row.some(button => button.callback_data === "home"));
  if (!hasCallback(enhanced, "advanced_schedule")) {
    const row = [cb("Advanced schedule", "advanced_schedule"), cb("Spacing", "stagger_menu")];
    if (backIndex >= 0) rows.splice(backIndex, 0, row);
    else rows.push(row);
  }
  return { text, other: enhanced };
}

function enhanceActivity(text, other) {
  const enhanced = cloneOther(other) || {};
  const rows = enhanced.reply_markup?.inline_keyboard || [];
  const backIndex = rows.findIndex(row => row.some(button => button.callback_data === "home"));
  if (!hasCallback(enhanced, "history")) {
    const row = [cb("📜 Posting history", "history")];
    if (backIndex >= 0) rows.splice(backIndex, 0, row);
    else rows.push(row);
  }
  return { text, other: enhanced };
}

function transform(chatId, text, other) {
  const uid = uidFromChat(chatId);
  if (!uid) return { text, other };
  const value = String(text || "");
  if (value.startsWith("✈️ TelePilot")) return enhanceDashboard(uid, value, other);
  if (value.startsWith("📝 Message")) return enhanceMessage(uid, value, other);
  if (value.startsWith("📍 Destinations")) return enhanceDestinations(value, other);
  if (value.startsWith("⏱ Schedule")) return enhanceSchedule(value, other);
  if (value.startsWith("📊 Activity")) return enhanceActivity(value, other);
  return { text: value, other };
}

export function installProUiEnhancements(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotProUiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for TelePilot pro UI");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotProUiInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const enhanced = transform(chatId, text, other);
    return originalSendMessage.call(this, chatId, enhanced.text, enhanced.other, ...rest);
  };

  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const enhanced = transform(chatId, text, other);
    return originalEditMessageText.call(this, chatId, messageId, enhanced.text, enhanced.other, ...rest);
  };
}
