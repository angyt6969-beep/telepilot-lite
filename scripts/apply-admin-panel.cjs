const fs = require('node:fs');

const APP = 'app.js';
const FRAGMENTS = [
  'scripts/admin-panel-fragment-00.txt',
  'scripts/admin-panel-fragment-01.txt',
  'scripts/admin-panel-fragment-02.txt',
  'scripts/admin-panel-fragment-03.txt',
];
let source = fs.readFileSync(APP, 'utf8');

if (source.includes('// ===== TELEPILOT ADMIN PANEL =====')) {
  console.log('Admin panel already applied.');
  process.exit(0);
}

function replaceOnce(from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  source = source.replace(from, to);
}

// Remove the artificial destination cap and make destination display safe for large lists.
replaceOnce('const MAX_GROUPS = 100;\n', '', 'remove MAX_GROUPS constant');
replaceOnce('    if (out.length >= MAX_GROUPS) break;\n', '', 'remove saved destination truncation');
replaceOnce(
`function groupList(state) {
  return state.groups.length
    ? state.groups.map((g, i) => \`${'${i + 1}'}. ${'${destinationLabel(g)}'}\`).join("\\n")
    : "No destinations added.";
}`,
`function groupList(state) {
  if (!state.groups.length) return "No destinations added.";
  const visible = state.groups.slice(0, 20);
  const lines = visible.map((g, i) => \`${'${i + 1}'}. ${'${destinationLabel(g)}'}\`);
  if (state.groups.length > visible.length) {
    lines.push(\`… and ${'${state.groups.length - visible.length}'} more. Use Remove to browse all destinations.\`);
  }
  return lines.join("\\n");
}`,
'paginate destination summary');
replaceOnce(
`  if (!state.groups.some(g => g.id === destination.id)) {
    if (state.groups.length >= MAX_GROUPS) return ctx.reply(\`You reached the ${'${MAX_GROUPS}'}-destination limit.\`);
    state.groups.push(destination);
    saveState(state);
  }`,
`  if (!state.groups.some(g => g.id === destination.id)) {
    state.groups.push(destination);
    saveState(state);
  }`,
'remove /addhere destination cap');
replaceOnce(
`  if (state.groups.length >= MAX_GROUPS) {
    return ctx.editMessageText(
      \`👥 GROUPS & CHANNELS\\n\\nYou reached the ${'${MAX_GROUPS}'}-destination limit.\`,
      { reply_markup: new InlineKeyboard().text("➖ Remove", "remove_group_menu").row().text("⬅️ Back", "groups") },
    );
  }
`,
'',
'remove add destination cap');
replaceOnce(
`    if (state.groups.length >= MAX_GROUPS && !state.groups.some(g => g.id === destination.id)) {
      clearAwaiting(state);
      await safeDelete(ctx.chat.id, ctx.message.message_id);
      await autoDeleteNotice(ctx.chat.id, \`You reached the ${'${MAX_GROUPS}'}-destination limit.\`);
      return showHome(ctx, state);
    }
`,
'',
'remove destination cap while awaiting group');

// Admin persistence and audit log files.
replaceOnce(
`const SESSION_KEY_FILE = path.join(DATA_DIR, ".personal-session-key");`,
`const SESSION_KEY_FILE = path.join(DATA_DIR, ".personal-session-key");
const ADMIN_EVENT_FILE = path.join(DATA_DIR, "admin-events.jsonl");
const ADMIN_PAGE_SIZE = 8;
const ADMIN_EVENT_MAX_BYTES = 2 * 1024 * 1024;`,
'add admin constants');

