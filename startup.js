import { Api, Bot } from "grammy";
import { TelegramClient } from "teleproto";
import { installConnectUi } from "./connect-ui.js";
import { installLegalPages } from "./legal-pages.js";
import { installEmojiIdTool } from "./emoji-id-tool.js";
import { installInteractionEnhancements } from "./interaction-enhancements.js";
import { installMediaClearControl } from "./media-clear-control.js";
import { installOnboarding } from "./onboarding.js";
import { installDestinationAutomation, startDestinationAutomationWorker } from "./destination-automation.js";
import { installUxNavigation, installUxV12 } from "./ux-v12.js";
import { installUxV13Navigation, installUxV13, startQolV13Worker } from "./ux-v13.js";
import { installUxV13PolishNavigation, installUxV13Polish } from "./ux-v13-polish.js";
import { installUxV13VisualPolish } from "./ux-v13-visual-polish.js";
import { installOwnerControlsBot, installOwnerControlsUi } from "./owner-controls.js";
import { installProControls } from "./pro-controls.js";
import { installPostingEngineEnhancements } from "./posting-engine-enhancements.js";
import { installProTypography } from "./pro-typography.js";
import { installProUiEnhancements } from "./pro-ui.js";
import { installUiEnhancements } from "./ui.js";
import { installSenderAwareDestinationUi } from "./sender-destination-ui.js";
import { installSupportCenter } from "./support-center.js";
import { installSupportCenterEarly } from "./support-bootstrap.js";
import { installSupportUi } from "./support-ui.js";
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

// Install public trust pages first, then the branded connection-page transformer.
// This order lets Privacy/Terms/Support links be added after the connect UI is rendered.
installLegalPages();
installConnectUi();

// Owner controls are installed before app.js registers its handlers. This lets the
// permission gate wrap every admin callback and synchronize persisted admin membership first.
installOwnerControlsBot(Bot);

// Bot-level helpers are installed before app.js registers its handlers.
installEmojiIdTool(Bot);
installInteractionEnhancements(Bot);
installProControls(Bot);
installMediaClearControl(Bot);
installV1Controls(Bot);
installV1Extras(Bot);
// Support wraps app routes before onboarding so a previously deleted account cannot
// fall through to the new-user tutorial with stale in-memory access. The early adapter
// registers Support callbacks before grammY starts polling, so inline buttons are always answered.
installSupportCenterEarly(Bot, installSupportCenter);
installOnboarding(Bot);
installDestinationAutomation(Bot);
installUxNavigation(Bot);
installUxV13PolishNavigation(Bot);
installUxV13Navigation(Bot);

// Keep raw Telegram send methods so v1 can safely take over only scheduled sends.
prepareV1Engine(Api, TelegramClient);
installPostingEngineEnhancements(Api, TelegramClient);
installV1Engine(Api, TelegramClient);

// Owner controls are the innermost UI layer so role restrictions, the single Start/Stop
// control and explicitly selected premium button icons are enforced immediately before
// the raw Bot API request. The existing visual-polish layer still formats the v1.3 UI.
installOwnerControlsUi(Api);
installUxV13VisualPolish(Api);
installDeepPremiumEmojiEnhancements(Api);
installSupportUi(Api);
installV1Ui(Api);
installPremiumEmojiEnhancements(Api);
installProTypography(Api);
installProUiEnhancements(Api);
installSenderAwareDestinationUi(Api);
installUxV13Polish(Api);
installUxV13(Api);
installUxV12(Api);
installUiEnhancements(Api);

const profileBot = new Bot(BOT_TOKEN);

try {
  const stickers = await profileBot.api.raw.getForumTopicIconStickers();
  const palette = configurePremiumEmojiStickers(stickers);
  const deepPalette = configureDeepPremiumEmojiStickers(stickers);
  console.log(`TelePilot premium emoji palette loaded: ${palette.selected}/${palette.available} preferred icons available; deep UI ${deepPalette.enabled ? "enabled" : "disabled"}`);
} catch (err) {
  console.warn("Could not load Telegram premium emoji palette; using standard emoji UI:", err?.message || err);
}

const description = [
  "✈️ TelePilot",
  "",
  "Schedule Telegram posts from one clean control panel. Connect personal accounts, import destinations and Addlists, choose forum topics and go live.",
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
// app.js ends in an awaited long-polling bot.start(), so workers must start before import.
// Their first ticks are delayed, giving app.js time to register the runtime state hooks.
startDestinationAutomationWorker();
startQolV13Worker();
await import("./app.js");
