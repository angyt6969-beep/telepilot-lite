import { Api } from "grammy";

const PLANE_EMOJI_ID = "5231361378748472914";
const SETUP_EMOJI_ID = "5312536423851630001";
const CHECK_EMOJI_ID = "5206607081334906820";
const ACTION_EMOJI_ID = "5411590687663608498";
const KEY_EMOJI_ID = "5307843983102204243";
const ACCOUNT_EMOJI_ID = "5426991207731437507";
const START_EMOJI_ID = "5280863578369311403";
const STOP_EMOJI_ID = "5280474686260527507";

const STATIC_PREMIUM = new Map([
  ["✈", PLANE_EMOJI_ID],
  ["💡", SETUP_EMOJI_ID],
  ["✅", CHECK_EMOJI_ID],
  ["🔑", KEY_EMOJI_ID],
  ["👤", ACCOUNT_EMOJI_ID],
  ["📱", ACCOUNT_EMOJI_ID],
  ["▶", START_EMOJI_ID],
  ["🔥", START_EMOJI_ID],
  ["⏸", STOP_EMOJI_ID],
  ["⏹", STOP_EMOJI_ID],
  ["🛑", STOP_EMOJI_ID],
  ["❌", STOP_EMOJI_ID],
  ["⚠", STOP_EMOJI_ID],
]);

const TELEPILOT_CALLBACK_RE = /^(?:v1_|d[2345]_|fp_|linear_|tutorial(?::|_)|admin(?:_|$)|account(?:_|$)|message(?:_|$)|groups(?:_|$)|interval$|activity$|access$|support$|settings(?:_|$)|start(?:_|$)|stop(?:_|$)|home$|posting_setup$|redeem_key$)/i;
const TELEPILOT_TITLE_RE = /\b(?:TelePilot|Posting|Destination|Destinations|Account|Accounts|Sender|Message|Schedule|Timing|Activity|Settings|Access|Support|Tutorial|Preview|Backup|Import|Topic|Topics|Key|Admin|User|Pause|Retry|Search|Filter|Preset|Setups|Forwarded Post|Rotation|Exact|Queue|Emergency|Notifications|Statistics|Health|Variables|Folders|Overrides)\b/i;
const LEADING_DECORATION_RE = /^(?:(?:\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?|[←→↩↪＋+✓✔◀▶])\s*)+/u;

const TITLE_RENAMES = new Map([
  ["ADMIN TEAM", "Admin Team"],
  ["ADMIN PANEL", "Admin Panel"],
  ["KEY APPROVAL PENDING", "Key Approval Pending"],
  ["KEY APPROVAL REQUEST", "Key Approval Request"],
  ["KEY REQUEST EXPIRED", "Key Request Expired"],
  ["KEY REQUEST REJECTED", "Key Request Rejected"],
  ["KEY REQUEST APPROVED", "Key Request Approved"],
  ["NEW KEY", "New Key"],
  ["SMART PREVIEW", "Smart Preview"],
  ["TELEPILOT POWER TOOLS", "Advanced"],
]);

function cloneMarkup(other) {
  if (!other?.reply_markup?.inline_keyboard) return other ? { ...other } : {};
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
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`\\b${escaped}\\b`, "i");
  return lines.find(line => rx.test(line)) || "";
}

function valueAfterLabel(line, label) {
  if (!line) return "";
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`^.*?\\b${escaped}\\b\\s*:?[\\s]*(?:—\\s*)?`, "i");
  return String(line).replace(rx, "").trim();
}

function normalizeEmoji(value) {
  return String(value || "").replace(/[\uFE0E\uFE0F]/g, "");
}

function staticPremiumId(emoji) {
  return STATIC_PREMIUM.get(normalizeEmoji(emoji)) || "";
}

function customEmojiHtml(text, other, emoji, fallbackId = "") {
  const normalized = normalizeEmoji(emoji);
  const entity = (other?.entities || []).find(item => {
    if (item?.type !== "custom_emoji") return false;
    const value = String(text || "").slice(Number(item.offset || 0), Number(item.offset || 0) + Number(item.length || 0));
    return normalizeEmoji(value) === normalized;
  });
  const id = String(entity?.custom_emoji_id || fallbackId || staticPremiumId(emoji) || "");
  return id ? `<tg-emoji emoji-id="${id}">${esc(emoji)}</tg-emoji>` : esc(emoji);
}

