from pathlib import Path
import re

ROOT = Path('.')

def read(name): return (ROOT / name).read_text()
def write(name, value): (ROOT / name).write_text(value)
def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

def replace_between(text, start, end, replacement, label):
    i = text.find(start)
    if i < 0: raise SystemExit(f'{label}: start marker not found')
    j = text.find(end, i)
    if j < 0: raise SystemExit(f'{label}: end marker not found')
    return text[:i] + replacement + text[j:]

# runtime-hooks.js: support safe in-memory destination refresh without interrupting live posting.
runtime = read('runtime-hooks.js')
runtime = replace_once(runtime,
'''let reloadUserStateHandler = null;\n''',
'''let reloadUserStateHandler = null;\nlet syncUserGroupsHandler = null;\n''', 'runtime hook declaration')
runtime += '''\nexport function setSyncUserGroupsHandler(handler) {\n  syncUserGroupsHandler = typeof handler === "function" ? handler : null;\n}\n\nexport function syncUserGroups(uid) {\n  if (syncUserGroupsHandler) return syncUserGroupsHandler(String(uid));\n  return false;\n}\n'''
write('runtime-hooks.js', runtime)

# destination-automation.js: use the safe group sync hook and expose send-failure classification.
dest = read('destination-automation.js')
dest = replace_once(dest,
'import { reloadUserState } from "./runtime-hooks.js";',
'import { syncUserGroups } from "./runtime-hooks.js";', 'destination runtime import')
dest = dest.replace('reloadUserState(uid);', 'syncUserGroups(uid);')
dest = dest.replace('reloadUserState(id);', 'syncUserGroups(id);')
insert_marker = '''export function destinationAccountReady(destination, accountId = "") {\n'''
idx = dest.find(insert_marker)
if idx < 0: raise SystemExit('destination failure helper insertion marker missing')
helper = '''export function recordDestinationFailure(uid, destination, accountId, err) {\n  const id = String(uid || "");\n  const account = String(accountId || "");\n  const destinationId = String(destination?.id || "");\n  if (!id || !account || !destinationId) return false;\n  const code = errorCode(err);\n  const restricted = [\n    "CHAT_WRITE_FORBIDDEN", "CHAT_SEND_PLAIN_FORBIDDEN", "CHAT_SEND_MEDIA_FORBIDDEN",\n    "CHAT_SEND_PHOTOS_FORBIDDEN", "CHAT_SEND_VIDEOS_FORBIDDEN",\n  ].some(token => code.includes(token));\n  if (!restricted) return false;\n  const settings = readAppSettings(id);\n  const groups = Array.isArray(settings.groups) ? settings.groups.slice() : [];\n  const group = groups.find(row => String(row?.id || "") === destinationId);\n  if (!group) return false;\n  group.accountJoin = { ...(group.accountJoin || {}) };\n  group.accountJoin[account] = accountJoinEntry(\n    "verification",\n    "Telegram currently blocks posting from this account. Open the group and complete any verification or rules step, then TelePilot will recheck it.",\n  );\n  group.joinStatus = overallStatus(group);\n  writeAppSettings(id, { ...settings, version: Math.max(5, Number(settings.version || 0)), groups });\n  syncUserGroups(id);\n  return true;\n}\n\n'''
dest = dest[:idx] + helper + dest[idx:]
write('destination-automation.js', dest)

