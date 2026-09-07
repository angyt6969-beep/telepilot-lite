import fs from "node:fs";
import path from "node:path";
import { scanDestinationSources } from "./destinations-v2.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const INPUT_TTL_MS = 20 * 60_000;
const REVIEW_TTL_MS = 30 * 60_000;

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
function cleanState(raw = {}) {
  const review = raw?.review && Date.now() - Number(raw.review.createdAt || 0) <= REVIEW_TTL_MS ? raw.review : null;
  const pendingInput = raw?.pendingInput && Date.now() - Number(raw.pendingInput.createdAt || 0) <= INPUT_TTL_MS ? raw.pendingInput : null;
  return {
    version: 2,
    pendingInput,
    review,
    lastScan: raw?.lastScan && typeof raw.lastScan === "object" ? raw.lastScan : null,
  };
}
function readState(uid) { return cleanState(readJson(statePath(uid), {})); }
function writeState(uid, value) { writeJsonAtomic(statePath(uid), cleanState(value)); }
function errorText(err) { return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 180); }
function inline(text, callback_data) { return { text, callback_data }; }
function keyboard(rows) { return { inline_keyboard: rows.filter(row => Array.isArray(row) && row.length) }; }

function reviewScreen(review) {
  const accessible = review?.accessible?.length || 0;
  const notJoined = review?.notJoined?.length || 0;
  const unsupported = review?.unsupported?.length || 0;
  const invalid = (review?.invalid?.length || 0) + (review?.unavailable?.length || 0);
  const forums = (review?.accessible || []).filter(item => item.forum).length;
  const sample = (review?.accessible || []).slice(0, 6).map(item => `✅ ${item.username || item.label}`).join("\n");
  return {
    text: [
      "🔎 Review scan",
      "",
      `Ready to save  ${accessible}`,
      forums ? `Forum groups  ${forums}` : null,
      notJoined ? `Join in Telegram first  ${notJoined}` : null,
      unsupported ? `Unsupported  ${unsupported}` : null,
      invalid ? `Could not use  ${invalid}` : null,
      "",
      sample || "No accessible groups were found.",
      accessible > 6 ? `… and ${accessible - 6} more` : null,
      "",
      "Nothing has been changed yet.",
    ].filter(Boolean).join("\n"),
    rows: [
      accessible ? [inline(`Add ${accessible} accessible`, `d2_confirm:${review.token}`)] : [],
      notJoined || invalid || unsupported ? [inline("View not added", `d2_skipped:${review.token}`)] : [],
      [inline("Cancel", "v1_destinations_v13")],
    ],
  };
}

async function editPrompt(ctx, pending, screen) {
  const options = { reply_markup: keyboard(screen.rows || []) };
  try {
    return await ctx.api.editMessageText(Number(pending.chatId), Number(pending.messageId), screen.text, options);
  } catch {
    return ctx.reply(screen.text, options);
  }
}

async function destinationInputPriorityMiddleware(ctx, next) {
  if (ctx.chat?.type !== "private" || !ctx.from?.id || !ctx.message?.text) return next();
  const uid = String(ctx.from.id);
  const state = readState(uid);
  const pending = state.pendingInput;
  if (pending?.type !== "source") return next();

  try { await ctx.deleteMessage(); } catch {}
  const sourceCount = String(ctx.message.text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).length;
  console.log(`TelePilot Destinations v2 captured destination input for ${uid}: ${sourceCount} source line(s)`);

  try {
    await editPrompt(ctx, pending, {
      text: "🔎 Scanning Telegram access…\n\nChecking only chats your connected personal accounts already belong to.",
      rows: [],
    });
    const review = await scanDestinationSources(uid, ctx.message.text);
    writeState(uid, {
      ...state,
      pendingInput: null,
      review,
      lastScan: { at: Date.now(), token: review.token },
    });
    console.log(`TelePilot Destinations v2 scan complete for ${uid}: ${review.accessible?.length || 0} accessible, ${review.notJoined?.length || 0} not joined`);
    await editPrompt(ctx, pending, reviewScreen(review));
    return;
  } catch (err) {
    writeState(uid, { ...state, pendingInput: null });
    console.warn(`TelePilot Destinations v2 scan failed for ${uid}: ${errorText(err)}`);
    await editPrompt(ctx, pending, {
      text: `❌ Could not scan destinations\n\n${errorText(err)}`,
      rows: [[inline("Try again", "d2_add")], [inline("← Destination Hub", "v1_destinations_v13")]],
    });
    return;
  }
}

function isMessageTextFilter(filter) {
  if (typeof filter === "string") return filter === "message:text";
  if (Array.isArray(filter)) return filter.some(isMessageTextFilter);
  return false;
}

export function installDestinationsV2InputPriority(BotClass) {
  const proto = BotClass?.prototype;
  if (!proto || proto.__telepilotDestinationsV2InputPriorityInstalled) return;
  const originalOn = proto.on;
  if (typeof originalOn !== "function") throw new Error("Unsupported grammY Bot shape for Destinations v2 input priority");

  Object.defineProperty(proto, "__telepilotDestinationsV2InputPriorityInstalled", { value: true });
  proto.on = function(filter, ...middleware) {
    if (!this.__telepilotDestinationsV2InputPriorityBound && isMessageTextFilter(filter)) {
      Object.defineProperty(this, "__telepilotDestinationsV2InputPriorityBound", { value: true });
      this.use(destinationInputPriorityMiddleware);
    }
    return originalOn.call(this, filter, ...middleware);
  };
  console.log("TelePilot Destinations v2 text-input priority enabled");
}
