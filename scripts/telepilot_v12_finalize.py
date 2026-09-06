from pathlib import Path

ROOT = Path('.')

def read(name): return (ROOT / name).read_text()
def write(name, value): (ROOT / name).write_text(value)
def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

# --- destination-automation.js: persist sender-routing join work and finish tutorial after topics ---
dest = read('destination-automation.js')
dest = replace_once(dest,
'import { syncUserGroups } from "./runtime-hooks.js";\n',
'import { syncUserGroups } from "./runtime-hooks.js";\nimport { advanceTutorialAfterAction } from "./onboarding.js";\n',
'destination onboarding import')
dest = dest.replace('const WORKER_INTERVAL_MS = 5 * 60_000;', 'const WORKER_INTERVAL_MS = 60_000;', 1)
dest = replace_once(dest,
'''    topicQueue: Array.isArray(raw.topicQueue) ? raw.topicQueue : [],\n    unresolvedInvites: Array.isArray(raw.unresolvedInvites) ? raw.unresolvedInvites : [],\n    lastWorkerAt: Number(raw.lastWorkerAt || 0) || 0,\n''',
'''    topicQueue: Array.isArray(raw.topicQueue) ? raw.topicQueue : [],\n    unresolvedInvites: Array.isArray(raw.unresolvedInvites) ? raw.unresolvedInvites : [],\n    routingQueue: Array.isArray(raw.routingQueue) ? raw.routingQueue : [],\n    lastWorkerAt: Number(raw.lastWorkerAt || 0) || 0,\n''',
'automation read routing queue')
dest = replace_once(dest,
'''    topicQueue: Array.isArray(value?.topicQueue) ? value.topicQueue.slice(-500) : [],\n    unresolvedInvites: Array.isArray(value?.unresolvedInvites) ? value.unresolvedInvites.slice(-500) : [],\n    lastWorkerAt: Number(value?.lastWorkerAt || 0) || 0,\n''',
'''    topicQueue: Array.isArray(value?.topicQueue) ? value.topicQueue.slice(-500) : [],\n    unresolvedInvites: Array.isArray(value?.unresolvedInvites) ? value.unresolvedInvites.slice(-500) : [],\n    routingQueue: Array.isArray(value?.routingQueue) ? value.routingQueue.slice(-1000) : [],\n    lastWorkerAt: Number(value?.lastWorkerAt || 0) || 0,\n''',
'automation write routing queue')

