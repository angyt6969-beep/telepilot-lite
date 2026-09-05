import { InlineKeyboard } from "grammy";
import { readAppSettings } from "./posting-engine-enhancements.js";
import { queuePreview, readV1 } from "./v1-engine.js";

function uidOf(ctx) { return ctx?.from?.id ? String(ctx.from.id) : ""; }
function destinationId(group) { return String(group?.id || group?.username || ""); }

function senderLabel(settings) {
  return settings.personalUsername ? `@${settings.personalUsername}` : "TelePilot Bot";
}

function formatWhen(ms) {
  if (!Number(ms || 0)) return "—";
  return new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

async function showSmartPreview(ctx) {
  const uid = uidOf(ctx);
  const settings = readAppSettings(uid);
  const pro = readV1(uid);
  const disabled = new Set((pro.disabledDestinationIds || []).map(String));
  const disabledFolders = new Set((pro.disabledFolders || []).map(String));
  const active = (settings.groups || []).filter(group => {
    const id = destinationId(group);
    if (disabled.has(id)) return false;
    const folder = String(pro.destinationFolders?.[id] || "");
    return !folder || !disabledFolders.has(folder);
  }).length;
  const next = queuePreview(uid)[0];
  const rotation = pro.rotation.mode === "cycle" ? "Cycle templates" : pro.rotation.mode === "random" ? "Random template" : "Off";
  const messageText = String(settings.adMessage || "").replace(/\s+/g, " ").trim();
  const messagePreview = messageText ? `${messageText.slice(0, 220)}${messageText.length > 220 ? "…" : ""}` : "Not set";
  const kb = new InlineKeyboard();
  if (settings.adMessage && active > 0) kb.text("▶ Start posting", "start").row();
  if (settings.adMessage) kb.text("Open message preview", "message_preview").row();
  kb.text("🧭 Posting queue", "v1_queue").text("⚡ Power Tools", "v1_tools").row().text("⬅️ Dashboard", "home");
  await ctx.editMessageText([
    "👁 Smart preview",
    `Sender — ${senderLabel(settings)}`,
    `Message — ${settings.adMessage ? `${settings.adMessage.length} chars${pro.media ? ` + ${pro.media.kind}` : ""}` : "Not set"}`,
    `Destinations — ${active} active / ${(settings.groups || []).length} saved`,
    `Interval — ${Number(settings.intervalMinutes || 30)} min`,
    `Rotation — ${rotation}`,
    `Posting window — ${pro.schedule?.enabled ? `${pro.schedule.start}–${pro.schedule.end}` : "24/7"}`,
    `Next exact job — ${next ? formatWhen(next.runAt) : "None"}`,
    "",
    "Message preview:",
    messagePreview,
    "",
    settings.adMessage && active > 0 ? "Everything required to start interval posting is ready." : "Finish the missing Message/Destination setup before starting.",
  ].join("\n"), { reply_markup: kb });
}

function registerHandlers(bot) {
  bot.callbackQuery("v1_preview", async ctx => {
    await ctx.answerCallbackQuery();
    await showSmartPreview(ctx);
  });
}

export function installV1Extras(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotV1ExtrasInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for TelePilot v1 extras");
  Object.defineProperty(BotClass.prototype, "__telepilotV1ExtrasInstalled", { value: true });
  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotV1ExtrasHandlersRegistered) {
      Object.defineProperty(this, "__telepilotV1ExtrasHandlersRegistered", { value: true });
      registerHandlers(this);
    }
    return originalStart.apply(this, args);
  };
}
