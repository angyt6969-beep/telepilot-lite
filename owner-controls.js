import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import { secureLicenseHash } from "./security-core.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const TEAM_FILE = path.join(DATA_DIR, "telepilot-admin-team.json");
const ADMIN_FILE = path.join(DATA_DIR, "telepilot-admin.json");
const LEGACY_SETTINGS_FILE = path.join(DATA_DIR, "telepilot-settings.json");
const APPROVAL_FILE = path.join(DATA_DIR, "telepilot-admin-approvals.json");
const KEY_FILE = path.join(DATA_DIR, "access-keys.json");
const ADMIN_EVENT_FILE = path.join(DATA_DIR, "admin-events.jsonl");
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const APPROVAL_TTL_MS = 15 * 60_000;

export const ACCOUNTS_BUTTON_CUSTOM_EMOJI_ID = "5426991207731437507";
export const START_BUTTON_CUSTOM_EMOJI_ID = "5280863578369311403";
export const STOP_BUTTON_CUSTOM_EMOJI_ID = "5280474686260527507";

const pendingAdminInput = new Set();

function readJson(file, fallback = {}) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function idsFrom(value) {
  return [...new Set(String(value || "").split(/[\s,;]+/).filter(id => /^\d+$/.test(id)))];
}
function logAdmin(type, data = {}) {
  try { fs.appendFileSync(ADMIN_EVENT_FILE, `${JSON.stringify({ ts: Date.now(), type, ...data })}\n`, { mode: 0o600 }); } catch {}
}
function normalizeAdmin(item) {
  const id = String(item?.id || "");
  if (!/^\d+$/.test(id)) return null;
  return {
    id,
    status: item?.status === "suspended" ? "suspended" : "active",
    username: String(item?.username || "").replace(/^@/, "").slice(0, 64),
    name: String(item?.name || "").slice(0, 100),
    addedAt: Number(item?.addedAt || 0) || Date.now(),
    addedBy: String(item?.addedBy || ""),
  };
}
function loadTeam() {
  const raw = readJson(TEAM_FILE, {});
  const owners = new Set((Array.isArray(raw?.owners) ? raw.owners : []).map(String).filter(id => /^\d+$/.test(id)));
  const legacySettings = readJson(LEGACY_SETTINGS_FILE, {});
  const legacyAdmin = readJson(ADMIN_FILE, {});
  idsFrom(process.env.TELEPILOT_OWNER_ID).forEach(id => owners.add(id));
  idsFrom(process.env.OWNER_ID).forEach(id => owners.add(id));
  if (/^\d+$/.test(String(legacySettings?.ownerId || ""))) owners.add(String(legacySettings.ownerId));

  const legacyIds = [
    ...idsFrom(process.env.TELEPILOT_ADMIN_ID),
    ...(Array.isArray(legacyAdmin?.adminIds) ? legacyAdmin.adminIds.map(String).filter(id => /^\d+$/.test(id)) : []),
  ];
  if (!owners.size && legacyIds.length) owners.add(legacyIds[0]);

  const admins = new Map();
  for (const item of Array.isArray(raw?.admins) ? raw.admins : []) {
    const admin = normalizeAdmin(item);
    if (admin && !owners.has(admin.id)) admins.set(admin.id, admin);
  }
  for (const id of legacyIds) {
    if (!owners.has(id) && !admins.has(id)) admins.set(id, normalizeAdmin({ id, addedBy: "migration" }));
  }
  return { version: 1, owners: [...owners], admins: [...admins.values()] };
}
function saveTeam(team) {
  const clean = {
    version: 1,
    owners: [...new Set((team?.owners || []).map(String).filter(id => /^\d+$/.test(id)))],
    admins: (team?.admins || []).map(normalizeAdmin).filter(Boolean),
  };
  writeJsonAtomic(TEAM_FILE, clean);
  return clean;
}
function syncAdminFile(team = loadTeam()) {
  const adminIds = [...new Set([...team.owners, ...team.admins.filter(item => item.status === "active").map(item => item.id)])];
  writeJsonAtomic(ADMIN_FILE, { version: 1, adminIds });
  return adminIds;
}
function bootstrapTeam() {
  const team = saveTeam(loadTeam());
  syncAdminFile(team);
  return team;
}
function roleOf(uid) {
  const id = String(uid || "");
  const team = loadTeam();
  if (team.owners.includes(id)) return "owner";
  const admin = team.admins.find(item => item.id === id);
  return admin?.status === "active" ? "admin" : null;
}
function isOwner(uid) { return roleOf(uid) === "owner"; }