# startup.js integration.
startup = read('startup.js')
startup = replace_once(startup,
'import { installOnboarding } from "./onboarding.js";\n',
'import { installOnboarding } from "./onboarding.js";\nimport { installDestinationAutomation, startDestinationAutomationWorker } from "./destination-automation.js";\nimport { installUxNavigation, installUxV12 } from "./ux-v12.js";\n', 'startup imports')
startup = replace_once(startup,
'''installSupportCenterEarly(Bot, installSupportCenter);\ninstallOnboarding(Bot);\n''',
'''installSupportCenterEarly(Bot, installSupportCenter);\ninstallOnboarding(Bot);\ninstallDestinationAutomation(Bot);\ninstallUxNavigation(Bot);\n''', 'startup bot installers')
startup = replace_once(startup,
'''installSenderAwareDestinationUi(Api);\ninstallUiEnhancements(Api);\n''',
'''installSenderAwareDestinationUi(Api);\n// v1.2 UX is installed immediately inside the legacy UI transformer so it receives\n// normalized screens and can collapse them into the new, simpler navigation.\ninstallUxV12(Api);\ninstallUiEnhancements(Api);\n''', 'startup api installer')
startup = replace_once(startup,
'''startV1Worker();\nawait import("./app.js");''',
'''startV1Worker();\nawait import("./app.js");\n// Start approval/verification rechecks only after app.js has registered its safe state-sync hook.\nstartDestinationAutomationWorker();''', 'startup workers')
write('startup.js', startup)

# app.js integration.
app = read('app.js')
app = replace_once(app,
'import { setReloadUserStateHandler } from "./runtime-hooks.js";',
'import { setReloadUserStateHandler, setSyncUserGroupsHandler } from "./runtime-hooks.js";\nimport {\n  destinationAccountReady,\n  destinationMenu,\n  handleDestinationText,\n  parseDestinationInput,\n  recordDestinationFailure,\n} from "./destination-automation.js";', 'app imports')

old_group_object = '''      accountMode: ["inherit", "bot", "all", "selected"].includes(item.accountMode) ? item.accountMode : "inherit",\n      accountIds: [...new Set((Array.isArray(item.accountIds) ? item.accountIds : []).map(String))],\n'''
new_group_object = '''      accountMode: ["inherit", "bot", "all", "selected"].includes(item.accountMode) ? item.accountMode : "inherit",\n      accountIds: [...new Set((Array.isArray(item.accountIds) ? item.accountIds : []).map(String))],\n      topicId: Number.isInteger(Number(item.topicId)) && Number(item.topicId) > 0 ? Number(item.topicId) : null,\n      topicTitle: String(item.topicTitle || "").slice(0, 100),\n      topicRequired: item.topicRequired === true,\n      joinStatus: ["ready", "needs_topic", "partial", "pending", "verification", "read_only", "failed"].includes(item.joinStatus) ? item.joinStatus : "ready",\n      accountJoin: item.accountJoin && typeof item.accountJoin === "object" && !Array.isArray(item.accountJoin) ? item.accountJoin : {},\n      source: String(item.source || "").slice(0, 30),\n      sourceSlug: String(item.sourceSlug || "").slice(0, 160),\n      importedAt: Number(item.importedAt || 0) || null,\n'''
app = replace_once(app, old_group_object, new_group_object, 'app destination normalization')
app = app.replace('    version: 4,\n    adMessage:', '    version: 5,\n    adMessage:', 1)

hook_marker = 'setReloadUserStateHandler(reloadState);\n'
hook_new = '''setReloadUserStateHandler(reloadState);\nsetSyncUserGroupsHandler(uid => {\n  const state = states.get(String(uid));\n  if (!state) return false;\n  state.groups = normalizeSavedGroups(loadUserSettings(uid).groups);\n  return true;\n});\n'''
app = replace_once(app, hook_marker, hook_new, 'app safe group sync hook')

app = replace_once(app,
'''function destinationLabel(destination) { return destination.username || destination.label || destination.id; }''',
'''function destinationLabel(destination) {\n  const base = destination.username || destination.label || destination.id;\n  return destination.topicTitle ? `${base} → ${destination.topicTitle}` : base;\n}''', 'destination label')

show_groups_start = '''async function showGroups(ctx, state) {\n'''
show_groups_end = '''async function showRemoveGroupPage(ctx, state, requestedPage = 0) {\n'''
show_groups_repl = '''async function showGroups(ctx, state) {\n  const menu = destinationMenu(state.uid);\n  await ctx.editMessageText(menu.text, { reply_markup: menu.keyboard });\n}\n'''
app = replace_between(app, show_groups_start, show_groups_end, show_groups_repl, 'showGroups')

