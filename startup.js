import { Api, Bot } from "grammy";
import { TelegramClient } from "teleproto";
import { installConnectUi } from "./connect-ui.js";
import { installLegalPages } from "./legal-pages.js";
import { installEmojiIdTool } from "./emoji-id-tool.js";
import { installInteractionEnhancements } from "./interaction-enhancements.js";
import { installMediaClearControl } from "./media-clear-control.js";
import { installOnboarding } from "./onboarding.js";
import { installDestinationsV2 } from "./destinations-v2.js";
import { installDestinationsV2Copy } from "./destinations-v2-copy.js";
import { installDestinationsV2InputPriority } from "./destinations-v2-input-priority.js";
import { retireLegacyDestinationState } from "./destinations-v2-migration.js";
import { installDestinationPreparationUi } from "./destination-preparation-ui.js";
import { startDestinationPreparationWorker } from "./destination-preparation-v1.js";
import { startDestinationJoinWorker } from "./destination-join-queue-v1.js";
import { startCleanupRejoinBridge } from "./destination-cleanup-rejoin-bridge.js";
import { installPrivatePeerResolution } from "./private-peer-resolution.js";
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
import {
  configureGlobalUiPolishStickers,
  installGlobalUiPolish,
} from "./global-ui-polish.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

retireLegacyDestinationState();
installLegalPages();
installConnectUi();

installOwnerControlsBot(Bot);
installEmojiIdTool(Bot);
installInteractionEnhancements(Bot);
installProControls(Bot);
installMediaClearControl(Bot);
installV1Controls(Bot);
installV1Extras(Bot);
installSupportCenterEarly(Bot, installSupportCenter);
installOnboarding(Bot);
installUxNavigation(Bot);
installUxV13PolishNavigation(Bot);
installUxV13Navigation(Bot);
// Destinations v2 remains the read-only scanner and destination data model.
installDestinationsV2(Bot);
// Bind before app.js registers its legacy message:text handler so destination
// input is captured by the scanner first.
installDestinationsV2InputPriority(Bot);
// Telegram mutations live in a separate explicit action layer. It owns only d3_*
// callbacks and never replaces the working scanner callbacks.
installDestinationPreparationUi(Bot);

prepareV1Engine(Api, TelegramClient);
installPostingEngineEnhancements(Api, TelegramClient);
installV1Engine(Api, TelegramClient);
installPrivatePeerResolution(TelegramClient);

// Install the gap-fill layer first so it is innermost. Existing page-specific
// wrappers run before it and keep full priority over pages/buttons they already polish.
installGlobalUiPolish(Api);
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
// This guard sits underneath the v1.3 transformer so old destination copy is
// replaced after v1.3 finishes transforming it.
installDestinationsV2Copy(Api);
installUxV13(Api);
installUxV12(Api);
installUiEnhancements(Api);

const profileBot = new Bot(BOT_TOKEN);

try {
  const stickers = await profileBot.api.raw.getForumTopicIconStickers();
  const palette = configurePremiumEmojiStickers(stickers);
  const deepPalette = configureDeepPremiumEmojiStickers(stickers);
  const globalPalette = configureGlobalUiPolishStickers(stickers);
  console.log(`TelePilot premium emoji palette loaded: ${palette.selected}/${palette.available} preferred icons available; deep UI ${deepPalette.enabled ? "enabled" : "disabled"}; global gap-fill ${globalPalette.enabled ? "enabled" : "disabled"}`);
} catch (err) {
  console.warn("Could not load Telegram premium emoji palette; using standard emoji UI:", err?.message || err);
}

const description = [
  "✈️ TelePilot",
  "",
  "Schedule Telegram posts from one clean control panel. Connect personal accounts, organize destinations, choose forum topics and go live.",
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
startQolV13Worker();
startDestinationJoinWorker();
startCleanupRejoinBridge();
startDestinationPreparationWorker();
await import("./app.js");