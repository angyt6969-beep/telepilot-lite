from pathlib import Path

P = Path("app.js")
s = P.read_text()


def once(old, new, label):
    global s
    c = s.count(old)
    if c != 1:
        raise RuntimeError(f"{label}: expected one match, got {c}")
    s = s.replace(old, new, 1)


def section(start, end, new, label):
    global s
    a = s.find(start)
    if a < 0:
        raise RuntimeError(f"{label}: start not found")
    b = s.find(end, a + len(start))
    if b < 0:
        raise RuntimeError(f"{label}: end not found")
    s = s[:a] + new.rstrip() + "\n\n" + s[b:]


once(
    'import { advanceTutorialAfterAction } from "./onboarding.js";\n',
    '''import { advanceTutorialAfterAction } from "./onboarding.js";
import {
  accountDisplayLabel,
  effectiveAccountIds,
  hasAnyAccount,
  listAccounts,
  loadAccountSession,
  normalizeAccountSelection,
  removeAccount,
  removeAllAccounts,
  saveAccountSession,
  senderSummary,
  updateAccountStatus,
} from "./account-store.js";
import { withDispatchContext } from "./dispatch-context.js";
import { isFatalSessionError, readProSettings } from "./posting-engine-enhancements.js";
import { setReloadUserStateHandler } from "./runtime-hooks.js";
''',
    "imports",
)
once('// TELEPILOT_SECURITY_PACK_V1\n', '// TELEPILOT_SECURITY_PACK_V1\n// TELEPILOT_MULTI_ACCOUNT_V11\n', 'marker')

section(
    'function normalizeSavedGroups(value) {',
    'function hasAccess(state) {',
    r'''function normalizeSavedGroups(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "");
    if (!/^-\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: String(item.label || item.title || id).slice(0, 120),
      type: String(item.type || "group"),
      username: item.username ? String(item.username) : "",
      accountMode: ["inherit", "all", "selected"].includes(item.accountMode) ? item.accountMode : "inherit",
      accountIds: [...new Set((Array.isArray(item.accountIds) ? item.accountIds : []).map(String))],
    });
  }
  return out;
}
function loadUserSettings(uid) { return readJson(settingsFile(uid), {}); }
function legacyAccessGrants(saved) {
  if (Array.isArray(saved.accessGrants)) return saved.accessGrants.filter(g => g && typeof g === "object").map(g => ({
    id: String(g.id || crypto.randomBytes(6).toString("hex")),
    keyId: String(g.keyId || ""),
    source: String(g.source || "legacy"),
    lifetime: g.lifetime === true,
    expiresAt: Number(g.expiresAt || 0) || 0,
    createdAt: Number(g.createdAt || 0) || Date.now(),
    revokedAt: Number(g.revokedAt || 0) || 0,
  }));
  const grants = [];
  if (saved.accessLifetime === true) grants.push({ id: "legacy-lifetime", keyId: String(saved.accessKeyId || ""), source: "legacy", lifetime: true, expiresAt: 0, createdAt: Date.now(), revokedAt: 0 });
  else if (Number(saved.accessUntil || 0) > 0) grants.push({ id: "legacy-timed", keyId: String(saved.accessKeyId || ""), source: "legacy", lifetime: false, expiresAt: Number(saved.accessUntil), createdAt: Date.now(), revokedAt: 0 });
  return grants;
}
function recomputeAccessState(state) {
  const now = Date.now();
  const grants = Array.isArray(state.accessGrants) ? state.accessGrants : [];
  const active = grants.filter(g => !Number(g.revokedAt || 0) && (g.lifetime === true || Number(g.expiresAt || 0) > now));
  state.accessLifetime = active.some(g => g.lifetime === true);
  state.accessUntil = state.accessLifetime ? null : active.reduce((max, g) => Math.max(max, Number(g.expiresAt || 0)), 0) || null;
  return active;
}
function createState(uid) {
  const saved = loadUserSettings(uid);
  const accounts = listAccounts(uid);
  const selection = normalizeAccountSelection(saved, accounts);
  const state = {
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
    accessGrants: legacyAccessGrants(saved),
    accessRevoked: saved.accessRevoked === true,
    senderMode: selection.mode,
    selectedAccountIds: selection.selected,
    personalUsername: typeof saved.personalUsername === "string" ? saved.personalUsername : "",
    telegramUsername: typeof saved.telegramUsername === "string" ? saved.telegramUsername : "",
    telegramFirstName: typeof saved.telegramFirstName === "string" ? saved.telegramFirstName : "",
    telegramLastName: typeof saved.telegramLastName === "string" ? saved.telegramLastName : "",
    createdAt: Number.isFinite(Number(saved.createdAt)) ? Number(saved.createdAt) : null,
    lastSeenAt: Number.isFinite(Number(saved.lastSeenAt)) ? Number(saved.lastSeenAt) : null,
    postingTimer: null,
    posting: saved.postingEnabled === true,
    cyclePromise: null,
    nextRunAt: Number(saved.nextRunAt || 0) || null,
    awaiting: null,
    awaitingPromptMessageId: null,
    awaitingPromptChatId: null,
    personalClients: new Map(),
    personalRestorePromises: new Map(),
    lastTouchedAt: Date.now(),
  };
  recomputeAccessState(state);
  return state;
}
function getState(uid) {
  const key = String(uid);
  if (!states.has(key)) states.set(key, createState(uid));
  const state = states.get(key);
  state.lastTouchedAt = Date.now();
  return state;
}
function reloadState(uid) {
  const key = String(uid);
  const old = states.get(key);
  if (old) {
    if (old.postingTimer) clearTimeout(old.postingTimer);
    for (const client of old.personalClients?.values?.() || []) void client.disconnect().catch(() => {});
  }
  states.delete(key);
  return true;
}
setReloadUserStateHandler(reloadState);
function saveState(state) {
  fs.mkdirSync(userDir(state.uid), { recursive: true, mode: 0o700 });
  recomputeAccessState(state);
  writeJsonAtomic(settingsFile(state.uid), {
    version: 4,
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
    accessGrants: state.accessGrants,
    accessRevoked: state.accessRevoked,
    senderMode: state.senderMode,
    selectedAccountIds: state.selectedAccountIds,
    personalUsername: state.personalUsername,
    telegramUsername: state.telegramUsername,
    telegramFirstName: state.telegramFirstName,
    telegramLastName: state.telegramLastName,
    createdAt: state.createdAt,
    lastSeenAt: state.lastSeenAt,
    postingEnabled: state.posting === true,
    nextRunAt: state.nextRunAt,
  });
}
''',
    "state model",
)