old_add_instructions = '''  const accounts = listAccounts(state.uid);\n  const instructions = usesBotSender(state, null, accounts)\n    ? "➕ ADD DESTINATIONS\\n\\nSend one or more public @usernames or t.me links. Put one destination on each line.\\n\\n@TelePilottBot must be an admin with posting permission in each destination. For private groups, use /addhere inside the group."\n    : "➕ ADD DESTINATIONS\\n\\nSend one or more public @usernames or t.me links. Put one destination on each line.\\n\\nAt least one selected connected account must already be joined and able to post. After adding, open Routing to choose exactly which account(s) post to each destination. Private groups without a username can use /addhere.";\n'''
new_add_instructions = '''  const accounts = listAccounts(state.uid);\n  const selectedPersonal = effectiveAccountIds(state, null, accounts);\n  const instructions = selectedPersonal.length\n    ? "➕ ADD DESTINATIONS\\n\\nPaste one or many Telegram destinations, one per line:\\n• @username or t.me/group\\n• private t.me/+ invite links\\n• t.me/addlist/... shared folders\\n\\nTelePilot will join missing groups with your selected personal sender account(s). Forum groups will ask you to choose a posting topic. Join requests and verification-required groups stay Pending until they are ready."\n    : "➕ ADD DESTINATIONS\\n\\nPaste public @usernames or t.me links, one per line.\\n\\nAutomatic joining, private invite links and Addlists require a selected personal sender account. Open Accounts first if you want TelePilot to join destinations for you. TelePilot Bot destinations still require @TelePilottBot to be added with posting permission.";\n'''
app = replace_once(app, old_add_instructions, new_add_instructions, 'add destination instructions')

# Replace message:text destination ingestion block.
start_marker = '''  if (state.awaiting === "group") {\n'''
end_marker = '''\n\n  }\n});\n\nbot.callbackQuery("account_cancel_login"'''
new_handler = '''  if (state.awaiting === "group") {\n    const pm = state.awaitingPromptMessageId;\n    const pc = state.awaitingPromptChatId || ctx.chat.id;\n    const rawText = String(ctx.message.text || "");\n    const accounts = listAccounts(state.uid);\n    const selectedPersonal = effectiveAccountIds(state, null, accounts);\n    clearAwaiting(state);\n    await safeDelete(ctx.chat.id, ctx.message.message_id);\n\n    let result;\n    if (selectedPersonal.length) {\n      result = await handleDestinationText(state.uid, rawText);\n      state.groups = normalizeSavedGroups(loadUserSettings(state.uid).groups);\n    } else {\n      const rawLines = rawText.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean);\n      const parsed = rawLines.map(parseDestinationInput);\n      const added = [], duplicates = [], failures = [];\n      let invalid = 0;\n      for (let index = 0; index < rawLines.length; index++) {\n        const item = parsed[index];\n        if (!item) { invalid++; continue; }\n        if (item.kind !== "public") {\n          failures.push(`${rawLines[index]} — automatic joining and Addlists require a selected personal account.`);\n          continue;\n        }\n        try {\n          const destination = await resolveDestination(`@${item.username}`, state.uid);\n          if (state.groups.some(group => group.id === destination.id)) duplicates.push(destinationLabel(destination));\n          else { state.groups.push(destination); added.push(destinationLabel(destination)); }\n        } catch (err) { failures.push(`${rawLines[index]} — ${err?.message || "cannot add"}`); }\n      }\n      saveState(state);\n      result = {\n        added: added.length, duplicates: duplicates.length, failed: failures.length + invalid, attention: 0,\n        text: [\n          "✅ Destination import complete",\n          `Added — ${added.length}`,\n          `Already saved — ${duplicates.length}`,\n          `Failed / invalid — ${failures.length + invalid}`,\n          ...(failures.length ? ["", ...failures.slice(0, 8)] : []),\n        ].join("\\n"),\n      };\n    }\n\n    const tutorialScreen = (result.added || result.duplicates || result.attention)\n      ? advanceTutorialAfterAction(state.uid, 3, 4)\n      : null;\n    if (tutorialScreen) {\n      try { await bot.api.editMessageText(pc, pm, tutorialScreen.text, { reply_markup: tutorialScreen.keyboard }); }\n      catch { await ctx.reply(tutorialScreen.text, { reply_markup: tutorialScreen.keyboard }); }\n      return;\n    }\n    const kb = new InlineKeyboard();\n    if (state.groups.some(group => group.topicRequired === true && !Number(group.topicId || 0))) kb.text("💬 Choose topics", "dest_topics").row();\n    kb.text("📍 Destinations", "groups");\n    try { await bot.api.editMessageText(pc, pm, result.text, { reply_markup: kb }); }\n    catch { await ctx.reply(result.text, { reply_markup: kb }); }\n    return;\n'''
app = replace_between(app, start_marker, end_marker, new_handler, 'destination message handler')

