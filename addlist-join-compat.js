import { Api, TelegramClient } from "teleproto";

function requestClassName(request) {
  return String(request?.className || request?.constructor?.className || "");
}
function peerKey(peer) {
  const raw = peer?.channelId ?? peer?.chatId ?? peer?.userId ?? peer?.id ?? "";
  try { return String(raw?.toString?.() ?? raw).replace(/\D/g, ""); }
  catch { return String(raw || "").replace(/\D/g, ""); }
}
function telegramErrorCode(err) {
  return String(err?.errorMessage || err?.description || err?.message || err || "").toUpperCase();
}

export function installAddlistJoinCompatibility(TelegramClientClass = TelegramClient) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotAddlistJoinCompatibilityInstalled) return;
  const originalInvoke = proto.invoke;
  if (typeof originalInvoke !== "function") throw new Error("Unsupported TelegramClient shape for Addlist compatibility");

  Object.defineProperty(proto, "__telepilotAddlistJoinCompatibilityInstalled", { value: true });
  proto.invoke = async function(request, ...rest) {
    if (requestClassName(request) !== "chatlists.JoinChatlistUpdates") {
      return originalInvoke.call(this, request, ...rest);
    }

    const chatlist = request?.chatlist;
    if (!chatlist) return originalInvoke.call(this, request, ...rest);

    // Telegram requires JoinChatlistUpdates peers to come from GetChatlistUpdates.
    // checkChatlistInvite.missingPeers is not a valid source for this method.
    const updates = await originalInvoke.call(
      this,
      new Api.chatlists.GetChatlistUpdates({ chatlist }),
    );
    const missingPeers = Array.isArray(updates?.missingPeers) ? updates.missingPeers : [];
    if (!missingPeers.length) return null;

    const missingIds = new Set(missingPeers.map(peerKey).filter(Boolean));
    let peers = (Array.isArray(request?.peers) ? request.peers : []).filter(peer => missingIds.has(peerKey(peer)));

    // If the caller's stale peer list does not overlap, resolve Telegram's current
    // missing peers directly from the connected account.
    if (!peers.length && typeof this.getInputEntity === "function") {
      peers = [];
      for (const peer of missingPeers) {
        try { peers.push(await this.getInputEntity(peer)); } catch {}
      }
    }
    if (!peers.length) return null;

    try {
      return await originalInvoke.call(
        this,
        new Api.chatlists.JoinChatlistUpdates({ chatlist, peers }),
        ...rest,
      );
    } catch (err) {
      // A folder created on the same connected account can legitimately have no
      // joinable include_peers. Treat that Telegram response as a no-op so the
      // importer can still reconcile the chats that are already joined.
      if (telegramErrorCode(err).includes("FILTER_INCLUDE_EMPTY")) {
        console.log("Addlist update contained no joinable peers; continuing with already joined chats");
        return null;
      }
      throw err;
    }
  };
}
