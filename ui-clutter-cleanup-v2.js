import fs from "node:fs";
import path from "node:path";
import { Api } from "grammy";

const DATA_DIR = process.env.DATA_DIR || "/data";
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const LEGACY_SETTINGS_FILE = path.join(DATA_DIR, "telepilot-settings.json");
const BACK_TEXT = "𝙂𝙤 𝙗𝙖𝙘𝙠";

function readJson(file, fallback = {}) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}

function adminIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) if (/^\d+$/.test(part)) ids.add(part);
  }
  const saved = readJson(ADMIN_FILE, {});
  for (const value of Array.isArray(saved?.adminIds) ? saved.adminIds : []) if (/^\d+$/.test(String(value))) ids.add(String(value));
  const legacy = readJson(LEGACY_SETTINGS_FILE, {});
  if (/^\d+$/.test(String(legacy?.ownerId || ""))) ids.add(String(legacy.ownerId));
  return ids;
}

function isAdminChat(chatId) { return adminIds().has(String(chatId || "")); }

function cloneOther(other) {
  const next = other && typeof other === "object" ? { ...other } : {};
  if (Array.isArray(other?.entities)) next.entities = other.entities.map(entity => ({ ...entity }));
  if (other?.reply_markup?.inline_keyboard) {
    next.reply_markup = {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    };
  }
  return next;
}

function allButtons(other) { return (other?.reply_markup?.inline_keyboard || []).flat(); }
function buttonByData(other, ...values) {
  const set = new Set(values.filter(Boolean).map(String));
  return allButtons(other).find(button => set.has(String(button?.callback_data || ""))) || null;
}
function buttonByText(other, rx) { return allButtons(other).find(button => rx.test(String(button?.text || ""))) || null; }

function cleanActionButton(template, text, callbackData, style) {
  const button = template ? { ...template } : {};
  button.text = text;
  if (callbackData) {
    button.callback_data = callbackData;
    delete button.url;
    delete button.web_app;
    delete button.login_url;
    delete button.switch_inline_query;
    delete button.switch_inline_query_current_chat;
    delete button.copy_text;
  }
  if (style) button.style = style;
  else delete button.style;
  return button;
}

function backButton(callbackData) {
  return { text: BACK_TEXT, callback_data: callbackData };
}

