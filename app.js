import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { Bot, InlineKeyboard } from "grammy";

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATA_DIR = process.env.DATA_DIR || "/data";
const PORT = Number(process.env.PORT || 3000);
const INTERVAL_VALUES = [1, 5, 10, 15, 30, 45, 60, 90, 120];
const MAX_GROUPS = 100;
const REMOVE_PAGE_SIZE = 8;
const POST_GAP_MS = 1500;
const IDLE_STATE_MS = 30 * 60_000;
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const KEY_FILE = path.join(DATA_DIR, "access-keys.json");
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const LEGACY_SETTINGS_FILE = path.join(DATA_DIR, "telepilot-settings.json");

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_DIR = path.join(DATA_DIR, "users");
fs.mkdirSync(USERS_DIR, { recursive: true });
const states = new Map();

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch (err) { console.warn(`Could not read ${path.basename(file)}:`, err?.message || err); return fallback; }
}
function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function settingsFile(uid) { return path.join(userDir(uid), "settings.json"); }

function resolveAdminIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID]) {
    for (const part of String(raw || "").split(/[\s,;]+/)) if (/^\d+$/.test(part)) ids.add(part);
  }
  const persisted = readJson(ADMIN_FILE, {});
  for (const value of Array.isArray(persisted.adminIds) ? persisted.adminIds : []) if (/^\d+$/.test(String(value))) ids.add(String(value));
  const legacy = readJson(LEGACY_SETTINGS_FILE, {});
  if (/^\d+$/.test(String(legacy.ownerId || ""))) ids.add(String(legacy.ownerId));
  if (ids.size) {
    try { writeJsonAtomic(ADMIN_FILE, { version: 1, adminIds: [...ids] }); } catch {}
  }
  return ids;
}
const ADMIN_IDS = resolveAdminIds();
function isAdmin(uid) { return ADMIN_IDS.has(String(uid)); }

function normalizeSavedGroups(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "");
    if (!/^-\d+$/.test(id)) continue;
    out.push({
      id,
      label: String(item.label || item.title || id).slice(0, 120),
      type: String(item.type || "group"),
      username: item.username ? String(item.username) : "",
    });
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}
function loadUserSettings(uid) { return readJson(settingsFile(uid), {}); }
function createState(uid) {
  const saved = loadUserSettings(uid);
  return {
    uid: Number(uid),
    adMessage: typeof saved.adMessage === "string" ? saved.adMessage : "",
    adEntities: Array.isArray(saved.adEntities) ? saved.adEntities : [],
    groups: normalizeSavedGroups(saved.groups),
    intervalMinutes: INTERVAL_VALUES.includes(Number(saved.intervalMinutes)) ? Number(saved.intervalMinutes) : 30,
    totalSent: Number.isFinite(Number(saved.totalSent)) ? Number(saved.totalSent) : 0,
    lastRunAt: Number.isFinite(Number(saved.lastRunAt)) ? Number(saved.lastRunAt) : null,
    lastCycleSuccess: Number.isFinite(Number(saved.lastCycleSuccess)) ? Number(saved.lastCycleSuccess) : 0,
    lastCycleFailed: Number.isFinite(Number(saved.lastCycleFailed)) ? Number(saved.lastCycleFailed) : 0,
    accessLifetime: saved.accessLifetime === true,
    accessUntil: Number.isFinite(Number(saved.accessUntil)) ? Number(saved.accessUntil) : null,
    accessKeyId: typeof saved.accessKeyId === "string" ? saved.accessKeyId : null,
    accessRevoked: saved.accessRevoked === true,
    postingTimer: null,
    posting: false,
    cyclePromise: null,
    nextRunAt: null,
    awaiting: null,
    awaitingPromptMessageId: null,
    awaitingPromptChatId: null,
    lastTouchedAt: Date.now(),
  };
}
function getState(uid) {
  const key = String(uid);
  if (!states.has(key)) states.set(key, createState(uid));
  const state = states.get(key);
  state.lastTouchedAt = Date.now();
  return state;
}
function saveState(state) {
  fs.mkdirSync(userDir(state.uid), { recursive: true, mode: 0o700 });
  writeJsonAtomic(settingsFile(state.uid), {
    version: 2,
    adMessage: state.adMessage,
    adEntities: state.adEntities,
    groups: state.groups,
    intervalMinutes: state.intervalMinutes,
    totalSent: state.totalSent,
    lastRunAt: state.lastRunAt,
    lastCycleSuccess: state.lastCycleSuccess,
    lastCycleFailed: state.lastCycleFailed,
    accessLifetime: state.accessLifetime,
    accessUntil: state.accessUntil,
    accessKeyId: state.accessKeyId,
    accessRevoked: state.accessRevoked,
  });
}