function canAdminUse(data) {
  const value = String(data || "");
  if (value === "admin") return true;
  if (!value.startsWith("admin_")) return true;
  if (value.startsWith("admin_team") || value.startsWith("admin_approval_key:")) return false;
  if (value === "admin_security" || value.startsWith("admin_security_") || value.startsWith("admin_cancel_logins")) return false;
  if (value.includes("_disconnect") || value.includes("_reset")) return false;
  if (value === "admin_key_custom" || value.startsWith("admin_key_custom")) return false;
  return true;
}

function loadApprovals() {
  const raw = readJson(APPROVAL_FILE, { version: 1, requests: [] });
  return { version: 1, requests: Array.isArray(raw?.requests) ? raw.requests : [] };
}
function saveApprovals(db) { writeJsonAtomic(APPROVAL_FILE, { version: 1, requests: (db?.requests || []).slice(-500) }); }
function durationLabel(duration) { return `${Number(duration)} days`; }
function pendingApprovalCount() {
  const now = Date.now();
  return loadApprovals().requests.filter(item => item.status === "pending" && Number(item.expiresAt || 0) > now).length;
}

function loadKeyDb() {
  const db = readJson(KEY_FILE, { version: 2, keys: [] });
  return { version: 2, keys: Array.isArray(db?.keys) ? db.keys : [] };
}
function saveKeyDb(db) { writeJsonAtomic(KEY_FILE, { version: 2, keys: db.keys }); }
function segment(length = 5) {
  let out = "";
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  return out;
}
function generateKey(days) {
  const db = loadKeyDb();
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = `TP-${segment()}-${segment()}-${segment()}-${segment()}`;
    const hash = secureLicenseHash(key);
    if (db.keys.some(item => item.hash === hash)) continue;
    const record = {
      id: crypto.randomBytes(5).toString("hex"), hash, hashVersion: 2,
      hint: `${key.slice(0, 8)}-•••••-•••••-•••••`, durationDays: Number(days), lifetime: false,
      boundTo: null, createdAt: Date.now(), redeemedAt: null, redeemedBy: null, revokedAt: null,
    };
    db.keys.push(record);
    saveKeyDb(db);
    return { key, record };
  }
  throw new Error("Could not generate a unique key");
}

async function requestKeyApproval(ctx, rawDuration) {
  if (roleOf(ctx.from?.id) !== "admin") return false;
  if (rawDuration === "lifetime") {
    await ctx.answerCallbackQuery({ text: "Lifetime keys are owner-only.", show_alert: true }).catch(() => {});
    return true;
  }
  const days = Number(rawDuration);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    await ctx.answerCallbackQuery({ text: "Choose one of the available durations.", show_alert: true }).catch(() => {});
    return true;
  }
  const db = loadApprovals();
  const now = Date.now();
  for (const request of db.requests) if (request.status === "pending" && Number(request.expiresAt || 0) <= now) request.status = "expired";
  const duplicate = db.requests.find(request => request.status === "pending" && String(request.requesterId) === String(ctx.from.id) && Number(request.duration) === days);
  if (duplicate) {
    saveApprovals(db);
    await ctx.answerCallbackQuery({ text: "That approval request is already pending.", show_alert: true }).catch(() => {});
    return true;
  }
  const request = {
    id: crypto.randomBytes(6).toString("hex"), requesterId: String(ctx.from.id),
    requesterUsername: String(ctx.from?.username || "").slice(0, 64),
    requesterName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").slice(0, 100),
    duration: days, status: "pending", createdAt: now, expiresAt: now + APPROVAL_TTL_MS,
  };
  db.requests.push(request);
  saveApprovals(db);
  logAdmin("key_approval_requested", { actorUid: request.requesterId, requestId: request.id, duration: `${days}d` });
  await ctx.answerCallbackQuery({ text: "Approval request sent to the owner." }).catch(() => {});
  try {
    await ctx.editMessageText(`⏳ KEY APPROVAL PENDING\n\nRequested: ${days} days\nExpires in: 15 minutes\n\nThe key will only be generated after owner approval.`, { reply_markup: new InlineKeyboard().text("⬅️ Keys", "admin_keys") });
  } catch {}
  const who = request.requesterUsername ? `@${request.requesterUsername}` : request.requesterName || request.requesterId;
  for (const ownerId of loadTeam().owners) {
    try {
      await ctx.api.sendMessage(Number(ownerId), `🔐 KEY APPROVAL REQUEST\n\nRequested by: ${who}\nTelegram ID: ${request.requesterId}\nDuration: ${days} days\nExpires: 15 minutes`, {
        reply_markup: new InlineKeyboard().text("✅ Approve", `admin_approval_key:approve:${request.id}`).text("❌ Reject", `admin_approval_key:reject:${request.id}`),
      });
    } catch {}
  }
  return true;
}

