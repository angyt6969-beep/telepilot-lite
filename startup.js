import { Api, Bot } from "grammy";
import { TelegramClient } from "teleproto";
import { installConnectUi } from "./connect-ui.js";
import { installEmojiIdTool } from "./emoji-id-tool.js";
import { installInteractionEnhancements } from "./interaction-enhancements.js";
import { installMediaClearControl } from "./media-clear-control.js";
import { installOnboarding } from "./onboarding.js";
import { installProControls } from "./pro-controls.js";
import { installPostingEngineEnhancements } from "./posting-engine-enhancements.js";
import { installProTypography } from "./pro-typography.js";
import { installProUiEnhancements } from "./pro-ui.js";
import { installUiEnhancements } from "./ui.js";
import { installSenderAwareDestinationUi } from "./sender-destination-ui.js";
import { installV1Controls } from "./v1-controls.js";
import { prepareV1Engine, installV1Engine } from "./v1-engine.js";
import { installV1Extras } from "./v1-extras.js";
import { installV1Ui } from "./v1-ui.js";
import { startV1Worker } from "./v1-worker.js";
import {
  configurePremiumEmojiStickers,
  installPremiumEmojiEnhancements,
} from "./premium-emoji.js";
import {
  configureDeepPremiumEmojiStickers,
  installDeepPremiumEmojiEnhancements,
} from "./premium-deep-ui.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

installConnectUi();
installEmojiIdTool(Bot);
installInteractionEnhancements(Bot);
installProControls(Bot);
installMediaClearControl(Bot);
installV1Controls(Bot);
installV1Extras(Bot);
installOnboarding(Bot);
prepareV1Engine(Api, TelegramClient);
installPostingEngineEnhancements(Api, TelegramClient);
installV1Engine(Api, TelegramClient);
installDeepPremiumEmojiEnhancements(Api);
installV1Ui(Api);
installPremiumEmojiEnhancements(Api);
installProTypography(Api);
installProUiEnhancements(Api);
installSenderAwareDestinationUi(Api);
installUiEnhancements(Api);

const profileBot = new Bot(BOT_TOKEN);

try {
  const stickers = await profileBot.api.raw.getForumTopicIconStickers();
  const palette = configurePremiumEmojiStickers(stickers);
  const deepPalette = configureDeepPremiumEmojiStickers(stickers);
  const normalize = value => String(value || "").replace(/[\uFE0E\uFE0F]/g, "");
  const available = new Set(stickers.map(sticker => normalize(sticker?.emoji)).filter(Boolean));
  const targets = ["🔑", "⚙️", "👀", "👁", "🔐", "🛠️", "⚡️", "🧰"];
  const presentTargets = targets.filter(emoji => available.has(normalize(emoji)));
  console.log(`TelePilot premium emoji palette loaded: ${palette.selected}/${palette.available} preferred icons available; deep UI ${deepPalette.enabled ? "enabled" : "disabled"}`);
  console.log(`TelePilot premium target icons available: ${presentTargets.join(" ") || "none"}`);
  console.log(`TelePilot premium emoji alternatives: ${[...available].join(" ")}`);
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

startV1Worker();
await import("./app.js");