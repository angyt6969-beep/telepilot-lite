import fs from "node:fs";
import path from "node:path";
import {
  importDestinationBatch,
  importResultScreen,
  parseImportLines,
} from "./destination-import-result-v3.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const INPUT_TTL_MS = 20 * 60_000;
const REVIEW_TTL_MS = 30 * 60_000;
const RESUME_TTL_MS = 30 * 60_000;
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
  const resumeImport = raw?.resumeImport
    && Date.now() - Number(raw.resumeImport.createdAt || 0) <= RESUME_TTL_MS
    && String(raw.resumeImport.text || "").trim()
      ? {
          text: String(raw.resumeImport.text).slice(0, MAX_SOURCE_TEXT),
          createdAt: Number(raw.resumeImport.createdAt || 0) || Date.now(),
          availableAt: Number(raw.resumeImport.availableAt || 0) || 0,
        }
      : null;
  return {
    version: 2,
    pendingInput,
    review,
    resumeImport,
    lastScan: raw?.lastScan && typeof raw.lastScan === "object" ? raw.lastScan : null,
  };
}
function readState(uid) { return cleanState(readJson(statePath(uid), {})); }
function writeState(uid, value) { writeJsonAtomic(statePath(uid), cleanState(value)); }
function errorText(err) { return String(err?.errorMessage || err?.description || err?.message || err || "Unknown Telegram error").slice(0, 220); }
function inline(text, callback_data) { return { text, callback_data }; }
function keyboard(rows) { return { inline_keyboard: rows.filter(row => Array.isArray(row) && row.length) }; }
function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));
}
function sourceOutcomeLabel(parsed) {
  if (parsed?.kind === "public") return `@${parsed.username}`.toLowerCase();
  if (parsed?.kind === "invite") return "private group invite";
  return "";
}

export function buildResumeText(result, rawText) {
  const cooldownRows = (Array.isArray(result?.outcomes) ? result.outcomes : [])
    .filter(row => row?.sourceKind !== "addlist")
    .filter(row => row?.kind === "cooldown")
    .filter(row => ["error", "not_attempted"].includes(String(row?.status || "")));
  if (!cooldownRows.length) return "";

  const waiting = new Set(cooldownRows.map(row => String(row?.source || "").trim().toLowerCase()).filter(Boolean));
  const parsed = parseImportLines(rawText);
  const lines = [];
  for (const row of parsed.sources || []) {
    if (row?.parsed?.kind === "addlist") continue;
    const label = sourceOutcomeLabel(row.parsed);
    if (label && waiting.has(label)) lines.push(String(row.original || row.parsed?.original || "").trim());
  }
  return [...new Set(lines.filter(Boolean))].join("\n");
}

export function decorateCooldownScreen(screen, result, resumeImport) {
  if (!resumeImport?.text) return screen;
  const remainingCount = resumeImport.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).length;
  const lines = String(screen?.text || "").split("\n")
    .filter(line => !line.includes("Not attempted — Telegram join cooldown is active"))
    .filter(line => !/…and \d+ more result/.test(line));
  lines.push("", `⏳ <b>Remaining:</b> — ${remainingCount}`, "<i>Telegram paused the batch. Continue the saved remainder after the cooldown.</i>");
  const rows = Array.isArray(screen?.rows) ? screen.rows.map(row => Array.isArray(row) ? row.map(button => ({ ...button })) : row) : [];
  rows.unshift([{ text: "Continue remaining", callback_data: "d3_resume_import" }]);
  return { ...screen, text: lines.join("\n"), rows };
}

function resumeStateFor(result, rawText) {
  const text = buildResumeText(result, rawText);
  if (!text) return null;
  return {
    text,
    createdAt: Date.now(),
    availableAt: Date.now() + Math.max(0, Number(result?.cooldownSeconds || 0)) * 1000,
  };
}

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

