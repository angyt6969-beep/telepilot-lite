import { Api, Bot } from "grammy";
import { TelegramClient } from "teleproto";
import { installConnectUi } from "./connect-ui.js";
import { installLegalPages } from "./legal-pages.js";
import { installEmojiIdTool } from "./emoji-id-tool.js";
import { installInteractionEnhancements } from "./interaction-enhancements.js";
import { installMediaClearControl } from "./media-clear-control.js";
import { installOnboarding } from "./onboarding.js";
import { installDestinationsV2, destinationsHomeScreen } from "./destinations-v2.js";
import { installDestinationHealthV3 } from "./destination-health-v3.js";
import { installDestinationMembershipV4 } from "./destination-membership-v4.js";
import { installDestinationTopicButtonRepairV4 } from "./destination-topic-button-repair-v4.js";
import { installReviewIssuesIconCleanup } from "./review-issues-icon-cleanup.js";
import { installDestinationsV2Copy } from "./destinations-v2-copy.js";
import { installDestinationsV2InputPriority } from "./destinations-v2-input-priority.js";
import { retireLegacyDestinationState } from "./destinations-v2-migration.js";
import { installDestinationPreparationUi } from "./destination-preparation-ui.js";
import { installAddlistBulkReimport } from "./destination-addlist-reimport-bulk.js";
import { installDestinationDeleteAll } from "./destination-delete-all-v1.js";
import { runDestinationPreparationTick } from "./destination-preparation-v1.js";
import { startDestinationJoinWorker } from "./destination-join-queue-v1.js";
import { startCleanupRejoinBridge } from "./destination-cleanup-rejoin-bridge.js";
import { installPrivatePeerResolution } from "./private-peer-resolution.js";
import { installTelegramRuntimeOptimizer } from "./telegram-runtime-optimizer.js";
import {
  installPostingReliabilityPre,
  installPostingReliabilityPost,
  installPostingReliabilityUi,
  retireLegacyAttentionQueues,
} from "./posting-reliability-v2.js";
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
import { installPauseResumeBot, installPauseResumeUi } from "./pause-resume-control-v1.js";
import { installForwardedPostBot, installForwardedPostSend, installForwardedPostUi } from "./forwarded-post-v1.js";
import { installForwardedPostSchedulerCompat } from "./forwarded-post-scheduler-compat.js";
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
import {
  configureUiIconSemanticsStickers,
  installUiIconSemantics,
} from "./ui-icon-semantics.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

const runtimeOptimizer = installTelegramRuntimeOptimizer(TelegramClient, {
  getMeTtlMs: 5 * 60_000,
  dialogMinGapMs: 6_000,
  connectMinGapMs: 750,
});
console.log(`TelePilot Telegram runtime optimizer enabled (identity cache ${Math.round(runtimeOptimizer.getMeTtlMs / 60_000)}m; dialog gap ${Math.round(runtimeOptimizer.dialogMinGapMs / 1000)}s; connect gap ${runtimeOptimizer.connectMinGapMs}ms)`);

installPostingReliabilityPre(TelegramClient);
const retiredAttention = retireLegacyAttentionQueues();
if (retiredAttention.unresolved || retiredAttention.routing) {
  console.log(`TelePilot retired stale destination attention queues: unresolved=${retiredAttention.unresolved}, routing=${retiredAttention.routing}, users=${retiredAttention.users}`);
}

retireLegacyDestinationState();
installLegalPages();
installConnectUi();

