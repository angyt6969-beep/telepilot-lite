import { recentAddlistImport } from "./addlist-reconciliation.js";

function adjustImportText(chatId, text) {
  const value = String(text || "");
  if (!value.startsWith("✅ Destination import complete")) return text;
  if (!recentAddlistImport(String(chatId || ""))) return text;
  const zeroAdded = /(?:^|\n)Added\s*[—-]\s*0(?:\n|$)/.test(value);
  const queued = /Auto-join queued\s*[—-]\s*[1-9]\d*/.test(value);
  if (!zeroAdded && !queued) {
    return `${value}\n\n🔄 Addlist reconciliation is running in the background. TelePilot will verify the folder against Telegram and recover any newly joined chats automatically.`;
  }
  const body = value
    .replace(/^✅ Destination import complete/, "⏳ Addlist import processing")
    .replace(/(?:^|\n)Added\s*[—-]\s*0(?=\n|$)/, "\nAdded so far — 0");
  return `${body}\n\n🔄 This shared folder is still being reconciled with Telegram. You do not need to paste it repeatedly; TelePilot will add confirmed joined chats in the background and duplicate detection remains active.`;
}

export function installAddlistImportUi(ApiClass) {
  const proto = ApiClass?.prototype;
  if (!proto || proto.__telepilotAddlistImportUiInstalled) return;
  const originalSendMessage = proto.sendMessage;
  const originalEditMessageText = proto.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for Addlist import UI");
  }
  Object.defineProperty(proto, "__telepilotAddlistImportUiInstalled", { value: true });
  proto.sendMessage = function(chatId, text, other, ...rest) {
    return originalSendMessage.call(this, chatId, adjustImportText(chatId, text), other, ...rest);
  };
  proto.editMessageText = function(chatId, messageId, text, other, ...rest) {
    return originalEditMessageText.call(this, chatId, messageId, adjustImportText(chatId, text), other, ...rest);
  };
}