# One-tap Start. Keep start_confirm as backwards-compatible alias without a second confirmation gate.
start_cb = '''bot.callbackQuery("start", async ctx => {\n'''
stop_cb = '''bot.callbackQuery("stop", async ctx => {\n'''
new_start = '''async function startPostingFromControl(ctx) {\n  const state = stateFromCtx(ctx);\n  if (!hasAccess(state)) return ctx.answerCallbackQuery({ text: "Your TelePilot access is inactive.", show_alert: true });\n  if (state.posting) return ctx.answerCallbackQuery({ text: "TelePilot is already running." });\n  if (!state.adMessage) return ctx.answerCallbackQuery({ text: "Set a message first.", show_alert: true });\n  if (!state.groups.length) return ctx.answerCallbackQuery({ text: "Add at least one destination first.", show_alert: true });\n  const readyDestinations = state.groups.filter(group => !(group.topicRequired === true && !Number(group.topicId || 0)));\n  if (!readyDestinations.length) return ctx.answerCallbackQuery({ text: "Choose a posting topic for your forum destinations first.", show_alert: true });\n  await ctx.answerCallbackQuery({ text: "Starting…" });\n  startPostingLoop(state);\n  logAdminEvent("posting_started", { uid: String(state.uid) });\n  await showHome(ctx, state);\n}\nbot.callbackQuery("start", startPostingFromControl);\nbot.callbackQuery("start_confirm", startPostingFromControl);\n'''
app = replace_between(app, start_cb, stop_cb, new_start, 'one-tap start')