routing_marker = '''async function resolveForRecheck(client, group) {\n'''
routing_code = r'''function setGroupAccountStatus(uid, destinationId, accountId, status, reason = "") {
  const settings = readAppSettings(uid);
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const group = groups.find(row => String(row?.id || "") === String(destinationId || ""));
  if (!group) return false;
  group.accountJoin = { ...(group.accountJoin || {}) };
  group.accountJoin[String(accountId)] = accountJoinEntry(status, reason);
  group.joinStatus = overallStatus(group);
  writeAppSettings(uid, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
  syncUserGroups(uid);
  return true;
}

export function queueRoutingSync(uid, destinationId = "", onlyAccountIds = []) {
  const id = String(uid || "");
  if (!id) return 0;
  const settings = readAppSettings(id);
  const accounts = listAccounts(id);
  const filter = new Set((Array.isArray(onlyAccountIds) ? onlyAccountIds : []).map(String));
  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];
  const store = readAutomation(id);
  const existing = new Set((store.routingQueue || []).map(row => `${row.destinationId}|${row.accountId}`));
  let queued = 0, changed = false;
  for (const group of groups) {
    if (destinationId && String(group.id) !== String(destinationId)) continue;
    const required = effectiveAccountIds(settings, group, accounts).map(String);
    for (const accountId of required) {
      if (filter.size && !filter.has(accountId)) continue;
      const current = group.accountJoin?.[accountId];
      if (current?.status === "ready") continue;
      const key = `${group.id}|${accountId}`;
      if (!existing.has(key)) {
        store.routingQueue.push({ destinationId: String(group.id), accountId, queuedAt: Date.now() });
        existing.add(key);
        queued++;
      }
      if (!current) {
        group.accountJoin = { ...(group.accountJoin || {}) };
        group.accountJoin[accountId] = accountJoinEntry("pending", "TelePilot is preparing this destination for the selected sender account.");
        group.joinStatus = overallStatus(group);
        changed = true;
      }
    }
  }
  if (changed) {
    writeAppSettings(id, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });
    syncUserGroups(id);
  }
  writeAutomation(id, store);
  return queued;
}

async function joinOneAddlistDestination(client, group) {
  const slug = String(group?.sourceSlug || "");
  if (!slug) throw new Error("The original Addlist is unavailable for this destination.");
  const invite = await client.api.chatlists.checkChatlistInvite({ slug });
  const chats = Array.isArray(invite?.chats) ? invite.chats : [];
  const wanted = String(group.id || "").replace(/^-100/, "").replace(/^-/, "").replace(/\D/g, "");
  let entity = chats.find(chat => idString(chat?.id || "").replace(/\D/g, "") === wanted) || null;
  const isAlready = invite?.className === "ChatlistInviteAlready" || Number.isInteger(Number(invite?.filterId));
  const peers = isAlready
    ? (Array.isArray(invite?.missingPeers) ? invite.missingPeers : [])
    : (Array.isArray(invite?.peers) ? invite.peers : []);
  const peer = peers.find(row => peerKey(row) === wanted) || null;
  if (peer) {
    const input = await inputPeer(client, entity || peer);
    try {
      if (isAlready) {
        await client.api.chatlists.joinChatlistUpdates({
          chatlist: new Api.InputChatlistDialogFilter({ filterId: Number(invite.filterId) }),
          peers: [input],
        });
      } else {
        await client.api.chatlists.joinChatlistInvite({ slug, peers: [input] });
      }
    } catch (err) {
      if (errorCode(err).includes("INVITE_REQUEST_SENT")) return { entity: null, status: "pending", reason: "Join request sent; waiting for admin approval." };
      throw err;
    }
  }
  if (!entity) {
    try { entity = await client.getEntity(group.id); } catch {}
  }
  return entity
    ? { entity, status: "ready", reason: "" }
    : { entity: null, status: "failed", reason: "Telegram could not resolve this Addlist destination for the selected account." };
}

async function prepareExistingDestination(uid, group, account, client) {
  let joined;
  if (group.username) {
    joined = await joinPublic(client, { kind: "public", username: normalizeUsername(group.username), original: group.username });
  } else if (group.source === "invite" && group.sourceSlug) {
    joined = await joinPrivateInvite(client, { kind: "invite", hash: group.sourceSlug, original: "Private invite" });
  } else if (group.source === "addlist" && group.sourceSlug) {
    joined = await joinOneAddlistDestination(client, group);
  } else {
    let entity = null;
    try { entity = await client.getEntity(group.id); } catch {}
    joined = entity
      ? { entity, status: "ready", reason: "" }
      : { entity: null, status: "failed", reason: "This private destination has no reusable invite. Add it again with its invite or Addlist link." };
  }
  if (!joined.entity) {
    setGroupAccountStatus(uid, group.id, account.id, joined.status || "failed", joined.reason || "Destination is not ready.");
    if (joined.status === "pending" && group.source === "invite" && group.sourceSlug) {
      addUnresolvedInvite(uid, { accountId: account.id, kind: "invite", hash: group.sourceSlug, original: group.label || "Private invite", status: "pending", reason: joined.reason });
    }
    return false;
  }
  await processEntityForAccount(uid, account, client, joined.entity, {
    kind: group.source || (group.username ? "public" : "existing"),
    slug: group.source === "addlist" ? group.sourceSlug : "",
    hash: group.source === "invite" ? group.sourceSlug : "",
    original: group.username || group.label || group.id,
  });
  return true;
}

export async function processRoutingQueue(uid, maxItems = 4) {
  const id = String(uid || "");
  const accounts = listAccounts(id);
  const byId = new Map(accounts.map(account => [String(account.id), account]));
  const initial = readAutomation(id);
  const work = (initial.routingQueue || []).slice(0, Math.max(1, Number(maxItems) || 4));
  if (!work.length) return { checked: 0, changed: 0 };
  const processed = new Set();
  const clients = new Map();
  let checked = 0, changed = 0;
  try {
    for (const item of work) {
      const key = `${item.destinationId}|${item.accountId}`;
      const settings = readAppSettings(id);
      const group = (settings.groups || []).find(row => String(row.id) === String(item.destinationId));
      const account = byId.get(String(item.accountId));
      if (!group || !account || !effectiveAccountIds(settings, group, accounts).map(String).includes(String(account.id))) {
        processed.add(key);
        continue;
      }
      let client = clients.get(account.id);
      if (!client) {
        try { client = await openAccountClient(id, account); clients.set(account.id, client); }
        catch (err) {
          setGroupAccountStatus(id, group.id, account.id, "failed", `Sender connection failed: ${String(err?.message || err).slice(0, 120)}`);
          processed.add(key);
          continue;
        }
      }
      checked++;
      try {
        changed += (await prepareExistingDestination(id, group, account, client)) ? 1 : 0;
        processed.add(key);
      } catch (err) {
        const code = errorCode(err);
        if (code.includes("FLOOD_WAIT")) break;
        const reason = code.includes("CHANNELS_TOO_MUCH")
          ? "This account has reached Telegram's joined-channel limit."
          : code.includes("INVITE_SLUG_EXPIRED") || code.includes("INVITE_HASH_EXPIRED")
            ? "The original invite has expired."
            : String(err?.message || err).slice(0, 160);
        setGroupAccountStatus(id, group.id, account.id, "failed", reason);
        processed.add(key);
      }
      await sleep(JOIN_GAP_MS);
    }
  } finally {
    for (const client of clients.values()) try { await client.disconnect(); } catch {}
  }
  if (processed.size) {
    const latest = readAutomation(id);
    latest.routingQueue = (latest.routingQueue || []).filter(row => !processed.has(`${row.destinationId}|${row.accountId}`));
    writeAutomation(id, latest);
  }
  if (changed) syncUserGroups(id);
  return { checked, changed };
}

'''
idx = dest.find(routing_marker)
if idx < 0: raise SystemExit('routing helper insertion marker not found')
dest = dest[:idx] + routing_code + dest[idx:]

