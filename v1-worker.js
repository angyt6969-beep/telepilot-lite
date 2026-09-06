import { Bot } from "grammy";
import { Api as MtApi, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import bigInt from "big-integer";
import {
  accountDisplayLabel,
  effectiveAccountIds,
  listAccounts,
  loadAccountSession,
  updateAccountStatus,
  usesBotSender,
} from "./account-store.js";
import { withDispatchContext } from "./dispatch-context.js";
import { destinationAccountReady, recordDestinationFailure } from "./destination-automation.js";
import { isFatalSessionError, listUserIds, readAppSettings } from "./posting-engine-enhancements.js";
import { readV1, v1Stats, writeV1 } from "./v1-engine.js";

const BOT_TOKEN=process.env.BOT_TOKEN||"";
const API_ID=Number(process.env.API_ID||0);
const API_HASH=process.env.API_HASH||"";
const DATA_DIR=process.env.DATA_DIR||"/data";
const TICK_MS=30_000;
const EXACT_CATCHUP_MS=10*60_000;
const SESSION_CHECK_MS=6*60*60_000;
const USER_CONCURRENCY=10;
let ticking=false;

function readJson(file,fallback){try{const fs=requireFs();return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):fallback;}catch{return fallback;}}
let fsModule=null;function requireFs(){if(!fsModule)throw new Error("internal");return fsModule;}
// ESM-safe delayed import value is assigned once at module initialization.
import fs from "node:fs"; fsModule=fs;
import path from "node:path";
const ADMIN_FILE=path.join(DATA_DIR,"telepilot-admin.json");
function isAdmin(uid){const ids=new Set();for(const raw of[process.env.TELEPILOT_ADMIN_ID,process.env.OWNER_ID])for(const part of String(raw||"").split(/[\s,;]+/))if(/^\d+$/.test(part))ids.add(part);const persisted=readJson(ADMIN_FILE,{});for(const value of Array.isArray(persisted.adminIds)?persisted.adminIds:[])ids.add(String(value));return ids.has(String(uid));}
function hasAccess(uid,settings){if(isAdmin(uid))return true;if(settings?.accessRevoked)return false;if(settings?.accessLifetime)return true;return Number(settings?.accessUntil||0)>Date.now();}
function localDate(pro,now=Date.now()){return new Date(now+Number(pro.schedule?.utcOffsetMinutes||0)*60_000);}
function dateKey(date){return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}-${String(date.getUTCDate()).padStart(2,"0")}`;}
function timeKey(date){return `${String(date.getUTCHours()).padStart(2,"0")}:${String(date.getUTCMinutes()).padStart(2,"0")}`;}
function destinationId(d){return String(d?.id||d?.username||"");}
function deliveryId(destination,accountId){return `${destinationId(destination)}:${Number(destination?.topicId||0)}|${accountId||"bot"}`;}
function toMtEntities(entities=[]){const out=[];for(const entity of entities){const base={offset:Number(entity?.offset||0),length:Number(entity?.length||0)};try{if(entity?.type==="bold")out.push(new MtApi.MessageEntityBold(base));else if(entity?.type==="italic")out.push(new MtApi.MessageEntityItalic(base));else if(entity?.type==="underline")out.push(new MtApi.MessageEntityUnderline(base));else if(entity?.type==="strikethrough")out.push(new MtApi.MessageEntityStrike(base));else if(entity?.type==="spoiler")out.push(new MtApi.MessageEntitySpoiler(base));else if(entity?.type==="code")out.push(new MtApi.MessageEntityCode(base));else if(entity?.type==="pre")out.push(new MtApi.MessageEntityPre({...base,language:entity.language||""}));else if(entity?.type==="text_link")out.push(new MtApi.MessageEntityTextUrl({...base,url:entity.url||""}));else if(entity?.type==="custom_emoji"&&/^\d+$/.test(String(entity.custom_emoji_id||"")))out.push(new MtApi.MessageEntityCustomEmoji({...base,documentId:bigInt(entity.custom_emoji_id)}));}catch{}}return out;}
async function openPersonalClient(uid,account){const client=new TelegramClient(new StringSession(loadAccountSession(uid,account.id)),API_ID,API_HASH,{connectionRetries:5,floodSleepThreshold:60});client.__telepilotOwnerUid=String(uid);client.__telepilotAccountId=String(account.id);await client.connect();if(!(await client.checkAuthorization()))throw new Error("Personal account session is no longer authorized.");const me=await client.getMe();updateAccountStatus(uid,account.id,{telegramId:me?.id,username:me?.username,firstName:me?.firstName,lastName:me?.lastName,status:"connected",lastError:"",lastVerifiedAt:Date.now()});return client;}
async function personalTarget(client,destination,dialogCache){if(destination?.username)return destination.username;if(!dialogCache.value)dialogCache.value=await client.getDialogs({});const wanted=String(destination?.id||"").replace(/^-100/,"").replace(/^-/,"");for(const dialog of dialogCache.value){const ids=[dialog?.id,dialog?.entity?.id,dialog?.inputEntity?.chatId,dialog?.inputEntity?.channelId].filter(v=>v!==undefined&&v!==null).map(v=>String(v).replace(/\D/g,""));if(wanted&&ids.includes(wanted))return dialog;}throw new Error(`Could not resolve ${destination?.label||destination?.id||"destination"}.`);}

async function sendCycle(uid,settings,bot,options={}){
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
        if(destination.topicRequired===true&&!Number(destination.topicId||0)){skipped++;continue;}
        try{const opts={...(settings.adEntities?.length?{entities:settings.adEntities}:{}),...(Number(destination.topicId||0)>1?{message_thread_id:Number(destination.topicId)}:{})};const result=await withDispatchContext({uid:String(uid),destinationId:destinationId(destination),cycleId,senderType:"bot",senderLabel:"TelePilot Bot",forcedTemplateId,autoDisableEligible:true},()=>bot.api.sendMessage(destination.id,settings.adMessage,opts));if(result?.__telepilotSkipped)skipped++;else sent++;newlyDelivered.push(key);}catch(err){failed++;errors.push(String(err?.description||err?.message||err).slice(0,180));}
        continue;
      }
      const accountIds=effectiveAccountIds(settings,destination,accounts);
      if(!accountIds.length){skipped++;continue;}
      for(const accountId of accountIds){
        const key=deliveryId(destination,accountId);if(delivered.has(key))continue;
        const account=byId.get(String(accountId));if(!account){failed++;errors.push(`Missing sender ${accountId}`);continue;}
        if(!destinationAccountReady(destination,account.id)){skipped++;continue;}
        try{
          let client=clients.get(account.id);
          if(!client){client=await openPersonalClient(uid,account);clients.set(account.id,client);dialogCaches.set(account.id,{value:null});}
          const entity=await personalTarget(client,destination,dialogCaches.get(account.id));
          const result=await withDispatchContext({uid:String(uid),destinationId:destinationId(destination),cycleId,senderType:"personal",senderLabel:accountDisplayLabel(account),accountId:String(account.id),forcedTemplateId,autoDisableEligible:accountIds.length===1},()=>client.sendMessage(entity,{message:settings.adMessage,...(settings.adEntities?.length?{formattingEntities:toMtEntities(settings.adEntities)}:{}),...(Number(destination.topicId||0)>1?{replyTo:Number(destination.topicId),topMsgId:Number(destination.topicId)}:{})}));
          if(result?.__telepilotSkipped)skipped++;else sent++;newlyDelivered.push(key);
        }catch(err){failed++;const message=String(err?.errorMessage||err?.message||err).slice(0,180);errors.push(`${accountDisplayLabel(account)}: ${message}`);updateAccountStatus(uid,account.id,{status:isFatalSessionError(err)?"needs-reconnect":"unknown",lastError:message,lastVerifiedAt:Date.now()});if(!isFatalSessionError(err))recordDestinationFailure(uid,destination,account.id,err);}
      }
    }
    return{sent,failed,skipped,delivered:newlyDelivered,errors};
  }finally{for(const client of clients.values())try{await client.disconnect();}catch{}}
}
function scheduledRun(pro,rule,now){if(rule?.enabled===false||!/^\d{2}:\d{2}$/.test(String(rule?.time||"")))return null;const offset=Number(pro.schedule?.utcOffsetMinutes||0), localNow=new Date(now+offset*60_000),[h,m]=String(rule.time).split(":").map(Number);const localRun=new Date(Date.UTC(localNow.getUTCFullYear(),localNow.getUTCMonth(),localNow.getUTCDate(),h,m));const days=Array.isArray(rule.days)?rule.days.map(Number):[0,1,2,3,4,5,6];if(!days.includes(localRun.getUTCDay()))return null;const runAt=localRun.getTime()-offset*60_000;if(now<runAt||now-runAt>EXACT_CATCHUP_MS)return null;return{runAt,key:`${dateKey(localRun)}|${rule.time}`};}
async function processExact(uid,settings,bot,now){const pro=readV1(uid);for(const rule of pro.exactTimes||[]){const due=scheduledRun(pro,rule,now);if(!due||String(rule.lastRunKey||"")===due.key)continue;const oldDelivered=String(rule.deliveryKey||"")===due.key&&Array.isArray(rule.delivered)?rule.delivered:[];const result=await sendCycle(uid,settings,bot,{templateId:rule.templateId,cycleId:`exact:${rule.id}:${due.key}`,delivered:oldDelivered});const latest=readV1(uid),stored=latest.exactTimes.find(item=>String(item.id)===String(rule.id));if(!stored)continue;const merged=[...new Set([...oldDelivered,...result.delivered])];stored.deliveryKey=due.key;stored.delivered=merged;stored.lastAttemptAt=Date.now();stored.lastError=result.errors[0]||"";if(result.failed===0){stored.lastRunKey=due.key;stored.delivered=[];}writeV1(uid,latest);}}
async function processOneTime(uid,settings,bot,now){const due=(readV1(uid).oneTimeJobs||[]).filter(job=>(!job.status||job.status==="pending")&&Number(job.runAt||0)>0&&Number(job.runAt)<=now&&Number(job.nextAttemptAt||0)<=now).map(job=>({id:String(job.id),templateId:String(job.templateId||""),delivered:Array.isArray(job.delivered)?job.delivered:[],attempts:Number(job.attempts||0)}));for(const job of due){const result=await sendCycle(uid,settings,bot,{templateId:job.templateId,cycleId:`once:${job.id}`,delivered:job.delivered});const latest=readV1(uid),stored=latest.oneTimeJobs.find(item=>String(item.id)===job.id);if(!stored)continue;stored.delivered=[...new Set([...(job.delivered||[]),...result.delivered])];stored.attempts=job.attempts+1;stored.error=result.errors[0]||"";if(result.failed===0){stored.status="done";stored.completedAt=Date.now();stored.delivered=[];}else if(stored.attempts>=3){stored.status="failed";stored.completedAt=Date.now();}else{stored.status="pending";stored.nextAttemptAt=Date.now()+Math.min(10*60_000,60_000*(2**(stored.attempts-1)));}writeV1(uid,latest);}}
async function flushAlerts(uid,bot){const current=readV1(uid),alerts=(current.pendingAlerts||[]).slice(0,3),sent=[];for(const alert of alerts){try{await bot.api.sendMessage(uid,alert.text);sent.push(String(alert.id));}catch{break;}}if(!sent.length)return;const latest=readV1(uid);latest.pendingAlerts=(latest.pendingAlerts||[]).filter(a=>!sent.includes(String(a.id)));writeV1(uid,latest);}
async function accessReminder(uid,settings,bot,now){if(isAdmin(uid)||settings.accessLifetime||settings.accessRevoked||!settings.accessUntil)return;const remaining=Number(settings.accessUntil)-now;if(remaining<=0||remaining>3*86_400_000)return;const pro=readV1(uid),days=Math.max(1,Math.ceil(remaining/86_400_000)),key=`${dateKey(localDate(pro,now))}|${days}`;if(pro.reminders?.lastAccessKey===key)return;try{await bot.api.sendMessage(uid,`💎 TelePilot Access\n\nYour access expires in ${days} day${days===1?"":"s"}.\n\nYour saved setup remains on TelePilot if you renew later.`);}catch{return;}const latest=readV1(uid);latest.reminders.lastAccessKey=key;writeV1(uid,latest);}
function currentWeekKey(local){const copy=new Date(local.getTime());copy.setUTCDate(copy.getUTCDate()-copy.getUTCDay());return dateKey(copy);}
async function weeklyRecap(uid,bot,now){const pro=readV1(uid);if(!pro.weeklyRecap?.enabled)return;const local=localDate(pro,now);if(local.getUTCDay()!==Number(pro.weeklyRecap.day||0)||local.getUTCHours()!==Number(pro.weeklyRecap.hour||18))return;const key=currentWeekKey(local);if(pro.weeklyRecap.lastKey===key)return;const stats=v1Stats(uid,now).week;if(stats.sent||stats.failed||stats.skipped)try{await bot.api.sendMessage(uid,["📊 Weekly TelePilot recap","",`Sent — ${stats.sent}`,`Failed — ${stats.failed}`,`Skipped — ${stats.skipped}`,"","Open Activity → Posting history for details."].join("\n"));}catch{return;}const latest=readV1(uid);latest.weeklyRecap.lastKey=key;writeV1(uid,latest);}
async function sessionHealth(uid,bot,now){const accounts=listAccounts(uid);if(!accounts.length)return;const current=readV1(uid);if(Number(current.sessionHealth?.lastCheckedAt||0)>now-SESSION_CHECK_MS)return;let connected=0,failed=0;const issues=[];for(const account of accounts){let client;try{client=await openPersonalClient(uid,account);connected++;}catch(err){failed++;const message=String(err?.message||err).slice(0,180);issues.push(`${accountDisplayLabel(account)} — ${message}`);updateAccountStatus(uid,account.id,{status:isFatalSessionError(err)?"needs-reconnect":"unknown",lastError:message,lastVerifiedAt:now});}finally{try{await client?.disconnect();}catch{}}}const latest=readV1(uid);latest.sessionHealth.status=failed===0?"connected":connected?"partial":"needs-reconnect";latest.sessionHealth.lastError=issues[0]||"";latest.sessionHealth.lastCheckedAt=now;if(!latest.sessionHealth.firstSeenAt)latest.sessionHealth.firstSeenAt=now;latest.accountHealth=Object.fromEntries(listAccounts(uid).map(a=>[a.id,{status:a.status,lastError:a.lastError,lastCheckedAt:a.lastVerifiedAt}]));writeV1(uid,latest);if(failed&&latest.notificationMode!=="silent")try{await bot.api.sendMessage(uid,`⚠️ TelePilot Sender\n\n${failed} connected account${failed===1?"":"s"} need attention. ${connected} account${connected===1?"":"s"} remain available.\n\nOpen Sender to review them.`);}catch{}}
async function processUser(uid,bot){const now=Date.now(),settings=readAppSettings(uid);try{await flushAlerts(uid,bot);}catch{}try{await sessionHealth(uid,bot,now);}catch{}try{await accessReminder(uid,settings,bot,now);}catch{}const pro=readV1(uid);if(!hasAccess(uid,settings)||pro.paused)return;try{await processExact(uid,settings,bot,Date.now());}catch(err){console.warn(`Exact scheduler error ${uid}:`,err?.message||err);}try{await processOneTime(uid,settings,bot,Date.now());}catch(err){console.warn(`One-time scheduler error ${uid}:`,err?.message||err);}try{await weeklyRecap(uid,bot,Date.now());}catch{}}
async function tick(bot){if(ticking)return;ticking=true;try{const users=listUserIds();for(let i=0;i<users.length;i+=USER_CONCURRENCY){const batch=users.slice(i,i+USER_CONCURRENCY);await Promise.allSettled(batch.map(uid=>processUser(uid,bot)));}}finally{ticking=false;}}
export function startV1Worker(){if(!BOT_TOKEN||!API_ID||!API_HASH){console.warn("TelePilot v1 worker disabled: missing Telegram credentials");return null;}const bot=new Bot(BOT_TOKEN),run=()=>void tick(bot).catch(err=>console.error("TelePilot v1 worker failed:",err?.message||err));const initial=setTimeout(run,15_000),timer=setInterval(run,TICK_MS);initial.unref?.();timer.unref?.();console.log("TelePilot v1 multi-account scheduler enabled");return timer;}