function statusFrom(text) {
  const header = linesOf(text).slice(0, 3).join(" ").toUpperCase();
  if (/\bPAUSED\b/.test(header)) return "PAUSED";
  if (/\bLIVE\b/.test(header)) return "LIVE";
  if (/\bREADY\b/.test(header)) return "READY";
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
  if (status === "LIVE") return `<tg-emoji emoji-id="${START_EMOJI_ID}">▶️</tg-emoji> <b>Status:</b> — <b>LIVE</b>`;
  if (status === "READY") return `<tg-emoji emoji-id="${CHECK_EMOJI_ID}">✅</tg-emoji> <b>Status:</b> — <b>READY</b>`;
  if (status === "PAUSED") return `<tg-emoji emoji-id="${STOP_EMOJI_ID}">⏸</tg-emoji> <b>Status:</b> — <b>PAUSED</b>`;
  return `<tg-emoji emoji-id="${SETUP_EMOJI_ID}">💡</tg-emoji> <b>Status:</b> — <b>SETUP</b>`;
}

function actionLine(status, message, destinations) {
  if (status === "LIVE") return "Posting is running.";
  if (status === "PAUSED") return "Posting is paused.";
  if (/not set/i.test(message)) return "Set a message to continue.";
  if (/not set|^0\b/i.test(destinations)) return "Add a destination to continue.";
  if (status === "READY") return "Ready to start.";
  return "Finish setup to continue.";
}

function buttonFallbackLabel(data, current = "") {
  const value = String(data || "").toLowerCase();
  if (/rename/.test(value)) return "Rename";
  if (/delete|_del\b|remove/.test(value)) return "Delete";
  if (/edit/.test(value)) return "Edit";
  if (/prev|previous/.test(value)) return "Previous";
  if (/next/.test(value)) return "Next";
  if (/home|dashboard/.test(value)) return "Dashboard";
  if (/posting_setup/.test(value)) return "Posting Setup";
  if (/cancel|back/.test(value)) return "Back";
  if (/add|create|new/.test(value)) return "Add";
  return current || "Open";
}

function buttonStyle(button) {
  if (button?.style) return button.style;
  const value = `${button?.text || ""} ${button?.callback_data || ""}`.toLowerCase();
  if (/stop|delete|remove|clear|revoke|disconnect|reset|cancel|discard|disable|emergency/.test(value)) return "danger";
  if (/confirm|save|done|apply|approve|redeem|finish|complete|start|launch|enable|resume/.test(value)) return "success";
  if (/add|create|new|connect|join|prepar|settings|tools|advanced|open|browse|preview|checkout/.test(value)) return "primary";
  return undefined;
}

function cleanButtonText(button) {
  let text = String(button?.text || "");
  text = text
    .replace(/Power Tools/ig, "Advanced")
    .replace(/Smart preview/g, "Smart Preview")
    .replace(/Emergency stop/g, "Emergency Stop")
    .replace(/Message rotation/g, "Message Rotation")
    .replace(/Exact times/g, "Exact Times")
    .replace(/Posting queue/g, "Posting Queue")
    .replace(/Sender health/g, "Sender Health");

  const data = String(button?.callback_data || "");
  const isGetKey = /get\s*\/?\s*renew\s*key|get a key|get key|renew key|checkout/i.test(text)
    || /checkout|redeem_key/i.test(data);

  if (isGetKey && !/redeem/i.test(text)) button.icon_custom_emoji_id = KEY_EMOJI_ID;

  if (button?.icon_custom_emoji_id) {
    const stripped = text.replace(LEADING_DECORATION_RE, "").trimStart();
    text = stripped || buttonFallbackLabel(data, text);
  }

  if (data === "v1_tools") text = "Advanced";
  if (data === "v1_dashboard_v13" || (data === "home" && /home|dashboard/i.test(text))) text = "Dashboard";
  if (data === "v1_posting_setup_v13" || data === "posting_setup") text = "Posting Setup";
  if (data === "tutorial_restart") text = "Tutorial";

  button.text = text || buttonFallbackLabel(data);
  const style = buttonStyle(button);
  if (style && !button.style) button.style = style;
  return button;
}

