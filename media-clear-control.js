import fs from "node:fs";
import { readAppSettings, readProSettings, writeProSettings } from "./posting-engine-enhancements.js";

export function installMediaClearControl(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotMediaClearInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for media clear control");
  Object.defineProperty(BotClass.prototype, "__telepilotMediaClearInstalled", { value: true });

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotMediaClearHandlerRegistered) {
      Object.defineProperty(this, "__telepilotMediaClearHandlerRegistered", { value: true });
      this.callbackQuery("media_clear", async ctx => {
        const uid = String(ctx.from?.id || "");
        const pro = readProSettings(uid);
        if (pro.media?.localPath) {
          try { fs.rmSync(pro.media.localPath, { force: true }); } catch {}
        }
        pro.media = null;
        writeProSettings(uid, pro);
        const settings = readAppSettings(uid);
        await ctx.answerCallbackQuery({ text: "Media removed" });
        await ctx.editMessageText(
          `📝 AD MESSAGE\n\n${settings.adMessage ? `✅ Saved • ${String(settings.adMessage).length} characters` : "❌ No message set yet."}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "✏️ Change", callback_data: "message_change" }],
                [{ text: "⬅️ Back", callback_data: "home" }],
              ],
            },
          },
        );
      });
    }
    return originalStart.apply(this, args);
  };
}
