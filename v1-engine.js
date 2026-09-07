import fs from "node:fs";
import bigInt from "big-integer";
import { Api as MtApi } from "teleproto";
import { currentDispatchContext, childDispatchContext } from "./dispatch-context.js";
import {
  errorText,
  isPermanentDestinationError,
  readAppSettings,
  readProSettings,
  renderDynamicMessage,
  scheduleAllowsNow,
  withRetry,
  writeProSettings,
} from "./posting-engine-enhancements.js";

const CYCLE_STALE_MS = 30 * 60_000;
const HISTORY_LIMIT = 500;
const MEDIA_CAPTION_LIMIT = 1024;
const cycleRuntime = new Map();
let rawApiSendMessage = null;
let rawPersonalSendMessage = null;

function destinationId(destination) { return String(destination?.id || destination?.username || destination?.label || ""); }
function destinationLabel(destination) { return String(destination?.username || destination?.label || destination?.id || "Destination"); }
function cloneEntity(entity) {
  if (!entity || typeof entity !== "object") return entity;
  const proto = Object.getPrototypeOf(entity);
  return !proto || proto === Object.prototype ? { ...entity } : Object.assign(Object.create(proto), entity);
}
function nowIsoDate(pro, now = new Date()) {
  return new Date(now.getTime() + Number(pro?.schedule?.utcOffsetMinutes || 0) * 60_000).toISOString().slice(0,10);
}
function adjustEntities(entities, start, oldLength, newLength) {
  const delta = newLength-oldLength, end = start+oldLength;
  for (const entity of entities) {
    const s = Number(entity.offset||0), e = s+Number(entity.length||0);
    if (s >= end) entity.offset = s+delta;
    else if (e > start && s < end) entity.length = Math.max(0, Number(entity.length||0)+delta);
  }
}
function replaceToken(text, entities, token, replacement) {
  let value = text, from = 0;
  while (from < value.length) {
    const index = value.indexOf(token, from);
    if (index < 0) break;
    value = value.slice(0,index)+replacement+value.slice(index+token.length);
    adjustEntities(entities,index,token.length,replacement.length);
    from = index+replacement.length;
  }
  return value;
}