async function decideKeyRequest(ctx, decision, id) {
  if (!isOwner(ctx.from?.id)) return;
  const db = loadApprovals();
  const request = db.requests.find(item => String(item.id) === String(id));
  if (!request || request.status !== "pending") {
    await ctx.answerCallbackQuery({ text: "This request is no longer pending.", show_alert: true }).catch(() => {});
    return;
  }
  if (Number(request.expiresAt || 0) <= Date.now()) {
    request.status = "expired"; saveApprovals(db);
    await ctx.answerCallbackQuery({ text: "This request expired.", show_alert: true }).catch(() => {});
    try { await ctx.editMessageText("⌛ KEY REQUEST EXPIRED"); } catch {}
    return;
  }
  if (decision === "reject") {
    request.status = "rejected"; request.decidedAt = Date.now(); request.decidedBy = String(ctx.from.id); saveApprovals(db);
    logAdmin("key_approval_rejected", { actorUid: String(ctx.from.id), requesterUid: request.requesterId, requestId: request.id });
    await ctx.answerCallbackQuery({ text: "Rejected." }).catch(() => {});
    try { await ctx.editMessageText(`❌ KEY REQUEST REJECTED\n\n${durationLabel(request.duration)} request from ${request.requesterUsername ? `@${request.requesterUsername}` : request.requesterId}.`); } catch {}
    try { await ctx.api.sendMessage(Number(request.requesterId), `❌ Your ${durationLabel(request.duration)} key request was rejected by the owner.`); } catch {}
    return;
  }

  let placeholder;
  try { placeholder = await ctx.api.sendMessage(Number(request.requesterId), "✅ Your key request was approved. Generating the key securely…"); }
  catch {
    await ctx.answerCallbackQuery({ text: "I cannot deliver to that admin right now, so no key was generated.", show_alert: true }).catch(() => {});
    return;
  }
  const { key, record } = generateKey(request.duration);
  request.status = "approved"; request.decidedAt = Date.now(); request.decidedBy = String(ctx.from.id); request.keyId = record.id; saveApprovals(db);
  logAdmin("key_approval_approved", { actorUid: String(ctx.from.id), requesterUid: request.requesterId, requestId: request.id, keyId: record.id, duration: `${request.duration}d` });
  logAdmin("key_generated", { actorUid: request.requesterId, approvedBy: String(ctx.from.id), keyId: record.id, duration: `${request.duration}d` });
  const kb = new InlineKeyboard().copyText("📋 Copy key", key).row().text("🔑 Key Management", "admin_keys");
  const keyText = `🔑 NEW KEY\n\n${key}\n\nDuration: ${durationLabel(request.duration)}\nApproved by owner.`;
  try { await ctx.api.editMessageText(Number(request.requesterId), placeholder.message_id, keyText, { reply_markup: kb }); }
  catch { try { await ctx.api.sendMessage(Number(request.requesterId), keyText, { reply_markup: kb }); } catch {} }
  await ctx.answerCallbackQuery({ text: "Approved and delivered." }).catch(() => {});
  try { await ctx.editMessageText(`✅ KEY REQUEST APPROVED\n\n${durationLabel(request.duration)} key generated for ${request.requesterUsername ? `@${request.requesterUsername}` : request.requesterId}.\nKey ID: ${record.id}`); } catch {}
}

