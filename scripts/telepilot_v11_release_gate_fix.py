from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return (ROOT / name).read_text(encoding="utf-8")


def write(name, text):
    (ROOT / name).write_text(text, encoding="utf-8")


def replace_once(text, old, new, label):
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one old block, found {count}")
    return text.replace(old, new, 1)


def section(text, start, end, new_body, label):
    a = text.find(start)
    if a < 0:
        raise RuntimeError(f"{label}: start not found")
    b = text.find(end, a)
    if b < 0:
        raise RuntimeError(f"{label}: end not found")
    return text[:a] + new_body.rstrip() + "\n" + text[b:]


# ---------------------------------------------------------------------------
# account-store.js: explicit bot/all/selected sender modes plus per-route bot.
# ---------------------------------------------------------------------------
name = "account-store.js"
text = read(name)
text = section(
    text,
    "export function normalizeAccountSelection",
    "export function senderSummary",
    '''export function normalizeAccountSelection(settings, accounts = []) {
  const valid = new Set(accounts.map(item => String(item.id)));
  const selected = [...new Set((Array.isArray(settings?.selectedAccountIds) ? settings.selectedAccountIds : []).map(String).filter(id => valid.has(id)))];
  const requestedMode = String(settings?.senderMode || "");
  // Preserve legacy behaviour for profiles created before senderMode existed:
  // a connected personal account remains selected unless the user explicitly chooses Bot.
  const mode = requestedMode === "bot" ? "bot" : requestedMode === "all" ? "all" : "selected";
  if (mode === "selected" && !selected.length && accounts[0]) selected.push(String(accounts[0].id));
  return { mode, selected };
}
export function usesBotSender(settings, destination = null, accounts = []) {
  if (!accounts.length) return true;
  const routeMode = ["inherit", "bot", "all", "selected"].includes(destination?.accountMode) ? destination.accountMode : "inherit";
  if (routeMode === "bot") return true;
  if (routeMode !== "inherit") return false;
  return normalizeAccountSelection(settings, accounts).mode === "bot";
}
export function effectiveAccountIds(settings, destination = null, accounts = []) {
  if (!accounts.length) return [];
  const valid = new Set(accounts.map(item => String(item.id)));
  const routeMode = ["inherit", "bot", "all", "selected"].includes(destination?.accountMode) ? destination.accountMode : "inherit";
  if (routeMode === "bot") return [];
  if (routeMode === "all") return accounts.map(item => String(item.id));
  if (routeMode === "selected") {
    return [...new Set((Array.isArray(destination?.accountIds) ? destination.accountIds : []).map(String).filter(id => valid.has(id)))];
  }
  const global = normalizeAccountSelection(settings, accounts);
  if (global.mode === "bot") return [];
  return global.mode === "all" ? accounts.map(item => String(item.id)) : global.selected;
}''',
    "account selection and route mode",
)
text = section(
    text,
    "export function senderSummary",
    "\n}",
    '''export function senderSummary(settings, accounts = []) {
  if (!accounts.length) return "TelePilot Bot";
  const selected = normalizeAccountSelection(settings, accounts);
  if (selected.mode === "bot") return "TelePilot Bot";
  if (selected.mode === "all") return accounts.length === 1 ? accountDisplayLabel(accounts[0]) : `All ${accounts.length} accounts`;
  if (selected.selected.length === 1) return accountDisplayLabel(accounts.find(item => item.id === selected.selected[0]));
  return `${selected.selected.length} selected accounts`;
}''',
    "sender summary",
)
# section() above stops at the closing marker itself, so remove any duplicated close if present.
text = text.replace("}\n}\n", "}\n", 1) if "export function senderSummary" in text else text
write(name, text)


