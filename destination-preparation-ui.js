import fs from "node:fs";
import path from "node:path";
import {
  cleanupSummary,
  prepareReviewedSources,
} from "./destination-preparation-v1.js";
import { recoverNotJoinedAddlistPeers } from "./destination-preparation-addlist-recovery.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const REVIEW_TTL_MS = 30 * 60_000;
const running = new Set();

function userDir(uid) { return path.join(DATA_DIR, "users", String(uid)); }
function statePath(uid) { return path.join(userDir(uid), "destinations-v2.json"); }
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readReview(uid) {
  const state = readJson(statePath(uid), {});
  const review = state?.review;
  if (!review || Date.now() - Number(review.createdAt || 0) > REVIEW_TTL_MS) return null;
  return review;
}
function writeReview(uid, review) {
  const state = readJson(statePath(uid), {});
  writeJsonAtomic(statePath(uid), { ...state, version: Math.max(2, Number(state.version || 0)), review });
}
function inline(text, callback_data) { return { text, callback_data }; }
function keyboard(rows) { return { inline_keyboard: rows.filter(row => Array.isArray(row) && row.length) }; }
function errorText(err) { return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 220); }

function reviewScreen(review) {
  const accessible = review?.accessible?.length || 0;
  const notJoined = review?.notJoined?.length || 0;
  const unsupported = review?.unsupported?.length || 0;
  const invalid = (review?.invalid?.length || 0) + (review?.unavailable?.length || 0);
  const forums = (review?.accessible || []).filter(item => item.forum).length;
  const sample = (review?.accessible || []).slice(0, 6).map(item => `✅ ${item.username || item.label}`).join("\n");
  const canPrepare = Boolean(review?.sourceText);
  return {
    text: [
      "🔎 Review scan",
      "",
      `Ready now  ${accessible}`,
      forums ? `Forum groups  ${forums}` : null,
      notJoined ? `Not joined yet  ${notJoined}` : null,
      unsupported ? `Unsupported  ${unsupported}` : null,
      invalid ? `Could not use  ${invalid}` : null,
      "",
      sample || "No accessible groups were found yet.",
      accessible > 6 ? `… and ${accessible - 6} more` : null,
      "",
      canPrepare ? "Choose Join + prepare to join missing groups, then queue mute + archive for confirmed groups." : "Scan again to enable preparation.",
    ].filter(Boolean).join("\n"),
    rows: [
      canPrepare ? [inline("⚡ Join + prepare all", `d3_prepare:${review.token}`)] : [],
      accessible ? [inline(`Add ${accessible} accessible only`, `d2_confirm:${review.token}`)] : [],
      notJoined || invalid || unsupported ? [inline("View not added", `d3_skipped:${review.token}`)] : [],
      [inline("Cancel", "v1_destinations_v13")],
    ],
  };
}
function skippedScreen(review) {
  const lines = [];
  for (const item of review?.notJoined || []) lines.push(`↗️ ${item.username || item.label}\nNot joined yet.`);
  for (const item of review?.unsupported || []) lines.push(`⚠️ ${item.username || item.label}\nUnsupported destination type.`);
  for (const item of review?.invalid || []) lines.push(`❌ ${String(item.original || "Input").slice(0, 60)}\n${item.reason}`);
  for (const item of review?.unavailable || []) lines.push(`❌ ${String(item.original || "Input").slice(0, 60)}\n${item.reason}`);
  return {
    text: ["↗️ Not ready yet", "", lines.slice(0, 12).join("\n\n") || "Nothing was skipped.", lines.length > 12 ? `\n…and ${lines.length - 12} more` : ""].join("\n"),
    rows: [[inline("← Review", `d3_review:${review.token}`)]],
  };
}
function cleanupScreen(uid) {
  const summary = cleanupSummary(uid);
  const wait = summary.nextAt > Date.now() ? Math.max(1, Math.ceil((summary.nextAt - Date.now()) / 1000)) : 0;
  return {
    text: [
      "🧹 Destination cleanup",
      "",
      `Queued  ${summary.total}`,
      `Muted  ${summary.muted}/${summary.total}`,
      `Archived  ${summary.archived}/${summary.total}`,
      `Complete  ${summary.complete}/${summary.total}`,
      summary.failed ? `Needs attention  ${summary.failed}` : null,
      wait ? `Telegram cooldown  ~${wait}s` : null,
      "",
      summary.waiting ? "Cleanup continues automatically from the explicit preparation queue." : "No cleanup work is waiting.",
    ].filter(Boolean).join("\n"),
    rows: [[inline("↻ Refresh", "d3_cleanup_status")], [inline("← Destination Hub", "v1_destinations_v13")]],
  };
}
async function editOrReply(ctx, screen) {
  const options = { reply_markup: keyboard(screen.rows || []) };
  try { return await ctx.editMessageText(screen.text, options); }
  catch { return ctx.reply(screen.text, options); }
}