section(
    'function redeemLicenseKey(state, rawKey) {',
    'const EXTERNAL_SESSION_ENCRYPTION_KEY = getExternalSessionKey();',
    r'''function addAccessGrant(state, grant) {
  state.accessGrants = Array.isArray(state.accessGrants) ? state.accessGrants : [];
  state.accessGrants.push({
    id: String(grant.id || crypto.randomBytes(6).toString("hex")),
    keyId: String(grant.keyId || ""), source: String(grant.source || "admin"),
    lifetime: grant.lifetime === true, expiresAt: Number(grant.expiresAt || 0) || 0,
    createdAt: Number(grant.createdAt || 0) || Date.now(), revokedAt: Number(grant.revokedAt || 0) || 0,
  });
  recomputeAccessState(state);
}
function redeemLicenseKey(state, rawKey) {
  const uid = String(state?.uid || "");
  const rate = takeRateLimit("key-redeem", uid, 5, 10 * 60_000);
  if (!rate.ok) {
    appendSecurityEvent("key_redeem_rate_limited", { uid });
    void notifySecurityAdmins(`Repeated access-key attempts were blocked for Telegram user ${uid}.`);
    return { ok: false, error: rateLimitMessage(rate) };
  }
  const normalized = normalizeKey(rawKey);
  const supported = /^TP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalized)
    || /^TP-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(normalized);
  if (!supported) return { ok: false, error: "This key cannot be used." };
  const db = loadKeyDb();
  const record = db.keys.find(item => licenseRecordMatches(item, normalized));
  if (!record || record.revokedAt || record.redeemedAt || (record.boundTo && String(record.boundTo) !== uid)) {
    appendSecurityEvent("key_redeem_failed", { uid, reason: record?.boundTo && String(record.boundTo) !== uid ? "bound_mismatch" : "unusable" });
    return { ok: false, error: "This key cannot be used." };
  }
  record.redeemedAt = Date.now();
  record.redeemedBy = uid;
  if (record.lifetime) addAccessGrant(state, { keyId: record.id, source: "key", lifetime: true });
  else {
    recomputeAccessState(state);
    const base = Math.max(Date.now(), Number(state.accessUntil || 0));
    addAccessGrant(state, { keyId: record.id, source: "key", expiresAt: base + Number(record.durationDays) * 86_400_000 });
  }
  state.accessKeyId = record.id;
  state.accessRevoked = false;
  saveKeyDb(db);
  saveState(state);
  resetRateLimit("key-redeem", uid);
  logAdminEvent("key_redeemed", { uid, keyId: record.id, duration: record.lifetime ? "lifetime" : `${record.durationDays}d` });
  appendSecurityEvent("key_redeemed", { uid, keyId: record.id, bound: !!record.boundTo });
  return { ok: true, record };
}
function revokeKey(identifier) {
  const value = normalizeKey(identifier);
  const db = loadKeyDb();
  const record = /^TP-/.test(value)
    ? db.keys.find(item => licenseRecordMatches(item, value))
    : db.keys.find(item => String(item.id).toLowerCase() === String(identifier || "").trim().toLowerCase());
  if (!record) return { ok: false, error: "Key not found." };
  if (!record.revokedAt) record.revokedAt = Date.now();
  saveKeyDb(db);
  if (record.redeemedBy) {
    const state = getState(record.redeemedBy);
    let changed = false;
    for (const grant of state.accessGrants || []) {
      if (String(grant.keyId || "") === String(record.id) && !grant.revokedAt) { grant.revokedAt = Date.now(); changed = true; }
    }
    if (changed) {
      recomputeAccessState(state);
      if (!hasAccess(state)) stopPostingLoop(state);
      saveState(state);
    }
  }
  return { ok: true, record };
}
''',
    "access grants",
)

section(
    'const EXTERNAL_SESSION_ENCRYPTION_KEY = getExternalSessionKey();',
    'const bot = new Bot(BOT_TOKEN);',
    r'''function hasPersonalSession(uid) { return hasAnyAccount(uid); }
''',
    "session store migration",
)

section(
    'function accountLabel(state) {',
    'function cancelLoginAttempt(uid, reason = "cancelled") {',
    r'''function accountLabel(state) { return senderSummary(state, listAccounts(state.uid)); }
async function ensurePersonalClient(state, accountId) {
  const account = listAccounts(state.uid).find(item => item.id === String(accountId));
  if (!account) return null;
  if (state.personalClients.has(account.id)) return state.personalClients.get(account.id);
  if (state.personalRestorePromises.has(account.id)) return state.personalRestorePromises.get(account.id);
  const promise = (async () => {
    let client;
    try {
      client = new TelegramClient(new StringSession(loadAccountSession(state.uid, account.id)), API_ID, API_HASH, { connectionRetries: 5, floodSleepThreshold: 60 });
      client.__telepilotOwnerUid = String(state.uid);
      client.__telepilotAccountId = String(account.id);
      await client.connect();
      if (!(await client.checkAuthorization())) throw new Error("Saved Telegram session is no longer authorized");
      const me = await client.getMe();
      updateAccountStatus(state.uid, account.id, { telegramId: me?.id, username: me?.username, firstName: me?.firstName, lastName: me?.lastName, status: "connected", lastError: "", lastVerifiedAt: Date.now() });
      state.personalClients.set(account.id, client);
      return client;
    } catch (err) {
      updateAccountStatus(state.uid, account.id, { status: isFatalSessionError(err) ? "needs-reconnect" : "unknown", lastError: telegramErrorCode(err).slice(0, 120), lastVerifiedAt: Date.now() });
      try { await client?.disconnect(); } catch {}
      console.warn(`Could not restore personal Telegram account ${account.id} for user ${state.uid}:`, err?.message || err);
      return null;
    } finally { state.personalRestorePromises.delete(account.id); }
  })();
  state.personalRestorePromises.set(account.id, promise);
  return promise;
}
async function disconnectOneAccount(state, accountId, logout = true) {
  const id = String(accountId);
  const client = state.personalClients.get(id);
  state.personalClients.delete(id);
  state.personalRestorePromises.delete(id);
  if (logout) try { await client?.logOut(); } catch {}
  try { await client?.disconnect(); } catch {}
  removeAccount(state.uid, id);
  state.selectedAccountIds = (state.selectedAccountIds || []).map(String).filter(value => value !== id);
  for (const group of state.groups) group.accountIds = (group.accountIds || []).map(String).filter(value => value !== id);
  const accounts = listAccounts(state.uid);
  const selection = normalizeAccountSelection(state, accounts);
  state.senderMode = selection.mode;
  state.selectedAccountIds = selection.selected;
  state.personalUsername = accounts.length === 1 ? accounts[0].username : "";
  saveState(state);
}
''',
    "multi account clients",
)