async function render(ctx, text, keyboard) {
  const opts = keyboard ? { reply_markup: keyboard } : {};
  try { if (ctx.callbackQuery?.message) return await ctx.editMessageText(text, opts); }
  catch (err) { if (String(err?.description || err?.message || "").toLowerCase().includes("message is not modified")) return; }
  return ctx.reply(text, opts);
}
function adminLabel(admin) { return admin?.username ? `@${admin.username}` : admin?.name || admin?.id || "Unknown"; }
async function showAdminTeam(ctx) {
  const team = loadTeam();
  const kb = new InlineKeyboard().text("➕ Add Admin", "admin_team_add").row();
  for (const admin of team.admins.slice(0, 20)) kb.text(`${admin.status === "active" ? "✅" : "⏸"} ${adminLabel(admin).slice(0, 34)}`, `admin_team_member:${admin.id}`).row();
  const pending = pendingApprovalCount();
  kb.text(`🔐 Pending Approvals${pending ? ` (${pending})` : ""}`, "admin_team_approvals").row().text("⬅️ Admin", "admin");
  return render(ctx, `👑 ADMIN TEAM\n\nOwners: ${team.owners.length}\nActive admins: ${team.admins.filter(item => item.status === "active").length}\n\nAdmins can manage customers and request keys. Security lockdown, admin management, account disconnect/reset, custom keys and Lifetime keys remain owner-only.`, kb);
}
async function showAdminMember(ctx, id) {
  const admin = loadTeam().admins.find(item => item.id === String(id));
  if (!admin) return showAdminTeam(ctx);
  const kb = new InlineKeyboard()
    .text(admin.status === "active" ? "⏸ Suspend" : "▶️ Resume", `admin_team_${admin.status === "active" ? "suspend" : "resume"}:${admin.id}`).row()
    .text("🗑 Remove Admin", `admin_team_remove:${admin.id}`).danger().row()
    .text("⬅️ Admin Team", "admin_team");
  return render(ctx, `🛡 ADMIN\n\nUser: ${adminLabel(admin)}\nTelegram ID: ${admin.id}\nStatus: ${admin.status === "active" ? "Active" : "Suspended"}`, kb);
}
async function showApprovals(ctx) {
  const db = loadApprovals();
  const now = Date.now(); let changed = false;
  for (const item of db.requests) if (item.status === "pending" && Number(item.expiresAt || 0) <= now) { item.status = "expired"; changed = true; }
  if (changed) saveApprovals(db);
  const pending = db.requests.filter(item => item.status === "pending").slice(-20).reverse();
  const kb = new InlineKeyboard();
  for (const item of pending) kb.text(`🔐 ${item.requesterUsername ? `@${item.requesterUsername}` : item.requesterId} • ${durationLabel(item.duration)}`, `admin_team_approval:${item.id}`).row();
  kb.text("⬅️ Admin Team", "admin_team");
  return render(ctx, `🔐 PENDING APPROVALS\n\n${pending.length ? `${pending.length} request(s) waiting for you.` : "No approval requests are waiting."}`, kb);
}
async function showApproval(ctx, id) {
  const request = loadApprovals().requests.find(item => String(item.id) === String(id));
  if (!request || request.status !== "pending") return showApprovals(ctx);
  const who = request.requesterUsername ? `@${request.requesterUsername}` : request.requesterName || request.requesterId;
  return render(ctx, `🔐 KEY APPROVAL REQUEST\n\nRequested by: ${who}\nTelegram ID: ${request.requesterId}\nDuration: ${durationLabel(request.duration)}`, new InlineKeyboard()
    .text("✅ Approve", `admin_approval_key:approve:${request.id}`).text("❌ Reject", `admin_approval_key:reject:${request.id}`).row()
    .text("⬅️ Approvals", "admin_team_approvals"));
}
function scheduleRestart(ctx, message) {
  if (!process.env.RAILWAY_PUBLIC_DOMAIN) return;
  void ctx.reply(`✅ ${message}\n\nApplying the permission change now…`).catch(() => {});
  setTimeout(() => process.exit(0), 900);
}
async function handleAdminIdText(ctx) {
  const ownerId = String(ctx.from?.id || "");
  if (!pendingAdminInput.has(ownerId) || !isOwner(ownerId)) return false;
  const id = String(ctx.message?.text || "").trim();
  if (!/^\d+$/.test(id)) { await ctx.reply("❌ Send the person's numeric Telegram user ID."); return true; }
  pendingAdminInput.delete(ownerId);
  const team = loadTeam();
  if (team.owners.includes(id)) { await ctx.reply("That Telegram ID is already an owner."); return true; }
  let username = "", name = "";
  try { const chat = await ctx.api.getChat(Number(id)); username = String(chat?.username || ""); name = [chat?.first_name, chat?.last_name].filter(Boolean).join(" "); } catch {}
  const existing = team.admins.find(item => item.id === id);
  if (existing) { existing.status = "active"; if (username) existing.username = username; if (name) existing.name = name; }
  else team.admins.push(normalizeAdmin({ id, username, name, addedAt: Date.now(), addedBy: ownerId }));
  saveTeam(team); syncAdminFile(team); logAdmin("admin_team_member_added", { actorUid: ownerId, uid: id });
  await ctx.reply(`✅ Admin added for Telegram ID ${id}.`);
  scheduleRestart(ctx, "Admin team updated.");
  return true;
}
function registerOwnerHandlers(bot) {
  bot.callbackQuery("admin_team", async ctx => { if (isOwner(ctx.from?.id)) await showAdminTeam(ctx); });
  bot.callbackQuery("admin_team_add", async ctx => {
    if (!isOwner(ctx.from?.id)) return;
    pendingAdminInput.add(String(ctx.from.id));
    await render(ctx, "➕ ADD ADMIN\n\nSend the person's numeric Telegram user ID.", new InlineKeyboard().text("⬅️ Cancel", "admin_team"));
  });
  bot.callbackQuery(/^admin_team_member:(\d+)$/, async ctx => { if (isOwner(ctx.from?.id)) await showAdminMember(ctx, ctx.match[1]); });
  bot.callbackQuery(/^admin_team_(suspend|resume):(\d+)$/, async ctx => {
    if (!isOwner(ctx.from?.id)) return;
    const team = loadTeam(); const admin = team.admins.find(item => item.id === ctx.match[2]); if (!admin) return showAdminTeam(ctx);
    admin.status = ctx.match[1] === "suspend" ? "suspended" : "active"; saveTeam(team); syncAdminFile(team);
    logAdmin(admin.status === "active" ? "admin_team_member_resumed" : "admin_team_member_suspended", { actorUid: String(ctx.from.id), uid: admin.id });
    await ctx.answerCallbackQuery({ text: admin.status === "active" ? "Admin resumed." : "Admin suspended." }).catch(() => {});
    await showAdminMember(ctx, admin.id); scheduleRestart(ctx, "Admin status updated.");
  });
  bot.callbackQuery(/^admin_team_remove:(\d+)$/, async ctx => {
    if (!isOwner(ctx.from?.id)) return;
    const team = loadTeam(); const before = team.admins.length; team.admins = team.admins.filter(item => item.id !== ctx.match[1]);
    if (before === team.admins.length) return showAdminTeam(ctx);
    saveTeam(team); syncAdminFile(team); logAdmin("admin_team_member_removed", { actorUid: String(ctx.from.id), uid: ctx.match[1] });
    await ctx.answerCallbackQuery({ text: "Admin removed." }).catch(() => {}); await showAdminTeam(ctx); scheduleRestart(ctx, "Admin removed.");
  });
  bot.callbackQuery("admin_team_approvals", async ctx => { if (isOwner(ctx.from?.id)) await showApprovals(ctx); });
  bot.callbackQuery(/^admin_team_approval:([a-f0-9]+)$/, async ctx => { if (isOwner(ctx.from?.id)) await showApproval(ctx, ctx.match[1]); });
  bot.callbackQuery(/^admin_approval_key:(approve|reject):([a-f0-9]+)$/, async ctx => decideKeyRequest(ctx, ctx.match[1], ctx.match[2]));
}