export function installDestinationPreparationUi(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotDestinationPreparationUiInstalled) return;
  const originalStart = BotClass.prototype.start;
  if (typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for destination preparation UI");
  Object.defineProperty(BotClass.prototype, "__telepilotDestinationPreparationUiInstalled", { value: true });

  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotDestinationPreparationUiHandlers) {
      Object.defineProperty(this, "__telepilotDestinationPreparationUiHandlers", { value: true });

      this.callbackQuery(/^d3_prepare:([A-Za-z0-9_-]+)$/, async ctx => {
        const uid = String(ctx.from?.id || "");
        const token = String(ctx.match?.[1] || "");
        const review = readReview(uid);
        if (!review || review.token !== token) {
          await ctx.answerCallbackQuery({ text: "That scan expired. Scan the destinations again.", show_alert: true });
          return editOrReply(ctx, { text: "⌛ Scan expired\n\nOpen Destination Hub and scan the sources again.", rows: [[inline("← Destination Hub", "v1_destinations_v13")]] });
        }
        if (running.has(uid)) return ctx.answerCallbackQuery({ text: "Preparation is already running." });

        running.add(uid);
        await ctx.answerCallbackQuery({ text: "Preparing destinations…" });
        await editOrReply(ctx, {
          text: "⚡ Preparing destinations…\n\nJoining missing groups first. TelePilot will only save chats Telegram confirms as joined. Mute + archive are queued afterward.",
          rows: [],
        });
        try {
          const initial = await prepareReviewedSources(uid, review);
          const result = await recoverNotJoinedAddlistPeers(uid, initial);
          writeReview(uid, result.postReview);
          const ready = result.postReview?.accessible?.length || 0;
          const notJoined = result.postReview?.notJoined?.length || 0;
          const failures = result.failures?.length || 0;
          const topics = Number(result.saved?.topics || 0);
          const recovered = Number(result.recovery?.recoveredAccessible || 0);
          await editOrReply(ctx, {
            text: [
              "✅ Join stage finished",
              "",
              `Ready after verification  ${ready}`,
              `Newly accessible  ${result.newlyAccessible}`,
              recovered ? `Recovered from imported folder  ${recovered}` : null,
              `New saved  ${result.saved?.added || 0}`,
              `Already saved  ${result.saved?.existing || 0}`,
              topics ? `Topics to choose  ${topics}` : null,
              notJoined ? `Still not joined  ${notJoined}` : null,
              result.pending?.length ? `Join requests pending  ${result.pending.length}` : null,
              failures ? `Join errors  ${failures}` : null,
              "",
              `Cleanup queued  ${result.cleanup?.pending || 0}`,
              "Mute and archive run from the separate paced queue only after Telegram confirms membership.",
              failures ? `\nFirst error: ${result.failures[0]}` : null,
            ].filter(Boolean).join("\n"),
            rows: [
              [inline("🧹 Cleanup status", "d3_cleanup_status")],
              topics ? [inline("💬 Choose topics", "d2_topics:0")] : [],
              [inline("📚 Browse", "d2_browse:0")],
              [inline("← Destination Hub", "v1_destinations_v13")],
            ],
          });
        } catch (err) {
          await editOrReply(ctx, {
            text: `❌ Preparation stopped\n\n${errorText(err)}\n\nThe read-only scanner remains unchanged. You can retry this preparation without rebuilding the Destination Hub.`,
            rows: [[inline("← Review", `d3_review:${token}`)], [inline("← Destination Hub", "v1_destinations_v13")]],
          });
        } finally {
          running.delete(uid);
        }
      });

      this.callbackQuery(/^d3_review:([A-Za-z0-9_-]+)$/, async ctx => {
        await ctx.answerCallbackQuery();
        const review = readReview(String(ctx.from?.id || ""));
        return editOrReply(ctx, review?.token === ctx.match[1] ? reviewScreen(review) : { text: "⌛ Scan expired", rows: [[inline("← Destination Hub", "v1_destinations_v13")]] });
      });

      this.callbackQuery(/^d3_skipped:([A-Za-z0-9_-]+)$/, async ctx => {
        await ctx.answerCallbackQuery();
        const review = readReview(String(ctx.from?.id || ""));
        return editOrReply(ctx, review?.token === ctx.match[1] ? skippedScreen(review) : { text: "⌛ Scan expired", rows: [[inline("← Destination Hub", "v1_destinations_v13")]] });
      });

      this.callbackQuery("d3_cleanup_status", async ctx => {
        await ctx.answerCallbackQuery();
        return editOrReply(ctx, cleanupScreen(String(ctx.from?.id || "")));
      });
    }
    return originalStart.apply(this, args);
  };
  console.log("TelePilot destination preparation UI enabled");
}
