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
      .replace(/TelePilot automatically joins supported missing groups and Addlists with the selected personal senders\.?/g, "TelePilot only checks chats your connected personal accounts already have access to.")
      .replace(/TelePilot automatically joins missing groups\.?/g, "TelePilot never joins groups for you. Join them in Telegram first, then add them here.");
  }

  if (value.startsWith("👤 Accounts")) {
    value = value.replace(
      /Connected personal accounts can join supported destinations, Addlists and request-only groups for you\. Readiness is tracked separately for each sender account\./g,
      "Connected personal accounts are used to verify access to destinations you already joined. TelePilot never joins chats from this screen.",
    );
  }

  if (value.startsWith("⚙️ Settings")) {
    value = value
      .replace(/Topic suggestions\s+[^\n]+/g, "Topic selection  Manual in Destination Hub")
      .replace(/Preferred topic words\s+[^\n]+\n?/g, "");
  }

  if (value.startsWith("📥 Add / Import Destinations") || value.startsWith("📍 Add destination") || value.startsWith("📍 Add destinations")) {
    value = [
      "＋ Add destinations",
      "",
      "Send @usernames, public links, private invite links or t.me/addlist/... shared folders.",
      "",
      "TelePilot scans access only. It never joins, mutes or archives chats.",
      "If a group is not already joined, you will be asked to join it in Telegram first.",
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