# Interval sender: topic support and readiness.
old_bot_send = '''        const result = await withDispatchContext({ uid:String(state.uid), destinationId:String(target.id), cycleId, senderType:"bot", senderLabel:"TelePilot Bot", autoDisableEligible:true }, () => bot.api.sendMessage(target.id, message, state.adEntities.length ? { entities:state.adEntities } : {}));'''
new_bot_send = '''        if (target.topicRequired === true && !Number(target.topicId || 0)) continue;\n        const botOptions = {\n          ...(state.adEntities.length ? { entities: state.adEntities } : {}),\n          ...(Number(target.topicId || 0) > 1 ? { message_thread_id: Number(target.topicId) } : {}),\n        };\n        const result = await withDispatchContext({ uid:String(state.uid), destinationId:String(target.id), cycleId, senderType:"bot", senderLabel:"TelePilot Bot", autoDisableEligible:true }, () => bot.api.sendMessage(target.id, message, botOptions));'''
app = replace_once(app, old_bot_send, new_bot_send, 'app bot topic send')
old_account_check = '''      const account = accountById.get(String(accountId));\n      if (!account) { failed++; continue; }\n      try {'''
new_account_check = '''      const account = accountById.get(String(accountId));\n      if (!account) { failed++; continue; }\n      if (!destinationAccountReady(target, account.id)) continue;\n      try {'''
app = replace_once(app, old_account_check, new_account_check, 'app personal destination readiness')
old_personal_send = '''        const result = await withDispatchContext({ uid:String(state.uid), destinationId:String(target.id), cycleId, senderType:"personal", senderLabel:accountDisplayLabel(account), accountId:String(account.id), autoDisableEligible:ids.length === 1 }, () => client.sendMessage(entity, { message, ...(state.adEntities.length ? { formattingEntities:toMtprotoEntities(state.adEntities) } : {}) }));'''
new_personal_send = '''        const result = await withDispatchContext({ uid:String(state.uid), destinationId:String(target.id), cycleId, senderType:"personal", senderLabel:accountDisplayLabel(account), accountId:String(account.id), autoDisableEligible:ids.length === 1 }, () => client.sendMessage(entity, {\n          message,\n          ...(state.adEntities.length ? { formattingEntities:toMtprotoEntities(state.adEntities) } : {}),\n          ...(Number(target.topicId || 0) > 1 ? { replyTo:Number(target.topicId), topMsgId:Number(target.topicId) } : {}),\n        }));'''
app = replace_once(app, old_personal_send, new_personal_send, 'app personal topic send')
old_failure_line = '''        if (isFatalPersonalSessionError(err)) updateAccountStatus(state.uid, account.id, { status:"needs-reconnect", lastError:code.slice(0,120), lastVerifiedAt:Date.now() });'''
new_failure_line = '''        if (isFatalPersonalSessionError(err)) updateAccountStatus(state.uid, account.id, { status:"needs-reconnect", lastError:code.slice(0,120), lastVerifiedAt:Date.now() });\n        else recordDestinationFailure(state.uid, target, account.id, err);'''
app = replace_once(app, old_failure_line, new_failure_line, 'app destination failure classification')
write('app.js', app)