export function ensureV1(pro) {
  const value = pro && typeof pro === "object" ? pro : {};
  if (!value.rotation || typeof value.rotation !== "object") value.rotation = {};
  value.rotation.mode = ["off","cycle","random"].includes(value.rotation.mode) ? value.rotation.mode : "off";
  value.rotation.index = Math.max(0, Number(value.rotation.index||0));
  if (!value.destinationOverrides || typeof value.destinationOverrides !== "object" || Array.isArray(value.destinationOverrides)) value.destinationOverrides = {};
  if (!value.destinationFolders || typeof value.destinationFolders !== "object" || Array.isArray(value.destinationFolders)) value.destinationFolders = {};
  if (!Array.isArray(value.disabledFolders)) value.disabledFolders = [];
  if (!value.customVariables || typeof value.customVariables !== "object" || Array.isArray(value.customVariables)) value.customVariables = {};
  if (!value.dateRange || typeof value.dateRange !== "object") value.dateRange = {};
  value.dateRange.enabled = value.dateRange.enabled === true;
  value.dateRange.start = typeof value.dateRange.start === "string" ? value.dateRange.start : "";
  value.dateRange.end = typeof value.dateRange.end === "string" ? value.dateRange.end : "";
  value.activeMessageExpiresAt = Number(value.activeMessageExpiresAt||0)||0;
  if (!value.postLimit || typeof value.postLimit !== "object") value.postLimit = {};
  value.postLimit.enabled = value.postLimit.enabled === true;
  value.postLimit.max = Math.max(0, Number(value.postLimit.max||0));
  value.postLimit.sent = Math.max(0, Number(value.postLimit.sent||0));
  value.notificationMode = ["all","important","silent"].includes(value.notificationMode) ? value.notificationMode : "important";
  value.autoDisableFailures = Math.min(10,Math.max(2,Number(value.autoDisableFailures||3)));
  if (!value.destinationFailures || typeof value.destinationFailures !== "object" || Array.isArray(value.destinationFailures)) value.destinationFailures = {};
  if (!Array.isArray(value.pendingAlerts)) value.pendingAlerts = [];
  if (!Array.isArray(value.exactTimes)) value.exactTimes = [];
  if (!Array.isArray(value.oneTimeJobs)) value.oneTimeJobs = [];
  if (!value.weeklyRecap || typeof value.weeklyRecap !== "object") value.weeklyRecap = {};
  value.weeklyRecap.enabled = value.weeklyRecap.enabled === true;
  value.weeklyRecap.day = Number.isInteger(Number(value.weeklyRecap.day)) ? Number(value.weeklyRecap.day) : 0;
  value.weeklyRecap.hour = Number.isInteger(Number(value.weeklyRecap.hour)) ? Number(value.weeklyRecap.hour) : 18;
  value.weeklyRecap.lastKey = typeof value.weeklyRecap.lastKey === "string" ? value.weeklyRecap.lastKey : "";
  if (!value.sessionHealth || typeof value.sessionHealth !== "object") value.sessionHealth = {};
  value.sessionHealth.status = typeof value.sessionHealth.status === "string" ? value.sessionHealth.status : "unknown";
  value.sessionHealth.lastCheckedAt = Number(value.sessionHealth.lastCheckedAt||0)||0;
  value.sessionHealth.firstSeenAt = Number(value.sessionHealth.firstSeenAt||0)||0;
  value.sessionHealth.lastError = typeof value.sessionHealth.lastError === "string" ? value.sessionHealth.lastError : "";
  if (!value.accountHealth || typeof value.accountHealth !== "object" || Array.isArray(value.accountHealth)) value.accountHealth = {};
  if (!value.reminders || typeof value.reminders !== "object") value.reminders = {};
  if (!value.draftBackup || typeof value.draftBackup !== "object") value.draftBackup = null;
  value.changelogSeen = typeof value.changelogSeen === "string" ? value.changelogSeen : "";
  value.templates = Array.isArray(value.templates) ? value.templates.map(template => ({ ...template, pinned: template?.pinned===true, expiresAt:Number(template?.expiresAt||0)||0 })) : [];
  return value;
}
export function readV1(uid) { return ensureV1(readProSettings(uid)); }
export function writeV1(uid, pro) { return ensureV1(writeProSettings(uid, ensureV1(pro))); }

