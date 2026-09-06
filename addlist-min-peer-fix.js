import { Api, TelegramClient } from "teleproto";

// Telegram's chatlists.checkChatlistInvite may return minimal Channel objects.
// teleproto intentionally refuses to convert a min Channel through getInputPeer
// when checkHash=true, even when Telegram supplied the access hash. For the
// chatlist import RPC, that exact ID/access-hash pair is the peer Telegram told
// us to pass back. Handle only that narrow case and leave every other entity
// resolution path untouched.
const proto = TelegramClient?.prototype;

function isCtorInstance(value, Ctor) {
  return typeof Ctor === "function" && value instanceof Ctor;
}

if (proto && !proto.__telepilotAddlistMinPeerFixInstalled) {
  const originalGetInputEntity = proto.getInputEntity;
  if (typeof originalGetInputEntity !== "function") {
    throw new Error("Unsupported TelegramClient shape for Addlist min-peer handling");
  }

  Object.defineProperty(proto, "__telepilotAddlistMinPeerFixInstalled", { value: true });
  Object.defineProperty(proto, "__telepilotOriginalGetInputEntityBeforeAddlistMinFix", {
    value: originalGetInputEntity,
  });

  proto.getInputEntity = async function(peer, ...rest) {
    const isChannel = isCtorInstance(peer, Api.Channel) || isCtorInstance(peer, Api.Community);
    const hasAccessHash = peer?.accessHash !== undefined && peer?.accessHash !== null;

    if (isChannel && peer?.min === true && peer?.id !== undefined && hasAccessHash) {
      return new Api.InputPeerChannel({
        channelId: peer.id,
        accessHash: peer.accessHash,
      });
    }

    return originalGetInputEntity.call(this, peer, ...rest);
  };

  console.log("TelePilot Addlist min-peer resolver enabled");
}
