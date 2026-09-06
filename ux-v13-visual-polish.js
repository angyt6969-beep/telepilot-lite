import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const LEGACY_SETTINGS_FILE = path.join(DATA_DIR, "telepilot-settings.json");

export const SETTINGS_BUTTON_CUSTOM_EMOJI_ID = "5341715473882955310";
export const START_BUTTON_CUSTOM_EMOJI_ID = "5280863578369311403";

const TOP_LEVEL_CALLBACKS = new Set([
  "v1_dashboard_v13",
  "v1_posting_setup_v13",
  "v1_activity_v13",
  "v1_accounts_v13",
  "v1_destinations_v13",
  "v1_settings_v13",
]);

const TOP_LEVEL_TITLES = [
  "📝 Posting Setup",
  "📊 Activity",
  "📈 Activity",
  "👤 Accounts",
  "📁 Destinations",
  "⚙️ Settings",
  "⚙ Settings",
];

function readJson(file, fallback = {}) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function resolvedAdminIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) {
      if (/^\d+$/.test(part)) ids.add(part);
    }
  }

  const persisted = readJson(ADMIN_FILE, {});
  for (const value of Array.isArray(persisted?.adminIds) ? persisted.adminIds : []) {
    if (/^\d+$/.test(String(value))) ids.add(String(value));
  }

  // Keep the v1.3 Dashboard aligned with app.js. Older TelePilot installs may still
  // identify the owner only through the legacy ownerId field.
  const legacy = readJson(LEGACY_SETTINGS_FILE, {});
  if (/^\d+$/.test(String(legacy?.ownerId || ""))) ids.add(String(legacy.ownerId));

  return ids;
}

function isAdminChat(chatId) {
  const value = String(chatId || "");
  return /^\d+$/.test(value) && resolvedAdminIds().has(value);
}