function hasAccess(state) {
  if (!state) return false;
  if (isAdmin(state.uid)) return true;
  if (state.accessRevoked) return false;
  if (state.accessLifetime) return true;
  return Number(state.accessUntil || 0) > Date.now();
}
function accessLabel(state) {
  if (isAdmin(state.uid)) return "Owner access";
  if (state.accessRevoked) return "Revoked";
  if (state.accessLifetime) return "Lifetime";
  if (!state.accessUntil || state.accessUntil <= Date.now()) return "Inactive";
  const days = Math.max(1, Math.ceil((state.accessUntil - Date.now()) / 86_400_000));
  return `${days} day${days === 1 ? "" : "s"} left`;
}
function formatAccessExpiry(state) {
  if (isAdmin(state.uid)) return "Owner access";
  if (state.accessLifetime) return "Lifetime";
  if (!state.accessUntil || state.accessUntil <= Date.now()) return "Expired";
  return new Date(state.accessUntil).toISOString().slice(0, 10);
}

function loadKeyDb() {
  const db = readJson(KEY_FILE, { version: 1, keys: [] });
  return { version: 1, keys: Array.isArray(db.keys) ? db.keys : [] };
}
function saveKeyDb(db) { writeJsonAtomic(KEY_FILE, { version: 1, keys: db.keys }); }
function normalizeKey(value) { return String(value || "").trim().toUpperCase().replace(/\s+/g, ""); }
function hashKey(value) { return crypto.createHash("sha256").update(normalizeKey(value)).digest("hex"); }
function randomKeySegment(length = 4) {
  let out = "";
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  return out;
}
function generateLicenseKey(duration) {
  const db = loadKeyDb();
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = `TP-${randomKeySegment()}-${randomKeySegment()}-${randomKeySegment()}`;
    const keyHash = hashKey(key);
    if (db.keys.some(item => item.hash === keyHash)) continue;
    const record = {
      id: crypto.randomBytes(4).toString("hex"),
      hash: keyHash,
      hint: `${key.slice(0, 7)}-••••-••••`,
      durationDays: duration === "lifetime" ? null : duration,
      lifetime: duration === "lifetime",
      createdAt: Date.now(),
      redeemedAt: null,
      redeemedBy: null,
      revokedAt: null,
    };
    db.keys.push(record);
    saveKeyDb(db);
    return { key, record };
  }
  throw new Error("Could not generate a unique key");
}
function redeemLicenseKey(state, rawKey) {
  const normalized = normalizeKey(rawKey);
  if (!/^TP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalized)) return { ok: false, error: "That key format is invalid." };
  const db = loadKeyDb();
  const record = db.keys.find(item => item.hash === hashKey(normalized));
  if (!record || record.revokedAt) return { ok: false, error: "That key is invalid or has been revoked." };
  if (record.redeemedAt) return { ok: false, error: "That key has already been redeemed." };
  record.redeemedAt = Date.now();
  record.redeemedBy = String(state.uid);
  if (record.lifetime) {
    state.accessLifetime = true;
    state.accessUntil = null;
  } else {
    const base = Math.max(Date.now(), Number(state.accessUntil || 0));
    state.accessUntil = base + Number(record.durationDays) * 86_400_000;
  }
  state.accessKeyId = record.id;
  state.accessRevoked = false;
  saveKeyDb(db);
  saveState(state);
  return { ok: true, record };
}
function revokeKey(identifier) {
  const value = normalizeKey(identifier);
  const db = loadKeyDb();
  const record = /^TP-/.test(value)
    ? db.keys.find(item => item.hash === hashKey(value))
    : db.keys.find(item => String(item.id).toLowerCase() === String(identifier || "").trim().toLowerCase());
  if (!record) return { ok: false, error: "Key not found." };
  if (!record.revokedAt) record.revokedAt = Date.now();
  saveKeyDb(db);
  if (record.redeemedBy) {
    const state = getState(record.redeemedBy);
    if (state.accessKeyId === record.id) {
      state.accessRevoked = true;
      stopPostingLoop(state);
      saveState(state);
    }
  }
  return { ok: true, record };
}

const bot = new Bot(BOT_TOKEN);
const botInfo = await bot.api.getMe();
const BOT_USER_ID = botInfo.id;