function eligibleTemplates(pro, now=Date.now()) { return (pro.templates||[]).filter(t => t?.message && (!Number(t.expiresAt||0) || Number(t.expiresAt)>now)); }
function findTemplate(pro,id) {
  if (!id) return null;
  const t=(pro.templates||[]).find(item=>String(item.id)===String(id));
  return t?.message && (!Number(t.expiresAt||0) || Number(t.expiresAt)>Date.now()) ? t : null;
}
function cycleFor(uid, pro, context) {
  const cycleId = String(context?.cycleId || `${uid}:${Math.floor(Date.now()/1000)}`);
  const key = `${uid}:${cycleId}`;
  let cycle=cycleRuntime.get(key);
  if (!cycle || Date.now()-cycle.startedAt>CYCLE_STALE_MS) {
    cycle={ startedAt:Date.now(), cycleId, rotationResolved:false, rotationTemplateId:"", skip:pro.skipNext===true, seen:new Set(), index:0 };
    if (pro.skipNext) { pro.skipNext=false; writeV1(uid,pro); }
    cycleRuntime.set(key,cycle);
    if (cycleRuntime.size>1000) {
      const cutoff=Date.now()-CYCLE_STALE_MS;
      for (const [k,v] of cycleRuntime) if (v.startedAt<cutoff) cycleRuntime.delete(k);
    }
  }
  return cycle;
}
function chooseCycleTemplate(uid,pro,cycle,context) {
  const forced=String(context?.forcedTemplateId||"");
  if (forced) return forced;
  if (cycle.rotationResolved) return cycle.rotationTemplateId||"";
  cycle.rotationResolved=true;
  const templates=eligibleTemplates(pro);
  if (!templates.length || pro.rotation.mode==="off") return "";
  if (pro.rotation.mode==="random") cycle.rotationTemplateId=String(templates[Math.floor(Math.random()*templates.length)].id);
  else {
    const index=Number(pro.rotation.index||0)%templates.length;
    cycle.rotationTemplateId=String(templates[index].id);
    pro.rotation.index=(index+1)%templates.length;
    writeV1(uid,pro);
  }
  return cycle.rotationTemplateId;
}
function selectContent(uid,settings,pro,destination,cycle,context,originalText,originalEntities) {
  const override=findTemplate(pro,pro.destinationOverrides?.[destinationId(destination)]);
  if (override) return { text:String(override.message), entities:Array.isArray(override.entities)?override.entities:[], templateId:String(override.id) };
  const rotated=findTemplate(pro,chooseCycleTemplate(uid,pro,cycle,context));
  if (rotated) return { text:String(rotated.message), entities:Array.isArray(rotated.entities)?rotated.entities:[], templateId:String(rotated.id) };
  return { text:String(originalText||settings.adMessage||""), entities:Array.isArray(originalEntities)?originalEntities:[], templateId:"" };
}
function renderV1(content,pro,destination,sender) {
  const rendered=renderDynamicMessage(content.text,content.entities,{pro,destination,sender});
  let text=String(rendered.text||"");
  const entities=(rendered.entities||[]).map(cloneEntity);
  for (const [rawName,rawValue] of Object.entries(pro.customVariables||{})) {
    const name=String(rawName||"").trim().replace(/[^A-Za-z0-9_]/g,"").slice(0,32);
    if (name) text=replaceToken(text,entities,`{${name}}`,String(rawValue??"").slice(0,500));
  }
  return { text, entities:entities.filter(e=>Number(e?.length||0)>0) };
}
function dateRangeAllows(pro) {
  if (!pro.dateRange?.enabled) return true;
  const date=nowIsoDate(pro);
  return !(pro.dateRange.start&&date<pro.dateRange.start) && !(pro.dateRange.end&&date>pro.dateRange.end);
}
function folderIsDisabled(pro,destination) {
  const folder=String(pro.destinationFolders?.[destinationId(destination)]||"");
  return !!folder && (pro.disabledFolders||[]).map(String).includes(folder);
}
function skipReason(pro,cycle,destination) {
  if (pro.paused) return "paused";
  if (cycle.skip) return "skip-next";
  if ((pro.disabledDestinationIds||[]).map(String).includes(destinationId(destination))) return "disabled";
  if (folderIsDisabled(pro,destination)) return "folder-disabled";
  if (!scheduleAllowsNow(pro)) return "outside-schedule";
  if (!dateRangeAllows(pro)) return "outside-date-range";
  if (Number(pro.activeMessageExpiresAt||0) && Date.now()>=Number(pro.activeMessageExpiresAt)) return "message-expired";
  if (pro.postLimit?.enabled && Number(pro.postLimit.max||0)>0 && Number(pro.postLimit.sent||0)>=Number(pro.postLimit.max)) return "post-limit";
  return "";
}
function queueAlert(pro,level,text) {
  if (pro.notificationMode==="silent" || (pro.notificationMode==="important"&&level!=="important")) return;
  pro.pendingAlerts.push({ id:`${Date.now()}-${Math.random().toString(16).slice(2,8)}`, ts:Date.now(), level, text:String(text).slice(0,700) });
  pro.pendingAlerts=pro.pendingAlerts.slice(-20);
}
function appendHistory(pro,item) { pro.history=Array.isArray(pro.history)?pro.history:[]; pro.history.push({ts:Date.now(),...item}); pro.history=pro.history.slice(-HISTORY_LIMIT); }
function recordSkipped(uid,destination,sender,reason,context) {
  const pro=readV1(uid); appendHistory(pro,{destination:destinationLabel(destination),destinationId:destinationId(destination),status:"skipped",reason,sender,accountId:String(context?.accountId||"")}); writeV1(uid,pro);
}
function recordSuccess(uid,destination,sender,templateId,context) {
  const pro=readV1(uid); appendHistory(pro,{destination:destinationLabel(destination),destinationId:destinationId(destination),status:"sent",sender,templateId,accountId:String(context?.accountId||"")});
  if (pro.postLimit?.enabled) pro.postLimit.sent=Number(pro.postLimit.sent||0)+1;
  const issue=pro.destinationFailures[destinationId(destination)];
  if (issue) { issue.transientCount=0; issue.permanentCount=0; issue.lastError=""; }
  writeV1(uid,pro);
}
function recordFailure(uid,destination,sender,err,context) {
  const pro=readV1(uid), id=destinationId(destination), permanent=isPermanentDestinationError(err);
  const old=pro.destinationFailures[id]||{};
  const next={
    transientCount:Number(old.transientCount||0)+(permanent?0:1),
    permanentCount:Number(old.permanentCount||0)+(permanent?1:0),
    count:Number(old.count||0)+1,
    lastAt:Date.now(), lastError:errorText(err), autoDisabledAt:Number(old.autoDisabledAt||0)||0,
  };
  pro.destinationFailures[id]=next;
  appendHistory(pro,{destination:destinationLabel(destination),destinationId:id,status:"failed",error:next.lastError,sender,accountId:String(context?.accountId||"")});
  if (permanent && context?.autoDisableEligible!==false && next.permanentCount>=Number(pro.autoDisableFailures||3) && !next.autoDisabledAt) {
    next.autoDisabledAt=Date.now();
    if (!(pro.disabledDestinationIds||[]).map(String).includes(id)) pro.disabledDestinationIds.push(id);
    queueAlert(pro,"important",`⚠️ ${destinationLabel(destination)} was automatically disabled after ${next.permanentCount} permanent posting failures.\n\nLast error — ${next.lastError}`);
  } else queueAlert(pro,"all",`⚠️ Post failed in ${destinationLabel(destination)}\n${next.lastError}`);
  writeV1(uid,pro);
}
function fakeResult(rendered,reason) { return { id:0,message_id:0,message:rendered?.text||"",text:rendered?.text||"",__telepilotSkipped:true,__telepilotSkipReason:reason||"skipped" }; }
function destinationFor(settings,context,entity) {
  if (context?.destinationId) {
    const found=(settings.groups||[]).find(g=>String(g.id)===String(context.destinationId));
    if (found) return found;
  }
  const raw=String(entity?.id??entity??"").replace(/\D/g,"");
  return (settings.groups||[]).find(g=>String(g.id||"").replace(/\D/g,"")===raw) || null;
}