function polishButtons(other) {
  const next = cloneMarkup(other);
  if (!next?.reply_markup?.inline_keyboard) return next;
  next.reply_markup.inline_keyboard = next.reply_markup.inline_keyboard.map(row => row.map(source => cleanButtonText({ ...source })));
  return next;
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
    "",
    statusHtml(status),
    `<b>Sender:</b> — ${esc(sender)}`,
    `<b>Message:</b> — ${esc(message)}`,
    `<b>Destinations:</b> — ${esc(destinations)}`,
    `<b>Timing:</b> — ${esc(timing)}`,
  ];
  if (status === "LIVE" && nextPost) out.push(`<b>Next post:</b> — ${esc(nextPost)}`);
  if (status === "PAUSED" && resumes) out.push(`<b>Resumes:</b> — ${esc(resumes)}`);
  out.push("");
  if (issueLine) out.push(`<tg-emoji emoji-id="${STOP_EMOJI_ID}">⚠️</tg-emoji> <b>Attention:</b> — ${esc(issueLine.replace(/^⚠\s*/, ""))}`);
  else out.push(`<i>${esc(actionLine(status, message, destinations))}</i>`);
  if (keyValue) out.push("", `<tg-emoji emoji-id="${KEY_EMOJI_ID}">🔑</tg-emoji> <b>Access:</b> — ${esc(keyValue.replace(/^—\s*/, ""))}`);

  const next = cloneMarkup(other);
  const rows = [];
  for (const row of next?.reply_markup?.inline_keyboard || []) {
    const kept = row.filter(button => button?.callback_data !== "v1_preview" && button?.callback_data !== "tools");
    if (kept.length) rows.push(kept);
  }
  return { text: out.join("\n"), other: polishButtons(cleanOther(next, rows, true)) };
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
  const titleEmoji = customEmojiHtml(text, other, "📝");
  return {
    text: [
      `${titleEmoji} <b><i>Posting Setup</i></b>`,
      "",
      `<b>Sender:</b> — ${esc(sender)}`,
      `<b>Message:</b> — ${esc(message)}`,
      `<b>Destinations:</b> — ${esc(destinations)}`,
      `<b>Timing:</b> — ${esc(timing)}`,
    ].join("\n"),
    other: polishButtons(cleanOther(other, rows.length ? rows : null, true)),
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
  const titleEmoji = customEmojiHtml(text, other, "👀");

  return {
    text: [
      `${titleEmoji} <b><i>Smart Preview</i></b>`,
      "",
      `<b>Sender:</b> — ${esc(sender)}`,
      `<b>Message:</b> — ${esc(message)}`,
      `<b>Destinations:</b> — ${esc(destinations)}`,
      `<b>Timing:</b> — ${esc(timing)}`,
      "",
      "<b><i>Preview</i></b>",
      esc(preview),
    ].join("\n"),
    other: polishButtons(cleanOther(other, rows, true)),
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
      `<tg-emoji emoji-id="${ACTION_EMOJI_ID}">⚡</tg-emoji> <b><i>Advanced</i></b>`,
      "",
      `<b>Rotation:</b> — ${esc(rotation)}`,
      `<b>Exact schedules:</b> — ${esc(exact)}`,
      `<b>Queued posts:</b> — ${esc(queued)}`,
    ].join("\n"),
    other: polishButtons(cleanOther(other, rows, true)),
  };
}