function cloneOther(other) {
  if (!other) return {};
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

function stripLeadingSymbol(text) {
  return String(text || "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function isTopLevelOverview(text) {
  const first = String(text || "").split("\n", 1)[0];
  return TOP_LEVEL_TITLES.includes(first);
}

function currentTopCallback(text) {
  const first = String(text || "").split("\n", 1)[0];
  if (first === "📝 Posting Setup") return "v1_posting_setup_v13";
  if (first === "📊 Activity" || first === "📈 Activity") return "v1_activity_v13";
  if (first === "👤 Accounts") return "v1_accounts_v13";
  if (first === "📁 Destinations") return "v1_destinations_v13";
  if (first === "⚙️ Settings" || first === "⚙ Settings") return "v1_settings_v13";
  return "";
}

function overviewText(text) {
  const value = String(text || "");
  if (!isTopLevelOverview(value)) return value;

  const lines = value.split("\n");
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    // v1.3 summary rows intentionally use two or more spaces between a short label
    // and its value. Convert those rows into one consistent, easy-to-scan format.
    const match = line.match(/^([A-Za-z][A-Za-z0-9 /&()+.'-]{0,34})\s{2,}(.+)$/);
    if (!match) continue;
    lines[index] = `${match[1].trim()}: — ${match[2].trim()}`;
  }
  return lines.join("\n");
}

function pushEntity(entities, entity) {
  if (!entities.some(item => item?.type === entity.type && item?.offset === entity.offset && item?.length === entity.length)) {
    entities.push(entity);
  }
}

function overviewEntities(text, other) {
  if (!isTopLevelOverview(text)) return other;

  const next = cloneOther(other);
  // These five v1.3 overview screens are plain text. Rebuild their formatting after
  // normalizing punctuation so all Bot API entity offsets match the final message.
  const entities = [];
  const firstLine = text.split("\n", 1)[0];
  const title = firstLine.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const titleOffset = firstLine.indexOf(title);
  if (title && titleOffset >= 0) {
    pushEntity(entities, { type: "bold", offset: titleOffset, length: title.length });
    pushEntity(entities, { type: "italic", offset: titleOffset, length: title.length });
  }

  let cursor = firstLine.length + 1;
  const lines = text.split("\n");
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.indexOf(": — ");
    if (marker > 0) {
      pushEntity(entities, { type: "bold", offset: cursor, length: marker });
      pushEntity(entities, { type: "italic", offset: cursor, length: marker });
    }
    cursor += line.length + 1;
  }

  delete next.parse_mode;
  next.entities = entities;
  return next;
}

function isBackButton(button, text) {
  const data = String(button?.callback_data || "");
  const label = String(button?.text || "").trim();
  const lower = label.toLowerCase();
  if (!data) return false;
  if (data === "home" || /(^|[_:])back($|[_:])/.test(data) || /(^|[_:])cancel($|[_:])/.test(data)) return true;
  if (/\bback\b/.test(lower) || /\bdashboard\b/.test(lower) || lower === "cancel" || label.startsWith("←")) return true;

  // On a child screen, a button that returns to one of the five main sections is a
  // parent-navigation control. Keep parent navigation below every action button.
  if (!String(text || "").startsWith("✈️ TelePilot") && TOP_LEVEL_CALLBACKS.has(data)) {
    const current = currentTopCallback(text);
    return !current || data !== current;
  }
  return false;
}

function moveBackButtonsToBottom(text, other) {
  const next = cloneOther(other);
  const rows = next.reply_markup?.inline_keyboard;
  if (!Array.isArray(rows)) return next;

  const actionRows = [];
  const backRows = [];
  for (const row of rows) {
    const actions = [];
    const backs = [];
    for (const button of row) {
      (isBackButton(button, text) ? backs : actions).push(button);
    }
    if (actions.length) actionRows.push(actions);
    if (backs.length) backRows.push(backs);
  }
  next.reply_markup.inline_keyboard = [...actionRows, ...backRows];
  return next;
}

function applyExplicitPremiumButtons(other) {
  const next = cloneOther(other);
  const rows = next.reply_markup?.inline_keyboard;
  if (!Array.isArray(rows)) return next;

  for (const row of rows) {
    for (const button of row) {
      const data = String(button?.callback_data || "");
      if (data === "start") {
        button.icon_custom_emoji_id = START_BUTTON_CUSTOM_EMOJI_ID;
        button.text = stripLeadingSymbol(button.text) || "Start";
        button.style = "success";
      } else if (data === "v1_settings_v13") {
        button.icon_custom_emoji_id = SETTINGS_BUTTON_CUSTOM_EMOJI_ID;
        button.text = stripLeadingSymbol(button.text) || "Settings";
      }
    }
  }
  return next;
}

function ensureAdminPanel(chatId, text, other) {
  const next = cloneOther(other);
  if (!String(text || "").startsWith("✈️ TelePilot") || !isAdminChat(chatId)) return next;
  const rows = next.reply_markup?.inline_keyboard;
  if (!Array.isArray(rows)) return next;
  if (rows.flat().some(button => String(button?.callback_data || "") === "admin")) return next;
  rows.push([{ text: "🟣 ADMIN PANEL", callback_data: "admin" }]);
  return next;
}

export function polishTelePilotPayload(chatId, text, other) {
  const polishedText = overviewText(text);
  let polishedOther = overviewEntities(polishedText, other);
  polishedOther = applyExplicitPremiumButtons(polishedOther);
  polishedOther = ensureAdminPanel(chatId, polishedText, polishedOther);
  polishedOther = moveBackButtonsToBottom(polishedText, polishedOther);
  return { text: polishedText, other: polishedOther };
}

function looksLikePremiumPermissionError(err) {
  const message = String(err?.description || err?.message || err || "").toUpperCase();
  return message.includes("CUSTOM_EMOJI")
    || message.includes("CUSTOM EMOJI")
    || message.includes("ICON_CUSTOM_EMOJI");
}

function withoutExplicitPremiumButtons(other) {
  const next = cloneOther(other);
  for (const row of next.reply_markup?.inline_keyboard || []) {
    for (const button of row) {
      if ([START_BUTTON_CUSTOM_EMOJI_ID, SETTINGS_BUTTON_CUSTOM_EMOJI_ID].includes(String(button?.icon_custom_emoji_id || ""))) {
        delete button.icon_custom_emoji_id;
      }
    }
  }
  return next;
}

export function installUxV13VisualPolish(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotUxV13VisualPolishInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for TelePilot v1.3 visual polish");
  }

  Object.defineProperty(ApiClass.prototype, "__telepilotUxV13VisualPolishInstalled", { value: true });

  ApiClass.prototype.sendMessage = async function(chatId, text, other, ...rest) {
    const result = polishTelePilotPayload(chatId, text, other);
    try {
      return await originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
    } catch (err) {
      if (!looksLikePremiumPermissionError(err)) throw err;
      return originalSendMessage.call(this, chatId, result.text, withoutExplicitPremiumButtons(result.other), ...rest);
    }
  };

  ApiClass.prototype.editMessageText = async function(chatId, messageId, text, other, ...rest) {
    const result = polishTelePilotPayload(chatId, text, other);
    try {
      return await originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
    } catch (err) {
      if (!looksLikePremiumPermissionError(err)) throw err;
      return originalEditMessageText.call(this, chatId, messageId, result.text, withoutExplicitPremiumButtons(result.other), ...rest);
    }
  };
}