dest = replace_once(dest,
'''    await ctx.answerCallbackQuery({ text: `Posting topic: ${result.topic.title}` });\n    await showTopicIndex(ctx);\n''',
'''    await ctx.answerCallbackQuery({ text: `Posting topic: ${result.topic.title}` });\n    const remaining = topicQueueForGroups(String(ctx.from?.id || ""));\n    const tutorialScreen = remaining.length ? null : advanceTutorialAfterAction(String(ctx.from?.id || ""), 3, 4);\n    if (tutorialScreen) return ctx.editMessageText(tutorialScreen.text, { reply_markup: tutorialScreen.keyboard });\n    await showTopicIndex(ctx);\n''',
'topic tutorial continuation')

dest = replace_once(dest,
'''        const hasAttention = store.unresolvedInvites.length || (settings.groups || []).some(group => Object.values(group.accountJoin || {}).some(row => ["pending", "verification"].includes(String(row?.status || ""))));\n        if (!hasAttention) continue;\n        try { await recheckDestinations(uid, RECHECK_PER_TICK); } catch (err) { console.warn(`Destination recheck failed for ${uid}:`, err?.message || err); }\n''',
'''        const hasAttention = store.routingQueue.length || store.unresolvedInvites.length || (settings.groups || []).some(group => Object.values(group.accountJoin || {}).some(row => ["pending", "verification"].includes(String(row?.status || ""))));\n        if (!hasAttention) continue;\n        try { if (store.routingQueue.length) await processRoutingQueue(uid, 4); } catch (err) { console.warn(`Destination routing sync failed for ${uid}:`, err?.message || err); }\n        try { await recheckDestinations(uid, RECHECK_PER_TICK); } catch (err) { console.warn(`Destination recheck failed for ${uid}:`, err?.message || err); }\n''',
'worker routing queue')
write('destination-automation.js', dest)