section(
    'async function completeLogin(attempt, user) {',
    'async function beginPersonalLogin(uid, phone) {',
    r'''async function completeLogin(attempt, user) {
  const state = getState(attempt.uid);
  const me = (user?.id || user?.username || user?.firstName) ? user : await attempt.client.getMe();
  const account = saveAccountSession(attempt.uid, me, attempt.client.session.save());
  attempt.client.__telepilotOwnerUid = String(state.uid);
  attempt.client.__telepilotAccountId = String(account.id);
  const previous = state.personalClients.get(account.id);
  if (previous && previous !== attempt.client) try { await previous.disconnect(); } catch {}
  state.personalClients.set(account.id, attempt.client);
  const accounts = listAccounts(state.uid);
  if (!(state.selectedAccountIds || []).length) state.selectedAccountIds = [account.id];
  state.selectedAccountIds = normalizeAccountSelection(state, accounts).selected;
  state.personalUsername = accounts.length === 1 ? account.username : "";
  saveState(state);
  logAdminEvent("account_connected", { uid: String(state.uid), accountId: account.id });
  appendSecurityEvent("account_connected", { uid: String(state.uid), accountId: account.id });
  void notifySecurityAdmins(`A personal Telegram account was connected for user ${state.uid}.`);
  attempt.client = null;
  attempt.stage = "done";
  attempt.doneAt = Date.now();
  const tutorialScreen = advanceTutorialAfterAction(attempt.uid, 2, 3);
  try {
    const label = accountDisplayLabel(account);
    if (tutorialScreen) await bot.api.sendMessage(attempt.uid, `✅ ${label} connected.\n\n${tutorialScreen.text}`, { reply_markup: tutorialScreen.keyboard });
    else await bot.api.sendMessage(attempt.uid, `✅ ${label} connected.\n\nYou now have ${accounts.length} connected account${accounts.length === 1 ? "" : "s"}.`, { reply_markup: new InlineKeyboard().text("👤 Manage senders", "account") });
  } catch {}
  setTimeout(() => { const current = loginAttempts.get(String(attempt.uid)); if (current === attempt) loginAttempts.delete(String(attempt.uid)); }, 2 * 60_000);
}
''',
    "complete login",
)

once(
    'function isFatalPersonalSessionError(err) {\n  const code = telegramErrorCode(err);\n  return code.includes("AUTH_KEY_UNREGISTERED")\n    || code.includes("SESSION_REVOKED")\n    || code.includes("SESSION_EXPIRED")\n    || code.includes("AUTH_KEY_DUPLICATED")\n    || code.includes("USER_DEACTIVATED");\n}\n',
    'function isFatalPersonalSessionError(err) { return isFatalSessionError(err); }\n',
    'fatal session classifier',
)

section(
    'async function resolveDestination(target, ownerUid) {',
    'function stopPostingLoop(state) {',
    r'''async function resolveDestination(target, ownerUid) {
  const ownerState = ownerUid ? getState(ownerUid) : null;
  const accounts = ownerState ? listAccounts(ownerState.uid) : [];
  if (ownerState && accounts.length) {
    if (!String(target).startsWith("@")) throw new Error("Personal-account setup needs a public @username or t.me link. Private groups can be added with /addhere.");
    const wanted = String(target).slice(1).toLowerCase();
    let matched = null;
    for (const account of accounts) {
      const client = await ensurePersonalClient(ownerState, account.id);
      if (!client) continue;
      let dialogs;
      try { dialogs = await client.getDialogs({}); } catch { continue; }
      const dialog = dialogs.find(item => String(item?.entity?.username || "").toLowerCase() === wanted);
      if (!dialog) continue;
      const entity = dialog.entity;
      if (entity?.broadcast === true && entity?.creator !== true && entity?.adminRights?.postMessages !== true) continue;
      matched = dialog;
      break;
    }
    if (!matched) throw new Error(`None of your connected accounts can currently post to @${wanted}. Join it with at least one sender account and check channel permissions.`);
    let chat = null;
    try { chat = await bot.api.getChat(`@${wanted}`); } catch {}
    if (chat && ["group", "supergroup", "channel"].includes(chat.type)) return { id: String(chat.id), label: String(chat.title || chat.username || chat.id).slice(0,120), type: chat.type, username: chat.username ? `@${chat.username}` : `@${wanted}`, accountMode: "inherit", accountIds: [] };
    const peerId = personalDialogPeerId(matched);
    if (!peerId) throw new Error("TelePilot could not identify that destination.");
    const entity = matched.entity;
    return { id: peerId, label: String(entity?.title || entity?.username || target).slice(0,120), type: entity?.broadcast === true ? "channel" : entity?.megagroup === true ? "supergroup" : "group", username: `@${wanted}`, accountMode: "inherit", accountIds: [] };
  }
  let chat;
  try { chat = await bot.api.getChat(target); } catch (err) { throw new Error(cleanDestinationError(err)); }
  if (!chat || !["group", "supergroup", "channel"].includes(chat.type)) throw new Error("That destination is not a Telegram group or channel.");
  let member;
  try { member = await bot.api.getChatMember(chat.id, BOT_USER_ID); } catch { throw new Error("Add @TelePilottBot to that group/channel first, then try again."); }
  if (member.status !== "administrator") throw new Error("Make @TelePilottBot an admin in that group/channel first.");
  if (chat.type === "channel" && member.can_post_messages !== true) throw new Error("Give @TelePilottBot permission to post messages in that channel.");
  if (ownerUid) {
    let ownerMember;
    try { ownerMember = await bot.api.getChatMember(chat.id, Number(ownerUid)); } catch { throw new Error("I could not verify that you are an admin of that destination."); }
    if (!["creator", "administrator"].includes(ownerMember.status)) throw new Error("Only an admin of that group/channel can add it to their TelePilot profile.");
  }
  return { id: String(chat.id), label: String(chat.title || chat.username || chat.id).slice(0,120), type: chat.type, username: chat.username ? `@${chat.username}` : "", accountMode: "inherit", accountIds: [] };
}
''',
    "destination resolver",
)

