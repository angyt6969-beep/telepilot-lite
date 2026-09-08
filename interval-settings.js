import { readAppSettings } from "./posting-engine-enhancements.js";

export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

function wholeNumber(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

export function normalizeIntervalSeconds(value, fallback = 30 * 60) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return fallback;
  const rounded = Math.round(seconds);
  if (rounded < MIN_INTERVAL_SECONDS || rounded > MAX_INTERVAL_SECONDS) return fallback;
  return rounded;
}

export function intervalSecondsFromSettings(settings = {}, fallback = 30 * 60) {
  const direct = Number(settings?.intervalSeconds);
  if (Number.isFinite(direct) && direct >= MIN_INTERVAL_SECONDS && direct <= MAX_INTERVAL_SECONDS) {
    return normalizeIntervalSeconds(direct, fallback);
  }

  const legacyMinutes = Number(settings?.intervalMinutes);
  if (Number.isFinite(legacyMinutes) && legacyMinutes > 0) {
    return normalizeIntervalSeconds(legacyMinutes * 60, fallback);
  }

  return normalizeIntervalSeconds(fallback, 30 * 60);
}

export function intervalMinutesForCompatibility(seconds) {
  return normalizeIntervalSeconds(seconds) / 60;
}

export function parseCustomInterval(input, unit) {
  const value = wholeNumber(input);
  if (value === null || value < 1) {
    return { ok: false, error: "Enter a positive whole number." };
  }

  if (unit !== "seconds" && unit !== "minutes") {
    return { ok: false, error: "Unsupported interval unit." };
  }

  const maxInput = unit === "seconds"
    ? MAX_INTERVAL_SECONDS
    : Math.floor(MAX_INTERVAL_SECONDS / 60);
  if (value > maxInput) {
    return {
      ok: false,
      error: `Enter between 1 and ${maxInput.toLocaleString("en-US")} ${unit}.`,
    };
  }

  const seconds = unit === "seconds" ? value : value * 60;
  return { ok: true, seconds, unit, value };
}

export function formatIntervalSeconds(value) {
  let seconds = normalizeIntervalSeconds(value);
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || !parts.length) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function rewriteTimingText(chatId, text) {
  if (!/^\d+$/.test(String(chatId || ""))) return String(text || "");
  let settings;
  try { settings = readAppSettings(String(chatId)); } catch { return String(text || ""); }
  if (!settings || typeof settings !== "object") return String(text || "");
  const display = formatIntervalSeconds(intervalSecondsFromSettings(settings));
  return String(text || "").replace(
    /(\bTiming(?:\s{2,}|\s+[—–:-]\s*)every\s+)[^\n]+/gi,
    (_, prefix) => `${prefix}${display}`,
  );
}

export function installIntervalDisplayUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotIntervalDisplayUiInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for interval display UI");
  }

  Object.defineProperty(ApiClass.prototype, "__telepilotIntervalDisplayUiInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    return originalSendMessage.call(this, chatId, rewriteTimingText(chatId, text), other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    return originalEditMessageText.call(this, chatId, messageId, rewriteTimingText(chatId, text), other, ...rest);
  };
  return true;
}

export const __test = { wholeNumber, rewriteTimingText };