# ---------------------------------------------------------------------------
# app.js: respect Bot mode even while personal accounts remain connected.
# ---------------------------------------------------------------------------
name = "app.js"
text = read(name)
text = replace_once(
    text,
    '  senderSummary,\n  updateAccountStatus,\n} from "./account-store.js";',
    '  senderSummary,\n  updateAccountStatus,\n  usesBotSender,\n} from "./account-store.js";',
    "app account-store import",
)
text = text.replace(
    '["inherit", "all", "selected"].includes(item.accountMode)',
    '["inherit", "bot", "all", "selected"].includes(item.accountMode)',
)
text = replace_once(
    text,
    '  if (!(state.selectedAccountIds || []).length) state.selectedAccountIds = [account.id];',
    '  if (state.senderMode !== "bot" && !(state.selectedAccountIds || []).length) state.selectedAccountIds = [account.id];',
    "connect must preserve explicit bot mode",
)

text = section(
    text,
    "async function resolveDestination",
    "function stopPostingLoop",
    '''async function resolveDestination(target, ownerUid) {
  const ownerState = ownerUid ? getState(ownerUid) : null;
  const accounts = ownerState ? listAccounts(ownerState.uid) : [];
  const botSender = ownerState ? usesBotSender(ownerState, null, accounts) : true;
  if (ownerState && accounts.length && !botSender) {
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
    if (!matched) throw new Error(`None of your selected sender accounts can currently post to @${wanted}. Join it with at least one sender account and check channel permissions.`);
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
    if (!["creator", "administrator"].includes(ownerMember.status)) throw new Error("Only an admin of that group/channel can add it while TelePilot Bot is the sender.");
  }
  return { id: String(chat.id), label: String(chat.title || chat.username || chat.id).slice(0,120), type: chat.type, username: chat.username ? `@${chat.username}` : "", accountMode: "inherit", accountIds: [] };
}''',
    "resolve destination sender mode",
)

text = section(
    text,
    "async function sendCycleBody",
    "function runCycle",
    '''async function sendCycleBody(state, cycleId = `interval:${state.uid}:${Date.now()}`) {
  if (!state.posting || !hasAccess(state)) { stopPostingLoop(state); return; }
  const message = state.adMessage, targets = [...state.groups], accounts = listAccounts(state.uid);
  if (!message || !targets.length) { stopPostingLoop(state); return; }
  const accountById = new Map(accounts.map(item => [String(item.id), item]));
  let success = 0, failed = 0;
  for (const target of targets) {
    if (!state.posting || !hasAccess(state)) break;
    const botSender = usesBotSender(state, target, accounts);
    const ids = botSender ? [] : effectiveAccountIds(state, target, accounts);
    if (botSender) {
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
}''',
    "interval cycle sender routing",
)

text = replace_once(
    text,
    '''  const hint = hasPersonalSession(state.uid)
    ? "Paste one or many public destinations (one per line). Use Routing to choose which accounts post to each destination and which message template it uses."
    : "Paste one or many public destinations (one per line). @TelePilottBot must have posting permissions; private groups can use /addhere.";''',
    '''  const accounts = listAccounts(state.uid);
  const hint = usesBotSender(state, null, accounts)
    ? "Paste one or many public destinations (one per line). @TelePilottBot must have posting permissions; private groups can use /addhere."
    : "Paste one or many public destinations (one per line). Use Routing to choose which accounts post to each destination and which message template it uses.";''',
    "groups sender-aware hint",
)

