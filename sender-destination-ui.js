import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";

function userIdFromChat(chatId) {
  const value = String(chatId ?? "");
  return /^\d+$/.test(value) ? value : "";
}

function senderForChat(chatId) {
  const uid = userIdFromChat(chatId);
  if (!uid) return { mode: "bot", label: "TelePilot Bot" };

  const dir = path.join(DATA_DIR, "users", uid);
  const sessionFile = path.join(dir, "personal-session.enc");
  let personal = false;
  try {
    personal = fs.existsSync(sessionFile) && fs.statSync(sessionFile).size > 20;
  } catch {}

  if (!personal) return { mode: "bot", label: "TelePilot Bot" };

  let username = "";
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    username = typeof settings?.personalUsername === "string" ? settings.personalUsername.trim() : "";
  } catch {}

  return {
    mode: "personal",
    label: username ? `@${username.replace(/^@/, "")}` : "Personal account",
  };
}

function destinationsListFromUi(text) {
  const lines = String(text || "").split("\n");
  const firstContent = lines.findIndex((line, index) => index > 0 && /^\d+\.\s/.test(line.trim()));
  if (firstContent < 0) return { list: "", count: 0 };

  const items = [];
  for (let i = firstContent; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!/^\d+\.\s/.test(line.trim())) break;
    items.push(line);
  }
  return { list: items.join("\n"), count: items.length };
}

function destinationCount(text) {
  const match = String(text || "").split("\n")[0]?.match(/·\s*(\d+)\s*$/);
  return Number(match?.[1] || 0);
}

function transformDestinations(text, sender) {
  const { list, count: parsedCount } = destinationsListFromUi(text);
  const count = parsedCount || destinationCount(text);
  const none = count === 0;

  if (sender.mode === "personal") {
    return [
      `📍 Destinations${count ? ` · ${count}` : ""}`,
      `Sender  ${sender.label}`,
      "",
      none ? "No destinations yet." : list,
      "",
      none
        ? "Add the first group or channel you want your personal account to post to."
        : `${sender.label} sends every posting cycle to all destinations above.`,
      "",
      "TelePilot Bot is used to link and verify destinations during setup; the scheduled posts themselves are sent from your personal account.",
      "Private group? Run /addhere inside that group while you are an admin.",
    ].join("\n");
  }

  return [
    `📍 Destinations${count ? ` · ${count}` : ""}`,
    "Sender  TelePilot Bot",
    "",
    none ? "No destinations yet." : list,
    "",
    none
      ? "Add the first group or channel for TelePilot Bot to post to."
      : "TelePilot Bot sends every posting cycle to all destinations above.",
    "",
    "The bot must stay in each destination with the permissions needed to post.",
    "Private group? Run /addhere inside that group while you are an admin.",
  ].join("\n");
}

function transformAddDestination(sender) {
  if (sender.mode === "personal") {
    return [
      "📍 Add destination",
      "Personal account setup",
      "",
      `Posting as  ${sender.label}`,
      "",
      `1 · Make sure ${sender.label} is in the group/channel and can post`,
      "2 · Add @TelePilottBot as an admin so TelePilot can link and verify it",
      "3 · Send the public @username or t.me link here",
      "",
      "Your personal account sends the scheduled posts — the bot is only used for destination setup and verification.",
      "Private group? Run /addhere inside that group instead.",
    ].join("\n");
  }

  return [
    "📍 Add destination",
    "TelePilot Bot setup",
    "",
    "Posting as  TelePilot Bot",
    "",
    "1 · Add @TelePilottBot as an admin",
    "2 · For channels, allow it to post messages",
    "3 · Send the public @username or t.me link here",
    "",
    "TelePilot Bot will send the scheduled posts to this destination.",
    "Private group? Run /addhere inside that group instead.",
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