# --- app.js: ready-count Home, one-tap start readiness, route synchronization, correct forum replies ---
app = read('app.js')
app = replace_once(app,
'''  parseDestinationInput,\n  recordDestinationFailure,\n} from "./destination-automation.js";''',
'''  parseDestinationInput,\n  processRoutingQueue,\n  queueRoutingSync,\n  recordDestinationFailure,\n} from "./destination-automation.js";''',
'app destination imports')

helper_marker = '''function mainKeyboard(state) {\n'''
helper = r'''function readyDestinationCount(state) {
  const accounts = listAccounts(state.uid);
  let ready = 0;
  for (const group of state.groups || []) {
    if (group.topicRequired === true && !Number(group.topicId || 0)) continue;
    if (usesBotSender(state, group, accounts)) { ready++; continue; }
    const ids = effectiveAccountIds(state, group, accounts);
    if (ids.some(id => destinationAccountReady(group, id))) ready++;
  }
  return ready;
}
function scheduleRoutingSync(state, destinationId = "", accountIds = []) {
  const queued = queueRoutingSync(state.uid, destinationId, accountIds);
  if (queued > 0) void processRoutingQueue(state.uid, Math.min(4, queued)).catch(err => console.warn(`Routing sync failed for ${state.uid}:`, err?.message || err));
  return queued;
}
'''
idx = app.find(helper_marker)
if idx < 0: raise SystemExit('app helper marker not found')
app = app[:idx] + helper + app[idx:]
app = replace_once(app,
'    `👥 Groups: ${state.groups.length}`,\n',
'    `👥 Groups: ${readyDestinationCount(state)}`,\n',
'dashboard ready destination count')

app = replace_once(app,
'''  const readyDestinations = state.groups.filter(group => !(group.topicRequired === true && !Number(group.topicId || 0)));\n  if (!readyDestinations.length) return ctx.answerCallbackQuery({ text: "Choose a posting topic for your forum destinations first.", show_alert: true });\n''',
'''  if (!readyDestinationCount(state)) return ctx.answerCallbackQuery({ text: "No destination is ready yet. Finish topic selection, approval or verification first.", show_alert: true });\n''',
'start readiness')

app = replace_once(app,
'''          ...(Number(target.topicId || 0) > 1 ? { replyTo:Number(target.topicId), topMsgId:Number(target.topicId) } : {}),\n''',
'''          ...(Number(target.topicId || 0) > 1 ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: Number(target.topicId) }) } : {}),\n''',
'interval personal topic reply')

