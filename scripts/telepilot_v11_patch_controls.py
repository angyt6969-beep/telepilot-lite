from pathlib import Path


def patch(path, fn):
    p=Path(path); s=p.read_text(); s=fn(s); p.write_text(s); print(f'patched {path}')

def once(s,old,new,label):
    c=s.count(old)
    if c!=1: raise RuntimeError(f'{label}: expected one, got {c}')
    return s.replace(old,new,1)

def section(s,start,end,new,label):
    a=s.find(start)
    if a<0: raise RuntimeError(f'{label}: start not found')
    b=s.find(end,a+len(start))
    if b<0: raise RuntimeError(f'{label}: end not found')
    return s[:a]+new.rstrip()+'\n\n'+s[b:]


def v1_controls(s):
    s=once(s,'import { InlineKeyboard } from "grammy";\n','import { InlineKeyboard } from "grammy";\nimport { listAccounts, senderSummary } from "./account-store.js";\n','v1 account import')
    s=section(s,'function localToUtcMs(date, time, offsetMinutes) {','function fakeCallbackContext(ctx, data) {',r'''function strictDateParts(date) {
  const m=String(date||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return null;const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);const d=new Date(Date.UTC(year,month-1,day));if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return null;return{year,month,day};
}
function localToUtcMs(date, time, offsetMinutes) {
  const d=strictDateParts(date),t=String(time||"").match(/^(\d{2}):(\d{2})$/);if(!d||!t)return 0;const hour=Number(t[1]),minute=Number(t[2]);if(hour>23||minute>59)return 0;return Date.UTC(d.year,d.month-1,d.day,hour,minute)-Number(offsetMinutes||0)*60_000;
}
''','strict dates')
    # Date range must also validate real calendar dates.
    s=once(s,'if (!match || match[2] < match[1]) {','if (!match || !strictDateParts(match[1]) || !strictDateParts(match[2]) || match[2] < match[1]) {','date range validation')
    # Multi-account sender health display.
    s=section(s,'async function showSession(ctx) {','async function showBackup(ctx) {',r'''async function showSession(ctx) {
  const uid=uidOf(ctx),settings=readAppSettings(uid),pro=readV1(uid),accounts=listAccounts(uid),kb=new InlineKeyboard().text("Open Sender","account").row().text("⬅️ Power Tools","v1_tools");
  const healthy=accounts.filter(a=>a.status==="connected").length,attention=accounts.filter(a=>a.status==="needs-reconnect").length;
  await ctx.editMessageText(["🩺 Sender health",`Sender mode — ${senderSummary(settings,accounts)}`,`Connected accounts — ${accounts.length}`,`Healthy — ${healthy}`,`Needs reconnect — ${attention}`,`Overall — ${accounts.length?pro.sessionHealth.status:"Bot sender"}`,`Last verified — ${accounts.length?fmtAgo(pro.sessionHealth.lastCheckedAt):"—"}`,...(pro.sessionHealth.lastError?[`Last issue — ${pro.sessionHealth.lastError}`]:[]),"","A problem with one sender no longer disables the other connected accounts."].join("\n"),{reply_markup:kb});
}
''','multi sender health')
    # Changelog 1.1.
    s=section(s,'async function showChangelog(ctx) {','async function showAdminUsers(ctx) {',r'''async function showChangelog(ctx) {
  const uid=uidOf(ctx),pro=readV1(uid);pro.changelogSeen="1.1.0";writeV1(uid,pro);
  await ctx.editMessageText(["🆕 What's new in TelePilot 1.1","","• Unlimited connected sender accounts at the TelePilot app level","• Post from all accounts or any selected accounts at once","• Per-destination account routing — different accounts can handle different groups","• Per-destination message templates — different groups can receive different posts","• Bulk destination adding — paste one group/channel per line","• LIVE interval posting resumes after safe service restarts","• Long Telegram FLOOD_WAIT values now use the real wait time","• Exact-time and one-time jobs track partial delivery so retries do not duplicate successful sends","• Stronger account health, retry and failure classification","• Safer transactional backup restore and broader configuration backups","","Open Sender and Destination Routing to configure the new multi-account controls."].join("\n"),{reply_markup:new InlineKeyboard().text("👤 Sender","account").text("📍 Destinations","groups").row().text("⬅️ Power Tools","v1_tools")});
}
''','1.1 changelog')
    # Clear pending input on navigation/cancel callbacks before the next text can be consumed.
    old='''  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    for (const handler of middleware) {'''
    new='''  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    const inputOpeners = new Set(["v1_exact_add","v1_once_add","v1_date_range","v1_expiry_set","v1_limit_set","v1_variable_add","v1_variable_remove","v1_search_dest","v1_search_tpl"]);
    if (typeof trigger === "string" && !inputOpeners.has(trigger)) {
      middleware = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx,next) { const uid=uidOf(ctx); if(uid) pending.delete(uid); return handler.call(this,ctx,next); });
    }
    for (const handler of middleware) {'''
    s=once(s,old,new,'clear v1 pending')
    return s


