const PAGE_PREFIXES = [
  "👋 Welcome to TelePilot",
  "📱 Sender & Message",
  "📁 Destinations & Schedule",
  "⚙️ Tools & Safety",
  "⚡ TelePilot Power Tools",
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
];

const PRIMARY = new Set([
  "v1_tools", "v1_preview", "v1_exact_add", "v1_once_add", "v1_date_range",
  "v1_expiry_set", "v1_limit_set", "v1_variable_add", "v1_search_dest", "v1_search_tpl",
  "v1_folder_assign_menu", "v1_backup", "tutorial_restart",
]);
const SUCCESS = new Set([
  "tutorial:finish", "start", "start_confirm", "v1_rotation:cycle", "v1_rotation:random",
]);
const DANGER = new Set([
  "v1_emergency", "v1_date_clear", "v1_expiry_clear", "v1_limit_clear", "v1_fail_reset",
]);

function isTelePilotPage(text) {
  const value = String(text || "");
  return PAGE_PREFIXES.some(prefix => value.startsWith(prefix))
    || value.startsWith("✈️ TelePilot")
    || value.startsWith("⚙️ TelePilot Tools")
    || value.startsWith("📱 Sender")
    || value.startsWith("📝 Message")
    || value.startsWith("📁 Destinations")
    || value.startsWith("📆 Schedule")
    || value.startsWith("📈 Activity")
    || value.startsWith("💎 Access")
    || value.startsWith("💎 TelePilot Access");
}

function replaceHyphenLabels(text) {
  return String(text || "").split("\n").map(line => {
    if (/^[A-Za-z][A-Za-z0-9 /&()]{0,34} - /.test(line)) return line.replace(" - ", " — ");
    return line;
  }).join("\n");
}

function addEntityOnce(entities, entity) {
  if (!entities.some(existing => existing?.type === entity.type && existing?.offset === entity.offset && existing?.length === entity.length)) entities.push(entity);
}

function firstTitleRange(text) {
  const first = String(text || "").split("\n")[0];
  if (!first) return null;
  const index = first.search(/[\p{L}\p{N}]/u);
  if (index < 0) return null;
  return { offset: index, length: first.length - index };
}

function addFormatting(text, other) {
  if (!isTelePilotPage(text) || other?.parse_mode) return other;
  const range = firstTitleRange(text);
  if (!range) return other;
  const entities = Array.isArray(other?.entities) ? other.entities.map(entity => ({ ...entity })) : [];
  addEntityOnce(entities, { type: "bold", offset: range.offset, length: range.length });

  const secondaryLabels = [
    "Sender", "Message", "Destinations", "Schedule", "Access", "Rotation", "Mode",
    "Available templates", "Recurring exact times", "Pending one-time posts", "Active dates",
    "Message expires", "Post limit", "Interval", "Posting window", "Next exact job", "Health",
    "Session file", "Last verified", "Notifications", "Weekly recap", "Profiles", "Active access",
  ];
  for (const label of secondaryLabels) {
    let from = 0;
    while (from < text.length) {
      const offset = text.indexOf(`${label} —`, from);
      if (offset < 0) break;
      addEntityOnce(entities, { type: "bold", offset, length: label.length });
      from = offset + label.length;
    }
  }
  entities.sort((a, b) => Number(a.offset || 0) - Number(b.offset || 0) || Number(a.length || 0) - Number(b.length || 0));
  return { ...(other || {}), entities };
}

function hasCallback(markup, data) {
  return (markup?.inline_keyboard || []).flat().some(button => button.callback_data === data);
}

function polishMarkup(text, other) {
  if (!other?.reply_markup?.inline_keyboard) return other;
  const inline_keyboard = other.reply_markup.inline_keyboard.map(row => row.map(source => {
    const button = { ...source };
    const data = button.callback_data || "";
    if (PRIMARY.has(data)) button.style = "primary";
    if (SUCCESS.has(data)) button.style = "success";
    if (DANGER.has(data) || /(?:_del:|_revoke:)/.test(data)) button.style = "danger";
    return button;
  }));

  if (String(text || "").startsWith("⚙️ TelePilot Tools") && !hasCallback({ inline_keyboard }, "v1_tools")) {
    const backIndex = inline_keyboard.findIndex(row => row.some(button => button.callback_data === "home"));
    const rows = [
      [{ text: "⚡ Power Tools", callback_data: "v1_tools", style: "primary" }, { text: "👁 Smart preview", callback_data: "v1_preview", style: "primary" }],
      [{ text: "❓ Tutorial", callback_data: "tutorial_restart" }, { text: "🆕 What's new", callback_data: "v1_changelog" }],
    ];
    if (backIndex >= 0) inline_keyboard.splice(backIndex, 0, ...rows);
    else inline_keyboard.push(...rows);
  }

  if (String(text || "").startsWith("✈️ TelePilot") && /READY|LIVE/.test(String(text)) && !hasCallback({ inline_keyboard }, "v1_preview")) {
    const homeIndex = inline_keyboard.findIndex(row => row.some(button => button.callback_data === "home" && /refresh/i.test(button.text || "")));
    const row = [{ text: "👁 Smart preview", callback_data: "v1_preview", style: "primary" }];
    if (homeIndex >= 0) inline_keyboard.splice(homeIndex, 0, row);
    else inline_keyboard.push(row);
  }

  return { ...(other || {}), reply_markup: { ...other.reply_markup, inline_keyboard } };
}

function enhance(text, other) {
  const value = isTelePilotPage(text) ? replaceHyphenLabels(text) : String(text || "");
  let next = polishMarkup(value, other);
  next = addFormatting(value, next);
  return { text: value, other: next };
}

export function installV1Ui(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotV1UiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for TelePilot v1 UI");
  Object.defineProperty(ApiClass.prototype, "__telepilotV1UiInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = enhance(text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };

  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = enhance(text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
}
