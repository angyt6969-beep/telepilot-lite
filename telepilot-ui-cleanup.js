import { Api } from "grammy";

const PLANE_EMOJI_ID = "5231361378748472914";
const SETUP_EMOJI_ID = "5312536423851630001";

function cloneMarkup(other) {
  if (!other?.reply_markup?.inline_keyboard) return other || {};
  return {
    ...(other || {}),
    reply_markup: {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    },
  };
}

function allButtons(other) {
  return (other?.reply_markup?.inline_keyboard || []).flat();
}

function findButton(other, callbackData) {
  const button = allButtons(other).find(item => item?.callback_data === callbackData);
  return button ? { ...button } : null;
}

function makeButton(text, callbackData, template = null) {
  return {
    ...(template || {}),
    text,
    callback_data: callbackData,
  };
}

function cleanOther(other, rows = null, html = false) {
  const next = cloneMarkup(other);
  if (rows) next.reply_markup = { ...(next.reply_markup || {}), inline_keyboard: rows };
  delete next.entities;
  delete next.caption_entities;
  if (html) next.parse_mode = "HTML";
  else delete next.parse_mode;
  return next;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));
}

function linesOf(text) {
  return String(text || "").split("\n").map(line => line.trim()).filter(Boolean);
}

function lineWith(lines, label) {
  const rx = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i");
  return lines.find(line => rx.test(line)) || "";
}

function valueAfterLabel(line, label) {
  if (!line) return "";
  const rx = new RegExp(`^.*?\\b${label.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b\\s*:?[\\s]*(?:—\\s*)?`, "i");
  return String(line).replace(rx, "").trim();
}

function statusFrom(text) {
  const value = String(text || "").toUpperCase();
  if (value.includes("PAUSED")) return "PAUSED";
  if (value.includes("● LIVE") || /\bLIVE\b/.test(value)) return "LIVE";
  if (value.includes("● READY") || /\bREADY\b/.test(value)) return "READY";
  return "SETUP";
}

function normalizeMessageValue(value) {
  if (!value || /not set/i.test(value)) return "Not set";
  if (/ready/i.test(value)) return "Ready";
  return value.replace(/^[✓!✅⚠️]+\s*/, "").trim();
}

function normalizeDestinationValue(value) {
  const raw = String(value || "").replace(/^[✓!✅⚠️]+\s*/, "").trim();
  const match = raw.match(/(\d+)\s+ready\s*\/\s*(\d+)\s+total/i);
  if (match) {
    const ready = Number(match[1]);
    const total = Number(match[2]);
    if (!total) return "Not set";
    if (ready === total) return `${ready} ready`;
    return `${ready} / ${total} ready`;
  }
  const active = raw.match(/(\d+)\s+active(?:\s*\/\s*(\d+)\s+saved)?/i);
  if (active) {
    const count = Number(active[1]);
    return count ? `${count} active` : "Not set";
  }
  return raw || "Not set";
}

function normalizeTimingValue(value) {
  let raw = String(value || "").replace(/^[✓!✅⚠️]+\s*/, "").trim();
  raw = raw.replace(/^every\s+/i, "");
  if (!raw) return "Not set";
  return `Every ${raw}`;
}

function statusHtml(status) {
  if (status === "LIVE") return "🟢 <b>LIVE</b>";
  if (status === "READY") return "🟢 <b>READY</b>";
  if (status === "PAUSED") return "⏸ <b>PAUSED</b>";
  return `<tg-emoji emoji-id="${SETUP_EMOJI_ID}">💡</tg-emoji> <b>SETUP</b>`;
}

function actionLine(status, message, destinations) {
  if (status === "LIVE") return "Posting is running.";
  if (status === "PAUSED") return "Posting is paused.";
  if (/not set/i.test(message)) return "Set a message to continue.";
  if (/not set|^0\b/i.test(destinations)) return "Add a destination to continue.";
  if (status === "READY") return "Ready to start.";
  return "Finish setup to continue.";
}