section(
    'function stopPostingLoop(state) {',
    'function groupList(state) {',
    r'''function stopPostingLoop(state, persist = true) {
  state.posting = false;
  state.nextRunAt = null;
  if (state.postingTimer) clearTimeout(state.postingTimer);
  state.postingTimer = null;
  if (persist) saveState(state);
}
function suspendPostingLoop(state) {
  if (state.postingTimer) clearTimeout(state.postingTimer);
  state.postingTimer = null;
}
async function resolvePersonalTarget(client, destination, uid, accountId) {
  if (destination.username) return destination.username;
  const cacheKey = `${uid}:${accountId}:${destination.id}`;
  const cached = personalTargetCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PERSONAL_TARGET_CACHE_MS) return cached.entity;
  const dialogs = await client.getDialogs({});
  for (const dialog of dialogs) {
    const candidates = [dialog?.id,dialog?.entity?.id,dialog?.inputEntity?.chatId,dialog?.inputEntity?.channelId].filter(v=>v!==undefined&&v!==null).map(v=>String(v));
    const target = String(destination.id).replace(/^-100/, "").replace(/^-/, "");
    if (candidates.includes(String(destination.id)) || candidates.some(value => value.replace(/\D/g, "") === target)) {
      personalTargetCache.set(cacheKey, { at: Date.now(), entity: dialog }); return dialog;
    }
  }
  throw new Error("This account could not resolve that private destination. Open the group in Telegram and try again.");
}
function isFatalPersonalSessionError(err) { return isFatalSessionError(err); }
async function sendCycleBody(state, cycleId = `interval:${state.uid}:${Date.now()}`) {
  if (!state.posting || !hasAccess(state)) { stopPostingLoop(state); return; }
  const message = state.adMessage, targets = [...state.groups], accounts = listAccounts(state.uid);
  if (!message || !targets.length) { stopPostingLoop(state); return; }
  const accountById = new Map(accounts.map(item => [String(item.id), item]));
  let success = 0, failed = 0;
  for (const target of targets) {
    if (!state.posting || !hasAccess(state)) break;
    const ids = effectiveAccountIds(state, target, accounts);
    if (!accounts.length) {
      try {
        const result = await withDispatchContext({ uid:String(state.uid), destinationId:String(target.id), cycleId, senderType:"bot", senderLabel:"TelePilot Bot", autoDisableEligible:true }, () => bot.api.sendMessage(target.id, message, state.adEntities.length ? { entities:state.adEntities } : {}));
        if (!result?.__telepilotSkipped) { success++; state.totalSent++; }
      } catch (err) { failed++; console.error(`User ${state.uid} bot post failed ${target.id}:`, err?.description || err?.message || err); }
      continue;
    }
    if (!ids.length) continue;
    for (const accountId of ids) {
      const account = accountById.get(String(accountId));
      if (!account) { failed++; continue; }
      try {
        const client = await ensurePersonalClient(state, account.id);
        if (!client) throw new Error(account.status === "needs-reconnect" ? "Account needs reconnect" : "Telegram connection unavailable");
        const entity = await resolvePersonalTarget(client, target, state.uid, account.id);
        const result = await withDispatchContext({ uid:String(state.uid), destinationId:String(target.id), cycleId, senderType:"personal", senderLabel:accountDisplayLabel(account), accountId:String(account.id), autoDisableEligible:ids.length === 1 }, () => client.sendMessage(entity, { message, ...(state.adEntities.length ? { formattingEntities:toMtprotoEntities(state.adEntities) } : {}) }));
        if (!result?.__telepilotSkipped) { success++; state.totalSent++; }
      } catch (err) {
        failed++;
        personalTargetCache.delete(`${state.uid}:${account.id}:${target.id}`);
        const code = telegramErrorCode(err);
        console.error(`User ${state.uid}/${account.id} failed to post to ${target.id}:`, err?.errorMessage || err?.message || err);
        if (isFatalPersonalSessionError(err)) updateAccountStatus(state.uid, account.id, { status:"needs-reconnect", lastError:code.slice(0,120), lastVerifiedAt:Date.now() });
        const notice = takeRateLimit("destination-error-notice", `${state.uid}:${account.id}:${target.id}:${code.slice(0,40)}`, 1, 6*60*60_000);
        if (notice.ok) await autoDeleteNotice(state.uid, `⚠️ ${accountDisplayLabel(account)} → ${destinationLabel(target)} failed. ${isFatalPersonalSessionError(err) ? "Reconnect that sender account." : "Check sender membership/permissions or Destination routing."}`, 20000);
      }
      if (state.posting) await new Promise(resolve => setTimeout(resolve, POST_GAP_MS));
    }
  }
  state.lastRunAt = Date.now(); state.lastCycleSuccess = success; state.lastCycleFailed = failed; saveState(state);
  logAdminEvent("post_cycle", { uid:String(state.uid), success, failed });
}
function runCycle(state, cycleId) {
  if (state.cyclePromise) return state.cyclePromise;
  state.cyclePromise = sendCycleBody(state, cycleId).finally(() => { state.cyclePromise = null; });
  return state.cyclePromise;
}
function scheduleCycleAt(state, runAt) {
  if (state.postingTimer) clearTimeout(state.postingTimer);
  if (!state.posting || !hasAccess(state)) { stopPostingLoop(state); return; }
  const delayMs = state.intervalMinutes * 60_000;
  let target = Number(runAt || 0) || Date.now() + delayMs;
  while (target <= Date.now()) target += delayMs;
  state.nextRunAt = target; saveState(state);
  state.postingTimer = setTimeout(async () => {
    state.postingTimer = null;
    const scheduledAt = target;
    await runCycle(state, `interval:${state.uid}:${scheduledAt}`);
    if (!state.posting) return;
    let next = scheduledAt + delayMs;
    while (next <= Date.now()) next += delayMs;
    scheduleCycleAt(state, next);
  }, Math.max(1, target - Date.now()));
}
function scheduleNextCycle(state) { scheduleCycleAt(state, Date.now() + state.intervalMinutes * 60_000); }
function startPostingLoop(state) {
  if (!hasAccess(state)) return;
  if (state.posting && (state.postingTimer || state.cyclePromise)) return;
  state.posting = true;
  const startedAt = Date.now(); state.nextRunAt = startedAt + state.intervalMinutes * 60_000; saveState(state);
  void (async () => { await runCycle(state, `interval:${state.uid}:${startedAt}`); if (state.posting && !state.postingTimer) scheduleCycleAt(state, state.nextRunAt || startedAt + state.intervalMinutes*60_000); })();
}
function restorePostingLoops() {
  for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes:true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const saved = loadUserSettings(entry.name);
    if (saved.postingEnabled !== true) continue;
    const state = getState(entry.name);
    if (!hasAccess(state) || !state.adMessage || !state.groups.length) { stopPostingLoop(state); continue; }
    state.posting = true;
    const due = Number(saved.nextRunAt || 0);
    if (due && due > Date.now()) scheduleCycleAt(state, due);
    else void (async () => { const now=Date.now(); await runCycle(state, `interval:${state.uid}:restore:${now}`); if (state.posting) scheduleCycleAt(state, now + state.intervalMinutes*60_000); })();
  }
}
''',
    "multi account interval engine",
)

