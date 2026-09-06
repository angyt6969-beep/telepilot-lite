import fs from "node:fs";
import path from "node:path";
import { listAccounts, senderSummary } from "./account-store.js";

const DATA_DIR = process.env.DATA_DIR || "/data";

function userIdFromChat(chatId) {
  const value = String(chatId ?? "");
  return /^\d+$/.test(value) ? value : "";
}

function senderForChat(chatId) {
  const uid = userIdFromChat(chatId);
  if (!uid) return { mode: "bot", label: "TelePilot Bot" };
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "users", uid, "settings.json"), "utf8")); } catch {}
  const label = senderSummary(settings, listAccounts(uid));
  return { mode: label === "TelePilot Bot" ? "bot" : "personal", label };
}

function destinationsListFromUi(text) {
  const lines = String(text || "").split("\n");
  const firstContent = lines.findIndex((line, index) => index > 0 && /^\d+\.\s/.test(line.trim()));
  if (firstContent < 0) return { list: "", count: 0 };
  const items = [];
  for (let i = firstContent; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!/^\d+\.\s/.test(line.trim()) && !/^…and\s/.test(line.trim())) break;
    items.push(line);
  }
  return { list: items.join("\n"), count: items.filter(line => /^\d+\.\s/.test(line.trim())).length };
}

function destinationCount(text) {
  const match = String(text || "").split("\n")[0]?.match(/·\s*(\d+)\s*$/);
  return Number(match?.[1] || 0);
}

function transformDestinations(text, sender) {
  const value = String(text || "");
  const { list, count: parsedCount } = destinationsListFromUi(value);
  const count = destinationCount(value) || parsedCount;
  if (sender.mode !== "personal") return value;

  const statusLines = value.split("\n").filter(line => /^(Ready |Cleanup |Topics |Pending )/.test(line.trim()));
  return [
    `📍 Destinations${count ? ` · ${count}` : ""}`,
    `Sender  ${sender.label}`,
    "",
    count ? list : "No destinations yet.",
    "",
    ...statusLines,
    statusLines.length ? "" : null,
    "Paste @username, t.me/..., https://t.me/..., private t.me/+ links or t.me/addlist/... folders.",
    "TelePilot joins confirmed chats with the selected personal account, queues mute + archive once, and asks you to choose a forum topic when needed.",
  ].filter(Boolean).join("\n");
}

function transformAddDestination(sender) {
  if (sender.mode === "personal") {
    return [
      "📍 Add destinations",
      `Posting as  ${sender.label}`,
      "",
      "Accepted formats:",
      "• @username",
      "• t.me/group or https://t.me/group",
      "• private t.me/+ invite links",
      "• t.me/addlist/... shared folders",
      "",
      "You can paste multiple destinations, one per line. TelePilot joins them with the selected personal account, then queues mute + archive. Forum groups require a topic choice before posting.",
    ].join("\n");
  }
  return [
    "📍 Add destination",
    "TelePilot Bot setup",
    "",
    "The automatic join importer requires a connected personal Telegram account. If you use TelePilot Bot as sender, add the bot to the destination manually and use /addhere where supported.",
  ].join("\n");
}

function transformSenderAwareText(chatId, text) {
  const value = String(text ?? "");
  const sender = senderForChat(chatId);
  if (value.startsWith("📍 Destinations")) return transformDestinations(value, sender);
  if (value.startsWith("📍 Add destination")) return transformAddDestination(sender);
  return value;
}

export function installSenderAwareDestinationUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotSenderAwareDestinationUiInstalled) return;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for sender-aware destination UI");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotSenderAwareDestinationUiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    return originalSendMessage.call(this, chatId, transformSenderAwareText(chatId, text), other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    return originalEditMessageText.call(this, chatId, messageId, transformSenderAwareText(chatId, text), other, ...rest);
  };
}