export async function prepareExternalPersonalDispatch(context, entity) {
  const uid=String(context?.uid||"");
  if(!uid || context?.senderType!=="personal" || !context?.cycleId)return{managed:false,skip:false};
  const settings=readAppSettings(uid),destination=destinationFor(settings,context,entity);
  if(!destination)return{managed:false,skip:false};
  const pro=readV1(uid),cycle=cycleFor(uid,pro,context);cycle.index++;
  const sender=String(context.senderLabel||"Personal account"),reason=skipReason(pro,cycle,destination);
  if(reason){const result=fakeResult({text:""},reason);recordSkipped(uid,destination,sender,reason,context);return{managed:true,skip:true,result,uid,destination,sender,context};}
  if(cycle.index>1&&Number(pro.staggerSeconds||0)>0)await new Promise(r=>setTimeout(r,Number(pro.staggerSeconds)*1000));
  return{managed:true,skip:false,uid,destination,sender,context};
}
export function completeExternalPersonalDispatch(handle,result){
  if(!handle?.managed||handle?.skip)return result;
  try{recordSuccess(handle.uid,handle.destination,handle.sender,"",handle.context);}catch(err){console.warn(`TelePilot suppressed forwarding bookkeeping error after Telegram confirmed delivery for ${handle.uid}/${destinationId(handle.destination)}:`,err?.message||err);}
  return result;
}
export function failExternalPersonalDispatch(handle,err){
  if(handle?.managed&&!handle?.skip){try{recordFailure(handle.uid,handle.destination,handle.sender,err,handle.context);}catch(bookkeepingError){console.warn(`TelePilot could not record forwarding failure for ${handle.uid}/${destinationId(handle.destination)}:`,bookkeepingError?.message||bookkeepingError);}}
  throw err;
}