function cloneOther(other) {
  if (!other) return {};
  const next = { ...other };
  if (Array.isArray(other.entities)) next.entities = other.entities.map(item => ({ ...item }));
  if (other.reply_markup?.inline_keyboard) next.reply_markup = { ...other.reply_markup, inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))) };
  return next;
}
function stripIcon(text) { return String(text || "").replace(/^[^\p{L}\p{N}]+/u, "").trim(); }
function runningDashboard(text) { return /(^|\n)(● LIVE|⏸ PAUSED)(\n|$)/.test(String(text || "")) || String(text || "").includes("Posting is running."); }
function applyDashboardUi(text, other) {
  const next = cloneOther(other); const rows = next.reply_markup?.inline_keyboard; if (!Array.isArray(rows)) return next;
  for (const row of rows) for (const button of row) if (String(button?.callback_data || "") === "v1_accounts_v13") {
    button.icon_custom_emoji_id = ACCOUNTS_BUTTON_CUSTOM_EMOJI_ID; button.text = stripIcon(button.text) || "Accounts";
  }
  if (!String(text || "").startsWith("✈️ TelePilot")) return next;
  const remaining = rows.map(row => row.filter(button => !["start", "stop"].includes(String(button?.callback_data || "")))).filter(row => row.length);
  remaining.unshift([runningDashboard(text)
    ? { text: "Stop", callback_data: "stop", icon_custom_emoji_id: STOP_BUTTON_CUSTOM_EMOJI_ID, style: "danger" }
    : { text: "Start", callback_data: "start", icon_custom_emoji_id: START_BUTTON_CUSTOM_EMOJI_ID, style: "success" }]);
  next.reply_markup.inline_keyboard = remaining; return next;
}
function applyAdminUi(chatId, text, other) {
  const next = cloneOther(other); const rows = next.reply_markup?.inline_keyboard; if (!Array.isArray(rows)) return next;
  const role = roleOf(chatId);
  next.reply_markup.inline_keyboard = rows.map(row => row.filter(button => {
    const data = String(button?.callback_data || "");
    if (data === "admin") return !!role;
    if (!data.startsWith("admin_")) return true;
    return role === "owner" || (role === "admin" && canAdminUse(data));
  })).filter(row => row.length);
  if (role === "admin" && String(text || "").startsWith("➕ GENERATE KEY")) {
    next.reply_markup.inline_keyboard = next.reply_markup.inline_keyboard.map(row => row.filter(button => !["admin_key_gen:lifetime", "admin_key_custom"].includes(String(button?.callback_data || "")))).filter(row => row.length);
  }
  if (role === "owner" && String(text || "").startsWith("🟣 TELEPILOT ADMIN") && !next.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "admin_team")) {
    const pending = pendingApprovalCount(); const row = [{ text: "👑 Admin Team", callback_data: "admin_team" }];
    if (pending) row.push({ text: `🔐 Approvals (${pending})`, callback_data: "admin_team_approvals" });
    const back = next.reply_markup.inline_keyboard.findIndex(row => row.some(button => ["home", "v1_dashboard_v13"].includes(String(button?.callback_data || ""))));
    if (back >= 0) next.reply_markup.inline_keyboard.splice(back, 0, row); else next.reply_markup.inline_keyboard.push(row);
  }
  return next;
}
export function polishOwnerControlsPayload(chatId, text, other) {
  const role = roleOf(chatId); let value = String(text || "");
  if (role === "admin") value = value.replaceAll("Owner access", "Admin access");
  let next = applyDashboardUi(value, other); next = applyAdminUi(chatId, value, next); return { text: value, other: next };
}
function premiumError(err) { const value = String(err?.description || err?.message || err || "").toUpperCase(); return value.includes("CUSTOM_EMOJI") || value.includes("CUSTOM EMOJI") || value.includes("ICON_CUSTOM_EMOJI"); }
function withoutOurIcons(other) {
  const next = cloneOther(other); const ids = new Set([ACCOUNTS_BUTTON_CUSTOM_EMOJI_ID, START_BUTTON_CUSTOM_EMOJI_ID, STOP_BUTTON_CUSTOM_EMOJI_ID]);
  for (const row of next.reply_markup?.inline_keyboard || []) for (const button of row) if (ids.has(String(button?.icon_custom_emoji_id || ""))) delete button.icon_custom_emoji_id;
  return next;
}