export function simplifyDashboard(text, other) {
  const lines = linesOf(text);
  const sender = valueAfterLabel(lineWith(lines, "Sender"), "Sender") || "Not set";
  const message = normalizeMessageValue(valueAfterLabel(lineWith(lines, "Message"), "Message"));
  const destinations = normalizeDestinationValue(valueAfterLabel(lineWith(lines, "Destinations"), "Destinations"));
  const timing = normalizeTimingValue(valueAfterLabel(lineWith(lines, "Timing"), "Timing") || valueAfterLabel(lineWith(lines, "Schedule"), "Schedule"));
  const status = statusFrom(text);
  const nextPost = valueAfterLabel(lineWith(lines, "Next post"), "Next post");
  const resumes = valueAfterLabel(lineWith(lines, "Resumes"), "Resumes");
  const issueLine = lines.find(line => /\bitem(?:s)? need attention\b/i.test(line)) || "";
  const keyLine = lines.find(line => /Key\s*\/\s*renewal/i.test(line) || /^🔑\s*Access\b/i.test(line)) || "";
  const keyValue = keyLine ? (valueAfterLabel(keyLine, "Key / renewal") || valueAfterLabel(keyLine, "Access")) : "";

  const out = [
    `<tg-emoji emoji-id="${PLANE_EMOJI_ID}">✈️</tg-emoji> <b><i>TelePilot</i></b>`,
    statusHtml(status),
    "",
    `Sender: — ${esc(sender)}`,
    `Message: — ${esc(message)}`,
    `Destinations: — ${esc(destinations)}`,
    `Timing: — ${esc(timing)}`,
  ];
  if (status === "LIVE" && nextPost) out.push(`Next post: — ${esc(nextPost)}`);
  if (status === "PAUSED" && resumes) out.push(`Resumes: — ${esc(resumes)}`);
  out.push("");
  if (issueLine) out.push(esc(issueLine.replace(/^⚠\s*/, "Attention: — ")));
  else out.push(actionLine(status, message, destinations));
  if (keyValue) out.push("", `🔑 Access: — ${esc(keyValue.replace(/^—\s*/, ""))}`);

  const next = cloneMarkup(other);
  const rows = [];
  for (const row of next?.reply_markup?.inline_keyboard || []) {
    const kept = row.filter(button => button?.callback_data !== "v1_preview" && button?.callback_data !== "tools");
    if (kept.length) rows.push(kept);
  }
  return { text: out.join("\n"), other: cleanOther(next, rows, true) };
}

function compactPostingSetup(text, other) {
  const lines = linesOf(text);
  const sender = valueAfterLabel(lineWith(lines, "Sender"), "Sender") || "Not set";
  const message = normalizeMessageValue(valueAfterLabel(lineWith(lines, "Message"), "Message"));
  const destinations = normalizeDestinationValue(valueAfterLabel(lineWith(lines, "Destinations"), "Destinations"));
  const timing = normalizeTimingValue(valueAfterLabel(lineWith(lines, "Timing"), "Timing"));
  const rows = [];
  const pairs = [
    ["message", "interval"],
    ["v1_preview"],
    ["v1_setups_v13", "v1_tools"],
    ["v1_dashboard_v13"],
  ];
  for (const pair of pairs) {
    const row = pair.map(data => findButton(other, data)).filter(Boolean);
    if (row.length) rows.push(row);
  }
  return {
    text: [
      "📝 <b><i>Posting Setup</i></b>",
      "",
      `Sender: — ${esc(sender)}`,
      `Message: — ${esc(message)}`,
      `Destinations: — ${esc(destinations)}`,
      `Timing: — ${esc(timing)}`,
    ].join("\n"),
    other: cleanOther(other, rows.length ? rows : null, true),
  };
}

function compactSmartPreview(text, other) {
  const lines = linesOf(text);
  const sender = valueAfterLabel(lineWith(lines, "Sender"), "Sender") || "Not set";
  const message = normalizeMessageValue(valueAfterLabel(lineWith(lines, "Message"), "Message"));
  const destinations = normalizeDestinationValue(valueAfterLabel(lineWith(lines, "Destinations"), "Destinations"));
  const timing = normalizeTimingValue(valueAfterLabel(lineWith(lines, "Interval"), "Interval") || valueAfterLabel(lineWith(lines, "Timing"), "Timing"));
  const previewIndex = lines.findIndex(line => /^Message preview:?$/i.test(line));
  let preview = "Not set";
  if (previewIndex >= 0 && lines[previewIndex + 1]) preview = lines[previewIndex + 1];

  const rows = [];
  const start = findButton(other, "start");
  if (start) rows.push([start]);
  const openMessage = findButton(other, "message_preview");
  if (openMessage) rows.push([makeButton("📝 Open Message", "message_preview", openMessage)]);
  const backTemplate = findButton(other, "home") || findButton(other, "v1_dashboard_v13") || findButton(other, "v1_tools");
  rows.push([makeButton("← Posting Setup", "v1_posting_setup_v13", backTemplate)]);

  return {
    text: [
      "👀 <b><i>Smart Preview</i></b>",
      "",
      `Sender: — ${esc(sender)}`,
      `Message: — ${esc(message)}`,
      `Destinations: — ${esc(destinations)}`,
      `Timing: — ${esc(timing)}`,
      "",
      "<b>Preview</b>",
      esc(preview),
    ].join("\n"),
    other: cleanOther(other, rows, true),
  };
}

