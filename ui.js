const CALLBACK_LABELS = new Map([
  ["home", "← Dashboard"],
  ["account", "👤 Sender"],
  ["account_phone", "Connect personal account"],
  ["account_disconnect", "Disconnect"],
  ["account_cancel_login", "Cancel login"],
  ["message", "📝 Message"],
  ["message_change", "✏️ Edit message"],
  ["message_preview", "Preview"],
  ["groups", "📍 Destinations"],
  ["add_group", "＋ Add destination"],
  ["remove_group_menu", "Manage"],
  ["clear_groups", "Clear all"],
  ["clear_groups_confirm", "Clear all"],
  ["interval", "⏱ Schedule"],
  ["start", "▶ Start posting"],
  ["start_confirm", "▶ Go live"],
  ["stop", "⏹ Stop posting"],
  ["activity", "📊 Activity"],
  ["access", "🔑 Access"],
  ["redeem_key", "Redeem key"],
]);

function cb(text, callback_data) { return { text, callback_data }; }
function cloneMarkup(markup) {
  if (!markup?.inline_keyboard) return markup;
  return {
    ...markup,
    inline_keyboard: markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
  };
}
function withKeyboard(other, rows) {
  return { ...(other || {}), reply_markup: { inline_keyboard: rows } };
}
function lineValue(text, prefix) {
  const line = String(text).split("\n").find(value => value.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}
function callbackIds(other) {
  return new Set((other?.reply_markup?.inline_keyboard || []).flat().map(b => b.callback_data).filter(Boolean));
}
function firstUrl(other) {
  return (other?.reply_markup?.inline_keyboard || []).flat().find(b => b.url)?.url || "";
}
function normalizeExistingButtons(other) {
  const markup = cloneMarkup(other?.reply_markup);
  if (!markup?.inline_keyboard) return other;
  for (const row of markup.inline_keyboard) {
    for (const button of row) {
      if (button.callback_data && CALLBACK_LABELS.has(button.callback_data)) {
        button.text = CALLBACK_LABELS.get(button.callback_data);
      }
    }
  }
  return { ...(other || {}), reply_markup: markup };
}

function transformDashboard(text, other) {
  const running = text.includes("🟢 Running");
  const sender = lineValue(text, "👤 Posting as: ") || "@TelePilottBot";
  const access = lineValue(text, "🔑 Access: ") || "Active";
  const message = lineValue(text, "📝 Message: ");
  const groupsRaw = lineValue(text, "👥 Groups: ");
  const interval = lineValue(text, "⏱ Interval: ") || "30 min";
  const next = lineValue(text, "⏳ Next post: ");
  const groups = Number.parseInt(groupsRaw, 10) || 0;
  const messageReady = message.startsWith("✅");
  const ready = messageReady && groups > 0;

  const stateLine = running
    ? "● LIVE · Autoposting"
    : ready
      ? "● READY · Everything is set"
      : "○ SETUP · Finish the last step";

  const messageLabel = messageReady
    ? (message.match(/\((\d+) chars\)/)?.[1] ? `Ready · ${message.match(/\((\d+) chars\)/)[1]} chars` : "Ready")
    : "Not set";

  let footer;
  if (running) footer = `Next post  ${next || "after this cycle"}`;
  else if (!messageReady) footer = "Next step  →  Create your message";
  else if (!groups) footer = "Next step  →  Add a destination";
  else footer = "Ready when you are. First post sends immediately.";

  const newText = [
    "✈️ TelePilot",
    stateLine,
    "",
    `Sender  ${sender}`,
    `Message  ${messageLabel}`,
    `Destinations  ${groups}`,
    `Schedule  ${interval}`,
    "",
    footer,
    `Access  ${access}`,
  ].join("\n");

  const rows = [];
  if (running) rows.push([cb("⏹ Stop posting", "stop")]);
  else if (!messageReady) rows.push([cb("✍️ Create message", "message_change")]);
  else if (!groups) rows.push([cb("＋ Add destination", "add_group")]);
  else rows.push([cb("▶ Start posting", "start")]);
  rows.push([cb("👤 Sender", "account"), cb("📝 Message", "message")]);
  rows.push([cb("📍 Destinations", "groups"), cb("⏱ Schedule", "interval")]);
  rows.push([cb("📊 Activity", "activity"), cb("🔑 Access", "access")]);
  rows.push([cb("↻ Refresh", "home")]);
  return { text: newText, other: withKeyboard(other, rows) };
}

function transformAccess(text, other) {
  if (text.startsWith("🔐 TELEPILOT ACCESS")) {
    return {
      text: "🔒 TelePilot Access\n\nA valid access key is required to unlock posting and account controls.\n\nPaste your key once and this device/account stays linked to your TelePilot profile.",
      other: withKeyboard(other, [[cb("Redeem access key", "redeem_key")]]),
    };
  }
  const plan = lineValue(text, "Plan: ") || "Active";
  const expires = lineValue(text, "Expires: ");
  return {
    text: [
      "🔑 Access",
      "● Active",
      "",
      plan,
      expires && expires !== plan ? `Expires  ${expires}` : null,
      "",
      "Your TelePilot features are unlocked.",
    ].filter(Boolean).join("\n"),
    other: withKeyboard(other, [[cb("Redeem another key", "redeem_key")], [cb("← Dashboard", "home")]]),
  };
}

function transformAccount(text, other) {
  if (text.includes("✅ Connected")) {
    const match = text.match(/Connected(?: as)?\s+(@[A-Za-z0-9_]+)/);
    const sender = match?.[1] || "Personal account";
    return {
      text: [
        "👤 Sender",
        "● Connected",
        "",
        sender,
        "",
        "Scheduled posts are sent from this personal Telegram account.",
      ].join("\n"),
      other: withKeyboard(other, [[cb("Disconnect", "account_disconnect")], [cb("← Dashboard", "home")]]),
    };
  }
  return {
    text: [
      "👤 Sender",
      "○ Personal account not connected",
      "",
      "Connect your Telegram account to send scheduled posts as yourself instead of the TelePilot bot.",
      "",
      "Your login code and 2FA stay on the secure connection page.",
    ].join("\n"),
    other: withKeyboard(other, [[cb("Connect personal account", "account_phone")], [cb("← Dashboard", "home")]]),
  };
}

function transformPhonePrompt(text, other) {
  return {
    text: [
      "👤 Connect account",
      "Step 1 of 2 · Phone number",
      "",
      "Send the phone number attached to the Telegram account you want to use.",
      "",
      "Include the country code, for example +37120000000.",
    ].join("\n"),
    other: withKeyboard(other, [[cb("Cancel", "account")]]),
  };
}

function transformLoginRequested(text, other) {
  const url = firstUrl(other);
  const appDelivery = text.includes("in-app delivery");
  const rows = [];
  if (url) rows.push([{ text: "Continue securely", url }]);
  rows.push([cb("Cancel login", "account_cancel_login")], [cb("← Sender", "account")]);
  return {
    text: [
      "👤 Connect account",
      "Step 2 of 2 · Verify",
      "",
      appDelivery ? "Telegram sent the login code to your Telegram app." : "Telegram requested a login code.",
      "",
      "Open the secure page to finish verification. If 2FA is enabled, it will ask for your password there too.",
    ].join("\n"),
    other: withKeyboard(other, rows),
  };
}

function transformMessage(text, other) {
  const saved = text.includes("✅ Saved");
  const chars = text.match(/(\d+) characters/)?.[1];
  const rows = saved
    ? [[cb("Preview", "message_preview"), cb("✏️ Edit message", "message_change")], [cb("← Dashboard", "home")]]
    : [[cb("✍️ Create message", "message_change")], [cb("← Dashboard", "home")]];
  return {
    text: [
      "📝 Message",
      saved ? `● Ready${chars ? ` · ${chars} characters` : ""}` : "○ Not set",
      "",
      saved ? "Formatting, links and custom emoji are preserved exactly as sent." : "Create the message TelePilot should send on every cycle.",
    ].join("\n"),
    other: withKeyboard(other, rows),
  };
}

function transformMessageEditor(text, other) {
  return {
    text: [
      "📝 Message",
      "Send the exact message you want TelePilot to post.",
      "",
      "Formatting, links and Telegram emoji are preserved.",
    ].join("\n"),
    other: withKeyboard(other, [[cb("Cancel", "message")]]),
  };
}

function transformGroups(text, other) {
  const sections = text.split("\n\n");
  const list = sections[1] || "No destinations added.";
  const none = /No destinations added/i.test(list);
  const count = none ? 0 : list.split("\n").filter(line => /^\d+\./.test(line.trim())).length;
  const rows = count
    ? [[cb("＋ Add destination", "add_group"), cb("Manage", "remove_group_menu")], [cb("Clear all", "clear_groups")], [cb("← Dashboard", "home")]]
    : [[cb("＋ Add destination", "add_group")], [cb("← Dashboard", "home")]];
  return {
    text: [
      `📍 Destinations${count ? ` · ${count}` : ""}`,
      "",
      none ? "No destinations yet." : list,
      "",
      none
        ? "Add a group or channel you manage."
        : "TelePilot will post to every destination in this list.",
      "",
      "Private group? Use /addhere inside the group while you are an admin.",
    ].join("\n"),
    other: withKeyboard(other, rows),
  };
}

function transformAddDestination(text, other) {
  return {
    text: [
      "📍 Add destination",
      "",
      "1 · Add @TelePilottBot as an admin",
      "2 · Allow posting in channels",
      "3 · Send the public @username or t.me link here",
      "",
      "Private group? Run /addhere inside that group instead.",
    ].join("\n"),
    other: withKeyboard(other, [[cb("Cancel", "groups")]]),
  };
}

function transformSchedule(text, other) {
  const current = lineValue(text, "Current: ") || "30 min";
  const selected = current.endsWith(" min") ? `${current.replace(" min", "")}m` : current;
  const markup = cloneMarkup(other?.reply_markup);
  if (markup?.inline_keyboard) {
    for (const row of markup.inline_keyboard) {
      for (const button of row) {
        if (button.callback_data?.startsWith("i") && button.text === selected) button.text = `✓ ${button.text}`;
        if (button.callback_data === "home") button.text = "← Dashboard";
      }
    }
  }
  return {
    text: [
      "⏱ Schedule",
      `Every ${current}`,
      "",
      "Choose how often TelePilot should repeat your message.",
    ].join("\n"),
    other: { ...(other || {}), reply_markup: markup },
  };
}

function transformActivity(text, other) {
  const status = lineValue(text, "Status: ");
  const sender = lineValue(text, "Posting as: ");
  const total = lineValue(text, "Total successful posts: ");
  const last = lineValue(text, "Last cycle: ");
  const result = lineValue(text, "Last result: ");
  const next = lineValue(text, "Next cycle: ");
  const running = status.includes("Running");
  return {
    text: [
      "📊 Activity",
      running ? "● LIVE" : "○ Idle",
      "",
      `Last run  ${last || "Never"}`,
      `Result  ${result || "No runs yet"}`,
      `Total sent  ${total || "0"}`,
      running ? `Next run  ${next || "—"}` : null,
      "",
      `Sender  ${sender || "@TelePilottBot"}`,
    ].filter(Boolean).join("\n"),
    other: withKeyboard(other, [[cb("↻ Refresh", "activity")], [cb("← Dashboard", "home")]]),
  };
}

function transformStart(text, other) {
  const sender = lineValue(text, "Posting as: ");
  const destinations = lineValue(text, "Destinations: ");
  const interval = lineValue(text, "Interval: ");
  return {
    text: [
      "🚀 Ready to launch",
      "",
      `Sender  ${sender}`,
      `Destinations  ${destinations}`,
      `Schedule  ${interval}`,
      "",
      "The first post sends immediately. Repeats begin after your selected interval.",
    ].join("\n"),
    other: withKeyboard(other, [[cb("▶ Go live", "start_confirm")], [cb("← Dashboard", "home")]]),
  };
}

function transformRemoveDestination(text, other) {
  return {
    text: text.replace("➖ REMOVE DESTINATION", "📍 Manage destinations").replace("Choose a destination to remove:", "Choose one to remove:"),
    other: normalizeExistingButtons(other),
  };
}

function transformClearDestinations(text, other) {
  return {
    text: text.replace("🗑 CLEAR DESTINATIONS", "Clear destinations").replace("Remove all", "Remove all"),
    other: withKeyboard(other, [[cb("Clear all", "clear_groups_confirm")], [cb("Cancel", "groups")]]),
  };
}

function transformPreviewButtons(text, other) {
  const ids = callbackIds(other);
  if (ids.has("message_change") && ids.has("message")) {
    return { text, other: withKeyboard(other, [[cb("✏️ Edit message", "message_change")], [cb("← Message", "message")]]) };
  }
  return { text, other: normalizeExistingButtons(other) };
}

export function transformUi(text, other) {
  const value = String(text ?? "");
  if (value.startsWith("✈️ TELEPILOT")) return transformDashboard(value, other);
  if (value.startsWith("🔑 ACCESS") || value.startsWith("🔐 TELEPILOT ACCESS")) return transformAccess(value, other);
  if (value.startsWith("👤 PERSONAL ACCOUNT")) return transformAccount(value, other);
  if (value.startsWith("📱 CONNECT ACCOUNT")) return transformPhonePrompt(value, other);
  if (value.startsWith("📩 LOGIN CODE REQUESTED")) return transformLoginRequested(value, other);
  if (value.startsWith("📝 AD MESSAGE")) return transformMessage(value, other);
  if (value.startsWith("✏️ SET AD MESSAGE")) return transformMessageEditor(value, other);
  if (value.startsWith("👥 GROUPS & CHANNELS")) return transformGroups(value, other);
  if (value.startsWith("➕ ADD DESTINATION")) return transformAddDestination(value, other);
  if (value.startsWith("⏱ INTERVAL")) return transformSchedule(value, other);
  if (value.startsWith("📊 ACTIVITY")) return transformActivity(value, other);
  if (value.startsWith("▶️ START TELEPILOT")) return transformStart(value, other);
  if (value.startsWith("➖ REMOVE DESTINATION")) return transformRemoveDestination(value, other);
  if (value.startsWith("🗑 CLEAR DESTINATIONS")) return transformClearDestinations(value, other);
  return transformPreviewButtons(value, other);
}

export function installUiEnhancements(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotUiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for TelePilot UI enhancements");
  }

  Object.defineProperty(ApiClass.prototype, "__telepilotUiInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const transformed = transformUi(text, other);
    return originalSendMessage.call(this, chatId, transformed.text, transformed.other, ...rest);
  };

  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const transformed = transformUi(text, other);
    return originalEditMessageText.call(this, chatId, messageId, transformed.text, transformed.other, ...rest);
  };
}
