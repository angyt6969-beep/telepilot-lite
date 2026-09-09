function peerDigits(value) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) return "";
  return text.replace(/^-100/, "").replace(/^-/, "").replace(/\D/g, "");
}

function dialogMatches(dialog, targetDigits) {
  if (!targetDigits) return false;
  const values = [
    dialog?.id,
    dialog?.entity?.id,
    dialog?.inputEntity?.channelId,
    dialog?.inputEntity?.chatId,
    dialog?.inputEntity?.userId,
  ];
  return values.some(value => peerDigits(value) === targetDigits);
}

export function installPrivatePeerResolution(TelegramClientClass) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotPrivatePeerResolutionInstalled) return;
  const originalGetEntity = proto.getEntity;
  const originalGetDialogs = proto.getDialogs;
  if (typeof originalGetEntity !== "function") throw new Error("Unsupported TelegramClient shape for private peer resolution");

  Object.defineProperty(proto, "__telepilotPrivatePeerResolutionInstalled", { value: true });

  // Destinations v2's forum-topic picker historically falls back to a 500-dialog
  // scan when a saved @username cannot be resolved. Imported/private forum groups
  // can legitimately sit beyond that window, which produced the misleading
  // "Open or join this group" error even for joined groups. Expand only that
  // exact legacy lookup size; preserve every other getDialogs call unchanged.
  if (typeof originalGetDialogs === "function" && !proto.__telepilotTopicDialogWindowFixInstalled) {
    Object.defineProperty(proto, "__telepilotTopicDialogWindowFixInstalled", { value: true });
    proto.getDialogs = async function(params = {}, ...rest) {
      if (params && typeof params === "object" && Number(params.limit) === 500) {
        return originalGetDialogs.call(this, { ...params, limit: 1000 }, ...rest);
      }
      return originalGetDialogs.call(this, params, ...rest);
    };
  }

  proto.getEntity = async function(entityLike, ...rest) {
    try {
      return await originalGetEntity.call(this, entityLike, ...rest);
    } catch (originalError) {
      const targetDigits = peerDigits(entityLike);
      if (!targetDigits || this.__telepilotResolvingPrivatePeer === true) throw originalError;
      this.__telepilotResolvingPrivatePeer = true;
      try {
        const dialogs = await this.getDialogs({ limit: 1000 });
        const dialog = dialogs.find(item => dialogMatches(item, targetDigits));
        if (!dialog) throw originalError;
        const entity = dialog.entity || dialog.inputEntity || dialog;
        if (!entity) throw originalError;
        return entity;
      } catch (fallbackError) {
        if (fallbackError === originalError) throw originalError;
        throw originalError;
      } finally {
        this.__telepilotResolvingPrivatePeer = false;
      }
    }
  };
}