function sanitizeBotEntities(entities = []) {
  const allowed = new Set(["bold", "italic", "underline", "strikethrough", "spoiler", "blockquote", "expandable_blockquote", "code", "pre", "text_link", "custom_emoji"]);
  return entities.filter(e => allowed.has(e?.type)).map(e => ({
    type: e.type,
    offset: Number(e.offset),
    length: Number(e.length),
    ...(e.url ? { url: String(e.url) } : {}),
    ...(e.language ? { language: String(e.language) } : {}),
    ...(e.custom_emoji_id ? { custom_emoji_id: String(e.custom_emoji_id) } : {}),
  })).filter(e => Number.isInteger(e.offset) && Number.isInteger(e.length) && e.offset >= 0 && e.length > 0);
}
async function safeDelete(chatId, messageId) { if (!chatId || !messageId) return; try { await bot.api.deleteMessage(chatId, messageId); } catch {} }
async function autoDeleteNotice(chatId, text, ms = 9000) { try { const m = await bot.api.sendMessage(chatId, text); setTimeout(() => void safeDelete(chatId, m.message_id), ms); } catch {} }
function clearAwaiting(state) { state.awaiting = null; state.awaitingPromptMessageId = null; state.awaitingPromptChatId = null; }
function privateOnly(ctx) { return ctx.chat?.type === "private"; }
function stateFromCtx(ctx) { const uid = ctx.from?.id; return uid ? getState(uid) : null; }
function formatInterval(m) { const v = Number(m); if (v < 60) return `${v} min`; if (v % 60 === 0) return `${v / 60}h`; return `${Math.floor(v / 60)}h ${v % 60}m`; }
function formatAgo(ts) { if (!ts) return "Never"; const s = Math.max(0, Math.floor((Date.now() - ts) / 1000)); if (s < 10) return "Just now"; if (s < 60) return `${s}s ago`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; }
function formatUntil(state) {
  if (!state.posting) return "—";
  if (!state.nextRunAt) return state.cyclePromise ? "after current cycle" : "—";
  const s = Math.max(0, Math.ceil((state.nextRunAt - Date.now()) / 1000));
  if (s < 60) return "<1 min";
  return formatInterval(Math.ceil(s / 60));
}

function accessKeyboard(active) {
  const kb = new InlineKeyboard().text(active ? "🔑 Redeem another key" : "🔑 Redeem Key", "redeem_key");
  if (active) kb.row().text("⬅️ Back", "home");
  return kb;
}
async function showAccess(ctx, state, locked = false) {
  clearAwaiting(state);
  const text = hasAccess(state)
    ? `🔑 ACCESS\n\n✅ Active\nPlan: ${accessLabel(state)}\nExpires: ${formatAccessExpiry(state)}\n\nYou can redeem another key to extend your access.`
    : "🔐 TELEPILOT ACCESS\n\nRedeem a valid access key to use TelePilot.";
  const opts = { reply_markup: accessKeyboard(hasAccess(state)) };
  try {
    if (ctx.callbackQuery?.message) await ctx.editMessageText(text, opts);
    else await ctx.reply(text, opts);
  } catch {
    await ctx.reply(text, opts);
  }
  if (locked) stopPostingLoop(state);
}
function mainKeyboard() {
  return new InlineKeyboard()
    .text("🔑 Access", "access").text("📝 Message", "message").row()
    .text("👥 Groups", "groups").text("⏱ Interval", "interval").row()
    .text("▶️ START", "start").text("⏹ STOP", "stop").row()
    .text("📊 Activity", "activity").text("🔄 Refresh", "home");
}
function dashboard(state) {
  return [
    "✈️ TELEPILOT", "", state.posting ? "🟢 Running" : "⚪ Stopped", "",
    `🔑 Access: ${accessLabel(state)}`,
    `📝 Message: ${state.adMessage ? `✅ Set (${state.adMessage.length} chars)` : "❌ Not set"}`,
    `👥 Groups: ${state.groups.length}`,
    `⏱ Interval: ${formatInterval(state.intervalMinutes)}`,
    state.posting ? `⏳ Next post: ${formatUntil(state)}` : null,
  ].filter(Boolean).join("\n");
}
async function showHome(ctx, state) {
  clearAwaiting(state);
  if (!hasAccess(state)) return showAccess(ctx, state, true);
  const opts = { reply_markup: mainKeyboard() };
  try { if (ctx.callbackQuery?.message) await ctx.editMessageText(dashboard(state), opts); else await ctx.reply(dashboard(state), opts); }
  catch { await ctx.reply(dashboard(state), opts); }
}
async function editDashboard(chatId, messageId, state) {
  if (!hasAccess(state)) return false;
  try { await bot.api.editMessageText(chatId, messageId, dashboard(state), { reply_markup: mainKeyboard() }); return true; }
  catch { return false; }
}