async function editCurrent(ctx, screen) {
  const options = {
    reply_markup: keyboard(screen.rows || []),
    ...(screen.parse_mode ? { parse_mode: screen.parse_mode } : {}),
  };
  try { return await ctx.editMessageText(screen.text, options); }
  catch { return ctx.reply(screen.text, options); }
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

  writeState(uid, { ...state, pendingInput: null, review: null, resumeImport: null });
  try {
    await editPrompt(ctx, pending, {
      text: [
        "⚡ <b><i>Adding destinations</i></b>",
        "",
        "<i>TelePilot is checking posting access first, joining eligible destinations, then starting mute + archive cleanup.</i>",
        "",
        "<b>Addlists:</b> — Telegram native shared-folder bulk import",
        "<b>Group lists:</b> — paced individual joins",
        "<b>Read-only groups:</b> — discarded before joining",
      ].join("\n"),
      parse_mode: "HTML",
      rows: [],
    });

    const result = await importDestinationBatch(uid, rawText);
    const resumeImport = resumeStateFor(result, rawText);
    writeState(uid, {
      ...readState(uid),
      pendingInput: null,
      review: result.postReview,
      resumeImport,
      lastScan: { at: Date.now(), token: result.postReview?.token || "" },
    });
    console.log(
      `TelePilot destination import complete for ${uid}: ready=${result.postReview?.accessible?.length || 0}, `
      + `notJoined=${result.postReview?.notJoined?.length || 0}, discarded=${result.outcomes?.filter(row => row.status === "discarded").length || 0}, `
      + `failures=${result.outcomes?.filter(row => row.status === "error").length || 0}, resume=${resumeImport ? resumeImport.text.split(/\r?\n/).filter(Boolean).length : 0}`,
    );
    await editPrompt(ctx, pending, decorateCooldownScreen(importResultScreen(result), result, resumeImport));
    return;
  } catch (err) {
    console.warn(`TelePilot destination import failed for ${uid}: ${errorText(err)}`);
    await editPrompt(ctx, pending, {
      text: [
        "❌ <b><i>Destination import failed</i></b>",
        "",
        `<b>Reason:</b> — ${esc(errorText(err))}`,
        "",
        "<i>No hidden retry is running. Fix the stated reason and send the destinations again.</i>",
      ].join("\n"),
      parse_mode: "HTML",
      rows: [[inline("Try again", "d2_add")], [inline("𝙂𝙤 𝙗𝙖𝙘𝙠", "v1_destinations_v13")]],
    });
    return;
  }
}

async function resumeDestinationImport(ctx) {
  const uid = String(ctx.from?.id || "");
  if (!uid || ctx.chat?.type !== "private") return;
  const state = readState(uid);
  const resumeImport = state.resumeImport;
  if (!resumeImport?.text) {
    try { await ctx.answerCallbackQuery({ text: "No paused destination import is waiting.", show_alert: true }); } catch {}
    return;
  }
  const waitMs = Math.max(0, Number(resumeImport.availableAt || 0) - Date.now());
  if (waitMs > 0) {
    const seconds = Math.max(1, Math.ceil(waitMs / 1000));
    try { await ctx.answerCallbackQuery({ text: `Telegram asked TelePilot to wait ${seconds}s more.`, show_alert: true }); } catch {}
    return;
  }

  try { await ctx.answerCallbackQuery({ text: "Continuing remaining groups…" }); } catch {}
  writeState(uid, { ...state, resumeImport: null });
  await editCurrent(ctx, {
    text: [
      "⚡ <b><i>Continuing destination import</i></b>",
      "",
      "<i>TelePilot is processing only the groups saved from the paused batch.</i>",
    ].join("\n"),
    parse_mode: "HTML",
    rows: [],
  });

  try {
    const result = await importDestinationBatch(uid, resumeImport.text);
    const nextResume = resumeStateFor(result, resumeImport.text);
    writeState(uid, {
      ...readState(uid),
      pendingInput: null,
      review: result.postReview,
      resumeImport: nextResume,
      lastScan: { at: Date.now(), token: result.postReview?.token || "" },
    });
    await editCurrent(ctx, decorateCooldownScreen(importResultScreen(result), result, nextResume));
  } catch (err) {
    writeState(uid, { ...readState(uid), resumeImport: { ...resumeImport, createdAt: Date.now() } });
    await editCurrent(ctx, {
      text: [
        "❌ <b><i>Could not continue import</i></b>",
        "",
        `<b>Reason:</b> — ${esc(errorText(err))}`,
        "",
        "<i>The remaining list was kept. Try Continue remaining again when Telegram is ready.</i>",
      ].join("\n"),
      parse_mode: "HTML",
      rows: [[inline("Continue remaining", "d3_resume_import")], [inline("𝙂𝙤 𝙗𝙖𝙘𝙠", "v1_destinations_v13")]],
    });
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
  const originalStart = proto.start;
  if (typeof originalOn !== "function" || typeof originalStart !== "function") throw new Error("Unsupported grammY Bot shape for Destinations v2 input priority");

  Object.defineProperty(proto, "__telepilotDestinationsV2InputPriorityInstalled", { value: true });
  proto.on = function(filter, ...middleware) {
    if (!this.__telepilotDestinationsV2InputPriorityBound && isMessageTextFilter(filter)) {
      Object.defineProperty(this, "__telepilotDestinationsV2InputPriorityBound", { value: true });
      this.use(destinationInputPriorityMiddleware);
    }
    return originalOn.call(this, filter, ...middleware);
  };
  proto.start = function(...args) {
    if (!this.__telepilotDestinationResumeHandlerBound) {
      Object.defineProperty(this, "__telepilotDestinationResumeHandlerBound", { value: true });
      this.callbackQuery("d3_resume_import", resumeDestinationImport);
    }
    return originalStart.apply(this, args);
  };
  console.log("TelePilot destination auto-import input priority enabled");
}

export const __test = {
  cleanState,
  buildResumeText,
  decorateCooldownScreen,
  resumeStateFor,
};
