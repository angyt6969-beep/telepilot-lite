import { TelegramClient } from "teleproto";

function dialogPeerDigits(value) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) return "";
  return text.replace(/^-100/, "").replace(/^-/, "").replace(/\D/g, "");
}

function dialogIdentity(dialog) {
  const values = [
    dialog?.id,
    dialog?.entity?.id,
    dialog?.inputEntity?.channelId,
    dialog?.inputEntity?.chatId,
    dialog?.inputEntity?.userId,
  ];
  for (const value of values) {
    const id = dialogPeerDigits(value);
    if (id) return id;
  }
  return "";
}

function mergeDialogs(primary, secondary) {
  const out = [];
  const seen = new Set();
  for (const dialog of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    const key = dialogIdentity(dialog) || `row:${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dialog);
  }
  return out;
}

export function installTopicPeerResolutionV2(TelegramClientClass = TelegramClient) {
  const proto = TelegramClientClass?.prototype;
  if (!proto || proto.__telepilotTopicPeerResolutionV2Installed) return false;
  const originalGetDialogs = proto.getDialogs;
  if (typeof originalGetDialogs !== "function") throw new Error("Unsupported TelegramClient shape for topic peer resolution v2");

  Object.defineProperty(proto, "__telepilotTopicPeerResolutionV2Installed", { value: true });

  proto.getDialogs = async function(params = {}, ...rest) {
    const requested = params && typeof params === "object" ? params : {};
    const limit = Number(requested.limit || 0);

    // Destinations v2 resolves saved forum groups with a 500-dialog fallback.
    // Those groups may already have been archived by TelePilot's cleanup worker,
    // so include both active and archived dialogs for that resolver. Leave every
    // unrelated getDialogs call untouched.
    if (limit !== 500) return originalGetDialogs.call(this, params, ...rest);

    const expanded = { ...requested, limit: 1000 };
    const active = await originalGetDialogs.call(this, expanded, ...rest);

    let archived = [];
    try {
      archived = await originalGetDialogs.call(this, { ...expanded, archived: true }, ...rest);
    } catch {
      // Some Telegram client builds may not expose the archived option. The
      // expanded active lookup is still strictly better than the old 500 cap.
    }

    return mergeDialogs(active, archived);
  };

  return true;
}

installTopicPeerResolutionV2(TelegramClient);