function normalizeTarget(input) {
  let v = String(input || "").trim().replace(/^https?:\/\/(www\.)?t\.me\//i, "");
  v = v.split(/[/?#]/)[0];
  if (!v) return null;
  if (/^-\d+$/.test(v)) return v;
  if (/^\d+$/.test(v)) return null;
  v = v.replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(v) ? `@${v}` : null;
}
function destinationLabel(destination) { return destination.username || destination.label || destination.id; }
async function resolveDestination(target, ownerUid) {
  const chat = await bot.api.getChat(target);
  if (!chat || !["group", "supergroup", "channel"].includes(chat.type)) throw new Error("That destination is not a Telegram group or channel.");
  let member;
  try { member = await bot.api.getChatMember(chat.id, BOT_USER_ID); }
  catch { throw new Error("Add @TelePilottBot to that group/channel first, then try again."); }
  if (member.status !== "administrator") throw new Error("Make @TelePilottBot an admin in that group/channel first.");
  if (chat.type === "channel" && member.can_post_messages !== true) throw new Error("Give @TelePilottBot permission to post messages in that channel.");
  if (ownerUid) {
    let ownerMember;
    try { ownerMember = await bot.api.getChatMember(chat.id, Number(ownerUid)); }
    catch { throw new Error("I could not verify that you are an admin of that destination."); }
    if (!["creator", "administrator"].includes(ownerMember.status)) throw new Error("Only an admin of that group/channel can add it to their TelePilot profile.");
  }
  return {
    id: String(chat.id),
    label: String(chat.title || chat.username || chat.id).slice(0, 120),
    type: chat.type,
    username: chat.username ? `@${chat.username}` : "",
  };
}
function stopPostingLoop(state) {
  state.posting = false;
  state.nextRunAt = null;
  if (state.postingTimer) clearTimeout(state.postingTimer);
  state.postingTimer = null;
}
async function sendCycleBody(state) {
  if (!state.posting || !hasAccess(state)) { stopPostingLoop(state); return; }
  const message = state.adMessage;
  const targets = [...state.groups];
  if (!message || !targets.length) { stopPostingLoop(state); return; }
  let success = 0, failed = 0;
  for (const target of targets) {
    if (!state.posting || !hasAccess(state)) { stopPostingLoop(state); break; }
    try {
      await bot.api.sendMessage(target.id, message, state.adEntities.length ? { entities: state.adEntities } : {});
      success++;
      state.totalSent++;
      if (state.posting) await new Promise(resolve => setTimeout(resolve, POST_GAP_MS));
    } catch (err) {
      failed++;
      console.error(`User ${state.uid} failed to post to ${target.id}:`, err?.description || err?.message || err);
    }
  }
  state.lastRunAt = Date.now();
  state.lastCycleSuccess = success;
  state.lastCycleFailed = failed;
  saveState(state);
}
function runCycle(state) {
  if (state.cyclePromise) return state.cyclePromise;
  state.cyclePromise = sendCycleBody(state).finally(() => { state.cyclePromise = null; });
  return state.cyclePromise;
}
function scheduleNextCycle(state) {
  if (state.postingTimer) clearTimeout(state.postingTimer);
  state.postingTimer = null;
  if (!state.posting || !hasAccess(state)) { stopPostingLoop(state); return; }
  const delay = state.intervalMinutes * 60_000;
  state.nextRunAt = Date.now() + delay;
  state.postingTimer = setTimeout(async () => {
    state.postingTimer = null;
    state.nextRunAt = null;
    await runCycle(state);
    if (state.posting) scheduleNextCycle(state);
  }, delay);
}
function startPostingLoop(state) {
  if (state.posting || !hasAccess(state)) return;
  state.posting = true;
  state.nextRunAt = null;
  void (async () => {
    await runCycle(state);
    if (state.posting && !state.postingTimer) scheduleNextCycle(state);
  })();
}

function groupList(state) { return state.groups.length ? state.groups.map((g, i) => `${i + 1}. ${destinationLabel(g)}`).join("\n") : "No destinations added."; }
function groupsKeyboard(state) {
  const kb = new InlineKeyboard().text("➕ Add destination", "add_group");
  if (state.groups.length) kb.text("➖ Remove", "remove_group_menu");
  kb.row();
  if (state.groups.length) kb.text("🗑 Clear all", "clear_groups").row();
  return kb.text("⬅️ Back", "home");
}
async function showGroups(ctx, state) {
  await ctx.editMessageText(`👥 GROUPS & CHANNELS\n\n${groupList(state)}\n\nAdd @TelePilottBot as an admin in each destination first. In a group, you can also send /addhere while you are a group admin.`, { reply_markup: groupsKeyboard(state) });
}
async function showRemoveGroupPage(ctx, state, requestedPage = 0) {
  const pages = Math.max(1, Math.ceil(state.groups.length / REMOVE_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
  const start = page * REMOVE_PAGE_SIZE;
  const kb = new InlineKeyboard();
  state.groups.slice(start, start + REMOVE_PAGE_SIZE).forEach((g, offset) => kb.text(`❌ ${destinationLabel(g).slice(0, 40)}`, `remove_group:${start + offset}:${page}`).row());
  if (pages > 1) {
    if (page > 0) kb.text("◀️ Prev", `remove_group_menu:${page - 1}`);
    if (page < pages - 1) kb.text("Next ▶️", `remove_group_menu:${page + 1}`);
    kb.row();
  }
  kb.text("⬅️ Back", "groups");
  await ctx.editMessageText(`➖ REMOVE DESTINATION\n\nPage ${page + 1}/${pages}\nChoose a destination to remove:`, { reply_markup: kb });
}

bot.use(async (ctx, next) => {
  if (ctx.callbackQuery && ctx.chat && ctx.chat.type !== "private") {
    try { await ctx.answerCallbackQuery({ text: "Use TelePilot controls in a private chat." }); } catch {}
    return;
  }
  await next();
});

bot.command("start", async ctx => {
  if (!privateOnly(ctx)) return;
  const state = stateFromCtx(ctx);
  if (!hasAccess(state)) return showAccess(ctx, state, true);
  await showHome(ctx, state);
});
bot.command("genkey", async ctx => {
  if (!privateOnly(ctx) || !isAdmin(ctx.from?.id)) return;
  const arg = String(ctx.message?.text || "").trim().split(/\s+/)[1]?.toLowerCase();
  let duration;
  if (arg === "lifetime") duration = "lifetime";
  else if (/^\d+$/.test(arg || "")) {
    const days = Number(arg);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return ctx.reply("Usage: /genkey 30, /genkey 90, or /genkey lifetime");
    duration = days;
  } else return ctx.reply("Usage: /genkey 30, /genkey 90, or /genkey lifetime");
  const { key, record } = generateLicenseKey(duration);
  await ctx.reply(`🔑 New ${duration === "lifetime" ? "lifetime" : `${duration}-day`} key\n\n${key}\n\nID: ${record.id}\nSingle use. The full key is shown only in this message.`);
});
bot.command("keys", async ctx => {
  if (!privateOnly(ctx) || !isAdmin(ctx.from?.id)) return;
  const db = loadKeyDb();
  const rows = db.keys.slice(-25).reverse();
  if (!rows.length) return ctx.reply("No keys generated yet.");
  const activeUnused = db.keys.filter(k => !k.revokedAt && !k.redeemedAt).length;
  const redeemed = db.keys.filter(k => !!k.redeemedAt && !k.revokedAt).length;
  const text = rows.map(k => {
    const status = k.revokedAt ? "🚫 revoked" : k.redeemedAt ? "✅ redeemed" : "🟢 unused";
    const plan = k.lifetime ? "lifetime" : `${k.durationDays}d`;
    return `${k.id} • ${plan} • ${status} • ${k.hint}`;
  }).join("\n");
  await ctx.reply(`🔑 KEYS\n\nUnused: ${activeUnused}\nRedeemed: ${redeemed}\n\nLatest:\n${text}\n\nRevoke with /revoke <key or ID>`);
});
bot.command("revoke", async ctx => {
  if (!privateOnly(ctx) || !isAdmin(ctx.from?.id)) return;
  const arg = String(ctx.message?.text || "").trim().split(/\s+/).slice(1).join(" ");
  if (!arg) return ctx.reply("Usage: /revoke <key or key ID>");
  const result = revokeKey(arg);
  if (!result.ok) return ctx.reply(result.error);
  await ctx.reply(`🚫 Key ${result.record.id} revoked${result.record.redeemedBy ? ". The linked user's current access was revoked too." : "."}`);
});

bot.command("addhere", async ctx => {
  if (!ctx.from || !ctx.chat || !["group", "supergroup"].includes(ctx.chat.type)) return;
  const state = getState(ctx.from.id);
  if (!hasAccess(state)) return ctx.reply("Your TelePilot access is inactive. Redeem a key in private chat first.");
  let member;
  try { member = await bot.api.getChatMember(ctx.chat.id, ctx.from.id); }
  catch { return ctx.reply("I couldn't verify your group permissions."); }
  if (!["creator", "administrator"].includes(member.status)) return ctx.reply("Only a group admin can link this group to their TelePilot profile.");
  let destination;
  try { destination = await resolveDestination(ctx.chat.id, ctx.from.id); }
  catch (err) { return ctx.reply(err?.message || "TelePilot cannot post here yet."); }
  if (!state.groups.some(g => g.id === destination.id)) {
    if (state.groups.length >= MAX_GROUPS) return ctx.reply(`You reached the ${MAX_GROUPS}-destination limit.`);
    state.groups.push(destination);
    saveState(state);
  }
  await ctx.reply(`✅ ${destinationLabel(destination)} added to your TelePilot profile.`);
});

bot.use(async (ctx, next) => {
  if (!privateOnly(ctx) || !ctx.from) return next();
  const state = getState(ctx.from.id);
  if (isAdmin(ctx.from.id) || hasAccess(state)) return next();
  const data = ctx.callbackQuery?.data;
  const text = ctx.message?.text || "";
  if (data === "redeem_key" || data === "access") return next();
  if (state.awaiting === "license_key" && ctx.message?.text) return next();
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return next();
  if (ctx.callbackQuery) {
    try { await ctx.answerCallbackQuery({ text: "Redeem an access key first.", show_alert: true }); } catch {}
    return showAccess(ctx, state, true);
  }
  return showAccess(ctx, state, true);
});

bot.callbackQuery("access", async ctx => { await ctx.answerCallbackQuery(); await showAccess(ctx, stateFromCtx(ctx)); });
bot.callbackQuery("redeem_key", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  state.awaiting = "license_key";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  await ctx.editMessageText("🔑 REDEEM KEY\n\nSend your TelePilot access key.\n\nExample: TP-XXXX-XXXX-XXXX", { reply_markup: new InlineKeyboard().text("⬅️ Cancel", "access") });
});
bot.callbackQuery("home", async ctx => { await ctx.answerCallbackQuery(); await showHome(ctx, stateFromCtx(ctx)); });
bot.callbackQuery("message", async ctx => {
  await ctx.answerCallbackQuery(); const state = stateFromCtx(ctx); clearAwaiting(state);
  const kb = new InlineKeyboard();
  if (state.adMessage) kb.text("👁 Preview", "message_preview").text("✏️ Change", "message_change").row(); else kb.text("➕ Set message", "message_change").row();
  kb.text("⬅️ Back", "home");
  await ctx.editMessageText(`📝 AD MESSAGE\n\n${state.adMessage ? `✅ Saved • ${state.adMessage.length} characters` : "❌ No message set yet."}`, { reply_markup: kb });
});
bot.callbackQuery("message_change", async ctx => {
  await ctx.answerCallbackQuery(); const state = stateFromCtx(ctx);
  state.awaiting = "message"; state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null; state.awaitingPromptChatId = ctx.chat?.id || null;
  await ctx.editMessageText("✏️ SET AD MESSAGE\n\nSend the message you want TelePilot to post. Telegram formatting is preserved.", { reply_markup: new InlineKeyboard().text("⬅️ Cancel", "message") });
});
bot.callbackQuery("message_preview", async ctx => {
  await ctx.answerCallbackQuery(); const state = stateFromCtx(ctx); const kb = new InlineKeyboard().text("✏️ Change", "message_change").row().text("⬅️ Back", "message");
  if (!state.adMessage) return ctx.editMessageText("No message set.", { reply_markup: kb });
  try { await ctx.editMessageText(state.adMessage, { reply_markup: kb, ...(state.adEntities.length ? { entities: state.adEntities } : {}) }); }
  catch { await ctx.editMessageText(state.adMessage, { reply_markup: kb }); }
});

bot.callbackQuery("groups", async ctx => { await ctx.answerCallbackQuery(); const state = stateFromCtx(ctx); clearAwaiting(state); await showGroups(ctx, state); });
bot.callbackQuery("add_group", async ctx => {
  await ctx.answerCallbackQuery(); const state = stateFromCtx(ctx);
  if (state.groups.length >= MAX_GROUPS) return ctx.editMessageText(`👥 GROUPS & CHANNELS\n\nYou reached the ${MAX_GROUPS}-destination limit.`, { reply_markup: new InlineKeyboard().text("➖ Remove", "remove_group_menu").row().text("⬅️ Back", "groups") });
  state.awaiting = "group"; state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null; state.awaitingPromptChatId = ctx.chat?.id || null;
  await ctx.editMessageText("➕ ADD DESTINATION\n\n1. Add @TelePilottBot as an admin in the group/channel.\n2. For channels, give it permission to post.\n3. Send the public @username or t.me link here.\n\nFor groups without a public username, send /addhere inside that group while you are an admin.", { reply_markup: new InlineKeyboard().text("⬅️ Cancel", "groups") });
});
bot.callbackQuery("remove_group_menu", async ctx => { await ctx.answerCallbackQuery(); await showRemoveGroupPage(ctx, stateFromCtx(ctx), 0); });
bot.callbackQuery(/^remove_group_menu:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); await showRemoveGroupPage(ctx, stateFromCtx(ctx), Number(ctx.match[1])); });
bot.callbackQuery(/^remove_group:(\d+):(\d+)$/, async ctx => {
  const state = stateFromCtx(ctx), i = Number(ctx.match[1]), page = Number(ctx.match[2]);
  if (!Number.isInteger(i) || i < 0 || i >= state.groups.length) return ctx.answerCallbackQuery({ text: "That destination is no longer in your list." });
  const [removed] = state.groups.splice(i, 1);
  if (state.posting && !state.groups.length) stopPostingLoop(state);
  saveState(state);
  await ctx.answerCallbackQuery({ text: `Removed ${destinationLabel(removed)}` });
  if (state.groups.length) await showRemoveGroupPage(ctx, state, page); else await showGroups(ctx, state);
});
bot.callbackQuery("clear_groups", async ctx => {
  await ctx.answerCallbackQuery(); const state = stateFromCtx(ctx);
  await ctx.editMessageText(`🗑 CLEAR DESTINATIONS\n\nRemove all ${state.groups.length} saved destinations?`, { reply_markup: new InlineKeyboard().text("⚠️ Yes, clear all", "clear_groups_confirm").row().text("⬅️ Cancel", "groups") });
});
bot.callbackQuery("clear_groups_confirm", async ctx => {
  const state = stateFromCtx(ctx); state.groups = []; stopPostingLoop(state); saveState(state);
  await ctx.answerCallbackQuery({ text: "Destinations cleared" }); await showGroups(ctx, state);
});

bot.callbackQuery("interval", async ctx => {
  await ctx.answerCallbackQuery(); const state = stateFromCtx(ctx);
  const kb = new InlineKeyboard().text("1m", "i1").text("5m", "i5").text("10m", "i10").row().text("15m", "i15").text("30m", "i30").text("45m", "i45").row().text("1h", "i60").text("1h 30m", "i90").text("2h", "i120").row().text("⬅️ Back", "home");
  await ctx.editMessageText(`⏱ INTERVAL\n\nCurrent: ${formatInterval(state.intervalMinutes)}\n\nChoose how often TelePilot should post.`, { reply_markup: kb });
});
for (const minutes of INTERVAL_VALUES) bot.callbackQuery(`i${minutes}`, async ctx => {
  const state = stateFromCtx(ctx); state.intervalMinutes = minutes; saveState(state); if (state.posting) scheduleNextCycle(state);
  await ctx.answerCallbackQuery({ text: `Set to ${formatInterval(minutes)}` }); await showHome(ctx, state);
});

bot.callbackQuery("activity", async ctx => {
  await ctx.answerCallbackQuery(); const state = stateFromCtx(ctx);
  await ctx.editMessageText(["📊 ACTIVITY", "", `Status: ${state.posting ? "🟢 Running" : "⚪ Stopped"}`, `Total successful posts: ${state.totalSent}`, `Last cycle: ${formatAgo(state.lastRunAt)}`, `Last result: ${state.lastRunAt ? `✅ ${state.lastCycleSuccess} sent • ❌ ${state.lastCycleFailed} failed` : "No runs yet"}`, `Next cycle: ${state.posting ? formatUntil(state) : "—"}`].join("\n"), { reply_markup: new InlineKeyboard().text("🔄 Refresh", "activity").row().text("⬅️ Back", "home") });
});
bot.callbackQuery("start", async ctx => {
  const state = stateFromCtx(ctx);
  if (!hasAccess(state)) return ctx.answerCallbackQuery({ text: "Your TelePilot access is inactive.", show_alert: true });
  if (state.posting) return ctx.answerCallbackQuery({ text: "TelePilot is already running." });
  if (!state.adMessage) return ctx.answerCallbackQuery({ text: "Set an ad message first.", show_alert: true });
  if (!state.groups.length) return ctx.answerCallbackQuery({ text: "Add at least one group/channel first.", show_alert: true });
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`▶️ START TELEPILOT\n\nDestinations: ${state.groups.length}\nInterval: ${formatInterval(state.intervalMinutes)}\n\nTelePilot will post as @${botInfo.username} once immediately, then continue on your selected interval.`, { reply_markup: new InlineKeyboard().text("▶️ Confirm start", "start_confirm").row().text("⬅️ Cancel", "home") });
});
bot.callbackQuery("start_confirm", async ctx => {
  const state = stateFromCtx(ctx); await ctx.answerCallbackQuery({ text: "Starting…" });
  if (!hasAccess(state) || !state.adMessage || !state.groups.length) return showHome(ctx, state);
  startPostingLoop(state); await showHome(ctx, state);
});
bot.callbackQuery("stop", async ctx => {
  const state = stateFromCtx(ctx), was = state.posting; if (was) stopPostingLoop(state);
  await ctx.answerCallbackQuery({ text: was ? "TelePilot stopped" : "TelePilot is already stopped." }); if (was) await showHome(ctx, state);
});

bot.on("message:text", async ctx => {
  if (!privateOnly(ctx)) return;
  const state = stateFromCtx(ctx); if (!state?.awaiting) return;
  if (state.awaiting === "license_key") {
    const pm = state.awaitingPromptMessageId, pc = state.awaitingPromptChatId || ctx.chat.id;
    const result = redeemLicenseKey(state, ctx.message.text);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!result.ok) {
      const n = await ctx.reply(`❌ ${result.error}\n\nSend a valid key or tap Cancel.`);
      setTimeout(() => void safeDelete(ctx.chat.id, n.message_id), 8000);
      return;
    }
    clearAwaiting(state);
    const plan = result.record.lifetime ? "Lifetime" : `${result.record.durationDays} days`;
    await autoDeleteNotice(ctx.chat.id, `✅ Key redeemed. ${plan} of TelePilot access activated.`, 8000);
    if (!(await editDashboard(pc, pm, state))) await ctx.reply(dashboard(state), { reply_markup: mainKeyboard() });
    return;
  }
  if (!hasAccess(state)) return showAccess(ctx, state, true);
  if (state.awaiting === "message") {
    const pm = state.awaitingPromptMessageId, pc = state.awaitingPromptChatId || ctx.chat.id;
    state.adMessage = ctx.message.text; state.adEntities = sanitizeBotEntities(ctx.message.entities || []); clearAwaiting(state); saveState(state);
    await safeDelete(ctx.chat.id, ctx.message.message_id); if (!(await editDashboard(pc, pm, state))) await ctx.reply(dashboard(state), { reply_markup: mainKeyboard() }); return;
  }
  if (state.awaiting === "group") {
    const target = normalizeTarget(ctx.message.text);
    if (!target) { const n = await ctx.reply("I couldn't read that. Send a public @username or t.me/username link. For private groups, use /addhere inside the group."); setTimeout(() => void safeDelete(ctx.chat.id, n.message_id), 8000); return; }
    let destination;
    try { destination = await resolveDestination(target, state.uid); }
    catch (err) { const n = await ctx.reply(`❌ ${err?.message || "TelePilot cannot post there yet."}`); setTimeout(() => void safeDelete(ctx.chat.id, n.message_id), 9000); return; }
    if (state.groups.length >= MAX_GROUPS && !state.groups.some(g => g.id === destination.id)) { clearAwaiting(state); await safeDelete(ctx.chat.id, ctx.message.message_id); await autoDeleteNotice(ctx.chat.id, `You reached the ${MAX_GROUPS}-destination limit.`); return showHome(ctx, state); }
    const pm = state.awaitingPromptMessageId, pc = state.awaitingPromptChatId || ctx.chat.id;
    if (!state.groups.some(g => g.id === destination.id)) state.groups.push(destination);
    clearAwaiting(state); saveState(state); await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!(await editDashboard(pc, pm, state))) await ctx.reply(dashboard(state), { reply_markup: mainKeyboard() });
  }
});

const healthServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ ok: true, service: "TelePilot" }));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
healthServer.listen(PORT, "0.0.0.0", () => console.log(`TelePilot health server listening on port ${PORT}`));

const idleSweep = setInterval(() => {
  const cutoff = Date.now() - IDLE_STATE_MS;
  for (const [key, state] of states) {
    if (state.posting || state.awaiting || state.cyclePromise || state.lastTouchedAt > cutoff) continue;
    states.delete(key);
  }
}, 10 * 60_000);
idleSweep.unref?.();

bot.catch(err => console.error("Bot error:", err.error));
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`TelePilot shutting down (${signal})…`);
  clearInterval(idleSweep);
  try { bot.stop(); } catch {}
  for (const state of states.values()) {
    stopPostingLoop(state);
    try { await state.cyclePromise; } catch {}
  }
  await new Promise(resolve => healthServer.close(resolve));
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`TelePilot key-access bot mode starting with ${ADMIN_IDS.size} admin profile(s)…`);
await bot.start({ onStart: info => console.log(`Control bot running as @${info.username}`) });
