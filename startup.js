import { Api, Bot } from "grammy";
import { TelegramClient } from "teleproto";
import { installConnectUi } from "./connect-ui.js";
import { installLegalPages } from "./legal-pages.js";
import { installEmojiIdTool } from "./emoji-id-tool.js";
import { installInteractionEnhancements } from "./interaction-enhancements.js";
import { installMediaClearControl } from "./media-clear-control.js";
import { installOnboarding } from "./onboarding.js";
import { installDestinationAutomation, startDestinationAutomationWorker } from "./destination-automation.js";
import { installDestinationDeleteControls, installDestinationDeleteUi } from "./destination-delete-ui.js";
import { installArchiveMuteQueue, startArchiveMuteWorker } from "./archive-mute-queue-v3.js";
import { installAddlistReconciliation, startAddlistReconciliationWorker } from "./addlist-reconciliation.js";
import { installAddlistJoinCompatibility } from "./addlist-join-compat.js";
import { installAddlistPeerResolution } from "./addlist-peer-resolution.js";
import { installAddlistSafety } from "./addlist-safety.js";
import { installAddlistImportUi } from "./addlist-import-ui.js";
import { installAddlistLiveStatus, installAddlistLiveProgressUi } from "./addlist-live-progress.js";
import { installForumGeneralFallback, startForumGeneralFallbackWorker } from "./forum-general-fallback.js";
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

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

installLegalPages();
installConnectUi();

installOwnerControlsBot(Bot);
installForumGeneralFallback(Bot);

installEmojiIdTool(Bot);
installInteractionEnhancements(Bot);
installProControls(Bot);
installMediaClearControl(Bot);
installV1Controls(Bot);
installV1Extras(Bot);
installDestinationDeleteControls(Bot);
installSupportCenterEarly(Bot, installSupportCenter);
installOnboarding(Bot);
installDestinationAutomation(Bot);
installUxNavigation(Bot);
installUxV13PolishNavigation(Bot);
installUxV13Navigation(Bot);

prepareV1Engine(Api, TelegramClient);
installPostingEngineEnhancements(Api, TelegramClient);
installV1Engine(Api, TelegramClient);
installPrivatePeerResolution(TelegramClient);
installArchiveMuteQueue(TelegramClient);
installAddlistReconciliation(TelegramClient);
// Peer resolution must sit inside the safety/compatibility wrappers so Telegram's
// full Chat/access-hash responses are cached before the outer layers filter them.
installAddlistPeerResolution(TelegramClient);
installAddlistSafety(TelegramClient);
installAddlistJoinCompatibility(TelegramClient);
// Keep live status outermost so it observes the final result after compatibility,
// safety and peer-resolution layers have finished processing Telegram's response.
installAddlistLiveStatus(TelegramClient);

installOwnerControlsUi(Api);
installDestinationDeleteUi(Api);
installAddlistImportUi(Api);
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
// Installed last so the status message can observe the final bot response and then
// edit that exact Telegram message as reconciliation progresses.
installAddlistLiveProgressUi(Api);

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
startDestinationAutomationWorker();
startAddlistReconciliationWorker();
startArchiveMuteWorker();
startForumGeneralFallbackWorker();
startQolV13Worker();
await import("./app.js");