installOwnerControlsBot(Bot);
installEmojiIdTool(Bot);
installInteractionEnhancements(Bot);
installProControls(Bot);
installMediaClearControl(Bot);
installV1Controls(Bot);
// Capture the established Start/Stop/Home callbacks so pause and resume use the
// same validated posting loop rather than creating a second scheduler path.
installPauseResumeBot(Bot);
installV1Extras(Bot);
installSupportCenterEarly(Bot, installSupportCenter);
installOnboarding(Bot);
installUxNavigation(Bot);
installUxV13PolishNavigation(Bot);
installUxV13Navigation(Bot);
// Destinations v2 remains the read-only scanner and destination data model.
installDestinationsV2(Bot);
// Destination health v3 is installed after Destinations v2 so its Bot.start
// wrapper registers the enhanced hub/issues callbacks first at runtime.
installDestinationHealthV3(Bot, destinationsHomeScreen);
// Membership v4 is installed last among destination Bot.start wrappers so it
// registers exact d2_refresh/d5 issue handlers first at runtime. It never joins.
installDestinationMembershipV4(Bot);
// Keep issue-detail topic buttons routed into the established d2 topic picker.
installDestinationTopicButtonRepairV4(Bot);
// Remove legacy warning glyphs from Review Issues button text while preserving
// the dedicated premium custom emoji icon.
installReviewIssuesIconCleanup(Bot);
// Bind before app.js registers its legacy message:text handler so destination
// input is captured by the scanner first.
installDestinationsV2InputPriority(Bot);
// Install after destination input priority so Forwarded Post's one-shot source
// capture is registered first when app.js later binds its message:text handler.
installForwardedPostBot(Bot);
// Telegram mutations live in a separate explicit action layer. It owns only d3_*
// callbacks and never replaces the working scanner callbacks.
installDestinationPreparationUi(Bot);
// Installed after preparation UI so this wrapper registers its d3_prepare
// interceptor first. It only handles the stale already-imported Addlist case;
// normal preparation continues through the existing handler via next().
installAddlistBulkReimport(Bot);
// Delete-all is a focused d4_* destructive-control layer. It registers after
// Destinations v2 so its enhanced d2_manage renderer gets callback priority.
installDestinationDeleteAll(Bot);

prepareV1Engine(Api, TelegramClient);
installPostingEngineEnhancements(Api, TelegramClient);
installV1Engine(Api, TelegramClient);
installPostingReliabilityPost(TelegramClient);
installPrivatePeerResolution(TelegramClient);
// Forwarded Post is outermost on personal Telegram sends so it can replace only
// interval-cycle sendMessage calls with Telegram's real forwardMessages method.
installForwardedPostSend(TelegramClient);
// Install this nearest the raw Bot API so it sees the final Message keyboard
// after the general UI wrappers have applied their own polish.
installForwardedPostUi(Api);
// Keep the legacy scheduler satisfied when Forwarded Post is the only configured
// post. The placeholder never reaches Telegram because personal sends are
// replaced by forwardMessages before dispatch.
installForwardedPostSchedulerCompat(Api);
// Install this before the general UI wrappers. Because those wrappers are added
// later, this transformer runs nearest the raw Telegram send and sees their final
// keyboard, so Pause/Resume cannot be accidentally dropped by later polish.
installPauseResumeUi(Api);
console.log("TelePilot Forwarded Post enabled (real Telegram forwards; personal senders only)");

// The global gap-fill is innermost. Semantic icon correction sits directly
// outside it, so it can claim plain buttons first and prevent generic fallbacks.
installGlobalUiPolish(Api);
installUiIconSemantics(Api);
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
// Reliability UI is outermost so generic legacy posting failures are replaced by
// exact Telegram reasons after all other text/keyboard transforms finish.
installPostingReliabilityUi(Api);

const profileBot = new Bot(BOT_TOKEN);

try {
  const stickers = await profileBot.api.raw.getForumTopicIconStickers();
  const palette = configurePremiumEmojiStickers(stickers);
  const deepPalette = configureDeepPremiumEmojiStickers(stickers);
  const globalPalette = configureGlobalUiPolishStickers(stickers);
  const semanticPalette = configureUiIconSemanticsStickers(stickers);
  console.log(`TelePilot premium emoji palette loaded: ${palette.selected}/${palette.available} preferred icons available; deep UI ${deepPalette.enabled ? "enabled" : "disabled"}; global gap-fill ${globalPalette.enabled ? "enabled" : "disabled"}; semantic icons ${semanticPalette.enabled ? "enabled" : "disabled"}`);
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

function startOptimizedDestinationPreparationWorker() {
  const intervalMs = 10_000;
  const timer = setInterval(() => void runDestinationPreparationTick(), intervalMs);
  timer.unref?.();
  setTimeout(() => void runDestinationPreparationTick(), 1_000).unref?.();
  console.log("TelePilot destination preparation worker enabled (10s conservative polling; explicit jobs only; paced mute + batched archive)");
  return timer;
}

startV1Worker();
startQolV13Worker();
startDestinationJoinWorker();
startCleanupRejoinBridge();
startOptimizedDestinationPreparationWorker();
await import("./app.js");