once(
    'function groupsKeyboard(state) {\n  const kb = new InlineKeyboard().text("➕ Add destination", "add_group");\n  if (state.groups.length) kb.text("➖ Remove", "remove_group_menu");\n  kb.row();\n  if (state.groups.length) kb.text("🗑 Clear all", "clear_groups").row();\n  return kb.text("⬅️ Back", "home");\n}\n',
    '''function groupsKeyboard(state) {
  const kb = new InlineKeyboard().text("➕ Add destinations", "add_group");
  if (state.groups.length) kb.text("🎯 Routing", "route_groups:0").row().text("➖ Remove", "remove_group_menu");
  kb.row();
  if (state.groups.length) kb.text("🗑 Clear all", "clear_groups").row();
  return kb.text("⬅️ Back", "home");
}
''',
    "groups keyboard",
)
once(
    '  const hint = hasPersonalSession(state.uid)\n    ? "Public destinations use your connected personal account and do not require @TelePilottBot to be an admin. For private groups without a username, /addhere can still be used for setup."\n    : "Add @TelePilottBot as an admin in each destination first. In a group, you can also send /addhere while you are a group admin.";\n',
    '  const hint = hasPersonalSession(state.uid)\n    ? "Paste one or many public destinations (one per line). Use Routing to choose which accounts post to each destination and which message template it uses."\n    : "Paste one or many public destinations (one per line). @TelePilottBot must have posting permissions; private groups can use /addhere.";\n',
    "groups hint",
)

# Add routing helpers before the connect-page renderer.
route_helpers = r'''
const ROUTE_PAGE_SIZE = 8;
const ACCOUNT_PAGE_SIZE = 8;
function routeAccountLabel(state, group) {
  const accounts = listAccounts(state.uid), ids = effectiveAccountIds(state, group, accounts);
  if (!accounts.length) return "TelePilot Bot";
  if (group.accountMode === "all") return `All ${accounts.length} accounts`;
  if (group.accountMode === "selected") return `${ids.length} selected account${ids.length === 1 ? "" : "s"}`;
  return `Inherit · ${senderSummary(state, accounts)}`;
}
async function showRoutingPage(ctx, state, requestedPage=0) {
  const pages=Math.max(1,Math.ceil(state.groups.length/ROUTE_PAGE_SIZE)), page=Math.max(0,Math.min(Number(requestedPage)||0,pages-1)), start=page*ROUTE_PAGE_SIZE, kb=new InlineKeyboard();
  state.groups.slice(start,start+ROUTE_PAGE_SIZE).forEach((g,o)=>kb.text(`🎯 ${destinationLabel(g).slice(0,36)}`,`route_dest:${start+o}:${page}`).row());
  if(pages>1){if(page>0)kb.text("◀ Prev",`route_groups:${page-1}`);if(page<pages-1)kb.text("Next ▶",`route_groups:${page+1}`);kb.row();}
  kb.text("⬅️ Destinations","groups");
  await ctx.editMessageText(`🎯 DESTINATION ROUTING\n\nChoose a destination. Each destination can inherit your global sender selection, use all accounts, or use selected accounts. You can also assign a different saved message template.\n\nPage ${page+1}/${pages}`,{reply_markup:kb});
}
async function showRouteDestination(ctx,state,index,backPage=0){const group=state.groups[index];if(!group)return showRoutingPage(ctx,state,backPage);const pro=readProSettings(state.uid),overrideId=String(pro.destinationOverrides?.[String(group.id)]||""),template=(pro.templates||[]).find(t=>String(t.id)===overrideId),kb=new InlineKeyboard().text("Inherit senders",`route_mode:${index}:inherit:${backPage}`).text("All accounts",`route_mode:${index}:all:${backPage}`).row().text("Choose accounts",`route_accounts:${index}:0:${backPage}`).row().text("📝 Choose message",`v1_override_dest:${index}`).row().text("⬅️ Routing",`route_groups:${backPage}`);await ctx.editMessageText(["🎯 DESTINATION ROUTING",destinationLabel(group),"",`Senders — ${routeAccountLabel(state,group)}`,`Message — ${template?String(template.name||"Template"):"Default / rotation"}`,"","This destination can use different sender accounts and a different message from your other destinations."].join("\n"),{reply_markup:kb});}
async function showRouteAccounts(ctx,state,index,requestedPage=0,backPage=0){const group=state.groups[index];if(!group)return showRoutingPage(ctx,state,backPage);const accounts=listAccounts(state.uid),pages=Math.max(1,Math.ceil(accounts.length/ACCOUNT_PAGE_SIZE)),page=Math.max(0,Math.min(Number(requestedPage)||0,pages-1)),selected=new Set((group.accountIds||[]).map(String)),start=page*ACCOUNT_PAGE_SIZE,kb=new InlineKeyboard();accounts.slice(start,start+ACCOUNT_PAGE_SIZE).forEach(a=>kb.text(`${selected.has(a.id)?"✅":"○"} ${accountDisplayLabel(a).slice(0,35)}`,`route_account_toggle:${index}:${a.id}:${page}:${backPage}`).row());if(pages>1){if(page>0)kb.text("◀ Prev",`route_accounts:${index}:${page-1}:${backPage}`);if(page<pages-1)kb.text("Next ▶",`route_accounts:${index}:${page+1}:${backPage}`);kb.row();}kb.text("⬅️ Destination",`route_dest:${index}:${backPage}`);await ctx.editMessageText(`👤 ROUTE SENDERS\n\n${destinationLabel(group)}\nSelected — ${selected.size}\n\nToggle any number of connected accounts. There is no TelePilot account-count limit.`,{reply_markup:kb});}
async function showAccounts(ctx,state,requestedPage=0){clearAwaiting(state);const accounts=listAccounts(state.uid),selection=normalizeAccountSelection(state,accounts),pages=Math.max(1,Math.ceil(accounts.length/ACCOUNT_PAGE_SIZE)),page=Math.max(0,Math.min(Number(requestedPage)||0,pages-1)),start=page*ACCOUNT_PAGE_SIZE,kb=new InlineKeyboard().text("＋ Add account","account_phone").row();if(accounts.length)kb.text(selection.mode==="all"?"✅ All accounts":"Use all accounts","account_mode_all").text(selection.mode==="selected"?"✅ Selected":"Choose accounts","account_select:0").row();accounts.slice(start,start+ACCOUNT_PAGE_SIZE).forEach(a=>kb.text(`${a.status==="needs-reconnect"?"⚠️":"👤"} ${accountDisplayLabel(a).slice(0,36)}`,`account_detail:${a.id}:${page}`).row());if(pages>1){if(page>0)kb.text("◀ Prev",`account:${page-1}`);if(page<pages-1)kb.text("Next ▶",`account:${page+1}`);kb.row();}kb.text("⬅️ Dashboard","home");await ctx.editMessageText(["👤 SENDER ACCOUNTS",`Connected — ${accounts.length}`,`Posting mode — ${senderSummary(state,accounts)}`,"","Connect as many Telegram accounts as you need, then post from all of them or any selected set. Destination Routing can override the sender set per group/channel."].join("\n"),{reply_markup:kb});}
async function showAccountSelection(ctx,state,requestedPage=0){const accounts=listAccounts(state.uid),selected=new Set((state.selectedAccountIds||[]).map(String)),pages=Math.max(1,Math.ceil(accounts.length/ACCOUNT_PAGE_SIZE)),page=Math.max(0,Math.min(Number(requestedPage)||0,pages-1)),start=page*ACCOUNT_PAGE_SIZE,kb=new InlineKeyboard();accounts.slice(start,start+ACCOUNT_PAGE_SIZE).forEach(a=>kb.text(`${selected.has(a.id)?"✅":"○"} ${accountDisplayLabel(a).slice(0,35)}`,`account_toggle:${a.id}:${page}`).row());if(pages>1){if(page>0)kb.text("◀ Prev",`account_select:${page-1}`);if(page<pages-1)kb.text("Next ▶",`account_select:${page+1}`);kb.row();}kb.text("⬅️ Senders","account");await ctx.editMessageText(`👤 CHOOSE SENDER ACCOUNTS\n\nSelected — ${selected.size}\n\nToggle any accounts. Selected mode sends each routed post from every selected account.`,{reply_markup:kb});}
'''
once('function htmlPage(token) {', route_helpers + '\nfunction htmlPage(token) {', 'routing helpers')

