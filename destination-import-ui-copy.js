import { Api } from "grammy";

function plain(value) {
  return String(value || "")
    .replace(/<tg-emoji\b[^>]*>/gi, "")
    .replace(/<\/tg-emoji>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}
function firstLine(value) { return plain(value).split("\n", 1)[0].replace(/^[^\p{L}\p{N}＋]+/u, "").trim(); }
function cloneOther(other) {
  const next = other && typeof other === "object" ? { ...other } : {};
  if (other?.reply_markup?.inline_keyboard) {
    next.reply_markup = {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    };
  }
  return next;
}
function transform(text, other) {
  const title = firstLine(text);
  if (!/^Add destinations$/i.test(title) && !/^Add \/ Import$/i.test(title)) return { text, other };
  const next = cloneOther(other);
  delete next.entities;
  next.parse_mode = "HTML";
  next.reply_markup = {
    ...(next.reply_markup || {}),
    inline_keyboard: [[{ text: "𝙂𝙤 𝙗𝙖𝙘𝙠", callback_data: "v1_destinations_v13" }]],
  };
  return {
    text: [
      "📥 <b><i>Add / Import</i></b>",
      "",
      "Send one or many Telegram sources — one per line.",
      "",
      "<b>Groups:</b> — <code>@groupname</code>, public links, or private invite links",
      "<b>Addlists:</b> — <code>t.me/addlist/...</code> shared folders",
      "",
      "<i>Addlists use Telegram’s native bulk folder import. Normal group lists are joined individually. Mixed messages are supported.</i>",
    ].join("\n"),
    other: next,
  };
}

export function installDestinationImportUiCopy(ApiClass = Api) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotDestinationImportUiCopyInstalled) return;
  const originalSend = ApiClass.prototype.sendMessage;
  const originalEdit = ApiClass.prototype.editMessageText;
  if (typeof originalSend !== "function" || typeof originalEdit !== "function") throw new Error("Unsupported grammY Api shape for destination import UI copy");
  Object.defineProperty(ApiClass.prototype, "__telepilotDestinationImportUiCopyInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = transform(text, other);
    return originalSend.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = transform(text, other);
    return originalEdit.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
}

export const __test = { transform };
installDestinationImportUiCopy(Api);
