const PRO_PREFIXES = [
  "⚙️ TelePilot Tools",
  "📝 Templates",
  "📝 Manage templates",
  "📝 Save template",
  "📆 Advanced schedule",
  "📆 Set timezone",
  "⏱ Destination spacing",
  "✨ Dynamic placeholders",
  "📁 Destination switches",
  "🩺 Destination health",
  "📜 Posting history",
  "📥 Import configuration",
  "📥 Import complete",
  "🛡 TelePilot Admin",
];

const PRIMARY = new Set([
  "tools", "test_send", "templates", "tpl_save", "advanced_schedule", "stagger_menu",
  "dest_health", "dest_switches", "history", "placeholders", "export_config", "import_config",
  "admin_panel", "sched_timezone", "posting_pause", "posting_skip",
]);
const SUCCESS = new Set(["placeholders_toggle", "sched_toggle"]);
const DANGER = new Set(["media_clear"]);

function isProText(text) {
  const value = String(text || "");
  return PRO_PREFIXES.some(prefix => value.startsWith(prefix));
}

function enhanceText(text) {
  let value = String(text || "");
  if (!isProText(value)) return value;
  return value
    .replace(/^Saved\s{2,}/gm, "Saved — ")
    .replace(/^Posting\s{2,}/gm, "Posting — ")
    .replace(/^Next cycle\s{2,}/gm, "Next cycle — ")
    .replace(/^Days\s{2,}/gm, "Days — ")
    .replace(/^Hours\s{2,}/gm, "Hours — ")
    .replace(/^Timezone\s{2,}/gm, "Timezone — ")
    .replace(/^Extra delay\s{2,}/gm, "Extra delay — ")
    .replace(/^Status\s{2,}/gm, "Status — ")
    .replace(/^Profiles\s{2,}/gm, "Profiles — ")
    .replace(/^Active access\s{2,}/gm, "Active access — ")
    .replace(/^Personal senders\s{2,}/gm, "Personal senders — ")
    .replace(/^Unused keys\s{2,}/gm, "Unused keys — ")
    .replace(/^Redeemed keys\s{2,}/gm, "Redeemed keys — ")
    .replace(/^Media\s{2,}/gm, "Media — ");
}

function addEntityOnce(entities, entity) {
  if (!entities.some(item => item.type === entity.type && item.offset === entity.offset && item.length === entity.length)) {
    entities.push(entity);
  }
}

function addBold(entities, text, label, italic = false) {
  let from = 0;
  while (from < text.length) {
    const offset = text.indexOf(label, from);
    if (offset < 0) break;
    addEntityOnce(entities, { type: "bold", offset, length: label.length });
    if (italic) addEntityOnce(entities, { type: "italic", offset, length: label.length });
    from = offset + label.length;
  }
}

function enhanceFormatting(text, other) {
  if (!isProText(text) || other?.parse_mode) return other;
  const entities = Array.isArray(other?.entities) ? other.entities.map(entity => ({ ...entity })) : [];
  const firstLine = text.split("\n")[0];
  const title = firstLine.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (title) addBold(entities, text, title);
  for (const label of [
    "Saved", "Posting", "Next cycle", "Days", "Hours", "Timezone", "Extra delay", "Status",
    "Profiles", "Active access", "Personal senders", "Unused keys", "Redeemed keys", "Media",
  ]) addBold(entities, text, label);
  for (const label of ["Active now", "Outside posting window", "Disabled"]) addBold(entities, text, label, true);
  entities.sort((a, b) => a.offset - b.offset || a.length - b.length);
  return entities.length ? { ...(other || {}), entities } : other;
}

function enhanceButtons(other) {
  const keyboard = other?.reply_markup?.inline_keyboard;
  if (!keyboard) return other;
  const inline_keyboard = keyboard.map(row => row.map(source => {
    const button = { ...source };
    const data = String(button.callback_data || "");
    if (PRIMARY.has(data) || data.startsWith("tpl_load:") || data.startsWith("stagger:") || data.startsWith("sched_days:") || data.startsWith("sched_hours:")) button.style = "primary";
    if (SUCCESS.has(data)) button.style = "success";
    if (DANGER.has(data) || data.startsWith("tpl_del:")) button.style = "danger";
    return button;
  }));
  return { ...(other || {}), reply_markup: { ...other.reply_markup, inline_keyboard } };
}

function transform(text, other) {
  const value = enhanceText(text);
  let opts = enhanceButtons(other);
  opts = enhanceFormatting(value, opts);
  return { text: value, other: opts };
}

export function installProTypography(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotProTypographyInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for TelePilot pro typography");
  Object.defineProperty(ApiClass.prototype, "__telepilotProTypographyInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const enhanced = transform(text, other);
    return originalSendMessage.call(this, chatId, enhanced.text, enhanced.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const enhanced = transform(text, other);
    return originalEditMessageText.call(this, chatId, messageId, enhanced.text, enhanced.other, ...rest);
  };
}