text = section(
    text,
    "function routeAccountLabel",
    "function htmlPage",
    '''function routeAccountLabel(state, group) {
  const accounts = listAccounts(state.uid);
  if (usesBotSender(state, group, accounts)) return "TelePilot Bot";
  const ids = effectiveAccountIds(state, group, accounts);
  if (group.accountMode === "all") return `All ${accounts.length} accounts`;
  if (group.accountMode === "selected") return `${ids.length} selected account${ids.length === 1 ? "" : "s"}`;
  return `Inherit · ${senderSummary(state, accounts)}`;
}
async function showRoutingPage(ctx, state, requestedPage=0) {
  const pages=Math.max(1,Math.ceil(state.groups.length/ROUTE_PAGE_SIZE)), page=Math.max(0,Math.min(Number(requestedPage)||0,pages-1)), start=page*ROUTE_PAGE_SIZE, kb=new InlineKeyboard();
  state.groups.slice(start,start+ROUTE_PAGE_SIZE).forEach((g,o)=>kb.text(`🎯 ${destinationLabel(g).slice(0,36)}`,`route_dest:${start+o}:${page}`).row());
  if(pages>1){if(page>0)kb.text("◀ Prev",`route_groups:${page-1}`);if(page<pages-1)kb.text("Next ▶",`route_groups:${page+1}`);kb.row();}
  kb.text("⬅️ Destinations","groups");
  await ctx.editMessageText(`🎯 DESTINATION ROUTING\n\nChoose a destination. Each destination can inherit your global sender selection, use TelePilot Bot, use all connected accounts, or use selected accounts. You can also assign a different saved message template.\n\nPage ${page+1}/${pages}`,{reply_markup:kb});
}
async function showRouteDestination(ctx,state,index,backPage=0){
  const group=state.groups[index];if(!group)return showRoutingPage(ctx,state,backPage);
  const pro=readProSettings(state.uid),overrideId=String(pro.destinationOverrides?.[String(group.id)]||""),template=(pro.templates||[]).find(t=>String(t.id)===overrideId);
  const kb=new InlineKeyboard().text("Inherit senders",`route_mode:${index}:inherit:${backPage}`).text("TelePilot Bot",`route_mode:${index}:bot:${backPage}`).row().text("All accounts",`route_mode:${index}:all:${backPage}`).text("Choose accounts",`route_accounts:${index}:0:${backPage}`).row().text("📝 Choose message",`v1_override_dest:${index}`).row().text("⬅️ Routing",`route_groups:${backPage}`);
  await ctx.editMessageText(["🎯 DESTINATION ROUTING",destinationLabel(group),"",`Senders — ${routeAccountLabel(state,group)}`,`Message — ${template?String(template.name||"Template"):"Default / rotation"}`,"","This destination can use TelePilot Bot, different sender accounts and a different message from your other destinations."].join("\n"),{reply_markup:kb});
}
async function showRouteAccounts(ctx,state,index,requestedPage=0,backPage=0){const group=state.groups[index];if(!group)return showRoutingPage(ctx,state,backPage);const accounts=listAccounts(state.uid),pages=Math.max(1,Math.ceil(accounts.length/ACCOUNT_PAGE_SIZE)),page=Math.max(0,Math.min(Number(requestedPage)||0,pages-1)),selected=new Set((group.accountIds||[]).map(String)),start=page*ACCOUNT_PAGE_SIZE,kb=new InlineKeyboard();accounts.slice(start,start+ACCOUNT_PAGE_SIZE).forEach(a=>kb.text(`${selected.has(a.id)?"✅":"○"} ${accountDisplayLabel(a).slice(0,35)}`,`route_account_toggle:${index}:${a.id}:${page}:${backPage}`).row());if(pages>1){if(page>0)kb.text("◀ Prev",`route_accounts:${index}:${page-1}:${backPage}`);if(page<pages-1)kb.text("Next ▶",`route_accounts:${index}:${page+1}:${backPage}`);kb.row();}kb.text("⬅️ Destination",`route_dest:${index}:${backPage}`);await ctx.editMessageText(`👤 ROUTE SENDERS\n\n${destinationLabel(group)}\nSelected — ${selected.size}\n\nToggle any number of connected accounts. There is no TelePilot account-count limit.`,{reply_markup:kb});}
async function showAccounts(ctx,state,requestedPage=0){
  clearAwaiting(state);const accounts=listAccounts(state.uid),selection=normalizeAccountSelection(state,accounts),pages=Math.max(1,Math.ceil(accounts.length/ACCOUNT_PAGE_SIZE)),page=Math.max(0,Math.min(Number(requestedPage)||0,pages-1)),start=page*ACCOUNT_PAGE_SIZE,kb=new InlineKeyboard().text("＋ Add account","account_phone").row();
  kb.text(selection.mode==="bot"?"✅ TelePilot Bot":"Use TelePilot Bot","account_mode_bot").row();
  if(accounts.length)kb.text(selection.mode==="all"?"✅ All accounts":"Use all accounts","account_mode_all").text(selection.mode==="selected"?"✅ Selected":"Choose accounts","account_select:0").row();
  accounts.slice(start,start+ACCOUNT_PAGE_SIZE).forEach(a=>kb.text(`${a.status==="needs-reconnect"?"⚠️":"👤"} ${accountDisplayLabel(a).slice(0,36)}`,`account_detail:${a.id}:${page}`).row());if(pages>1){if(page>0)kb.text("◀ Prev",`account:${page-1}`);if(page<pages-1)kb.text("Next ▶",`account:${page+1}`);kb.row();}kb.text("⬅️ Dashboard","home");
  await ctx.editMessageText(["👤 SENDER ACCOUNTS",`Connected — ${accounts.length}`,`Posting mode — ${senderSummary(state,accounts)}`,"","Keep personal accounts connected without being forced to use them. Choose TelePilot Bot, all connected accounts, or any selected set. Destination Routing can override the sender per group/channel."].join("\n"),{reply_markup:kb});
}
async function showAccountSelection(ctx,state,requestedPage=0){const accounts=listAccounts(state.uid),selected=new Set((state.selectedAccountIds||[]).map(String)),pages=Math.max(1,Math.ceil(accounts.length/ACCOUNT_PAGE_SIZE)),page=Math.max(0,Math.min(Number(requestedPage)||0,pages-1)),start=page*ACCOUNT_PAGE_SIZE,kb=new InlineKeyboard();accounts.slice(start,start+ACCOUNT_PAGE_SIZE).forEach(a=>kb.text(`${selected.has(a.id)?"✅":"○"} ${accountDisplayLabel(a).slice(0,35)}`,`account_toggle:${a.id}:${page}`).row());if(pages>1){if(page>0)kb.text("◀ Prev",`account_select:${page-1}`);if(page<pages-1)kb.text("Next ▶",`account_select:${page+1}`);kb.row();}kb.text("⬅️ Senders","account");await ctx.editMessageText(`👤 CHOOSE SENDER ACCOUNTS\n\nSelected — ${selected.size}\n\nToggle any accounts. Selected mode sends each routed post from every selected account.`,{reply_markup:kb});}''',
    "sender and route UI",
)

