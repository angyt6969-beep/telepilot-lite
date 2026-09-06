import { TelegramClient } from "teleproto";

const chatCacheByClient = new WeakMap();

function idDigits(value) {
  const raw = value?.channelId ?? value?.chatId ?? value?.userId ?? value?.id ?? value ?? "";
  try { return String(raw?.toString?.() ?? raw).replace(/\D/g, ""); }
  catch { return String(raw || "").replace(/\D/g, ""); }
}

function cacheChats(client, chats) {
  if (!client || !Array.isArray(chats) || !chats.length) return;
  let cache = chatCacheByClient.get(client);
  if (!cache) {
    cache = new Map();
    chatCacheByClient.set(client, cache);
  }
  for (const chat of chats) {
    const key = idDigits(chat?.id);
    if (key) cache.set(key, chat);
  }
}

export function installAddlistPeerResolution(TelegramClientClass = TelegramClient) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotAddlistPeerResolutionInstalled) return;
  const originalInvoke = proto.invoke;
  const originalGetInputEntity = proto.getInputEntity;
  if (typeof originalInvoke !== "function" || typeof originalGetInputEntity !== "function") {
    throw new Error("Unsupported TelegramClient shape for Addlist peer resolution");
  }

  Object.defineProperty(proto, "__telepilotAddlistPeerResolutionInstalled", { value: true });

  proto.invoke = async function(request, ...rest) {
    const result = await originalInvoke.call(this, request, ...rest);
    // checkChatlistInvite/getChatlistUpdates return full Chat objects containing
    // the access hashes needed to turn lightweight PeerChannel references into
    // valid InputPeer values. Cache any returned chats for the same client.
    cacheChats(this, result?.chats);
    return result;
  };

  proto.getInputEntity = async function(entityLike, ...rest) {
    try {
      return await originalGetInputEntity.call(this, entityLike, ...rest);
    } catch (originalError) {
      const key = idDigits(entityLike);
      if (!key) throw originalError;
      const cachedChat = chatCacheByClient.get(this)?.get(key);
      if (!cachedChat) throw originalError;
      try {
        return await originalGetInputEntity.call(this, cachedChat, ...rest);
      } catch {
        throw originalError;
      }
    }
  };
}