function toMtEntities(entities=[]) {
  const out=[];
  for (const entity of entities) {
    if (entity?.className || entity?.CONSTRUCTOR_ID) { out.push(entity); continue; }
    const base={offset:Number(entity?.offset||0),length:Number(entity?.length||0)};
    try {
      if(entity?.type==="bold")out.push(new MtApi.MessageEntityBold(base));
      else if(entity?.type==="italic")out.push(new MtApi.MessageEntityItalic(base));
      else if(entity?.type==="underline")out.push(new MtApi.MessageEntityUnderline(base));
      else if(entity?.type==="strikethrough")out.push(new MtApi.MessageEntityStrike(base));
      else if(entity?.type==="spoiler")out.push(new MtApi.MessageEntitySpoiler(base));
      else if(entity?.type==="code")out.push(new MtApi.MessageEntityCode(base));
      else if(entity?.type==="pre")out.push(new MtApi.MessageEntityPre({...base,language:entity.language||""}));
      else if(entity?.type==="text_link")out.push(new MtApi.MessageEntityTextUrl({...base,url:entity.url||""}));
      else if(entity?.type==="custom_emoji"&&/^\d+$/.test(String(entity.custom_emoji_id||"")))out.push(new MtApi.MessageEntityCustomEmoji({...base,documentId:bigInt(entity.custom_emoji_id)}));
    } catch {}
  }
  return out;
}

function markPartialDelivery(err) {
  const value = err && typeof err === "object" ? err : new Error(String(err || "Media was delivered but the follow-up text failed."));
  try { value.__telepilotPartialDelivery = true; } catch {}
  return value;
}
function botMediaDeliveryOptions(other = {}) {
  const out = {};
  for (const key of [
    "business_connection_id", "message_thread_id", "direct_messages_topic_id", "disable_notification",
    "protect_content", "allow_paid_broadcast", "message_effect_id", "suggested_post_parameters",
    "reply_parameters", "reply_markup",
  ]) {
    if (other?.[key] !== undefined) out[key] = other[key];
  }
  return out;
}
async function sendBotMediaStage(api,chatId,media,options) {
  if(media.kind==="photo")return api.sendPhoto(chatId,media.fileId,options);
  if(media.kind==="video")return api.sendVideo(chatId,media.fileId,{...options,supports_streaming:true});
  if(media.kind==="animation")return api.sendAnimation(chatId,media.fileId,options);
  return api.sendDocument(chatId,media.fileId,options);
}
async function sendBotMedia(api,chatId,media,rendered,other={}) {
  const deliveryOptions=botMediaDeliveryOptions(other);
  if (rendered.text.length>MEDIA_CAPTION_LIMIT) {
    await withRetry(()=>sendBotMediaStage(api,chatId,media,deliveryOptions));
    try {
      return await withRetry(()=>rawApiSendMessage.call(api,chatId,rendered.text||"\u2063",{
        ...deliveryOptions,
        ...(rendered.entities.length?{entities:rendered.entities}:{}),
      }));
    } catch (err) {
      throw markPartialDelivery(err);
    }
  }
  const options={
    ...deliveryOptions,
    ...(rendered.text?{caption:rendered.text}:{}),
    ...(rendered.entities.length?{caption_entities:rendered.entities}:{}),
  };
  return withRetry(()=>sendBotMediaStage(api,chatId,media,options));
}
function personalMediaDeliveryOptions(params={}) {
  const { message, formattingEntities, ...rest } = params || {};
  return rest;
}
async function sendPersonalMedia(client,entity,media,rendered,params={}) {
  const mtEntities=toMtEntities(rendered.entities);
  if (!media.localPath || !fs.existsSync(media.localPath)) {
    return withRetry(()=>rawPersonalSendMessage.call(client,entity,{
      ...params,
      message:rendered.text||"\u2063",
      formattingEntities:mtEntities,
    }));
  }
  const deliveryOptions=personalMediaDeliveryOptions(params);
  const common={
    ...deliveryOptions,
    file:media.localPath,
    forceDocument:media.kind==="document",
    supportsStreaming:media.kind==="video",
  };
  if (rendered.text.length>MEDIA_CAPTION_LIMIT) {
    await withRetry(()=>client.sendFile(entity,{...common,caption:""}));
    try {
      return await withRetry(()=>rawPersonalSendMessage.call(client,entity,{
        ...params,
        message:rendered.text||"\u2063",
        formattingEntities:mtEntities,
      }));
    } catch (err) {
      throw markPartialDelivery(err);
    }
  }
  return withRetry(()=>client.sendFile(entity,{
    ...common,
    caption:rendered.text,
    ...(mtEntities.length?{formattingEntities:mtEntities}:{}),
  }));
}

