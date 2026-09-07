import { destinationsHomeScreen } from "./destinations-v2.js";

function keyboard(screen) {
  return { inline_keyboard: (screen?.rows || []).filter(row => Array.isArray(row) && row.length).map(row => row.map(button => ({ text: button.text, callback_data: button.callback_data }))) };
}
function cloneOther(other) {
  if (!other || typeof other !== "object") return other || {};
  const next = { ...other };
  if (other.reply_markup?.inline_keyboard) next.reply_markup = { ...other.reply_markup, inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))) };
  return next;
}
function rewriteButtons(other) {
  const next = cloneOther(other);
  for (const row of next?.reply_markup?.inline_keyboard || []) {
    for (const button of row) {
      if (["v1_topic_preferences_v13", "v1_topics_v13", "dest_topics"].includes(String(button.callback_data || ""))) {
        button.text = "💬 Destination Topics";
        button.callback_data = "d2_topics:0";
      }
      if (["groups"].includes(String(button.callback_data || ""))) button.callback_data = "v1_destinations_v13";
      if (["add_group"].includes(String(button.callback_data || ""))) button.callback_data = "d2_add";
    }
  }
  return next;
}
function rewrite(chatId, text, other) {
  const uid = String(chatId || "");
  let value = String(text || "");
  let options = rewriteButtons(other);

  if (/^\d+$/.test(uid) && (value.startsWith("📁 Destinations") || value.startsWith("📍 Destinations"))) {
    const screen = destinationsHomeScreen(uid);
    return { text: screen.text, other: { ...options, reply_markup: keyboard(screen) } };
  }

  if (value.startsWith("📍 Step 2 of 5 — Destinations")) {
    value = value
      .replace(/TelePilot automatically joins supported missing groups and Addlists with the selected personal senders\.?/g, "TelePilot scans first. On the review screen you can explicitly choose Join + prepare to join missing groups and queue mute + archive.")
      .replace(/TelePilot automatically joins missing groups\.?/g, "TelePilot scans first, then Join + prepare performs the Telegram changes only after you confirm.")
      .replace(/TelePilot only checks chats your connected personal accounts already have access to\.?/g, "TelePilot scans first. Join + prepare can then join missing groups and queue mute + archive after you confirm.")
      .replace(/TelePilot never joins groups for you\. Join them in Telegram first, then add them here\.?/g, "TelePilot only joins from the explicit Join + prepare action on the review screen.");
  }

  if (value.startsWith("👤 Accounts")) {
    value = value
      .replace(
        /Connected personal accounts can join supported destinations, Addlists and request-only groups for you\. Readiness is tracked separately for each sender account\./g,
        "Connected personal accounts verify access and are used only when you explicitly run Join + prepare from Destination Hub.",
      )
      .replace(
        /Connected personal accounts are used to verify access to destinations you already joined\. TelePilot never joins chats from this screen\./g,
        "Connected personal accounts verify access. Telegram joins only run after you explicitly choose Join + prepare in Destination Hub.",
      );
  }

  if (value.startsWith("⚙️ Settings")) {
    value = value
      .replace(/Topic suggestions\s+[^\n]+/g, "Topic selection  Manual in Destination Hub")
      .replace(/Preferred topic words\s+[^\n]+\n?/g, "");
  }

  if (
    value.startsWith("＋ Add destinations")
    || value.startsWith("📥 Add / Import Destinations")
    || value.startsWith("📍 Add destination")
    || value.startsWith("📍 Add destinations")
  ) {
    value = [
      "＋ Add destinations",
      "",
      "Send one or many Telegram sources, one per line:",
      "• @groupname",
      "• t.me/groupname",
      "• https://t.me/groupname",
      "• private t.me/+ invite links",
      "• t.me/addlist/... shared folders",
      "",
      "TelePilot scans first and changes nothing during the scan.",
      "On Review, choose ⚡ Join + prepare to join missing groups. Confirmed groups are then queued for mute + archive. Forum topics are still chosen manually.",
    ].join("\n");
    options = { ...options, reply_markup: { inline_keyboard: [[{ text: "← Destination Hub", callback_data: "v1_destinations_v13" }]] } };
  }

  return { text: value, other: options };
}

export function installDestinationsV2Copy(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotDestinationsV2CopyInstalled) return;
  Object.defineProperty(ApiClass.prototype, "__telepilotDestinationsV2CopyInstalled", { value: true });
  for (const method of ["sendMessage", "editMessageText"]) {
    const original = ApiClass.prototype[method];
    if (typeof original !== "function") continue;
    ApiClass.prototype[method] = async function(chatId, ...args) {
      if (method === "sendMessage") {
        const [text, other, ...rest] = args;
        const changed = rewrite(chatId, text, other);
        return original.call(this, chatId, changed.text, changed.other, ...rest);
      }
      const [messageId, text, other, ...rest] = args;
      const changed = rewrite(chatId, text, other);
      return original.call(this, chatId, messageId, changed.text, changed.other, ...rest);
    };
  }
}
