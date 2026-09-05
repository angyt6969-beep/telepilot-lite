import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const awaitingEmoji = new Map();
const AWAIT_MS = 5 * 60_000;

function adminIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) {
      if (/^\d+$/.test(part)) ids.add(part);
    }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
    for (const value of Array.isArray(saved?.adminIds) ? saved.adminIds : []) {
      if (/^\d+$/.test(String(value))) ids.add(String(value));
    }
  } catch {}
  return ids;
}

function isOwner(uid) {
  return adminIds().has(String(uid));
}

function customEmojiIds(message) {
  const ids = [];
  for (const entity of [
    ...(Array.isArray(message?.entities) ? message.entities : []),
    ...(Array.isArray(message?.caption_entities) ? message.caption_entities : []),
  ]) {
    if (entity?.type === "custom_emoji" && entity.custom_emoji_id) {
      ids.push(String(entity.custom_emoji_id));
    }
  }
  if (message?.sticker?.custom_emoji_id) ids.push(String(message.sticker.custom_emoji_id));
  return [...new Set(ids)];
}

async function replyIds(bot, chatId, ids) {
  const text = ids.length === 1
    ? `✨ Custom emoji ID\n\n${ids[0]}`
    : `✨ Custom emoji IDs\n\n${ids.map((id, i) => `${i + 1}. ${id}`).join("\n")}`;
  await bot.api.sendMessage(chatId, text);
}

export function installEmojiIdTool(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotEmojiIdToolInstalled) return;
  const originalHandleUpdate = BotClass.prototype.handleUpdate;
  if (typeof originalHandleUpdate !== "function") {
    throw new Error("Unsupported grammY Bot shape for emoji ID tool");
  }

  Object.defineProperty(BotClass.prototype, "__telepilotEmojiIdToolInstalled", { value: true });

  BotClass.prototype.handleUpdate = async function(update, ...rest) {
    const message = update?.message;
    const from = message?.from;
    const chat = message?.chat;

    if (message && from && chat?.type === "private" && isOwner(from.id)) {
      const text = String(message.text || message.caption || "").trim();
      const command = /^\/emojiid(?:@\w+)?(?:\s|$)/i.test(text);
      const ids = customEmojiIds(message);

      if (command) {
        if (ids.length) {
          await replyIds(this, chat.id, ids);
        } else {
          awaitingEmoji.set(String(from.id), Date.now() + AWAIT_MS);
          await this.api.sendMessage(
            chat.id,
            "✨ Send the premium/custom emoji now. I’ll reply with its exact custom_emoji_id.\n\nThis mode expires in 5 minutes.",
          );
        }
        return;
      }

      const expiresAt = awaitingEmoji.get(String(from.id));
      if (expiresAt) {
        awaitingEmoji.delete(String(from.id));
        if (expiresAt < Date.now()) {
          await this.api.sendMessage(chat.id, "Emoji ID mode expired. Send /emojiid and try again.");
          return;
        }
        if (!ids.length) {
          await this.api.sendMessage(
            chat.id,
            "I couldn’t find a custom emoji ID in that message. Send /emojiid again, then send the premium emoji by itself.",
          );
          return;
        }
        await replyIds(this, chat.id, ids);
        return;
      }
    }

    return originalHandleUpdate.call(this, update, ...rest);
  };
}
