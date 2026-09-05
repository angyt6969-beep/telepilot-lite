import { Api, Bot } from "grammy";
import { installDashboardPolish } from "./dashboard-polish.js";
import { installUiEnhancements } from "./ui.js";
import {
  configurePremiumEmojiStickers,
  installPremiumEmojiEnhancements,
} from "./premium-emoji.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

// Wrapper order matters: dashboard polish is installed first so it receives
// the fully transformed UI payload after the premium and regular UI layers.
installDashboardPolish(Api);
installPremiumEmojiEnhancements(Api);
installUiEnhancements(Api);

const profileBot = new Bot(BOT_TOKEN);

try {
  const stickers = await profileBot.api.raw.getForumTopicIconStickers();
  const palette = configurePremiumEmojiStickers(stickers);
  console.log(`TelePilot premium emoji palette loaded: ${palette.selected}/${palette.available} preferred icons available`);
} catch (err) {
  console.warn("Could not load Telegram premium emoji palette; using standard emoji UI:", err?.message || err);
}

const description = [
  "✈️ TelePilot",
  "",
  "Schedule Telegram posts from one clean control panel. Connect your personal account, save a message, choose destinations and go live.",
  "",
  "Open the bot to get started.",
].join("\n");

const shortDescription = "Personal Telegram autoposting from one clean dashboard ✈️";

try {
  await profileBot.api.raw.setMyDescription({ description });
  await profileBot.api.raw.setMyShortDescription({ short_description: shortDescription });
  console.log("TelePilot bot description updated");
} catch (err) {
  console.error("Could not update TelePilot bot description:", err?.message || err);
}

await import("./app.js");