# Access extension uses independent grants rather than mutating one entitlement.
section(
    'function extendUserAccess(state, duration) {',
    'async function showAdminExtend(ctx, uid, backPage = 0) {',
    r'''function extendUserAccess(state, duration) {
  state.accessRevoked = false;
  recomputeAccessState(state);
  if (duration === "lifetime") addAccessGrant(state, { source:"admin", lifetime:true });
  else {
    const days=Number(duration); if(!Number.isInteger(days)||days<1||days>3650)throw new Error("Days must be between 1 and 3650.");
    const base=Math.max(Date.now(),Number(state.accessUntil||0)); addAccessGrant(state,{source:"admin",expiresAt:base+days*86_400_000});
  }
  saveState(state);
}
async function disconnectPersonalAccount(state, actorUid = state.uid) {
  stopPostingLoop(state);
  cancelLoginAttempt(state.uid, "cancelled");
  for (const [id,client] of state.personalClients || []) { try { await client.logOut(); } catch {} try { await client.disconnect(); } catch {} state.personalClients.delete(id); }
  removeAllAccounts(state.uid);
  state.selectedAccountIds=[]; state.senderMode="selected"; state.personalUsername="";
  for(const group of state.groups){group.accountIds=[];group.accountMode="inherit";}
  saveState(state);
  logAdminEvent("account_disconnected", { uid:String(state.uid), actorUid:String(actorUid), all:true });
}
''',
    "admin access and disconnect",
)