text = replace_once(
    text,
    '''  if (hasPersonalSession(state.uid)) {
    if (["left", "kicked"].includes(ownerMember.status)
      || (ownerMember.status === "restricted" && ownerMember.can_send_messages !== true)) {
      return ctx.reply("Your connected personal account does not currently have permission to post in this group.");
    }
  } else if (!["creator", "administrator"].includes(ownerMember.status)) {
    return ctx.reply("Only a group admin can link this group when using TelePilot Bot as the sender.");
  }

  if (!hasPersonalSession(state.uid)) {''',
    '''  const accounts = listAccounts(state.uid);
  const botSender = usesBotSender(state, null, accounts);
  if (botSender && !["creator", "administrator"].includes(ownerMember.status)) {
    return ctx.reply("Only a group admin can link this group when using TelePilot Bot as the sender.");
  }

  if (botSender) {''',
    "addhere sender validation",
)

text = replace_once(
    text,
    '''  const instructions = hasPersonalSession(state.uid)
    ? "➕ ADD DESTINATIONS\\n\\nSend one or more public @usernames or t.me links. Put one destination on each line.\\n\\nAt least one connected account must already be joined and able to post. After adding, open Routing to choose exactly which account(s) post to each destination. Private groups without a username can use /addhere."
    : "➕ ADD DESTINATIONS\\n\\nSend one or more public @usernames or t.me links. Put one destination on each line.\\n\\n@TelePilottBot must be an admin with posting permission in each destination. For private groups, use /addhere inside the group.";''',
    '''  const accounts = listAccounts(state.uid);
  const instructions = usesBotSender(state, null, accounts)
    ? "➕ ADD DESTINATIONS\\n\\nSend one or more public @usernames or t.me links. Put one destination on each line.\\n\\n@TelePilottBot must be an admin with posting permission in each destination. For private groups, use /addhere inside the group."
    : "➕ ADD DESTINATIONS\\n\\nSend one or more public @usernames or t.me links. Put one destination on each line.\\n\\nAt least one selected connected account must already be joined and able to post. After adding, open Routing to choose exactly which account(s) post to each destination. Private groups without a username can use /addhere.";''',
    "add destination instructions",
)