function compactAdvanced(text, other) {
  const lines = linesOf(text);
  const rotation = valueAfterLabel(lineWith(lines, "Rotation"), "Rotation") || "Off";
  const exact = valueAfterLabel(lineWith(lines, "Exact schedules"), "Exact schedules") || "0";
  const queued = valueAfterLabel(lineWith(lines, "One-time posts"), "One-time posts") || "0";

  const rotationButton = findButton(other, "v1_rotation");
  const exactButton = findButton(other, "v1_exact");
  const queueButton = findButton(other, "v1_queue");
  const backupButton = findButton(other, "v1_backup");
  const emergencyButton = findButton(other, "v1_emergency");
  const backTemplate = findButton(other, "tools") || findButton(other, "home");
  const rows = [];
  if (rotationButton || exactButton) rows.push([
    rotationButton ? makeButton("🔄 Message Rotation", "v1_rotation", rotationButton) : makeButton("🔄 Message Rotation", "v1_rotation"),
    exactButton ? makeButton("🕒 Exact Times", "v1_exact", exactButton) : makeButton("🕒 Exact Times", "v1_exact"),
  ]);
  if (queueButton || backupButton) rows.push([
    queueButton ? makeButton("🧭 Posting Queue", "v1_queue", queueButton) : makeButton("🧭 Posting Queue", "v1_queue"),
    backupButton ? makeButton("📦 Backup", "v1_backup", backupButton) : makeButton("📦 Backup", "v1_backup"),
  ]);
  rows.push([emergencyButton ? makeButton("🛑 Emergency Stop", "v1_emergency", emergencyButton) : makeButton("🛑 Emergency Stop", "v1_emergency")]);
  rows.push([makeButton("← Posting Setup", "v1_posting_setup_v13", backTemplate)]);

  return {
    text: [
      "⚡ <b><i>Advanced</i></b>",
      "",
      `Rotation: — ${esc(rotation)}`,
      `Exact schedules: — ${esc(exact)}`,
      `Queued posts: — ${esc(queued)}`,
    ].join("\n"),
    other: cleanOther(other, rows, true),
  };
}

function retireToolsPage(other) {
  const backTemplate = findButton(other, "home") || findButton(other, "posting_setup") || findButton(other, "v1_tools");
  return {
    text: "📝 <b><i>Posting Setup</i></b>\n\nTools have been simplified. Use Posting Setup for everyday controls and Advanced for scheduling and safety.",
    other: cleanOther(other, [[makeButton("← Posting Setup", "v1_posting_setup_v13", backTemplate)]], true),
  };
}

function renameAdvancedNavigation(text, other) {
  const next = cloneMarkup(other);
  for (const row of next?.reply_markup?.inline_keyboard || []) {
    for (const button of row) {
      if (button?.callback_data === "v1_tools" && /power tools/i.test(String(button.text || ""))) {
        button.text = String(button.text || "").replace(/Power Tools/ig, "Advanced");
      }
    }
  }
  return { text: String(text || "").replace(/TelePilot Power Tools/g, "Advanced"), other: next };
}

export function cleanupTelePilotUi(text, other) {
  const value = String(text || "");
  if (value.startsWith("✈️ TelePilot") && /(SETUP|READY|LIVE|PAUSED)/i.test(value) && /Sender/i.test(value) && /Destinations/i.test(value)) {
    return simplifyDashboard(value, other);
  }
  if (value.startsWith("📝 Posting Setup")) return compactPostingSetup(value, other);
  if (value.startsWith("👁 Smart preview") || value.startsWith("👀 Smart Preview")) return compactSmartPreview(value, other);
  if (value.startsWith("⚡ TelePilot Power Tools") || value.startsWith("⚡ Advanced")) return compactAdvanced(value, other);
  if (value.startsWith("⚙️ TelePilot Tools") || value.startsWith("⚙️ Tools & Safety")) return retireToolsPage(other);
  return renameAdvancedNavigation(value, other);
}

export function installTelePilotUiCleanup(ApiClass = Api) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotFinalUiCleanupInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for TelePilot UI cleanup");
  Object.defineProperty(ApiClass.prototype, "__telepilotFinalUiCleanupInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = cleanupTelePilotUi(text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = cleanupTelePilotUi(text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
}

installTelePilotUiCleanup(Api);