# v1-worker scheduled sender parity.
worker = read('v1-worker.js')
worker = replace_once(worker,
'import { withDispatchContext } from "./dispatch-context.js";\n',
'import { withDispatchContext } from "./dispatch-context.js";\nimport { destinationAccountReady, recordDestinationFailure } from "./destination-automation.js";\n', 'worker destination import')
worker = replace_once(worker,
'function deliveryId(destination,accountId){return `${destinationId(destination)}|${accountId||"bot"}`;}',
'function deliveryId(destination,accountId){return `${destinationId(destination)}:${Number(destination?.topicId||0)}|${accountId||"bot"}`;}', 'worker delivery topic key')
old_worker_bot = '''        try{const result=await withDispatchContext({uid:String(uid),destinationId:destinationId(destination),cycleId,senderType:"bot",senderLabel:"TelePilot Bot",forcedTemplateId,autoDisableEligible:true},()=>bot.api.sendMessage(destination.id,settings.adMessage,settings.adEntities?.length?{entities:settings.adEntities}:{}));if(result?.__telepilotSkipped)skipped++;else sent++;newlyDelivered.push(key);}catch(err){failed++;errors.push(String(err?.description||err?.message||err).slice(0,180));}'''
new_worker_bot = '''        if(destination.topicRequired===true&&!Number(destination.topicId||0)){skipped++;continue;}\n        try{const opts={...(settings.adEntities?.length?{entities:settings.adEntities}:{}),...(Number(destination.topicId||0)>1?{message_thread_id:Number(destination.topicId)}:{})};const result=await withDispatchContext({uid:String(uid),destinationId:destinationId(destination),cycleId,senderType:"bot",senderLabel:"TelePilot Bot",forcedTemplateId,autoDisableEligible:true},()=>bot.api.sendMessage(destination.id,settings.adMessage,opts));if(result?.__telepilotSkipped)skipped++;else sent++;newlyDelivered.push(key);}catch(err){failed++;errors.push(String(err?.description||err?.message||err).slice(0,180));}'''
worker = replace_once(worker, old_worker_bot, new_worker_bot, 'worker bot topic send')
old_worker_account = '''        const account=byId.get(String(accountId));if(!account){failed++;errors.push(`Missing sender ${accountId}`);continue;}\n        try{'''
new_worker_account = '''        const account=byId.get(String(accountId));if(!account){failed++;errors.push(`Missing sender ${accountId}`);continue;}\n        if(!destinationAccountReady(destination,account.id)){skipped++;continue;}\n        try{'''
worker = replace_once(worker, old_worker_account, new_worker_account, 'worker readiness')
old_worker_personal = '''          const result=await withDispatchContext({uid:String(uid),destinationId:destinationId(destination),cycleId,senderType:"personal",senderLabel:accountDisplayLabel(account),accountId:String(account.id),forcedTemplateId,autoDisableEligible:accountIds.length===1},()=>client.sendMessage(entity,{message:settings.adMessage,...(settings.adEntities?.length?{formattingEntities:toMtEntities(settings.adEntities)}:{})}));'''
new_worker_personal = '''          const result=await withDispatchContext({uid:String(uid),destinationId:destinationId(destination),cycleId,senderType:"personal",senderLabel:accountDisplayLabel(account),accountId:String(account.id),forcedTemplateId,autoDisableEligible:accountIds.length===1},()=>client.sendMessage(entity,{message:settings.adMessage,...(settings.adEntities?.length?{formattingEntities:toMtEntities(settings.adEntities)}:{}),...(Number(destination.topicId||0)>1?{replyTo:Number(destination.topicId),topMsgId:Number(destination.topicId)}:{})}));'''
worker = replace_once(worker, old_worker_personal, new_worker_personal, 'worker personal topic send')
old_worker_catch = '''        }catch(err){failed++;const message=String(err?.errorMessage||err?.message||err).slice(0,180);errors.push(`${accountDisplayLabel(account)}: ${message}`);updateAccountStatus(uid,account.id,{status:isFatalSessionError(err)?"needs-reconnect":"unknown",lastError:message,lastVerifiedAt:Date.now()});}'''
new_worker_catch = '''        }catch(err){failed++;const message=String(err?.errorMessage||err?.message||err).slice(0,180);errors.push(`${accountDisplayLabel(account)}: ${message}`);updateAccountStatus(uid,account.id,{status:isFatalSessionError(err)?"needs-reconnect":"unknown",lastError:message,lastVerifiedAt:Date.now()});if(!isFatalSessionError(err))recordDestinationFailure(uid,destination,account.id,err);}'''
worker = replace_once(worker, old_worker_catch, new_worker_catch, 'worker failure classification')
write('v1-worker.js', worker)

# onboarding.js: retain persisted step compatibility while matching the new navigation and Addlist flow.
onboarding = read('onboarding.js')
onboarding = onboarding.replace('version: 2,', 'version: 3,', 1)
onboarding = onboarding.replace('version: 2 });', 'version: 3 });', 1)

def replace_function(text, name, next_name, body):
    start = f'function {name}'
    end = f'function {next_name}'
    return replace_between(text, start, end, body, name)