# Sender selection changes queue membership preparation without adding another confirmation screen.
app = replace_once(app,
'''bot.callbackQuery("account_mode_all", async ctx => { const state=stateFromCtx(ctx);state.senderMode="all";saveState(state);await ctx.answerCallbackQuery({text:"Posting from all connected accounts"});await showAccounts(ctx,state,0); });''',
'''bot.callbackQuery("account_mode_all", async ctx => { const state=stateFromCtx(ctx);state.senderMode="all";saveState(state);scheduleRoutingSync(state);await ctx.answerCallbackQuery({text:"Posting from all connected accounts"});await showAccounts(ctx,state,0); });''',
'global all account sync')
app = replace_once(app,
'''bot.callbackQuery(/^account_toggle:([A-Za-z0-9_-]+):(\\d+)$/, async ctx => {const state=stateFromCtx(ctx),id=String(ctx.match[1]),set=new Set((state.selectedAccountIds||[]).map(String));if(set.has(id))set.delete(id);else set.add(id);state.senderMode="selected";state.selectedAccountIds=[...set];saveState(state);await ctx.answerCallbackQuery({text:set.has(id)?"Selected":"Deselected"});await showAccountSelection(ctx,state,Number(ctx.match[2]));});''',
'''bot.callbackQuery(/^account_toggle:([A-Za-z0-9_-]+):(\\d+)$/, async ctx => {const state=stateFromCtx(ctx),id=String(ctx.match[1]),set=new Set((state.selectedAccountIds||[]).map(String));if(set.has(id))set.delete(id);else set.add(id);state.senderMode="selected";state.selectedAccountIds=[...set];saveState(state);if(set.has(id))scheduleRoutingSync(state,"",[id]);await ctx.answerCallbackQuery({text:set.has(id)?"Selected":"Deselected"});await showAccountSelection(ctx,state,Number(ctx.match[2]));});''',
'global account toggle sync')
app = replace_once(app,
'''bot.callbackQuery(/^account_only:([A-Za-z0-9_-]+)$/,async ctx=>{const state=stateFromCtx(ctx),id=String(ctx.match[1]);state.senderMode="selected";state.selectedAccountIds=[id];saveState(state);await ctx.answerCallbackQuery({text:"Using this account globally"});await showAccounts(ctx,state,0);});''',
'''bot.callbackQuery(/^account_only:([A-Za-z0-9_-]+)$/,async ctx=>{const state=stateFromCtx(ctx),id=String(ctx.match[1]);state.senderMode="selected";state.selectedAccountIds=[id];saveState(state);scheduleRoutingSync(state,"",[id]);await ctx.answerCallbackQuery({text:"Using this account globally"});await showAccounts(ctx,state,0);});''',
'account only sync')
app = replace_once(app,
'''bot.callbackQuery(/^route_mode:(\\d+):(inherit|bot|all):(\\d+)$/,async ctx=>{const state=stateFromCtx(ctx),group=state.groups[Number(ctx.match[1])];if(!group)return ctx.answerCallbackQuery({text:"Destination not found."});group.accountMode=ctx.match[2];if(group.accountMode!=="selected")group.accountIds=[];saveState(state);const notice=group.accountMode==="all"?"Using all accounts":group.accountMode==="bot"?"Using TelePilot Bot":"Using global sender selection";await ctx.answerCallbackQuery({text:notice});await showRouteDestination(ctx,state,Number(ctx.match[1]),Number(ctx.match[3]));});''',
'''bot.callbackQuery(/^route_mode:(\\d+):(inherit|bot|all):(\\d+)$/,async ctx=>{const state=stateFromCtx(ctx),group=state.groups[Number(ctx.match[1])];if(!group)return ctx.answerCallbackQuery({text:"Destination not found."});group.accountMode=ctx.match[2];if(group.accountMode!=="selected")group.accountIds=[];saveState(state);if(group.accountMode!=="bot")scheduleRoutingSync(state,group.id);const notice=group.accountMode==="all"?"Using all accounts":group.accountMode==="bot"?"Using TelePilot Bot":"Using global sender selection";await ctx.answerCallbackQuery({text:notice});await showRouteDestination(ctx,state,Number(ctx.match[1]),Number(ctx.match[3]));});''',
'route mode sync')
app = replace_once(app,
'''bot.callbackQuery(/^route_account_toggle:(\\d+):([A-Za-z0-9_-]+):(\\d+):(\\d+)$/,async ctx=>{const state=stateFromCtx(ctx),group=state.groups[Number(ctx.match[1])];if(!group)return ctx.answerCallbackQuery({text:"Destination not found."});const id=String(ctx.match[2]),set=new Set((group.accountIds||[]).map(String));if(set.has(id))set.delete(id);else set.add(id);group.accountMode="selected";group.accountIds=[...set];saveState(state);await ctx.answerCallbackQuery({text:set.has(id)?"Added to route":"Removed from route"});await showRouteAccounts(ctx,state,Number(ctx.match[1]),Number(ctx.match[3]),Number(ctx.match[4]));});''',
'''bot.callbackQuery(/^route_account_toggle:(\\d+):([A-Za-z0-9_-]+):(\\d+):(\\d+)$/,async ctx=>{const state=stateFromCtx(ctx),group=state.groups[Number(ctx.match[1])];if(!group)return ctx.answerCallbackQuery({text:"Destination not found."});const id=String(ctx.match[2]),set=new Set((group.accountIds||[]).map(String));if(set.has(id))set.delete(id);else set.add(id);group.accountMode="selected";group.accountIds=[...set];saveState(state);if(set.has(id))scheduleRoutingSync(state,group.id,[id]);await ctx.answerCallbackQuery({text:set.has(id)?"Added to route":"Removed from route"});await showRouteAccounts(ctx,state,Number(ctx.match[1]),Number(ctx.match[3]),Number(ctx.match[4]));});''',
'route account toggle sync')

