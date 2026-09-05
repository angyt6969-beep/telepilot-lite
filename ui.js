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
  ["admin", "🟣 Admin Panel"],
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

function displaySender(raw) {
  const value = String(raw || "").trim();
  if (!value || value === "Bot posting" || value === "@TelePilottBot") return "TelePilot Bot";
  return value;
}

function dashboardMessageLabel(raw) {
  if (!String(raw || "").startsWith("✅")) return "Not set";
  const chars = String(raw).match(/\((\d+) chars\)/)?.[1];
  return chars ? `Ready · ${chars} chars` : "Ready";
}

function transformDashboard(text, other) {
  const running = text.includes("🟢 Running");
  const senderRaw = lineValue(text, "👤 Posting as: ") || "@TelePilottBot";
  const sender = displaySender(senderRaw);
  const access = lineValue(text, "🔑 Access: ") || "Active";
  const message = lineValue(text, "📝 Message: ");
  const groupsRaw = lineValue(text, "👥 Groups: ");
  const interval = lineValue(text, "⏱ Interval: ") || "30 min";
  const next = lineValue(text, "⏳ Next post: ");
  const groups = Number.parseInt(groupsRaw, 10) || 0;
  const messageReady = message.startsWith("✅");
  const ready = messageReady && groups > 0;
  const setupComplete = 1 + (messageReady ? 1 : 0) + (groups > 0 ? 1 : 0);
  const isAdminDashboard = callbackIds(other).has("admin");

  const stateLine = running
    ? "● LIVE · Autoposting active"
    : ready
      ? "● READY · Everything is set"
      : `○ SETUP · ${setupComplete}/3 complete`;

  let focusLine;
  if (running) focusLine = `Next post  ${next || "after current cycle"}`;
  else if (!messageReady) focusLine = "Next step  →  Create your message";
  else if (!groups) focusLine = "Next step  →  Add a destination";
  else focusLine = "Ready when you are. First post sends immediately.";

  const progressLine = !running && !ready
    ? `Setup  ${setupComplete}/3  ·  Sender ✓  Message ${messageReady ? "✓" : "○"}  Destination ${groups > 0 ? "✓" : "○"}`
    : null;

  const newText = [
    "✈️ TelePilot",
    stateLine,
    "",
    `Sender  ${sender}`,
    `Message  ${dashboardMessageLabel(message)}`,
    `Destinations  ${groups}`,
    `Schedule  ${interval}`,
    progressLine ? "" : null,
    progressLine,
    "",
    focusLine,
    `Access  ${access}`,
  ].filter(value => value !== null).join("\n");

  const rows = [];
  if (running) rows.push([cb("⏹ Stop posting", "stop")]);
  else if (!messageReady) rows.push([cb("✍️ Create message", "message_change")]);
  else if (!groups) rows.push([cb("＋ Add destination", "add_group")]);
  else rows.push([cb("▶ Start posting", "start")]);

  rows.push([cb("👤 Sender", "account"), cb("📝 Message", "message")]);
  rows.push([cb("📍 Destinations", "groups"), cb("⏱ Schedule", "interval")]);
  rows.push([cb("📊 Activity", "activity"), cb("🔑 Access", "access")]);
  if (isAdminDashboard) rows.push([{ text: "🟣 Admin Panel", callback_data: "admin", style: "primary" }]);
  rows.push([cb("↻ Refresh", "home")]);

  return { text: newText, other: withKeyboard(other, rows) };
}

function transformAccess(text, other) {
  if (text.startsWith("🔐 TELEPILOT ACCESS")) {
    return {
      text: [
        "🔒 TelePilot Access",
        "",
        "Enter a valid access key to unlock TelePilot.",
        "",
        "Once redeemed, access stays linked to this Telegram profile.",
      ].join("\n"),
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
      `Plan  ${plan}`,
      expires && expires !== plan ? `Expires  ${expires}` : null,
      "",
      "TelePilot controls are unlocked.",
    ].filter(Boolean).join("\n"),
    other: withKeyboard(other, [
      [cb("Redeem another key", "redeem_key")],
      [cb("← Dashboard", "home")],
    ]),
  };
}

function transformAccount(text, other) {
  if (text.includes("✅ Connected")) {
    const match = text.match(/Connected(?: as)?\s+(@[A-Za-z0-9_]+)/);
    const sender = match?.[1] || "Personal account";
    return {
      text: [
        "👤 Sender",
        "● Personal account connected",
        "",
        `Posting as  ${sender}`,
        "",
        "Scheduled posts are sent from this Telegram account.",
      ].join("\n"),
      other: withKeyboard(other, [
        [cb("Disconnect", "account_disconnect")],
        [cb("← Dashboard", "home")],
      ]),
    };
  }

  return {
    text: [
      "👤 Sender",
      "● TelePilot Bot active",
      "",
      "Posting as  TelePilot Bot",
      "",
      "You can optionally connect a personal Telegram account to post as yourself.",
      "Bot posting remains available as the fallback sender.",
    ].join("\n"),
    other: withKeyboard(other, [
      [cb("Connect personal account", "account_phone")],
      [cb("← Dashboard", "home")],
    ]),
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
      "Finish verification on the secure TelePilot page. If 2FA is enabled, enter it there too.",
    ].join("\n"),
    other: withKeyboard(other, rows),
  };
}