onboarding = replace_function(onboarding, 'welcomePage()', 'featuresPage()', '''function welcomePage() {\n  return {\n    text: [\n      "👋 Welcome to TelePilot",\n      "",\n      "Set up automated Telegram posting without digging through a crowded control panel.",\n      "",\n      "The main app is organized into Home, Posting Setup, Accounts, Destinations and Settings.",\n      "",\n      "Continue to activate your access and build your first posting setup."\n    ].join("\\n"),\n    keyboard: new InlineKeyboard().text("Continue →", "onboarding:access").row().text("What can TelePilot do?", "onboarding:features"),\n  };\n}\n\n''')
onboarding = replace_function(onboarding, 'featuresPage()', 'setupPage1(uid)', '''function featuresPage() {\n  return {\n    text: [\n      "✨ TelePilot",\n      "",\n      "• Personal-account or TelePilot Bot sending",\n      "• Automatic destination joining for selected personal accounts",\n      "• Telegram Addlist / shared-folder importing",\n      "• Forum topic selection",\n      "• Repeating and exact-time posting",\n      "• Multi-account routing, preview and activity history",\n      "",\n      "Advanced controls stay out of the way until you need them."\n    ].join("\\n"),\n    keyboard: new InlineKeyboard().text("← Back", "onboarding:welcome").text("Continue →", "onboarding:access"),\n  };\n}\n\n''')
onboarding = replace_function(onboarding, 'setupPage1(uid)', 'setupPage2(uid)', '''function setupPage1(uid) {\n  const saved = settingsFor(uid);\n  const plan = saved.accessLifetime === true ? "Lifetime" : "Active";\n  return {\n    text: [\n      "✅ Access activated",\n      "",\n      `Access: ${plan}`,\n      "",\n      "This setup uses the same controls you will use every day. TelePilot saves your place if you leave and /start resumes the tutorial.",\n      "",\n      "We will configure Accounts → Destinations → Posting Setup → Preview."\n    ].join("\\n"),\n    keyboard: new InlineKeyboard().text("Start Setup →", "tutorial:2").row().text("Skip tutorial", "tutorial:skip"),\n  };\n}\n\n''')
onboarding = replace_function(onboarding, 'setupPage2(uid)', 'setupPage3(uid)', '''function setupPage2(uid) {\n  const saved = settingsFor(uid);\n  const accounts = listAccounts(uid);\n  const connected = accounts.length > 0;\n  const currentSender = senderSummary(saved, accounts);\n  return {\n    text: [\n      "👤 Step 1 of 5 — Accounts",\n      "",\n      connected ? `Connected accounts: ${accounts.length}` : "Choose who should send your posts.",\n      connected ? `Current sender: ${currentSender}` : "",\n      "",\n      "Personal accounts can automatically join pasted destinations and Addlists. TelePilot Bot works too, but you must add the bot to its destinations yourself."\n    ].filter(Boolean).join("\\n"),\n    keyboard: connected\n      ? new InlineKeyboard().text("👤 Use Connected Account", "tutorial:personal").row().text("🤖 Use TelePilot Bot", "tutorial:bot").row().text("Open Accounts", "account").row().text("Next →", "tutorial:3").text("Skip", "tutorial:skip")\n      : new InlineKeyboard().text("👤 Connect Personal Account", "account").row().text("🤖 Use TelePilot Bot", "tutorial:bot").row().text("Skip", "tutorial:skip"),\n  };\n}\n\n''')
onboarding = replace_function(onboarding, 'setupPage3(uid)', 'setupPage4(uid)', '''function setupPage3(uid) {\n  const saved = settingsFor(uid);\n  const groups = Array.isArray(saved.groups) ? saved.groups : [];\n  return {\n    text: [\n      "📍 Step 2 of 5 — Destinations",\n      "",\n      groups.length ? `Configured: ${groups.length}` : "Add where TelePilot should post.",\n      "",\n      "Paste public links, private invite links or a t.me/addlist/... shared folder. With a personal sender selected, TelePilot automatically joins missing groups.",\n      "",\n      "If a group uses forum topics, TelePilot asks you to choose the exact topic. Join requests and verification stay Pending instead of blocking the rest of your setup."\n    ].join("\\n"),\n    keyboard: groups.length\n      ? new InlineKeyboard().text("📍 Destinations", "groups").row().text("← Back", "tutorial:2").text("Next →", "tutorial:4").row().text("Skip", "tutorial:skip")\n      : new InlineKeyboard().text("＋ Add Destinations", "groups").row().text("← Back", "tutorial:2").text("Skip", "tutorial:skip"),\n  };\n}\n\n''')
onboarding = replace_function(onboarding, 'setupPage4(uid)', 'setupPage5(uid)', '''function setupPage4(uid) {\n  const saved = settingsFor(uid);\n  const ready = typeof saved.adMessage === "string" && saved.adMessage.trim().length > 0;\n  return {\n    text: [\n      "📝 Step 3 of 5 — Posting Setup",\n      "",\n      ready ? `Message ready · ${saved.adMessage.length} characters` : "Create the message TelePilot should send.",\n      "",\n      "Message and timing live together under Posting Setup. Advanced templates and exact schedules stay hidden under Advanced."\n    ].join("\\n"),\n    keyboard: ready\n      ? new InlineKeyboard().text("🧩 Posting Setup", "posting_setup").row().text("← Back", "tutorial:3").text("Next →", "tutorial:5").row().text("Skip", "tutorial:skip")\n      : new InlineKeyboard().text("📝 Create Message", "message").row().text("← Back", "tutorial:3").text("Skip", "tutorial:skip"),\n  };\n}\n\n''')
onboarding = replace_function(onboarding, 'setupPage5(uid)', 'setupPage6()', '''function setupPage5(uid) {\n  const saved = settingsFor(uid);\n  const interval = formatInterval(saved.intervalMinutes || 30);\n  return {\n    text: [\n      "⏱ Step 4 of 5 — Timing",\n      "",\n      `Current interval: ${interval}`,\n      "",\n      "Choose a normal repeat interval now. Exact times, one-time posts and other advanced scheduling remain available from Posting Setup → Advanced."\n    ].join("\\n"),\n    keyboard: new InlineKeyboard().text("⏱ Choose Timing", "interval").row().text("← Back", "tutorial:4").text("Next →", "tutorial:6").row().text("Skip", "tutorial:skip"),\n  };\n}\n\n''')
onboarding = replace_function(onboarding, 'setupPage6()', 'setupPage7(uid)', '''function setupPage6() {\n  return {\n    text: [\n      "👀 Step 5 of 5 — Preview",\n      "",\n      "Smart Preview shows the sender, message, active destinations and timing before you go live.",\n      "",\n      "Starting from Home is now one tap — there is no extra confirmation for normal posting actions."\n    ].join("\\n"),\n    keyboard: new InlineKeyboard().text("👀 Smart Preview", "v1_preview").row().text("← Back", "tutorial:5").text("Finish →", "tutorial:7").row().text("Skip", "tutorial:skip"),\n  };\n}\n\n''')
onboarding = replace_function(onboarding, 'setupPage7(uid)', 'tutorialPage(uid, page)', '''function setupPage7(uid) {\n  const saved = settingsFor(uid);\n  const groups = Array.isArray(saved.groups) ? saved.groups.length : 0;\n  const messageReady = typeof saved.adMessage === "string" && saved.adMessage.trim().length > 0;\n  const sender = hasPersonalSession(uid) ? senderSummary(saved, listAccounts(uid)) : "TelePilot Bot";\n  return {\n    text: [\n      "🎉 TelePilot is ready",\n      "",\n      `Sender  ${sender}`,\n      `Message  ${messageReady ? "Ready" : "Not set"}`,\n      `Destinations  ${groups}`,\n      `Timing  ${formatInterval(saved.intervalMinutes || 30)}`,\n      "",\n      "Home now stays simple: Start/Stop, Posting Setup, Accounts, Destinations and Settings. Advanced tools remain available without crowding the main screen."\n    ].join("\\n"),\n    keyboard: new InlineKeyboard().text("← Back", "tutorial:6").row().text("✅ Open TelePilot", "tutorial:finish"),\n  };\n}\n\n''')
write('onboarding.js', onboarding)

# package.json: permanent v1.2 regression gate.
pkg = read('package.json')
pkg = replace_once(pkg,
'"test": "npm run test:security && npm run test:teleproto && npm run test:v11",',
'"test": "npm run test:security && npm run test:teleproto && npm run test:v11 && npm run test:v12",', 'package test chain')
pkg = replace_once(pkg,
'"test:v11": "node telepilot-v11-regression-test.mjs"',
'"test:v11": "node telepilot-v11-regression-test.mjs",\n    "test:v12": "node telepilot-v12-regression-test.mjs"', 'package v12 test')
write('package.json', pkg)

print('TelePilot v1.2 integration patch applied')