text = replace_once(
    text,
    'bot.callbackQuery("account_mode_all", async ctx => { const state=stateFromCtx(ctx);state.senderMode="all";saveState(state);await ctx.answerCallbackQuery({text:"Posting from all connected accounts"});await showAccounts(ctx,state,0); });',
    'bot.callbackQuery("account_mode_bot", async ctx => { const state=stateFromCtx(ctx);state.senderMode="bot";saveState(state);await ctx.answerCallbackQuery({text:"Posting with TelePilot Bot"});await showAccounts(ctx,state,0); });\nbot.callbackQuery("account_mode_all", async ctx => { const state=stateFromCtx(ctx);state.senderMode="all";saveState(state);await ctx.answerCallbackQuery({text:"Posting from all connected accounts"});await showAccounts(ctx,state,0); });',
    "global bot sender callback",
)
text = replace_once(
    text,
    'bot.callbackQuery(/^route_mode:(\\d+):(inherit|all):(\\d+)$/,async ctx=>{const state=stateFromCtx(ctx),group=state.groups[Number(ctx.match[1])];if(!group)return ctx.answerCallbackQuery({text:"Destination not found."});group.accountMode=ctx.match[2];if(group.accountMode!=="selected")group.accountIds=[];saveState(state);await ctx.answerCallbackQuery({text:group.accountMode==="all"?"Using all accounts":"Using global sender selection"});await showRouteDestination(ctx,state,Number(ctx.match[1]),Number(ctx.match[3]));});',
    'bot.callbackQuery(/^route_mode:(\\d+):(inherit|bot|all):(\\d+)$/,async ctx=>{const state=stateFromCtx(ctx),group=state.groups[Number(ctx.match[1])];if(!group)return ctx.answerCallbackQuery({text:"Destination not found."});group.accountMode=ctx.match[2];if(group.accountMode!=="selected")group.accountIds=[];saveState(state);const notice=group.accountMode==="all"?"Using all accounts":group.accountMode==="bot"?"Using TelePilot Bot":"Using global sender selection";await ctx.answerCallbackQuery({text:notice});await showRouteDestination(ctx,state,Number(ctx.match[1]),Number(ctx.match[3]));});',
    "per-destination bot sender callback",
)
write(name, text)