# Do not advance tutorial past Destinations while forum topics still need a choice.
app = replace_once(app,
'''    const tutorialScreen = (result.added || result.duplicates || result.attention)\n      ? advanceTutorialAfterAction(state.uid, 3, 4)\n      : null;\n''',
'''    const needsTopicChoice = state.groups.some(group => group.topicRequired === true && !Number(group.topicId || 0));\n    const tutorialScreen = !needsTopicChoice && (result.added || result.duplicates || result.attention)\n      ? advanceTutorialAfterAction(state.uid, 3, 4)\n      : null;\n''',
'tutorial destination gate')
write('app.js', app)

# --- v1-worker.js: use MTProto InputReplyTo for forum topic delivery ---
worker = read('v1-worker.js')
worker = replace_once(worker,
'''...(Number(destination.topicId||0)>1?{replyTo:Number(destination.topicId),topMsgId:Number(destination.topicId)}:{})''',
'''...(Number(destination.topicId||0)>1?{replyTo:new MtApi.InputReplyToMessage({replyToMsgId:Number(destination.topicId)})}:{})''',
'worker personal topic reply')
write('v1-worker.js', worker)

# --- onboarding.js: topic selection is a required part of the destination tutorial step ---
onboarding = read('onboarding.js')
onboarding = replace_once(onboarding,
'''  const groups = Array.isArray(saved.groups) ? saved.groups : [];\n  return {\n''',
'''  const groups = Array.isArray(saved.groups) ? saved.groups : [];\n  const needsTopic = groups.filter(group => group?.topicRequired === true && !Number(group?.topicId || 0)).length;\n  return {\n''',
'tutorial destination topic count')
onboarding = replace_once(onboarding,
'''      "If a group uses forum topics, TelePilot asks you to choose the exact topic. Join requests and verification stay Pending instead of blocking the rest of your setup."\n    ].join("\\n"),\n    keyboard: groups.length\n      ? new InlineKeyboard().text("📍 Destinations", "groups").row().text("← Back", "tutorial:2").text("Next →", "tutorial:4").row().text("Skip", "tutorial:skip")\n      : new InlineKeyboard().text("＋ Add Destinations", "groups").row().text("← Back", "tutorial:2").text("Skip", "tutorial:skip"),\n''',
'''      "If a group uses forum topics, TelePilot asks you to choose the exact topic. Join requests and verification stay Pending instead of blocking the rest of your setup.",\n      needsTopic ? `\\n💬 ${needsTopic} forum destination${needsTopic === 1 ? " still needs" : "s still need"} a posting topic before this tutorial continues.` : ""\n    ].filter(Boolean).join("\\n"),\n    keyboard: groups.length && needsTopic === 0\n      ? new InlineKeyboard().text("📍 Destinations", "groups").row().text("← Back", "tutorial:2").text("Next →", "tutorial:4").row().text("Skip", "tutorial:skip")\n      : groups.length\n        ? new InlineKeyboard().text("💬 Choose Topics", "dest_topics").row().text("📍 Destinations", "groups").row().text("← Back", "tutorial:2").text("Skip", "tutorial:skip")\n        : new InlineKeyboard().text("＋ Add Destinations", "groups").row().text("← Back", "tutorial:2").text("Skip", "tutorial:skip"),\n''',
'tutorial destination topic gate')
write('onboarding.js', onboarding)