function replaceRows(other, rows) {
  const next = cloneOther(other);
  next.reply_markup = { ...(next.reply_markup || {}), inline_keyboard: rows.filter(row => Array.isArray(row) && row.length) };
  return next;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function plainText(text) {
  return decodeHtml(String(text || "")
    .replace(/<tg-emoji\b[^>]*>/gi, "")
    .replace(/<\/tg-emoji>/gi, "")
    .replace(/<[^>]+>/g, ""));
}

function plainLines(text) { return plainText(text).split("\n").map(line => line.trim()).filter(Boolean); }
function titleOf(text) {
  const first = plainText(text).split("\n", 1)[0].trim();
  return first.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}
function metric(lines, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`^${escaped}\\s*:?\\s*(?:—\\s*)?(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(rx);
    if (match) return match[1].trim();
    const spaced = line.match(new RegExp(`^${escaped}\\s{2,}(.+)$`, "i"));
    if (spaced) return spaced[1].trim();
  }
  return "";
}
function firstNumber(value) { return Number(String(value || "").match(/\d+/)?.[0] || 0); }

function esc(value) { return String(value ?? "").replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char])); }

function titleEmojiHtml(text, other, fallbackEmoji) {
  const htmlMatch = String(text || "").match(/<tg-emoji\s+emoji-id=["'](\d+)["'][^>]*>/i);
  if (htmlMatch) return `<tg-emoji emoji-id="${htmlMatch[1]}">${esc(fallbackEmoji)}</tg-emoji>`;
  const firstEnd = plainText(text).indexOf("\n");
  const source = plainText(text);
  const entity = (other?.entities || []).find(item => item?.type === "custom_emoji" && item?.custom_emoji_id && Number(item.offset || 0) <= (firstEnd < 0 ? source.length : firstEnd));
  if (entity) return `<tg-emoji emoji-id="${entity.custom_emoji_id}">${esc(fallbackEmoji)}</tg-emoji>`;
  return esc(fallbackEmoji);
}

function htmlPage(text, other, emoji, title, body, rows) {
  const next = replaceRows(other, rows);
  delete next.entities;
  delete next.caption_entities;
  next.parse_mode = "HTML";
  return {
    text: [`${titleEmojiHtml(text, other, emoji)} <b><i>${esc(title)}</i></b>`, "", ...body].join("\n"),
    other: next,
  };
}

function statusFromDashboard(text) {
  const source = plainText(text).toUpperCase();
  if (/\bPAUSED\b/.test(source)) return "PAUSED";
  if (/\bLIVE\b/.test(source)) return "LIVE";
  if (/\bREADY\b/.test(source)) return "READY";
  return "SETUP";
}

function compactDashboard(text, other) {
  const status = statusFromDashboard(text);
  const source = plainText(text);
  const inactiveAccess = /\bAccess\s*:?\s*(?:—\s*)?(?:Inactive|Revoked|Expired)\b/i.test(source);
  const rows = [];

  if (!inactiveAccess) {
    const control = status === "LIVE" || status === "PAUSED"
      ? cleanActionButton(buttonByData(other, "stop"), "Stop", "stop", "danger")
      : cleanActionButton(buttonByData(other, "start"), "Start", "start", "success");
    rows.push([control]);
  }

  const posting = cleanActionButton(buttonByData(other, "v1_posting_setup_v13", "posting_setup"), "Posting Setup", "v1_posting_setup_v13", "primary");
  const activityTemplate = buttonByData(other, "v1_activity_v13", "activity");
  const activity = inactiveAccess ? null : cleanActionButton(activityTemplate, "Activity", "v1_activity_v13");
  rows.push(activity ? [posting, activity] : [posting]);

  rows.push([
    cleanActionButton(buttonByData(other, "v1_accounts_v13", "account"), "Accounts", "v1_accounts_v13"),
    cleanActionButton(buttonByData(other, "v1_destinations_v13", "groups"), "Destinations", "v1_destinations_v13"),
  ]);
  rows.push([cleanActionButton(buttonByData(other, "v1_settings_v13", "settings"), "Settings", "v1_settings_v13", "primary")]);

  if (inactiveAccess) {
    const accessTemplate = buttonByText(other, /get\s*\/?\s*renew\s*key|get access|renew access|redeem/i)
      || buttonByData(other, "redeem_key", "crypto_checkout_start", "checkout");
    if (accessTemplate) rows.push([cleanActionButton(accessTemplate, "Get Access", String(accessTemplate.callback_data || ""), "primary")]);
  }

  return { text, other: replaceRows(other, rows) };
}

function postingSetupBody(text) {
  const lines = plainLines(text);
  const sender = metric(lines, "Sender") || "Not set";
  const message = metric(lines, "Message") || "Not set";
  const destinations = metric(lines, "Destinations") || "Not set";
  const timing = metric(lines, "Timing") || metric(lines, "Interval") || "Not set";
  return [
    `<b>Sender:</b> — ${esc(sender)}`,
    `<b>Message:</b> — ${esc(message)}`,
    `<b>Destinations:</b> — ${esc(destinations)}`,
    `<b>Timing:</b> — ${esc(timing)}`,
  ];
}

function compactPostingSetup(text, other) {
  const rows = [
    [
      cleanActionButton(buttonByData(other, "message", "message_change"), "Message", "message"),
      cleanActionButton(buttonByData(other, "interval"), "Timing", "interval"),
    ],
    [
      cleanActionButton(buttonByData(other, "v1_setups_v13"), "Setups", "v1_setups_v13"),
      cleanActionButton(buttonByData(other, "v1_tools"), "Advanced", "v1_tools", "primary"),
    ],
    [backButton("v1_dashboard_v13")],
  ];
  return htmlPage(text, other, "📝", "Posting Setup", postingSetupBody(text), rows);
}

function compactActivity(text, other) {
  const lines = plainLines(text);
  const posting = metric(lines, "Posting") || "Stopped";
  const next = metric(lines, "Next") || "—";
  const destinations = metric(lines, "Destination health") || metric(lines, "Destinations") || "—";
  const attentionValue = metric(lines, "Needs attention") || metric(lines, "Attention") || "0";
  const attention = firstNumber(attentionValue);
  const recentIndex = lines.findIndex(line => /^Recent$/i.test(line));
  let last = recentIndex >= 0 ? String(lines[recentIndex + 1] || "") : "";
  last = last.replace(/^[^\p{L}\p{N}@]+/u, "").trim();
  if (/no posting history/i.test(last)) last = "No posts yet";

  const body = [
    `<b>Posting:</b> — ${esc(posting.replace(/^[^\p{L}\p{N}]+/u, ""))}`,
    `<b>Next:</b> — ${esc(next)}`,
    `<b>Destinations:</b> — ${esc(destinations)}`,
    attention ? `<b>Attention:</b> — ${attention} destination${attention === 1 ? "" : "s"} need review` : null,
    last ? `<b>Last:</b> — ${esc(last)}` : null,
    "",
    `<i>${attention ? "Open Issues to fix them." : "Everything looks normal."}</i>`,
  ].filter(Boolean);

  const rows = [];
  if (/paused/i.test(posting)) {
    rows.push([cleanActionButton(buttonByData(other, "v1_resume_posting_v13"), "Resume", "v1_resume_posting_v13", "success")]);
  } else if (/running|live/i.test(posting)) {
    rows.push([cleanActionButton(buttonByData(other, "v1_pause_menu_v13"), "Pause", "v1_pause_menu_v13")]);
  }
  rows.push([cleanActionButton(buttonByData(other, "history", "v1_history") || buttonByText(other, /history/i), "History", "history", "primary")]);
  if (attention) rows.push([cleanActionButton(buttonByData(other, "d5_issues:0", "v1_dest_issues_v13") || buttonByText(other, /issues/i), "Issues", "d5_issues:0")]);
  rows.push([backButton("v1_dashboard_v13")]);
  return htmlPage(text, other, "📊", "Activity", body, rows);
}

function compactDestinations(text, other) {
  const lines = plainLines(text);
  const saved = metric(lines, "Saved") || "0";
  const ready = metric(lines, "Ready") || "0";
  const topicValue = metric(lines, "Choose topic") || metric(lines, "Topics") || "0";
  const topicCount = firstNumber(topicValue);
  let attention = firstNumber(metric(lines, "Needs attention") || metric(lines, "Attention"));
  if (!attention) attention = firstNumber(String(buttonByText(other, /review issues/i)?.text || ""));

  const body = [
    `<b>Saved:</b> — ${esc(saved)}`,
    `<b>Ready:</b> — ${esc(ready)}`,
    attention ? `<b>Attention:</b> — ${attention} destination${attention === 1 ? "" : "s"} need review` : null,
    topicCount ? `<b>Topics:</b> — ${topicCount} need selection` : null,
    "",
    `<i>${attention ? "Open Issues to fix them." : "Destinations are ready."}</i>`,
  ].filter(Boolean);

  const addTemplate = buttonByData(other, "d2_add", "v1_dest_add_v13") || buttonByText(other, /add/i);
  const browseTemplate = buttonByData(other, "d2_browse:0", "v1_dest_browse_v13") || buttonByText(other, /browse/i);
  const rows = [[
    cleanActionButton(addTemplate, "Add / Import", String(addTemplate?.callback_data || "d2_add"), "primary"),
    cleanActionButton(browseTemplate, "Browse", String(browseTemplate?.callback_data || "d2_browse:0")),
  ]];
  const attentionRow = [];
  if (topicCount) attentionRow.push(cleanActionButton(buttonByData(other, "d2_topics:0", "v1_topics_v13") || buttonByText(other, /topics/i), "Topics", "d2_topics:0"));
  if (attention) attentionRow.push(cleanActionButton(buttonByData(other, "d5_issues:0", "v1_dest_issues_v13") || buttonByText(other, /issues/i), "Issues", "d5_issues:0"));
  if (attentionRow.length) rows.push(attentionRow);
  rows.push([cleanActionButton(null, "More", "v1_dest_more_v2", "primary")]);
  rows.push([backButton("v1_dashboard_v13")]);
  return htmlPage(text, other, "📁", "Destinations", body, rows);
}

function compactSettings(chatId, text, other) {
  const lines = plainLines(text);
  const access = metric(lines, "Access") || "—";
  const body = [`<b>Access:</b> — ${esc(access)}`];
  const rows = [
    [
      cleanActionButton(buttonByData(other, "access"), "Access", "access", "primary"),
      cleanActionButton(buttonByData(other, "v1_notifications"), "Notifications", "v1_notifications"),
    ],
    [
      cleanActionButton(buttonByData(other, "referrals"), "Referrals", "referrals"),
      cleanActionButton(buttonByData(other, "support"), "Support", "support"),
    ],
    [cleanActionButton(buttonByData(other, "tutorial_restart"), "Tutorial", "tutorial_restart")],
  ];
  if (isAdminChat(chatId)) rows.push([cleanActionButton(buttonByData(other, "admin"), "Admin", "admin", "primary")]);
  rows.push([backButton("v1_dashboard_v13")]);
  return htmlPage(text, other, "⚙️", "Settings", body, rows);
}

function destinationMoreRows() {
  return [
    [cleanActionButton(null, "Check Access", "d2_refresh", "primary"), cleanActionButton(null, "Manage", "d2_manage:0")],
    [cleanActionButton(null, "Filter", "v1_dest_filters_v13"), cleanActionButton(null, "Sets", "v1_destination_presets_v13")],
    [cleanActionButton(null, "Import History", "v1_import_history_v13"), cleanActionButton(null, "Advanced", "v1_dest_advanced_v2", "primary")],
    [backButton("v1_destinations_v13")],
  ];
}
function destinationAdvancedRows() {
  return [
    [cleanActionButton(null, "Routing", "route_groups:0"), cleanActionButton(null, "Topic Settings", "v1_topic_preferences_v13")],
    [backButton("v1_dest_more_v2")],
  ];
}

function compactDestinationMore(text, other, advanced = false) {
  const rows = advanced ? destinationAdvancedRows() : destinationMoreRows();
  return htmlPage(text, other, "📁", advanced ? "Advanced Destinations" : "More", [
    `<i>${advanced ? "Routing and topic preferences live here." : "Less-used destination controls live here."}</i>`,
  ], rows);
}

function ensureNoSmartPreview(other) {
  const next = cloneOther(other);
  if (!next.reply_markup?.inline_keyboard) return next;
  next.reply_markup.inline_keyboard = next.reply_markup.inline_keyboard
    .map(row => row.filter(button => String(button?.callback_data || "") !== "v1_preview" && !/smart preview/i.test(String(button?.text || ""))))
    .filter(row => row.length);
  return next;
}

export function cleanupUiClutterV2(chatId, text, other) {
  const title = titleOf(text);
  if (/^Smart Preview$/i.test(title) || /^Smart preview$/i.test(title)) return compactPostingSetup(text, ensureNoSmartPreview(other));
  if (/^TelePilot$/i.test(title)) return compactDashboard(text, ensureNoSmartPreview(other));
  if (/^Posting Setup$/i.test(title)) return compactPostingSetup(text, ensureNoSmartPreview(other));
  if (/^Activity$/i.test(title)) return compactActivity(text, ensureNoSmartPreview(other));
  if (/^(?:Destination Hub|Destinations)$/i.test(title)) return compactDestinations(text, ensureNoSmartPreview(other));
  if (/^Settings$/i.test(title)) return compactSettings(chatId, text, ensureNoSmartPreview(other));
  if (/^Destination More$/i.test(title)) return compactDestinationMore(text, ensureNoSmartPreview(other), false);
  if (/^Destination Advanced$/i.test(title)) return compactDestinationMore(text, ensureNoSmartPreview(other), true);
  return { text, other: ensureNoSmartPreview(other) };
}

export function installUiClutterCleanupV2(ApiClass = Api) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotUiClutterCleanupV2Installed) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") throw new Error("Unsupported grammY Api shape for UI clutter cleanup v2");
  Object.defineProperty(ApiClass.prototype, "__telepilotUiClutterCleanupV2Installed", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = cleanupUiClutterV2(chatId, text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = cleanupUiClutterV2(chatId, text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
}

function postingSetupFallbackKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Message", callback_data: "message" }, { text: "Timing", callback_data: "interval" }],
      [{ text: "Setups", callback_data: "v1_setups_v13" }, { text: "Advanced", callback_data: "v1_tools", style: "primary" }],
      [backButton("v1_dashboard_v13")],
    ],
  };
}

export function installUiClutterNavigationV2(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotUiClutterNavigationV2Installed) return;
  const originalStart = BotClass.prototype.start;
  const originalCallbackQuery = BotClass.prototype.callbackQuery;
  if (typeof originalStart !== "function" || typeof originalCallbackQuery !== "function") throw new Error("Unsupported grammY Bot shape for UI clutter navigation v2");
  Object.defineProperty(BotClass.prototype, "__telepilotUiClutterNavigationV2Installed", { value: true });

  // Smart Preview is retired. Suppress any later legacy registration so an old
  // callback cannot resurrect the screen after this layer is installed.
  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    if (trigger === "v1_preview") return this;
    return originalCallbackQuery.call(this, trigger, ...middleware);
  };

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotUiClutterNavigationV2Handlers) {
      Object.defineProperty(this, "__telepilotUiClutterNavigationV2Handlers", { value: true });
      originalCallbackQuery.call(this, "v1_preview", async ctx => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText("📝 Posting Setup", { reply_markup: postingSetupFallbackKeyboard() });
      });
      originalCallbackQuery.call(this, "v1_dest_more_v2", async ctx => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText("📁 Destination More", { reply_markup: { inline_keyboard: destinationMoreRows() } });
      });
      originalCallbackQuery.call(this, "v1_dest_advanced_v2", async ctx => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText("📁 Destination Advanced", { reply_markup: { inline_keyboard: destinationAdvancedRows() } });
      });
    }
    return originalStart.apply(this, args);
  };
}

export const __test = {
  BACK_TEXT,
  titleOf,
  compactDashboard,
  compactPostingSetup,
  compactActivity,
  compactDestinations,
  compactSettings,
  destinationMoreRows,
  destinationAdvancedRows,
};

installUiClutterCleanupV2(Api);