# ---------------------------------------------------------------------------
# v1-worker.js: scheduled jobs use the same explicit sender routing.
# ---------------------------------------------------------------------------
name = "v1-worker.js"
text = read(name)
text = replace_once(
    text,
    '  updateAccountStatus,\n} from "./account-store.js";',
    '  updateAccountStatus,\n  usesBotSender,\n} from "./account-store.js";',
    "worker account-store import",
)
text = section(
    text,
    "async function sendCycle(uid,settings,bot,options={})",
    "function scheduledRun",
    '''async function sendCycle(uid,settings,bot,options={}){
  const groups=Array.isArray(settings.groups)?settings.groups:[];
  if(!groups.length||!settings.adMessage)return{sent:0,failed:0,skipped:0,delivered:[],errors:["Missing message or destination"]};
  const accounts=listAccounts(uid),clients=new Map(),dialogCaches=new Map();
  const delivered=new Set(Array.isArray(options.delivered)?options.delivered.map(String):[]);
  const newlyDelivered=[],errors=[];let sent=0,failed=0,skipped=0;
  const cycleId=String(options.cycleId||`worker:${uid}:${Date.now()}`),forcedTemplateId=String(options.templateId||"");
  const byId=new Map(accounts.map(a=>[String(a.id),a]));
  try{
    for(const destination of groups){
      if(usesBotSender(settings,destination,accounts)){
        const key=deliveryId(destination,"");if(delivered.has(key))continue;
        try{const result=await withDispatchContext({uid:String(uid),destinationId:destinationId(destination),cycleId,senderType:"bot",senderLabel:"TelePilot Bot",forcedTemplateId,autoDisableEligible:true},()=>bot.api.sendMessage(destination.id,settings.adMessage,settings.adEntities?.length?{entities:settings.adEntities}:{}));if(result?.__telepilotSkipped)skipped++;else sent++;newlyDelivered.push(key);}catch(err){failed++;errors.push(String(err?.description||err?.message||err).slice(0,180));}
        continue;
      }
      const accountIds=effectiveAccountIds(settings,destination,accounts);
      if(!accountIds.length){skipped++;continue;}
      for(const accountId of accountIds){
        const key=deliveryId(destination,accountId);if(delivered.has(key))continue;
        const account=byId.get(String(accountId));if(!account){failed++;errors.push(`Missing sender ${accountId}`);continue;}
        try{
          let client=clients.get(account.id);
          if(!client){client=await openPersonalClient(uid,account);clients.set(account.id,client);dialogCaches.set(account.id,{value:null});}
          const entity=await personalTarget(client,destination,dialogCaches.get(account.id));
          const result=await withDispatchContext({uid:String(uid),destinationId:destinationId(destination),cycleId,senderType:"personal",senderLabel:accountDisplayLabel(account),accountId:String(account.id),forcedTemplateId,autoDisableEligible:accountIds.length===1},()=>client.sendMessage(entity,{message:settings.adMessage,...(settings.adEntities?.length?{formattingEntities:toMtEntities(settings.adEntities)}:{})}));
          if(result?.__telepilotSkipped)skipped++;else sent++;newlyDelivered.push(key);
        }catch(err){failed++;const message=String(err?.errorMessage||err?.message||err).slice(0,180);errors.push(`${accountDisplayLabel(account)}: ${message}`);updateAccountStatus(uid,account.id,{status:isFatalSessionError(err)?"needs-reconnect":"unknown",lastError:message,lastVerifiedAt:Date.now()});}
      }
    }
    return{sent,failed,skipped,delivered:newlyDelivered,errors};
  }finally{for(const client of clients.values())try{await client.disconnect();}catch{}}
}''',
    "scheduled sender routing",
)
write(name, text)


# ---------------------------------------------------------------------------
# v1-extras.js: Smart Preview must never call multi-account mode "Bot".
# ---------------------------------------------------------------------------
name = "v1-extras.js"
text = read(name)
text = replace_once(
    text,
    'import { InlineKeyboard } from "grammy";\nimport { readAppSettings } from "./posting-engine-enhancements.js";',
    'import { InlineKeyboard } from "grammy";\nimport { listAccounts, senderSummary } from "./account-store.js";\nimport { readAppSettings } from "./posting-engine-enhancements.js";',
    "preview account import",
)
text = replace_once(
    text,
    '''function senderLabel(settings) {
  return settings.personalUsername ? `@${settings.personalUsername}` : "TelePilot Bot";
}''',
    '''function senderLabel(uid, settings) {
  return senderSummary(settings, listAccounts(uid));
}''',
    "preview sender label",
)
text = text.replace('`Sender — ${senderLabel(settings)}`', '`Sender — ${senderLabel(uid, settings)}`')
write(name, text)