# --- ux-v12.js: preserve the new Add Destination instructions after legacy UI normalization ---
ux = read('ux-v12.js')
ux = replace_once(ux,
'''  if (value.startsWith("📍 Destinations") || value.startsWith("💬 Choose posting topics") || value.startsWith("⏳ Pending & verification")) return normalizeDestinationNav(value, other);\n''',
'''  if (value.startsWith("📍 Add destination")) {\n    const next = relabelNavigation(other, "groups", "← Destinations");\n    return {\n      text: [\n        "📍 Add destinations",\n        "",\n        "Paste one or many Telegram destinations, one per line.",\n        "",\n        "Supported: @usernames, public links, private t.me/+ invites and t.me/addlist/... shared folders.",\n        "With a selected personal sender, TelePilot joins missing chats automatically. Forum groups ask you to choose the exact posting topic.",\n        "Join requests and verification-required groups stay Pending until Telegram allows posting.",\n        "",\n        "TelePilot Bot destinations still require the bot to be added with posting permission."\n      ].join("\\n"),\n      other: next,\n    };\n  }\n  if (value.startsWith("📍 Destinations") || value.startsWith("💬 Choose posting topics") || value.startsWith("⏳ Pending & verification")) return normalizeDestinationNav(value, other);\n''',
'ux add destination instructions')
write('ux-v12.js', ux)

# --- regression coverage for the final release invariants ---
test = read('telepilot-v12-regression-test.mjs')
test = replace_once(test,
'''  destinationAccountReady,\n} = await import("./destination-automation.js");\n''',
'''  destinationAccountReady,\n  queueRoutingSync,\n  processRoutingQueue,\n} = await import("./destination-automation.js");\n''',
'test routing imports')
test = replace_once(test,
'''assert.equal(destinationAccountReady({ id: "-1001", accountJoin: { a: { status: "verification" } } }, "a"), false);\n''',
'''assert.equal(destinationAccountReady({ id: "-1001", accountJoin: { a: { status: "verification" } } }, "a"), false);\nassert.equal(typeof queueRoutingSync, "function");\nassert.equal(typeof processRoutingQueue, "function");\n''',
'test routing exports')
test = replace_once(test,
'''assert.ok(app.includes("topMsgId"), "personal MTProto forum-topic routing missing in interval sender");\n''',
'''assert.ok(app.includes("InputReplyToMessage"), "personal MTProto forum-topic routing missing in interval sender");\n''',
'test app topic invariant')
test = replace_once(test,
'''assert.ok(worker.includes("topMsgId"), "personal MTProto forum-topic routing missing in scheduled worker");\n''',
'''assert.ok(worker.includes("InputReplyToMessage"), "personal MTProto forum-topic routing missing in scheduled worker");\n''',
'test worker topic invariant')
test += '''\nassert.ok(app.includes("readyDestinationCount"), "Home/start readiness must use ready destinations, not just saved destinations");\nassert.ok(app.includes("scheduleRoutingSync"), "sender routing changes must queue destination membership preparation");\nassert.ok(ux.includes("private t.me/+ invites") && ux.includes("t.me/addlist/..."), "normalized Add Destination screen lost v1.2 import guidance");\nassert.ok(onboarding.includes("needsTopic") && onboarding.includes("Choose Topics"), "tutorial must wait for forum-topic selection");\n'''
write('telepilot-v12-regression-test.mjs', test)

print('TelePilot v1.2 release finalization applied')