export function installOwnerControlsUi(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotOwnerControlsUiInstalled) return;
  const send = ApiClass.prototype.sendMessage, edit = ApiClass.prototype.editMessageText;
  if (typeof send !== "function" || typeof edit !== "function") throw new Error("Unsupported grammY Api shape for owner controls");
  Object.defineProperty(ApiClass.prototype, "__telepilotOwnerControlsUiInstalled", { value: true });
  ApiClass.prototype.sendMessage = async function(chatId, text, other, ...rest) {
    if (roleOf(chatId) === "admin" && String(text || "").startsWith("🛡 TelePilot Security")) return { message_id: 0 };
    const result = polishOwnerControlsPayload(chatId, text, other);
    try { return await send.call(this, chatId, result.text, result.other, ...rest); }
    catch (err) { if (!premiumError(err)) throw err; return send.call(this, chatId, result.text, withoutOurIcons(result.other), ...rest); }
  };
  ApiClass.prototype.editMessageText = async function(chatId, messageId, text, other, ...rest) {
    const result = polishOwnerControlsPayload(chatId, text, other);
    try { return await edit.call(this, chatId, messageId, result.text, result.other, ...rest); }
    catch (err) { if (!premiumError(err)) throw err; return edit.call(this, chatId, messageId, result.text, withoutOurIcons(result.other), ...rest); }
  };
}

