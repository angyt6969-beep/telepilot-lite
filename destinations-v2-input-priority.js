import fs from "node:fs";
import path from "node:path";
import { importDestinationBatch, importResultScreen } from "./destination-import-engine-v2.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const INPUT_TTL_MS = 20 * 60_000;
const REVIEW_TTL_MS = 30 * 60_000;
const MAX_SOURCE_TEXT = 20_000;

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
function errorText(err) { return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 220); }
function inline(text, callback_data) { return { text, callback_data }; }
function keyboard(rows) { return { inline_keyboard: rows.filter(row => Array.isArray(row) && row.length) }; }

async function editPrompt(ctx, pending, screen) {
  const options = {
    reply_markup: keyboard(screen.rows || []),
    ...(screen.parse_mode ? { parse_mode: screen.parse_mode } : {}),
  };
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
  const rawText = String(ctx.message.text || "").slice(0, MAX_SOURCE_TEXT);
  const sourceCount = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).length;
  console.log(`TelePilot captured destination import for ${uid}: ${sourceCount} source line(s)`);

  writeState(uid, { ...state, pendingInput: null, review: null });
  try {
    await editPrompt(ctx, pending, {
      text: [
        "⚡ <b><i>Adding destinations</i></b>",
        "",
        "<i>TelePilot is checking the groups, joining eligible destinations, then starting mute + archive cleanup.</i>",
        "",
        "<b>Addlists:</b> — Telegram native shared-folder bulk import",
        "<b>Group lists:</b> — automatic individual joins",
      ].join("\n"),
      parse_mode: "HTML",
      rows: [],
    });

    const result = await importDestinationBatch(uid, rawText);
    writeState(uid, {
      ...readState(uid),
      pendingInput: null,
      review: result.postReview,
      lastScan: { at: Date.now(), token: result.postReview?.token || "" },
    });
    console.log(
      `TelePilot destination import complete for ${uid}: ready=${result.postReview?.accessible?.length || 0}, `
      + `notJoined=${result.postReview?.notJoined?.length || 0}, failures=${result.outcomes?.filter(row => row.status === "error").length || 0}`,
    );
    await editPrompt(ctx, pending, importResultScreen(result));
    return;
  } catch (err) {
    console.warn(`TelePilot destination import failed for ${uid}: ${errorText(err)}`);
    await editPrompt(ctx, pending, {
      text: [
        "❌ <b><i>Destination import failed</i></b>",
        "",
        `<b>Reason:</b> — ${String(errorText(err)).replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]))}`,
        "",
        "<i>No hidden retry is running. Fix the stated reason and send the destinations again.</i>",
      ].join("\n"),
      parse_mode: "HTML",
      rows: [[inline("Try again", "d2_add")], [inline("𝙂𝙤 𝙗𝙖𝙘𝙠", "v1_destinations_v13")]],
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
  console.log("TelePilot destination auto-import input priority enabled");
}