# Replace account UI block with unlimited multi-account controls.
section(
    'bot.callbackQuery("account", async ctx => {',
    'bot.callbackQuery("message", async ctx => {',
    r'''bot.callbackQuery("account", async ctx => { await ctx.answerCallbackQuery(); await showAccounts(ctx,stateFromCtx(ctx),0); });
bot.callbackQuery(/^account:(\d+)$/, async ctx => { await ctx.answerCallbackQuery(); await showAccounts(ctx,stateFromCtx(ctx),Number(ctx.match[1])); });
bot.callbackQuery("account_phone", async ctx => {
  await ctx.answerCallbackQuery(); const state=stateFromCtx(ctx); state.awaiting="phone"; state.awaitingPromptMessageId=ctx.callbackQuery.message?.message_id||null; state.awaitingPromptChatId=ctx.chat?.id||null;
  await ctx.editMessageText("📱 CONNECT ACCOUNT\n\nSend the phone number for the Telegram account you want to add, including country code.\n\nYou can connect additional accounts the same way later.\n\nExample: +37120000000",{reply_markup:new InlineKeyboard().text("⬅️ Cancel","account")});
});
bot.callbackQuery("account_mode_all", async ctx => { const state=stateFromCtx(ctx);state.senderMode="all";saveState(state);await ctx.answerCallbackQuery({text:"Posting from all connected accounts"});await showAccounts(ctx,state,0); });
bot.callbackQuery(/^account_select:(\d+)$/, async ctx => {const state=stateFromCtx(ctx);state.senderMode="selected";saveState(state);await ctx.answerCallbackQuery();await showAccountSelection(ctx,state,Number(ctx.match[1]));});
bot.callbackQuery(/^account_toggle:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {const state=stateFromCtx(ctx),id=String(ctx.match[1]),set=new Set((state.selectedAccountIds||[]).map(String));if(set.has(id))set.delete(id);else set.add(id);state.senderMode="selected";state.selectedAccountIds=[...set];saveState(state);await ctx.answerCallbackQuery({text:set.has(id)?"Selected":"Deselected"});await showAccountSelection(ctx,state,Number(ctx.match[2]));});
bot.callbackQuery(/^account_detail:([A-Za-z0-9_-]+):(\d+)$/, async ctx => {const state=stateFromCtx(ctx),account=listAccounts(state.uid).find(a=>a.id===ctx.match[1]);if(!account)return ctx.answerCallbackQuery({text:"Account not found."});await ctx.answerCallbackQuery();const selected=(state.selectedAccountIds||[]).map(String).includes(account.id);const kb=new InlineKeyboard().text(selected?"Selected globally":"Use only this account",`account_only:${account.id}`).row().text("🔌 Disconnect",`account_remove:${account.id}:${ctx.match[2]}`).row().text("⬅️ Senders",`account:${ctx.match[2]}`);await ctx.editMessageText(["👤 SENDER ACCOUNT",accountDisplayLabel(account),"",`Status — ${account.status}`,`Telegram ID — ${account.telegramId||"—"}`,`Global selection — ${selected?"Selected":"Not selected"}`,account.lastError?`Last issue — ${account.lastError}`:"","Disconnecting this sender does not remove your destinations, messages or schedules."].filter(Boolean).join("\n"),{reply_markup:kb});});
bot.callbackQuery(/^account_only:([A-Za-z0-9_-]+)$/,async ctx=>{const state=stateFromCtx(ctx),id=String(ctx.match[1]);state.senderMode="selected";state.selectedAccountIds=[id];saveState(state);await ctx.answerCallbackQuery({text:"Using this account globally"});await showAccounts(ctx,state,0);});
bot.callbackQuery(/^account_remove:([A-Za-z0-9_-]+):(\d+)$/,async ctx=>{const state=stateFromCtx(ctx),id=String(ctx.match[1]);await ctx.answerCallbackQuery({text:"Disconnecting…"});await disconnectOneAccount(state,id,true);await showAccounts(ctx,state,Number(ctx.match[2]));});
// Compatibility/admin deletion path: this deliberately disconnects every connected account.
bot.callbackQuery("account_disconnect", async ctx => { const state=stateFromCtx(ctx);await ctx.answerCallbackQuery({text:"Disconnecting all accounts…"});await disconnectPersonalAccount(state,state.uid);await showHome(ctx,state); });
''',
    "account UI",
)

# Bulk destination instructions.
old_personal = '    ? "➕ ADD DESTINATION\\n\\n1. Make sure your connected personal account is already in the group/channel.\\n2. For channels, that account needs permission to post.\\n3. Send the public @username or t.me link here.\\n\\n@TelePilottBot does not need to be an admin for public destinations in personal-account mode. For private groups without a public username, /addhere can still be used."\n'
new_personal = '    ? "➕ ADD DESTINATIONS\\n\\nSend one or more public @usernames or t.me links. Put one destination on each line.\\n\\nAt least one connected account must already be joined and able to post. After adding, open Routing to choose exactly which account(s) post to each destination. Private groups without a username can use /addhere."\n'
once(old_personal, new_personal, 'personal add instructions')
old_bot = '    : "➕ ADD DESTINATION\\n\\n1. Add @TelePilottBot as an admin in the group/channel.\\n2. For channels, give it permission to post.\\n3. Send the public @username or t.me link here.\\n\\nFor groups without a public username, send /addhere inside that group while you are an admin.";\n'
new_bot = '    : "➕ ADD DESTINATIONS\\n\\nSend one or more public @usernames or t.me links. Put one destination on each line.\\n\\n@TelePilottBot must be an admin with posting permission in each destination. For private groups, use /addhere inside the group.";\n'
once(old_bot, new_bot, 'bot add instructions')

# Add routing callback handlers before remove menu.
once(
    'bot.callbackQuery("remove_group_menu", async ctx => {',
    r'''bot.callbackQuery(/^route_groups:(\d+)$/,async ctx=>{await ctx.answerCallbackQuery();await showRoutingPage(ctx,stateFromCtx(ctx),Number(ctx.match[1]));});
bot.callbackQuery(/^route_dest:(\d+):(\d+)$/,async ctx=>{await ctx.answerCallbackQuery();await showRouteDestination(ctx,stateFromCtx(ctx),Number(ctx.match[1]),Number(ctx.match[2]));});
bot.callbackQuery(/^route_mode:(\d+):(inherit|all):(\d+)$/,async ctx=>{const state=stateFromCtx(ctx),group=state.groups[Number(ctx.match[1])];if(!group)return ctx.answerCallbackQuery({text:"Destination not found."});group.accountMode=ctx.match[2];if(group.accountMode!=="selected")group.accountIds=[];saveState(state);await ctx.answerCallbackQuery({text:group.accountMode==="all"?"Using all accounts":"Using global sender selection"});await showRouteDestination(ctx,state,Number(ctx.match[1]),Number(ctx.match[3]));});
bot.callbackQuery(/^route_accounts:(\d+):(\d+):(\d+)$/,async ctx=>{const state=stateFromCtx(ctx),group=state.groups[Number(ctx.match[1])];if(!group)return ctx.answerCallbackQuery({text:"Destination not found."});group.accountMode="selected";saveState(state);await ctx.answerCallbackQuery();await showRouteAccounts(ctx,state,Number(ctx.match[1]),Number(ctx.match[2]),Number(ctx.match[3]));});
bot.callbackQuery(/^route_account_toggle:(\d+):([A-Za-z0-9_-]+):(\d+):(\d+)$/,async ctx=>{const state=stateFromCtx(ctx),group=state.groups[Number(ctx.match[1])];if(!group)return ctx.answerCallbackQuery({text:"Destination not found."});const id=String(ctx.match[2]),set=new Set((group.accountIds||[]).map(String));if(set.has(id))set.delete(id);else set.add(id);group.accountMode="selected";group.accountIds=[...set];saveState(state);await ctx.answerCallbackQuery({text:set.has(id)?"Added to route":"Removed from route"});await showRouteAccounts(ctx,state,Number(ctx.match[1]),Number(ctx.match[3]),Number(ctx.match[4]));});

bot.callbackQuery("remove_group_menu", async ctx => {''',
    'routing callbacks',
)