function retireToolsPage(text, other) {
  const backTemplate = findButton(other, "home") || findButton(other, "posting_setup") || findButton(other, "v1_tools");
  const titleEmoji = customEmojiHtml(text, other, "📝");
  return {
    text: `${titleEmoji} <b><i>Posting Setup</i></b>\n\n<i>Everyday controls are in Posting Setup. Scheduling and safety controls are under Advanced.</i>`,
    other: polishButtons(cleanOther(other, [[makeButton("← Posting Setup", "v1_posting_setup_v13", backTemplate)]], true)),
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

function isTelePilotPage(text, other) {
  const value = String(text || "");
  const first = value.split("\n", 1)[0].replace(/<[^>]+>/g, "");
  if (TELEPILOT_TITLE_RE.test(first)) return true;
  return allButtons(other).some(button => TELEPILOT_CALLBACK_RE.test(String(button?.callback_data || "")));
}

function titleParts(line) {
  const raw = String(line || "").trim();
  const match = raw.match(LEADING_DECORATION_RE);
  const prefix = match?.[0] || "";
  let title = raw.slice(prefix.length).trim();
  const renamed = TITLE_RENAMES.get(title.toUpperCase());
  if (renamed) title = renamed;
  title = title
    .replace(/\bSmart preview\b/g, "Smart Preview")
    .replace(/\bPower Tools\b/g, "Advanced");
  return { prefix, title };
}

function labelParts(line) {
  const raw = String(line || "").trim();
  if (!raw || /^https?:\/\//i.test(raw)) return null;

  const lead = raw.match(LEADING_DECORATION_RE)?.[0] || "";
  const body = raw.slice(lead.length).trim();
  let match = body.match(/^(.{1,42}?)\s{2,}(\S.*)$/);
  if (!match) match = body.match(/^(.{1,42}?):\s*(?:—\s*)?(\S.*)$/);
  if (!match) match = body.match(/^(.{1,42}?)\s+[—-]\s+(\S.*)$/);
  if (!match) return null;

  const label = match[1].trim();
  const value = match[2].trim();
  if (!label || !value) return null;
  if (label.split(/\s+/).length > 6) return null;
  if (/[.!?]$/.test(label)) return null;
  if (/^(?:http|https|t\.me)\b/i.test(label)) return null;
  return { lead, label, value };
}

function normalizePlainLines(text) {
  const source = String(text || "").split("\n");
  const out = [];
  let previewBody = false;
  for (let i = 0; i < source.length; i++) {
    let line = source[i].replace(/[ \t]+$/g, "");
    if (i === 0) {
      const { prefix, title } = titleParts(line);
      line = `${prefix}${title}`.trim();
    } else if (!previewBody) {
      line = line.replace(/\s-\s/g, " — ");
      const parsed = labelParts(line);
      if (parsed) line = `${parsed.lead}${parsed.label}: — ${parsed.value}`.trim();
    }

    out.push(line);
    if (/^(?:Message preview|Preview|Current message|Your TelePilot key):?\s*$/i.test(line.replace(LEADING_DECORATION_RE, "").trim())) {
      previewBody = true;
    }
  }

  const collapsed = [];
  for (const line of out) {
    if (!line.trim() && !collapsed.at(-1)?.trim()) continue;
    collapsed.push(line);
  }
  while (collapsed.length && !collapsed.at(-1).trim()) collapsed.pop();
  if (collapsed.length > 1 && collapsed[1].trim()) collapsed.splice(1, 0, "");
  return collapsed.join("\n");
}

function collectCustomEmojiRecords(text, other) {
  return (Array.isArray(other?.entities) ? other.entities : [])
    .filter(entity => entity?.type === "custom_emoji" && entity?.custom_emoji_id)
    .map(entity => ({
      emoji: String(text || "").slice(Number(entity.offset || 0), Number(entity.offset || 0) + Number(entity.length || 0)),
      id: String(entity.custom_emoji_id),
    }))
    .filter(item => item.emoji);
}

function addEntityOnce(entities, entity) {
  const duplicate = entities.some(existing =>
    existing?.type === entity.type
    && Number(existing?.offset || 0) === Number(entity.offset || 0)
    && Number(existing?.length || 0) === Number(entity.length || 0)
    && String(existing?.custom_emoji_id || "") === String(entity.custom_emoji_id || "")
  );
  if (!duplicate && Number(entity.length || 0) > 0) entities.push(entity);
}

function remapCustomEmojiEntities(oldText, newText, other) {
  const entities = [];
  const cursors = new Map();
  for (const record of collectCustomEmojiRecords(oldText, other)) {
    const cursor = Number(cursors.get(record.emoji) || 0);
    const index = String(newText).indexOf(record.emoji, cursor);
    if (index < 0) continue;
    addEntityOnce(entities, {
      type: "custom_emoji",
      offset: index,
      length: record.emoji.length,
      custom_emoji_id: record.id,
    });
    cursors.set(record.emoji, index + record.emoji.length);
  }
  return entities;
}

function addStaticPremiumEntities(text, entities) {
  const emojiRx = /\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?/gu;
  for (const match of String(text || "").matchAll(emojiRx)) {
    const emoji = match[0];
    const id = staticPremiumId(emoji);
    if (!id) continue;
    const offset = Number(match.index || 0);
    const length = emoji.length;
    const occupied = entities.some(entity => entity?.type === "custom_emoji"
      && Number(entity.offset || 0) === offset
      && Number(entity.length || 0) === length);
    if (!occupied) addEntityOnce(entities, { type: "custom_emoji", offset, length, custom_emoji_id: id });
  }
}

function addPlainFormatting(text, entities) {
  const value = String(text || "");
  const firstEnd = value.indexOf("\n");
  const firstLine = value.slice(0, firstEnd < 0 ? value.length : firstEnd);
  const prefix = firstLine.match(LEADING_DECORATION_RE)?.[0] || "";
  const titleStart = prefix.length;
  const titleLength = Math.max(0, firstLine.length - titleStart);
  if (titleLength) {
    addEntityOnce(entities, { type: "bold", offset: titleStart, length: titleLength });
    addEntityOnce(entities, { type: "italic", offset: titleStart, length: titleLength });
  }

  let offset = 0;
  for (const line of value.split("\n")) {
    const match = line.match(/^((?:(?:\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?|[←→↩↪])\s*)*)([^:\n]{1,42}:) — /u);
    if (match) {
      const labelOffset = offset + match[1].length;
      addEntityOnce(entities, { type: "bold", offset: labelOffset, length: match[2].length });
      if (/^Status:$/i.test(match[2])) {
        const state = line.match(/ — (SETUP|READY|LIVE|PAUSED)\b/i);
        if (state) addEntityOnce(entities, { type: "bold", offset: offset + line.indexOf(state[1]), length: state[1].length });
      }
    }
    offset += line.length + 1;
  }
}

function containsSensitiveEntities(other) {
  return (other?.entities || []).some(entity => !["custom_emoji", "bold", "italic"].includes(String(entity?.type || "")));
}

function polishPlainPage(text, other) {
  const original = String(text || "");
  const nextOther = polishButtons(cloneMarkup(other));
  if (containsSensitiveEntities(other)) {
    const entities = Array.isArray(nextOther.entities) ? nextOther.entities.map(entity => ({ ...entity })) : [];
    const firstLine = original.split("\n", 1)[0];
    const prefix = firstLine.match(LEADING_DECORATION_RE)?.[0] || "";
    const length = firstLine.length - prefix.length;
    if (length > 0) {
      addEntityOnce(entities, { type: "bold", offset: prefix.length, length });
      addEntityOnce(entities, { type: "italic", offset: prefix.length, length });
    }
    nextOther.entities = entities;
    return { text: original, other: nextOther };
  }

  const value = normalizePlainLines(original);
  const entities = remapCustomEmojiEntities(original, value, other);
  addStaticPremiumEntities(value, entities);
  addPlainFormatting(value, entities);
  entities.sort((a, b) => Number(a.offset || 0) - Number(b.offset || 0) || Number(a.length || 0) - Number(b.length || 0));
  delete nextOther.parse_mode;
  delete nextOther.caption_entities;
  nextOther.entities = entities;
  return { text: value, other: nextOther };
}

function polishHtmlPage(text, other) {
  const next = polishButtons(cloneMarkup(other));
  const value = String(text || "")
    .replace(/Power Tools/g, "Advanced")
    .replace(/\s-\s/g, " — ");
  return { text: value, other: next };
}

function finalPolish(text, other) {
  if (!isTelePilotPage(text, other)) return { text, other };
  if (String(other?.parse_mode || "").toUpperCase() === "HTML") return polishHtmlPage(text, other);
  return polishPlainPage(text, other);
}

export function cleanupTelePilotUi(text, other) {
  const value = String(text || "");
  let result;
  if (value.startsWith("✈️ TelePilot") && /(SETUP|READY|LIVE|PAUSED)/i.test(linesOf(value).slice(0, 3).join(" ")) && /Sender/i.test(value) && /Destinations/i.test(value)) {
    result = simplifyDashboard(value, other);
  } else if (value.startsWith("📝 Posting Setup")) {
    result = compactPostingSetup(value, other);
  } else if (value.startsWith("👁 Smart preview") || value.startsWith("👀 Smart Preview")) {
    result = compactSmartPreview(value, other);
  } else if (value.startsWith("⚡ TelePilot Power Tools") || value.startsWith("⚡ Advanced")) {
    result = compactAdvanced(value, other);
  } else if (value.startsWith("⚙️ TelePilot Tools") || value.startsWith("⚙️ Tools & Safety")) {
    result = retireToolsPage(value, other);
  } else {
    result = renameAdvancedNavigation(value, other);
  }
  return finalPolish(result.text, result.other);
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