export function prepareV1Engine(ApiClass,TelegramClientClass) {
  if(!rawApiSendMessage)rawApiSendMessage=ApiClass?.prototype?.sendMessage||null;
  if(!rawPersonalSendMessage)rawPersonalSendMessage=TelegramClientClass?.prototype?.sendMessage||null;
}
export function withForcedTemplate(uid,templateId,fn) {
  return childDispatchContext({uid:String(uid),forcedTemplateId:String(templateId||"")},fn);
}
export function installV1Engine(ApiClass,TelegramClientClass) {
  if(!rawApiSendMessage||!rawPersonalSendMessage)prepareV1Engine(ApiClass,TelegramClientClass);
  if(ApiClass?.prototype&&!ApiClass.prototype.__telepilotV1EngineInstalled){
    const currentSend=ApiClass.prototype.sendMessage;
    Object.defineProperty(ApiClass.prototype,"__telepilotV1EngineInstalled",{value:true});
    ApiClass.prototype.sendMessage=async function(chatId,text,other,...rest){
      const context=currentDispatchContext();
      if(!context?.uid || context.senderType==="personal")return currentSend.call(this,chatId,text,other,...rest);
      const uid=String(context.uid), settings=readAppSettings(uid), destination=destinationFor(settings,context,chatId);
      if(!destination)return currentSend.call(this,chatId,text,other,...rest);
      const pro=readV1(uid), cycle=cycleFor(uid,pro,context); cycle.index++;
      const sender=String(context.senderLabel||"TelePilot Bot");
      const content=selectContent(uid,settings,pro,destination,cycle,context,text,other?.entities||[]), rendered=renderV1(content,pro,destination,sender), reason=skipReason(pro,cycle,destination);
      if(reason){recordSkipped(uid,destination,sender,reason,context);return fakeResult(rendered,reason);}
      if(cycle.index>1&&Number(pro.staggerSeconds||0)>0)await new Promise(r=>setTimeout(r,Number(pro.staggerSeconds)*1000));
      try{
        const result=pro.media?.fileId
          ? await sendBotMedia(this,chatId,pro.media,rendered,other||{})
          : await withRetry(()=>rawApiSendMessage.call(this,chatId,rendered.text||"\u2063",{...(other||{}),...(rendered.entities.length?{entities:rendered.entities}:{entities:undefined})},...rest));
        recordSuccess(uid,destination,sender,content.templateId,context);
        return result;
      }
      catch(err){recordFailure(uid,destination,sender,err,context);throw err;}
    };
  }
  if(TelegramClientClass?.prototype&&!TelegramClientClass.prototype.__telepilotV1EngineInstalled){
    const currentSend=TelegramClientClass.prototype.sendMessage;
    Object.defineProperty(TelegramClientClass.prototype,"__telepilotV1EngineInstalled",{value:true});
    TelegramClientClass.prototype.sendMessage=async function(entity,params={},...rest){
      const context=currentDispatchContext();
      const uid=String(context?.uid||this.__telepilotOwnerUid||"");
      if(!uid || context?.senderType==="bot")return currentSend.call(this,entity,params,...rest);
      const settings=readAppSettings(uid), destination=destinationFor(settings,context,entity);
      if(!destination || !context?.cycleId)return currentSend.call(this,entity,params,...rest);
      const pro=readV1(uid), cycle=cycleFor(uid,pro,context); cycle.index++;
      const sender=String(context.senderLabel||"Personal account");
      const content=selectContent(uid,settings,pro,destination,cycle,context,String(params?.message||""),params?.formattingEntities||[]), rendered=renderV1(content,pro,destination,sender), reason=skipReason(pro,cycle,destination);
      if(reason){recordSkipped(uid,destination,sender,reason,context);return fakeResult(rendered,reason);}
      if(cycle.index>1&&Number(pro.staggerSeconds||0)>0)await new Promise(r=>setTimeout(r,Number(pro.staggerSeconds)*1000));
      try{
        const result=pro.media
          ? await sendPersonalMedia(this,entity,pro.media,rendered,params)
          : await withRetry(()=>rawPersonalSendMessage.call(this,entity,{...params,message:rendered.text||"\u2063",formattingEntities:toMtEntities(rendered.entities)},...rest));
        recordSuccess(uid,destination,sender,content.templateId,context);
        return result;
      }
      catch(err){recordFailure(uid,destination,sender,err,context);throw err;}
    };
  }
}
export function v1Stats(uid,now=Date.now()) {
  const history=readV1(uid).history||[], day=86_400_000;
  const summarize=since=>{const rows=history.filter(i=>Number(i.ts||0)>=since);return{sent:rows.filter(i=>i.status==="sent").length,failed:rows.filter(i=>i.status==="failed").length,skipped:rows.filter(i=>i.status==="skipped").length};};
  return{today:summarize(now-day),week:summarize(now-7*day),total:summarize(0)};
}
export function queuePreview(uid,now=Date.now()) {
  const pro=readV1(uid), offset=Number(pro.schedule?.utcOffsetMinutes||0), items=[];
  for(const job of pro.oneTimeJobs||[]){if(job.status&&job.status!=="pending")continue;const runAt=Number(job.runAt||0);if(runAt>=now)items.push({runAt,label:"One-time post"});}
  const localNow=new Date(now+offset*60_000);
  for(const rule of pro.exactTimes||[]){if(rule.enabled===false||!/^\d{2}:\d{2}$/.test(String(rule.time||"")))continue;const[h,m]=String(rule.time).split(":").map(Number);for(let add=0;add<8;add++){const local=new Date(Date.UTC(localNow.getUTCFullYear(),localNow.getUTCMonth(),localNow.getUTCDate()+add,h,m));const days=Array.isArray(rule.days)?rule.days.map(Number):[0,1,2,3,4,5,6];if(!days.includes(local.getUTCDay()))continue;const runAt=local.getTime()-offset*60_000;if(runAt>=now){items.push({runAt,label:`Exact — ${rule.time}`});break;}}}
  return items.sort((a,b)=>a.runAt-b.runAt).slice(0,20);
}

export const __test = {
  MEDIA_CAPTION_LIMIT,
  markPartialDelivery,
  botMediaDeliveryOptions,
  personalMediaDeliveryOptions,
};