def pro_controls(s):
    s=once(s,'import { StringSession } from "teleproto/sessions/index.js";\n','import { StringSession } from "teleproto/sessions/index.js";\nimport { accountDisplayLabel, effectiveAccountIds, listAccounts, loadAccountSession, senderSummary, updateAccountStatus } from "./account-store.js";\nimport { withDispatchContext } from "./dispatch-context.js";\nimport { reloadUserState } from "./runtime-hooks.js";\n','pro account imports')
    # Replace single-session opener.
    s=section(s,'async function openPersonalClient(uid) {','function toMtprotoEntities(entities = []) {',r'''async function openPersonalClient(uid, accountId) {
  const account=listAccounts(uid).find(a=>a.id===String(accountId));if(!account)throw new Error("Sender account not found.");
  const client=new TelegramClient(new StringSession(loadAccountSession(uid,account.id)),API_ID,API_HASH,{connectionRetries:5,floodSleepThreshold:60});client.__telepilotOwnerUid=String(uid);client.__telepilotAccountId=String(account.id);await client.connect();if(!(await client.checkAuthorization()))throw new Error("Personal account session is no longer authorized.");const me=await client.getMe();updateAccountStatus(uid,account.id,{telegramId:me?.id,username:me?.username,firstName:me?.firstName,lastName:me?.lastName,status:"connected",lastError:"",lastVerifiedAt:Date.now()});return client;
}
''','pro account opener')
    # Test send all/selected accounts.
    s=section(s,'async function sendTest(ctx) {','async function checkDestinationHealth(ctx) {',r'''async function sendTest(ctx) {
  const uid=uidOf(ctx),settings=readAppSettings(uid),pro=readProSettings(uid);if(!settings.adMessage)return ctx.answerCallbackQuery({text:"Create a message first.",show_alert:true});
  const destination={id:String(ctx.chat.id),label:"Test preview",username:""},accounts=listAccounts(uid),ids=effectiveAccountIds(settings,null,accounts);await ctx.answerCallbackQuery({text:"Sending test…"});
  if(accounts.length){let sent=0,failed=0;for(const id of ids){const account=accounts.find(a=>a.id===id);let client;try{client=await openPersonalClient(uid,id);const rendered=renderDynamicMessage(settings.adMessage,settings.adEntities||[],{pro,destination,sender:accountDisplayLabel(account)}),mt=toMtprotoEntities(rendered.entities);if(pro.media?.localPath&&fs.existsSync(pro.media.localPath))await client.sendFile("me",{file:pro.media.localPath,caption:rendered.text,...(mt.length?{formattingEntities:mt}:{}),forceDocument:pro.media.kind==="document",supportsStreaming:pro.media.kind==="video"});else await client.sendMessage("me",{message:rendered.text||"\u2063",...(mt.length?{formattingEntities:mt}:{})});sent++;}catch{failed++;}finally{try{await client?.disconnect();}catch{}}}await ctx.reply(`✅ Test complete — ${sent} sender${sent===1?"":"s"} received it in Saved Messages${failed?` • ${failed} failed`:""}.`);return;}
  const rendered=renderDynamicMessage(settings.adMessage,settings.adEntities||[],{pro,destination,sender:"TelePilot Bot"});if(pro.media?.fileId){const options={...(rendered.text?{caption:rendered.text}:{}),...(rendered.entities.length?{caption_entities:rendered.entities}:{})};if(pro.media.kind==="photo")await ctx.api.sendPhoto(ctx.chat.id,pro.media.fileId,options);else if(pro.media.kind==="video")await ctx.api.sendVideo(ctx.chat.id,pro.media.fileId,{...options,supports_streaming:true});else if(pro.media.kind==="animation")await ctx.api.sendAnimation(ctx.chat.id,pro.media.fileId,options);else await ctx.api.sendDocument(ctx.chat.id,pro.media.fileId,options);}else await ctx.api.sendMessage(ctx.chat.id,rendered.text||"\u2063",rendered.entities.length?{entities:rendered.entities}:{});
}
''','multi test send')
    # Health no 500-dialog cap; page output naturally limited for Telegram messages.
    s=s.replace('const dialogs = await client.getDialogs({ limit: 500 });','const dialogs = await client.getDialogs({});')
    # If old health opens one client without id, replace its personal branch wholesale with a concise all-account check.
    start='''  if (hasPersonalSessionFile(uid)) {
    let client;
    try {
      client = await openPersonalClient(uid);'''
    if start in s:
      a=s.find(start); b=s.find('''  } else {
    const botInfo = await ctx.api.getMe();''',a)
      if b<0: raise RuntimeError('health else marker missing')
      replacement=r'''  if (listAccounts(uid).length) {
    const accounts=listAccounts(uid);
    for (const group of groups.slice(0, 25)) {
      let ready=0,blocked=0;
      for (const account of accounts) { let client; try { client=await openPersonalClient(uid,account.id); const dialogs=await client.getDialogs({}); let dialog=null;if(group.username)dialog=dialogs.find(item=>String(item?.entity?.username||"").toLowerCase()===String(group.username).replace(/^@/,"").toLowerCase());if(!dialog){const raw=String(group.id||"").replace(/^-100/,"").replace(/^-/,"");dialog=dialogs.find(item=>String(item?.entity?.id||"").replace(/\D/g,"")===raw);}if(dialog&&!(dialog.entity?.broadcast===true&&dialog.entity?.creator!==true&&dialog.entity?.adminRights?.postMessages!==true))ready++;else blocked++;}catch{blocked++;}finally{try{await client?.disconnect();}catch{}} }
      lines.push(`${ready?"✅":"❌"} ${destinationLabel(group)} — ${ready}/${accounts.length} sender${accounts.length===1?"":"s"} ready${blocked?` • ${blocked} unavailable`:""}`);
    }
'''
      s=s[:a]+replacement+'\n'+s[b:]
    # Cancel message editor must really clear marker.
    s=once(s,'if (uid && trigger !== "message") messageEditorUsers.delete(uid);','if (uid) messageEditorUsers.delete(uid);','message editor cancel')
    # Clear pro pending when navigating away from an input.
    old='''  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    for (const handler of middleware) {'''
    new='''  BotClass.prototype.callbackQuery = function(trigger, ...middleware) {
    const inputOpeners=new Set(["tpl_save","sched_timezone","import_config"]);
    if(typeof trigger==="string"&&!inputOpeners.has(trigger)){middleware=middleware.map(handler=>typeof handler!=="function"?handler:async function(ctx,next){const uid=uidOf(ctx);if(uid)proAwaiting.delete(uid);return handler.call(this,ctx,next);});}
    for (const handler of middleware) {'''
    s=once(s,old,new,'clear pro pending')
    # Backup format 3: keep safe fields and all scheduling/routing configuration, excluding sessions/access.
    s=section(s,'function backupPayload(uid) {','function safeExport(uid) {',r'''function backupPayload(uid) {
  const settings=readAppSettings(uid),pro=readProSettings(uid),text=String(settings.adMessage||"").slice(0,4096);
  const templates=(pro.templates||[]).slice(0,100).map(template=>{const message=String(template.message||"").slice(0,4096);return{id:String(template.id||""),name:sanitizeName(template.name),message,entities:safeEntities(template.entities,message.length),createdAt:Number(template.createdAt||Date.now()),pinned:template.pinned===true,expiresAt:Number(template.expiresAt||0)||0};});
  return {kind:"TelePilotConfig",version:3,ownerUid:String(uid),exportedAt:new Date().toISOString(),message:{text,entities:safeEntities(settings.adEntities,text.length)},destinations:(settings.groups||[]).filter(g=>/^@[A-Za-z0-9_]{5,32}$/.test(String(g.username||""))).slice(0,2000).map(g=>({id:String(g.id||""),label:String(g.label||"").slice(0,120),type:String(g.type||"").slice(0,24),username:String(g.username),accountMode:["inherit","all","selected"].includes(g.accountMode)?g.accountMode:"inherit",accountIds:Array.isArray(g.accountIds)?g.accountIds.map(String):[]})),intervalMinutes:IMPORT_INTERVALS.has(Number(settings.intervalMinutes))?Number(settings.intervalMinutes):30,senderMode:settings.senderMode==="all"?"all":"selected",selectedAccountIds:Array.isArray(settings.selectedAccountIds)?settings.selectedAccountIds.map(String):[],pro:{placeholders:pro.placeholders===true,staggerSeconds:[0,2,5,10,20].includes(Number(pro.staggerSeconds))?Number(pro.staggerSeconds):0,schedule:safeSchedule(pro.schedule,defaultProSettings().schedule),templates,rotation:pro.rotation,destinationOverrides:pro.destinationOverrides,destinationFolders:pro.destinationFolders,disabledFolders:pro.disabledFolders,customVariables:pro.customVariables,dateRange:pro.dateRange,activeMessageExpiresAt:Number(pro.activeMessageExpiresAt||0),postLimit:pro.postLimit,notificationMode:pro.notificationMode,autoDisableFailures:Number(pro.autoDisableFailures||3),disabledDestinationIds:pro.disabledDestinationIds,exactTimes:pro.exactTimes,oneTimeJobs:(pro.oneTimeJobs||[]).filter(j=>!j.status||j.status==="pending"),weeklyRecap:pro.weeklyRecap}};
}
''','full backup payload')
    # Accept v2/v3, preserve safe extended pro objects for signed same-user backup.
    s=once(s,'if (parsed?.kind !== "TelePilotConfig" || Number(parsed?.version) !== 2) {','if (parsed?.kind !== "TelePilotConfig" || ![2,3].includes(Number(parsed?.version))) {','backup versions')
    # Extend returned config just before validate function return using known limited pro block.
    old='''    pro: {
      placeholders: payload.pro?.placeholders === true,
      staggerSeconds: [0, 2, 5, 10, 20].includes(Number(payload.pro?.staggerSeconds)) ? Number(payload.pro.staggerSeconds) : 0,
      schedule: safeSchedule(payload.pro?.schedule, currentPro.schedule),
      templates,
    },'''
    new='''    senderMode: payload.senderMode === "all" ? "all" : "selected",
    selectedAccountIds: Array.isArray(payload.selectedAccountIds) ? payload.selectedAccountIds.map(String) : [],
    pro: {
      placeholders: payload.pro?.placeholders === true,
      staggerSeconds: [0, 2, 5, 10, 20].includes(Number(payload.pro?.staggerSeconds)) ? Number(payload.pro.staggerSeconds) : 0,
      schedule: safeSchedule(payload.pro?.schedule, currentPro.schedule), templates,
      rotation: payload.pro?.rotation && typeof payload.pro.rotation === "object" ? payload.pro.rotation : currentPro.rotation,
      destinationOverrides: payload.pro?.destinationOverrides && typeof payload.pro.destinationOverrides === "object" ? payload.pro.destinationOverrides : {},
      destinationFolders: payload.pro?.destinationFolders && typeof payload.pro.destinationFolders === "object" ? payload.pro.destinationFolders : {},
      disabledFolders: Array.isArray(payload.pro?.disabledFolders) ? payload.pro.disabledFolders.map(String) : [],
      customVariables: payload.pro?.customVariables && typeof payload.pro.customVariables === "object" ? payload.pro.customVariables : {},
      dateRange: payload.pro?.dateRange && typeof payload.pro.dateRange === "object" ? payload.pro.dateRange : currentPro.dateRange,
      activeMessageExpiresAt: Number(payload.pro?.activeMessageExpiresAt || 0) || 0,
      postLimit: payload.pro?.postLimit && typeof payload.pro.postLimit === "object" ? payload.pro.postLimit : currentPro.postLimit,
      notificationMode: ["all","important","silent"].includes(payload.pro?.notificationMode) ? payload.pro.notificationMode : currentPro.notificationMode,
      autoDisableFailures: Math.min(10,Math.max(2,Number(payload.pro?.autoDisableFailures||3))),
      disabledDestinationIds: Array.isArray(payload.pro?.disabledDestinationIds) ? payload.pro.disabledDestinationIds.map(String) : [],
      exactTimes: Array.isArray(payload.pro?.exactTimes) ? payload.pro.exactTimes.slice(0,100) : [],
      oneTimeJobs: Array.isArray(payload.pro?.oneTimeJobs) ? payload.pro.oneTimeJobs.slice(0,100) : [],
      weeklyRecap: payload.pro?.weeklyRecap && typeof payload.pro.weeklyRecap === "object" ? payload.pro.weeklyRecap : currentPro.weeklyRecap,
    },'''
    if old not in s: raise RuntimeError('validate pro return not found')
    s=s.replace(old,new,1)
    # Transactional import: snapshot both files and roll back automatically on any thrown apply failure.
    s=once(s,'''    try {
      savePreImportBackup(uid);
      const config = pending.config;''','''    const settingsFilePath=settingsPath(uid),proFilePath=path.join(userDir(uid),"pro-settings.json");
    const beforeSettings=fs.existsSync(settingsFilePath)?fs.readFileSync(settingsFilePath):null,beforePro=fs.existsSync(proFilePath)?fs.readFileSync(proFilePath):null;
    try {
      savePreImportBackup(uid);
      const config = pending.config;''','import snapshot')
    s=once(s,'''      importedPro.templates = config.pro.templates;
      writeProSettings(uid, importedPro);''','''      Object.assign(importedPro, config.pro);
      importedPro.templates = config.pro.templates;
      writeProSettings(uid, importedPro);''','import full pro')
    # After handlers apply interval/destinations, persist sender/routing settings directly.
    s=once(s,'''      for (const destination of config.destinations) {
        try { await applyDestination(ctx, destination.username); added++; } catch {}
      }
      appendSecurityEvent("backup_imported", { uid, destinations: added });''','''      for (const destination of config.destinations) { try { await applyDestination(ctx,destination.username); added++; } catch {} }
      const restoredSettings=readJson(settingsPath(uid),{});restoredSettings.senderMode=config.senderMode;restoredSettings.selectedAccountIds=config.selectedAccountIds;const routingByUsername=new Map(config.destinations.map(d=>[String(d.username).toLowerCase(),d]));restoredSettings.groups=(restoredSettings.groups||[]).map(g=>{const r=routingByUsername.get(String(g.username||"").toLowerCase());return r?{...g,accountMode:r.accountMode||"inherit",accountIds:Array.isArray(r.accountIds)?r.accountIds:[]}:g;});fs.writeFileSync(settingsPath(uid),JSON.stringify(restoredSettings,null,2),{mode:0o600});reloadUserState(uid);
      appendSecurityEvent("backup_imported", { uid, destinations: added });''','import routing')
    s=once(s,'''    } catch (err) {
      appendSecurityEvent("backup_import_failed", { uid, reason: String(err?.message || err).slice(0, 120) });''','''    } catch (err) {
      try { if(beforeSettings)fs.writeFileSync(settingsFilePath,beforeSettings,{mode:0o600});else fs.rmSync(settingsFilePath,{force:true}); if(beforePro)fs.writeFileSync(proFilePath,beforePro,{mode:0o600});else fs.rmSync(proFilePath,{force:true}); reloadUserState(uid); } catch(rollbackErr){ console.error("TelePilot import rollback failed:",rollbackErr?.message||rollbackErr); }
      appendSecurityEvent("backup_import_failed", { uid, reason: String(err?.message || err).slice(0, 120) });''','import rollback')
    return s