// Persist enough Telegram identity metadata to make admin user management useful.
replaceOnce(
`    personalUsername: typeof saved.personalUsername === "string" ? saved.personalUsername : "",
    postingTimer: null,`,
`    personalUsername: typeof saved.personalUsername === "string" ? saved.personalUsername : "",
    telegramUsername: typeof saved.telegramUsername === "string" ? saved.telegramUsername : "",
    telegramFirstName: typeof saved.telegramFirstName === "string" ? saved.telegramFirstName : "",
    telegramLastName: typeof saved.telegramLastName === "string" ? saved.telegramLastName : "",
    createdAt: Number.isFinite(Number(saved.createdAt)) ? Number(saved.createdAt) : null,
    lastSeenAt: Number.isFinite(Number(saved.lastSeenAt)) ? Number(saved.lastSeenAt) : null,
    postingTimer: null,`,
'add user identity state');
replaceOnce(
`    accessRevoked: state.accessRevoked,
    personalUsername: state.personalUsername,
  });`,
`    accessRevoked: state.accessRevoked,
    personalUsername: state.personalUsername,
    telegramUsername: state.telegramUsername,
    telegramFirstName: state.telegramFirstName,
    telegramLastName: state.telegramLastName,
    createdAt: state.createdAt,
    lastSeenAt: state.lastSeenAt,
  });`,
'persist user identity state');

// Put an admin-only entry on the normal dashboard. Telegram only exposes named button styles,
// so we use the primary style plus a purple visual marker.
replaceOnce(
`function mainKeyboard() {
  return new InlineKeyboard()
    .text("👤 Account", "account").text("📝 Message", "message").row()
    .text("👥 Groups", "groups").text("⏱ Interval", "interval").row()
    .text("▶️ START", "start").text("⏹ STOP", "stop").row()
    .text("📊 Activity", "activity").text("🔑 Access", "access").row()
    .text("🔄 Refresh", "home");
}`,
`function mainKeyboard(state) {
  const kb = new InlineKeyboard()
    .text("👤 Account", "account").text("📝 Message", "message").row()
    .text("👥 Groups", "groups").text("⏱ Interval", "interval").row()
    .text("▶️ START", "start").text("⏹ STOP", "stop").row()
    .text("📊 Activity", "activity").text("🔑 Access", "access").row()
    .text("🔄 Refresh", "home");
  if (state && isAdmin(state.uid)) kb.row().text("🟣 ADMIN PANEL", "admin").primary();
  return kb;
}`,
'add admin dashboard button');
source = source.replaceAll('mainKeyboard()', 'mainKeyboard(state)');

// Record identity/last-seen data for private bot users without exposing any secrets.
replaceOnce(
`bot.use(async (ctx, next) => {
  if (ctx.callbackQuery && ctx.chat && ctx.chat.type !== "private") {
    try { await ctx.answerCallbackQuery({ text: "Use TelePilot controls in a private chat." }); } catch {}
    return;
  }
  await next();
});`,
`bot.use(async (ctx, next) => {
  if (ctx.from && ctx.chat?.type === "private") syncUserIdentity(ctx, getState(ctx.from.id));
  if (ctx.callbackQuery && ctx.chat && ctx.chat.type !== "private") {
    try { await ctx.answerCallbackQuery({ text: "Use TelePilot controls in a private chat." }); } catch {}
    return;
  }
  await next();
});`,
'capture user identity');

// Add admin handlers before the normal command handlers.
const adminFragment = FRAGMENTS.map(file => fs.readFileSync(file, 'utf8')).join('').trimEnd();
replaceOnce(
'bot.command("start", async ctx => {',
`${adminFragment}\n\nbot.command("start", async ctx => {`,
'insert admin panel');

// Route admin text-input states before normal user text workflows.
replaceOnce(
`bot.on("message:text", async ctx => {
  if (!privateOnly(ctx)) return;
  const state = stateFromCtx(ctx);
  if (!state?.awaiting) return;`,
`bot.on("message:text", async ctx => {
  if (!privateOnly(ctx)) return;
  const state = stateFromCtx(ctx);
  if (state && isAdmin(state.uid) && String(state.awaiting || "").startsWith("admin_")) {
    if (await handleAdminAwaitingText(ctx, state)) return;
  }
  if (!state?.awaiting) return;`,
'route admin text states');

// Use the shared secure disconnect helper for normal users too.
replaceOnce(
`bot.callbackQuery("account_disconnect", async ctx => {
  const state = stateFromCtx(ctx);
  await ctx.answerCallbackQuery({ text: "Disconnecting…" });
  stopPostingLoop(state);
  cancelLoginAttempt(state.uid, "cancelled");
  const client = state.personalClient;
  state.personalClient = null;
  state.personalUsername = "";
  try { await client?.logOut(); } catch {}
  try { await client?.disconnect(); } catch {}
  removePersonalSession(state.uid);
  saveState(state);
  await showHome(ctx, state);
});`,
`bot.callbackQuery("account_disconnect", async ctx => {
  const state = stateFromCtx(ctx);
  await ctx.answerCallbackQuery({ text: "Disconnecting…" });
  await disconnectPersonalAccount(state, state.uid);
  await showHome(ctx, state);
});`,
'share disconnect helper');