function transformMessage(text, other) {
  const saved = text.includes("✅ Saved");
  const chars = text.match(/(\d+) characters/)?.[1];
  return {
    text: [
      "📝 Message",
      saved ? `● Ready${chars ? ` · ${chars} characters` : ""}` : "○ Not set",
      "",
      saved
        ? "Your formatting, links and custom emoji are preserved."
        : "Create the message TelePilot should send on every cycle.",
    ].join("\n"),
    other: withKeyboard(other, saved
      ? [[cb("Preview", "message_preview"), cb("✏️ Edit message", "message_change")], [cb("← Dashboard", "home")]]
      : [[cb("✍️ Create message", "message_change")], [cb("← Dashboard", "home")]]),
  };
}

function transformMessageEditor(text, other) {
  return {
    text: [
      "📝 Message",
      "Create your post",
      "",
      "Send the exact message you want TelePilot to publish.",
      "Formatting, links and Telegram custom emoji are preserved.",
    ].join("\n"),
    other: withKeyboard(other, [[cb("Cancel", "message")]]),
  };
}

function transformPreview(text, other) {
  return { text, other: normalizeExistingButtons(other) };
}

function transformGroups(text, other) {
  const lines = String(text).split("\n");
  const entries = lines.filter(line => /^\d+\.\s/.test(line));
  return {
    text: [
      "📍 Destinations",
      entries.length ? `● ${entries.length} saved` : "○ None saved",
      "",
      entries.length ? entries.join("\n") : "Add a group or channel to continue.",
      "",
      "TelePilot only posts to destinations you explicitly add.",
    ].join("\n"),
    other: normalizeExistingButtons(other),
  };
}

function transformAddGroup(text, other) {
  return {
    text: [
      "📍 Add destination",
      "",
      "Send a public @username or t.me link for the group or channel you want to add.",
      "",
      "For private groups, use /addhere from inside the group.",
    ].join("\n"),
    other: normalizeExistingButtons(other),
  };
}

function transformRemoveGroup(text, other) {
  return { text: String(text).replace("➖ REMOVE DESTINATION", "📍 Manage destinations"), other: normalizeExistingButtons(other) };
}

function transformInterval(text, other) {
  const current = lineValue(text, "Current: ");
  return {
    text: [
      "⏱ Schedule",
      "",
      current ? `Current interval  ${current}` : null,
      "Choose how often TelePilot should post.",
    ].filter(Boolean).join("\n"),
    other: normalizeExistingButtons(other),
  };
}

function transformActivity(text, other) {
  const lines = String(text).split("\n").slice(1).filter(Boolean);
  return {
    text: ["📊 Activity", "", ...lines].join("\n"),
    other: normalizeExistingButtons(other),
  };
}

function transformStart(text, other) {
  return { text: String(text).replace("▶️ START TELEPILOT", "▶ Ready to start"), other: normalizeExistingButtons(other) };
}

function transform(text, other) {
  const value = String(text || "");
  if (value.startsWith("✈️ TELEPILOT")) return transformDashboard(value, other);
  if (value.startsWith("🔐 TELEPILOT ACCESS") || value.startsWith("🔑 ACCESS")) return transformAccess(value, other);
  if (value.startsWith("👤 PERSONAL ACCOUNT")) return transformAccount(value, other);
  if (value.startsWith("📱 CONNECT ACCOUNT")) return transformPhonePrompt(value, other);
  if (value.startsWith("📩 LOGIN CODE REQUESTED")) return transformLoginRequested(value, other);
  if (value.startsWith("📝 AD MESSAGE")) return transformMessage(value, other);
  if (value.startsWith("✏️ SET AD MESSAGE")) return transformMessageEditor(value, other);
  if (value.startsWith("👥 GROUPS & CHANNELS")) return transformGroups(value, other);
  if (value.startsWith("➕ ADD DESTINATION")) return transformAddGroup(value, other);
  if (value.startsWith("➖ REMOVE DESTINATION")) return transformRemoveGroup(value, other);
  if (value.startsWith("⏱ INTERVAL")) return transformInterval(value, other);
  if (value.startsWith("📊 ACTIVITY")) return transformActivity(value, other);
  if (value.startsWith("▶️ START TELEPILOT")) return transformStart(value, other);
  return { text: value, other: normalizeExistingButtons(other) };
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
    const transformed = transform(text, other);
    return originalSendMessage.call(this, chatId, transformed.text, transformed.other, ...rest);
  };

  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const transformed = transform(text, other);
    return originalEditMessageText.call(this, chatId, messageId, transformed.text, transformed.other, ...rest);
  };
}
