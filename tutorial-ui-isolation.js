import { Api } from "grammy";

export const TUTORIAL_GET_KEY_EMOJI_ID = "5307843983102204243";
const TUTORIAL_PLANE_EMOJI_ID = "5231361378748472914";
const TUTORIAL_CHECK_EMOJI_ID = "5206607081334906820";
const TUTORIAL_ACTION_EMOJI_ID = "5411590687663608498";
const SUPPORT_USERNAME = String(process.env.TELEPILOT_SUPPORT_USERNAME || "noahxrp").replace(/^@+/, "");

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

function tutorialSlide(text) {
  const match = String(text || "").match(/Slide\s+([1-5])\s+of\s+5/i);
  return match ? Number(match[1]) : 0;
}

function heading(title, slide) {
  return [
    `<tg-emoji emoji-id="${TUTORIAL_PLANE_EMOJI_ID}">✈️</tg-emoji> <b><i>${title}</i></b>`,
    `<i>Slide ${slide} of 5</i>`,
  ];
}

function accessIsActive(text) {
  return /<b>Access:<\/b>\s*—\s*Active/i.test(String(text || ""))
    || /\bAccess:\s*—\s*Active\b/i.test(String(text || ""));
}

function compactTutorialText(text, slide) {
  const active = accessIsActive(text);
  let body;

  if (slide === 1) {
    body = [
      ...heading("Welcome to TelePilot", slide),
      "",
      "✨ <b>TelePilot:</b> — Automated Telegram posting from one dashboard.",
      "",
      "🧩 <b>Setup:</b> — Choose your sender, destinations, message and timing.",
      "",
      "🛡 <b>Control:</b> — Preview your setup and review destination issues before going live.",
      "",
      "<i>Five quick slides. Nothing changes until you configure the dashboard.</i>",
    ];
  } else if (slide === 2) {
    body = [
      ...heading("Choose your sender", slide),
      "",
      "👤 <b>Personal account:</b> — Post as your Telegram account.",
      "",
      "🤖 <b>TelePilot Bot:</b> — Post as the bot where it has permission.",
      "",
      "🔐 <b>Connection:</b> — Personal account login uses TelePilot's protected flow.",
      "",
      "<i>You can change the sender later in Accounts.</i>",
    ];
  } else if (slide === 3) {
    body = [
      ...heading("Add destinations", slide),
      "",
      "📍 <b>Destinations:</b> — Add groups and channels.",
      "",
      "🗂 <b>Addlists:</b> — Import supported Telegram shared folders.",
      "",
      "💬 <b>Topics:</b> — Choose the exact forum topic when required.",
      "",
      "<i>Destination Health shows access and routing issues.</i>",
    ];
  } else if (slide === 4) {
    body = [
      ...heading("Build your post", slide),
      "",
      "📝 <b>Normal Post:</b> — Create a message or media post.",
      "",
      "↪️ <b>Forwarded Post:</b> — Forward a real Telegram message.",
      "",
      "⏱ <b>Timing:</b> — Use a repeat interval or exact-time schedule.",
      "",
      "👀 <b>Smart Preview:</b> — Review everything before going live.",
    ];
  } else {
    body = [
      ...heading("You're ready", slide),
      "",
      "✅ <b>Tutorial:</b> — Complete",
      active ? "🟢 <b>Access:</b> — Active" : "🔑 <b>Access:</b> — Key required",
      "",
      "<b><i>Setup flow</i></b>",
      "",
      "<b>Sender:</b> — Who posts",
      "<b>Destinations:</b> — Where it posts",
      "<b>Message:</b> — What gets posted",
      "<b>Timing:</b> — When it posts",
      "",
      active
        ? "<i>Open Dashboard to start building your setup.</i>"
        : `<i>Redeem a key to continue. Need one? Message @${SUPPORT_USERNAME}.</i>`,
    ];
  }

  return body.join("\n");
}

function isFinalDashboardButton(button) {
  return String(button?.style || "") === "success"
    || String(button?.icon_custom_emoji_id || "") === TUTORIAL_CHECK_EMOJI_ID;
}

function normalizeTutorialRows(text, next, slide) {
  const rows = [];
  for (const row of next.reply_markup.inline_keyboard) {
    const fixed = [];
    for (const source of row) {
      const button = { ...source };
      const data = String(button.callback_data || "");
      const label = String(button.text || "");

      // v1.3's generic back router rewrites tutorial Back and Open Dashboard
      // to the same Dashboard callback. Restore each one by its original style/icon.
      if (data === "v1_dashboard_v13" && slide === 5 && isFinalDashboardButton(button)) {
        button.text = "Open Dashboard";
        button.callback_data = "linear_onboarding_complete";
        button.icon_custom_emoji_id = TUTORIAL_CHECK_EMOJI_ID;
        button.style = "success";
      } else if (data === "v1_dashboard_v13" && slide > 1) {
        button.text = "Back";
        button.callback_data = `linear_tutorial:${slide - 1}`;
        button.icon_custom_emoji_id ||= TUTORIAL_ACTION_EMOJI_ID;
        if (button.style === "success") delete button.style;
      } else if ((data === "v1_dashboard_v13" || data === "home" || /dashboard/i.test(label)) && slide < 5) {
        continue;
      }

      if (slide === 5 && /^Get a Key$/i.test(String(button.text || ""))) {
        button.icon_custom_emoji_id = TUTORIAL_GET_KEY_EMOJI_ID;
      }
      fixed.push(button);
    }
    if (fixed.length) rows.push(fixed);
  }

  // Active users should see exactly one compact final row: Back + Open Dashboard.
  if (slide === 5 && accessIsActive(text)) {
    const flat = rows.flat();
    const back = flat.find(button => button.callback_data === "linear_tutorial:4");
    const dashboard = flat.find(button => button.callback_data === "linear_onboarding_complete");
    if (back && dashboard) return [[back, dashboard]];
  }
  return rows;
}

export function isolateTutorialPayload(text, other) {
  const slide = tutorialSlide(text);
  if (!slide || !other?.reply_markup?.inline_keyboard) return { text, other };

  const next = cloneOther(other);
  next.reply_markup.inline_keyboard = normalizeTutorialRows(text, next, slide);
  return { text: compactTutorialText(text, slide), other: next };
}

export function installTutorialUiIsolation(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotTutorialUiIsolationInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for tutorial UI isolation");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotTutorialUiIsolationInstalled", { value: true });

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = isolateTutorialPayload(text, other);
    return originalSendMessage.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = isolateTutorialPayload(text, other);
    return originalEditMessageText.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
  return true;
}

installTutorialUiIsolation(Api);