def onboarding(s):
    # Add account store import and replace local session-file check function.
    s=once(s,'import { InlineKeyboard } from "grammy";\n','import { InlineKeyboard } from "grammy";\nimport { listAccounts, senderSummary } from "./account-store.js";\n','onboarding account import')
    # Locate local hasPersonalSession function by markers if present.
    if 'function hasPersonalSession(uid)' in s:
      a=s.find('function hasPersonalSession(uid)');b=s.find('\n}\n',a)+3
      s=s[:a]+'function hasPersonalSession(uid) { return listAccounts(uid).length > 0; }\n'+s[b:]
    s=s.replace('"Connect one personal Telegram account so TelePilot can post as you."','"Connect one or more personal Telegram accounts. You can later post from all accounts, selected accounts, or route different accounts to different destinations."')
    s=s.replace('"Add the group or channel where TelePilot should post."','"Add one or many groups/channels. You can paste public destinations one per line and route each one separately."')
    # Ready sender summary from account store.
    old='''  const sender = hasPersonalSession(uid)
    ? (saved.personalUsername ? `@${saved.personalUsername}` : "Personal account")
    : "TelePilot Bot";'''
    if old in s: s=s.replace(old,'  const sender = senderSummary(saved, listAccounts(uid));',1)
    return s


def extras(s):
    s=once(s,'import { InlineKeyboard } from "grammy";\n','import { InlineKeyboard } from "grammy";\nimport { listAccounts, senderSummary } from "./account-store.js";\nimport { advanceTutorialAfterAction } from "./onboarding.js";\n','extras imports')
    s=s.replace('function senderLabel(settings) {\n  return settings.personalUsername ? `@${settings.personalUsername}` : "TelePilot Bot";\n}','function senderLabel(settings,uid) { return senderSummary(settings,listAccounts(uid)); }')
    s=s.replace('`Sender — ${senderLabel(settings)}`','`Sender — ${senderLabel(settings,uid)}`')
    # Smart preview already counts disabled folders. Add tutorial continuation button if step matches.
    s=once(s,'''  kb.text("🧭 Posting queue", "v1_queue").text("⚡ Power Tools", "v1_tools").row().text("⬅️ Dashboard", "home");''','''  const tutorialNext=advanceTutorialAfterAction(uid,6,7);
  if(tutorialNext) kb.text("Continue tutorial →","tutorial:7").row();
  kb.text("🧭 Posting queue", "v1_queue").text("⚡ Power Tools", "v1_tools").row().text("⬅️ Dashboard", "home");''','preview tutorial continuation')
    return s


def sender_ui(s):
    # Remove fs/path session-file dependency by using account store summary.
    if 'import fs from "node:fs";' in s:
      s=s.replace('import fs from "node:fs";\n','').replace('import path from "node:path";\n','')
    s='import { listAccounts, senderSummary } from "./account-store.js";\n'+s
    # Replace hasPersonalSession function body generically.
    if 'function hasPersonalSession(uid)' in s:
      a=s.find('function hasPersonalSession(uid)');b=s.find('\n}',a)+2;s=s[:a]+'function hasPersonalSession(uid) { return listAccounts(uid).length > 0; }'+s[b:]
    # If a sender label helper reads settings username, make it multi-account aware when easy.
    s=s.replace('return settings.personalUsername ? `@${settings.personalUsername}` : "TelePilot Bot";','return senderSummary(settings, listAccounts(uid));')
    return s

patch('v1-controls.js',v1_controls)
patch('pro-controls.js',pro_controls)
patch('onboarding.js',onboarding)
patch('v1-extras.js',extras)
patch('sender-destination-ui.js',sender_ui)