export function installOwnerControlsBot(BotClass) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotOwnerControlsBotInstalled) return;
  const team = bootstrapTeam();
  console.log(`TelePilot owner controls enabled: ${team.owners.length} owner(s), ${team.admins.filter(item => item.status === "active").length} delegated admin(s)`);
  const callbackQuery = BotClass.prototype.callbackQuery, on = BotClass.prototype.on, start = BotClass.prototype.start;
  if (typeof callbackQuery !== "function" || typeof on !== "function" || typeof start !== "function") throw new Error("Unsupported grammY Bot shape for owner controls");
  Object.defineProperty(BotClass.prototype, "__telepilotOwnerControlsBotInstalled", { value: true });
  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
      const data = String(ctx.callbackQuery?.data || ""), role = roleOf(ctx.from?.id);
      if (data.startsWith("admin")) {
        if (!role || (role === "admin" && !canAdminUse(data))) { await ctx.answerCallbackQuery({ text: "You do not have permission for that admin action.", show_alert: true }).catch(() => {}); return; }
        const match = data.match(/^admin_key_gen:(\d+|lifetime)$/);
        if (role === "admin" && match) { await requestKeyApproval(ctx, match[1]); return; }
      }
      return handler.call(this, ctx, next);
    });
    return callbackQuery.call(this, trigger, ...wrapped);
  };
  BotClass.prototype.on = function(filter, ...middleware) {
    if (filter !== "message:text") return on.call(this, filter, ...middleware);
    const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) { if (await handleAdminIdText(ctx)) return; return handler.call(this, ctx, next); });
    return on.call(this, filter, ...wrapped);
  };
  BotClass.prototype.start = function(...args) {
    if (!this.__telepilotOwnerHandlersRegistered) { Object.defineProperty(this, "__telepilotOwnerHandlersRegistered", { value: true }); registerOwnerHandlers(this); }
    return start.apply(this, args);
  };
}