# Duplicate /addhere feedback and route defaults.
once(
    '  const destination = {\n    id: String(ctx.chat.id),\n    label: String(ctx.chat.title || ctx.chat.id).slice(0, 120),\n    type: ctx.chat.type,\n    username: ctx.chat.username ? `@${ctx.chat.username}` : "",\n  };\n  if (!state.groups.some(g => g.id === destination.id)) {\n    state.groups.push(destination);\n    saveState(state);\n  }\n  await ctx.reply(`✅ ${destinationLabel(destination)} added to your TelePilot profile.`);\n',
    '  const destination = { id:String(ctx.chat.id), label:String(ctx.chat.title || ctx.chat.id).slice(0,120), type:ctx.chat.type, username:ctx.chat.username ? `@${ctx.chat.username}` : "", accountMode:"inherit", accountIds:[] };\n  const duplicate = state.groups.some(g => g.id === destination.id);\n  if (!duplicate) { state.groups.push(destination); saveState(state); }\n  await ctx.reply(duplicate ? `⚠️ ${destinationLabel(destination)} is already in your TelePilot destinations.` : `✅ ${destinationLabel(destination)} added to your TelePilot profile.`);\n',
    'addhere duplicate',
)

# Start screen uses selected/all sender summary and does not require every account to restore first.
once(
    '  if (hasPersonalSession(state.uid) && !(await ensurePersonalClient(state))) {\n    return ctx.answerCallbackQuery({ text: "Reconnect your personal Telegram account first.", show_alert: true });\n  }\n',
    '',
    'start preflight',
)
once(
    '  const sender = hasPersonalSession(state.uid)\n    ? (state.personalUsername ? `@${state.personalUsername}` : "your personal account")\n    : `@${botInfo.username}`;\n',
    '  const sender = accountLabel(state);\n',
    'start sender',
)
once(
    '  if (hasPersonalSession(state.uid) && !(await ensurePersonalClient(state))) return showHome(ctx, state);\n',
    '',
    'start confirm preflight',
)

# Bulk destination text handler.
section(
    '  if (state.awaiting === "group") {',
    '  }\n});\n\nbot.callbackQuery("account_cancel_login"',
    r'''  if (state.awaiting === "group") {
    const rawLines=String(ctx.message.text||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    const targets=[...new Set(rawLines.map(normalizeTarget).filter(Boolean))];
    const invalid=rawLines.length-targets.length;
    if(!targets.length){const n=await ctx.reply("❌ Send public @usernames or t.me links, one destination per line.");setTimeout(()=>void safeDelete(ctx.chat.id,n.message_id),8000);return;}
    const pm=state.awaitingPromptMessageId,pc=state.awaitingPromptChatId||ctx.chat.id,added=[],duplicates=[],failures=[];
    for(const target of targets){try{const destination=await resolveDestination(target,state.uid);if(state.groups.some(g=>g.id===destination.id))duplicates.push(destinationLabel(destination));else{state.groups.push(destination);added.push(destinationLabel(destination));}}catch(err){failures.push(`${target} — ${err?.message||"cannot add"}`);}}
    clearAwaiting(state);saveState(state);await safeDelete(ctx.chat.id,ctx.message.message_id);
    const tutorialScreen=(added.length||duplicates.length)?advanceTutorialAfterAction(state.uid,3,4):null;
    if(tutorialScreen){try{await bot.api.editMessageText(pc,pm,tutorialScreen.text,{reply_markup:tutorialScreen.keyboard});}catch{await ctx.reply(tutorialScreen.text,{reply_markup:tutorialScreen.keyboard});}return;}
    const summary=[`✅ Bulk destination setup complete`,`Added — ${added.length}`,`Already saved — ${duplicates.length}`,`Failed / invalid — ${failures.length+invalid}`];
    if(failures.length)summary.push("",...failures.slice(0,8));
    try{await bot.api.editMessageText(pc,pm,summary.join("\n"),{reply_markup:new InlineKeyboard().text("🎯 Routing","route_groups:0").row().text("⬅️ Destinations","groups")});}catch{await ctx.reply(summary.join("\n"));}
    return;
''',
    "bulk destination handler",
)
# The section replacement intentionally supplies the closing braces before the next callback.
once('\n\nbot.callbackQuery("account_cancel_login"', '\n  }\n});\n\nbot.callbackQuery("account_cancel_login"', 'restore text-handler close')

# Multi-account admin counts and detail labels.
once('  const connected = ids.filter(hasPersonalSession).length;\n', '  const connected = ids.reduce((sum,id)=>sum+listAccounts(id).length,0);\n', 'admin account count')
once('  const connected = hasPersonalSession(id);\n  const sender = connected ? (state.personalUsername ? `@${state.personalUsername}` : "Personal account") : "TelePilot Bot";\n', '  const connected = listAccounts(id).length > 0;\n  const sender = accountLabel(state);\n', 'admin sender label')

# Shutdown suspends persistent schedules and closes every account client without changing desired LIVE state.
section(
    'const idleSweep = setInterval(() => {',
    'bot.catch(err => {',
    r'''const idleSweep = setInterval(() => {
  const cutoff=Date.now()-IDLE_STATE_MS;
  for(const [key,state] of states){if(state.posting||state.awaiting||state.cyclePromise||state.personalRestorePromises?.size||state.lastTouchedAt>cutoff)continue;for(const client of state.personalClients?.values?.()||[])void client.disconnect().catch(()=>{});states.delete(key);}
},10*60_000);
idleSweep.unref?.();
restorePostingLoops();
''',
    'idle/restore loops',
)
section(
    'async function shutdown(signal) {',
    'process.once("SIGINT"',
    r'''async function shutdown(signal) {
  if(shuttingDown)return;shuttingDown=true;console.log(`TelePilot shutting down (${signal})…`);clearInterval(loginSweep);clearInterval(idleSweep);try{bot.stop();}catch{}
  for(const attempt of [...loginAttempts.values()])cancelLoginAttempt(attempt.uid,"shutdown");
  for(const state of states.values()){suspendPostingLoop(state);try{await state.cyclePromise;}catch{}for(const client of state.personalClients?.values?.()||[])try{await client.disconnect();}catch{}}
  await new Promise(resolve=>healthServer.close(resolve));
}
''',
    'shutdown',
)
once('console.log(`TelePilot v0.5 personal-account mode starting with ${ADMIN_IDS.size} admin profile(s)…`);', 'console.log(`TelePilot 1.1 multi-account mode starting with ${ADMIN_IDS.size} admin profile(s)…`);', 'startup version')

P.write_text(s)
print("TelePilot 1.1 app migration applied")