// Audit important operational events. No phone numbers, login codes, passwords, tokens,
// API hashes, encryption material or raw sessions are logged.
replaceOnce(
`  saveKeyDb(db);
  saveState(state);
  return { ok: true, record };
}`,
`  saveKeyDb(db);
  saveState(state);
  logAdminEvent("key_redeemed", { uid: String(state.uid), keyId: record.id, duration: record.lifetime ? "lifetime" : \`${'${record.durationDays}'}d\` });
  return { ok: true, record };
}`,
'log key redemption');
replaceOnce(
`  state.personalClient = attempt.client;
  saveState(state);
  attempt.client = null;`,
`  state.personalClient = attempt.client;
  saveState(state);
  logAdminEvent("account_connected", { uid: String(state.uid) });
  attempt.client = null;`,
'log personal account connection');
replaceOnce(
`  state.lastCycleFailed = failed;
  saveState(state);
}`,
`  state.lastCycleFailed = failed;
  saveState(state);
  logAdminEvent("post_cycle", { uid: String(state.uid), success, failed });
}`,
'log posting cycle');
replaceOnce(
`  const { key, record } = generateLicenseKey(duration);
  await ctx.reply(\`🔑 New ${'${duration === "lifetime" ? "lifetime" : `${duration}-day`}'} key\\n\\n${'${key}'}\\n\\nID: ${'${record.id}'}\\nSingle use. The full key is shown only in this message.\`);`,
`  const { key, record } = generateLicenseKey(duration);
  logAdminEvent("key_generated", { actorUid: String(ctx.from.id), keyId: record.id, duration: duration === "lifetime" ? "lifetime" : \`${'${duration}'}d\` });
  await ctx.reply(\`🔑 New ${'${duration === "lifetime" ? "lifetime" : `${duration}-day`}'} key\\n\\n${'${key}'}\\n\\nID: ${'${record.id}'}\\nSingle use. The full key is shown only in this message.\`, {
    reply_markup: new InlineKeyboard().copyText("📋 Copy key", key),
  });`,
'log/copy generated command key');
replaceOnce(
`  const result = revokeKey(arg);
  if (!result.ok) return ctx.reply(result.error);
  await ctx.reply(\`🚫 Key ${'${result.record.id}'} revoked${'${result.record.redeemedBy ? ". The linked user\'s current access was revoked too." : "."}'}\`);`,
`  const result = revokeKey(arg);
  if (!result.ok) return ctx.reply(result.error);
  logAdminEvent("key_revoked", { actorUid: String(ctx.from.id), uid: result.record.redeemedBy || undefined, keyId: result.record.id });
  await ctx.reply(\`🚫 Key ${'${result.record.id}'} revoked${'${result.record.redeemedBy ? ". The linked user\'s current access was revoked too." : "."}'}\`);`,
'log command key revocation');
replaceOnce(
`  startPostingLoop(state);
  await showHome(ctx, state);`,
`  startPostingLoop(state);
  logAdminEvent("posting_started", { uid: String(state.uid) });
  await showHome(ctx, state);`,
'log posting start');
replaceOnce(
`  const was = state.posting;
  if (was) stopPostingLoop(state);
  await ctx.answerCallbackQuery({ text: was ? "TelePilot stopped" : "TelePilot is already stopped." });`,
`  const was = state.posting;
  if (was) {
    stopPostingLoop(state);
    logAdminEvent("posting_stopped", { uid: String(state.uid) });
  }
  await ctx.answerCallbackQuery({ text: was ? "TelePilot stopped" : "TelePilot is already stopped." });`,
'log posting stop');

if (source.includes('MAX_GROUPS')) throw new Error('MAX_GROUPS still present after patch');
if (!source.includes('// ===== TELEPILOT ADMIN PANEL =====')) throw new Error('Admin panel marker missing after patch');

fs.writeFileSync(APP, source);
console.log('TelePilot admin panel patch applied successfully.');