# ---------------------------------------------------------------------------
# sender-destination-ui.js: stop reading the deleted legacy session path.
# ---------------------------------------------------------------------------
name = "sender-destination-ui.js"
text = read(name)
if 'from "./account-store.js"' not in text:
    text = text.replace('import path from "node:path";\n', 'import path from "node:path";\nimport { listAccounts, senderSummary } from "./account-store.js";\n')
start = text.find("function senderForChat")
end = text.find("function destinationsListFromUi", start)
if start < 0 or end < 0:
    raise RuntimeError("sender-aware UI sender section not found")
new_sender = '''function senderForChat(chatId) {
  const uid = userIdFromChat(chatId);
  if (!uid) return { mode: "bot", label: "TelePilot Bot" };
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "users", uid, "settings.json"), "utf8")); } catch {}
  const label = senderSummary(settings, listAccounts(uid));
  return { mode: label === "TelePilot Bot" ? "bot" : "personal", label };
}

'''
text = text[:start] + new_sender + text[end:]
write(name, text)


# ---------------------------------------------------------------------------
# Regression suite: prove Bot and account routing combinations locally.
# ---------------------------------------------------------------------------
name = "telepilot-v11-regression-test.mjs"
text = read(name)
anchor = '''assert.deepEqual(
  accounts.effectiveAccountIds({ senderMode: "all", selectedAccountIds: [] }, { accountMode: "selected", accountIds: [first.id] }, listed),
  [first.id],
);
'''
addition = anchor + '''
// Explicit TelePilot Bot mode remains available even while accounts stay connected.
assert.equal(accounts.usesBotSender({ senderMode: "bot", selectedAccountIds: [first.id] }, null, listed), true);
assert.deepEqual(accounts.effectiveAccountIds({ senderMode: "bot", selectedAccountIds: [first.id] }, null, listed), []);
assert.equal(accounts.senderSummary({ senderMode: "bot", selectedAccountIds: [first.id] }, listed), "TelePilot Bot");
assert.equal(accounts.usesBotSender({ senderMode: "all", selectedAccountIds: [] }, { accountMode: "bot" }, listed), true);
assert.deepEqual(accounts.effectiveAccountIds({ senderMode: "all", selectedAccountIds: [] }, { accountMode: "bot" }, listed), []);
// An explicit destination account route overrides global Bot mode.
assert.equal(accounts.usesBotSender({ senderMode: "bot", selectedAccountIds: [] }, { accountMode: "all" }, listed), false);
assert.deepEqual(
  accounts.effectiveAccountIds({ senderMode: "bot", selectedAccountIds: [] }, { accountMode: "all" }, listed).sort(),
  listed.map(item => item.id).sort(),
);
'''
text = replace_once(text, anchor, addition, "v11 bot routing assertions")
text = replace_once(
    text,
    'const security = source("security-core.js");',
    'const security = source("security-core.js");\nconst extras = source("v1-extras.js");\nconst senderUi = source("sender-destination-ui.js");',
    "v11 source fixtures",
)
text = replace_once(
    text,
    'assert.match(app, /accountMode/);',
    'assert.match(app, /accountMode/);\nassert.match(app, /account_mode_bot/);\nassert.match(app, /inherit\\|bot\\|all/);',
    "v11 app bot invariants",
)
text = replace_once(
    text,
    'assert.match(worker, /nextAttemptAt/);',
    'assert.match(worker, /nextAttemptAt/);\nassert.match(worker, /usesBotSender/);\nassert.match(extras, /senderSummary/);\nassert.match(extras, /listAccounts/);\nassert.doesNotMatch(senderUi, /personal-session\\.enc/);',
    "v11 preview and sender-ui invariants",
)
write(name, text)

print("TelePilot 1.1 release-gate fixes applied")
