import fs from "node:fs";
import path from "node:path";
import bigInt from "big-integer";
import { Bot, InlineKeyboard } from "grammy";
import { Api, TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions/index.js";
import { createConnectService } from "./connect-server.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || "https://telepilot-lite-production.up.railway.app";
const INTERVAL_VALUES = [1, 5, 10, 15, 30, 45, 60, 90, 120];

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!API_ID) throw new Error("Missing API_ID");
if (!API_HASH) throw new Error("Missing API_HASH");

fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_DIR = path.join(DATA_DIR, "users");
fs.mkdirSync(USERS_DIR, { recursive: true });
const states = new Map();

function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function settingsFile(uid) { return path.join(userDir(uid), "settings.json"); }
function sessionDir(uid) { return path.join(userDir(uid), "telegram-session"); }
function sessionName(uid) { return path.relative(process.cwd(), sessionDir(uid)) || `../data/users/${uid}/telegram-session`; }

function migrateLegacyOwner() {
  const legacySettings = path.join(DATA_DIR, "telepilot-settings.json");
  if (!fs.existsSync(legacySettings)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(legacySettings, "utf8"));
    const uid = Number(saved.ownerId);
    if (!Number.isInteger(uid) || uid <= 0) return;
    fs.mkdirSync(userDir(uid), { recursive: true });
    if (!fs.existsSync(settingsFile(uid))) {
      const migrated = { ...saved };
      delete migrated.ownerId;
      fs.writeFileSync(settingsFile(uid), JSON.stringify(migrated, null, 2), { mode: 0o600 });
    }
    const legacySession = path.join(DATA_DIR, "telepilot-user-session");
    if (fs.existsSync(legacySession) && !fs.existsSync(sessionDir(uid))) fs.cpSync(legacySession, sessionDir(uid), { recursive: true });
    console.log(`Migrated legacy TelePilot owner data into user ${uid}`);
  } catch (err) {
    console.warn("Legacy migration skipped:", err?.message || err);
  }
}
migrateLegacyOwner();

function loadUserSettings(uid) {
  try {
    if (!fs.existsSync(settingsFile(uid))) return {};
    return JSON.parse(fs.readFileSync(settingsFile(uid), "utf8"));
  } catch { return {}; }
}

function createState(uid) {
  const saved = loadUserSettings(uid);
  return {
    uid: Number(uid),
    client: null,
    connectedUsername: null,
    restorePromise: null,
    adMessage: typeof saved.adMessage === "string" ? saved.adMessage : "",
    adEntities: Array.isArray(saved.adEntities) ? saved.adEntities : [],
    groups: Array.isArray(saved.groups) ? saved.groups.filter(x => typeof x === "string") : [],
    intervalMinutes: INTERVAL_VALUES.includes(Number(saved.intervalMinutes)) ? Number(saved.intervalMinutes) : 30,
    totalSent: Number.isFinite(Number(saved.totalSent)) ? Number(saved.totalSent) : 0,
    lastRunAt: Number.isFinite(Number(saved.lastRunAt)) ? Number(saved.lastRunAt) : null,
    lastCycleSuccess: Number.isFinite(Number(saved.lastCycleSuccess)) ? Number(saved.lastCycleSuccess) : 0,
    lastCycleFailed: Number.isFinite(Number(saved.lastCycleFailed)) ? Number(saved.lastCycleFailed) : 0,
    postingTimer: null,
    posting: false,
    nextRunAt: null,
    awaiting: null,
    awaitingPromptMessageId: null,
    awaitingPromptChatId: null,
  };
}
function getState(uid) {
  const key = String(uid);
  if (!states.has(key)) states.set(key, createState(uid));
  return states.get(key);
}
function saveState(state) {
  fs.mkdirSync(userDir(state.uid), { recursive: true });
  const file = settingsFile(state.uid), temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({
    adMessage: state.adMessage,
    adEntities: state.adEntities,
    groups: state.groups,
    intervalMinutes: state.intervalMinutes,
    totalSent: state.totalSent,
    lastRunAt: state.lastRunAt,
    lastCycleSuccess: state.lastCycleSuccess,
    lastCycleFailed: state.lastCycleFailed,
  }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

const bot = new Bot(BOT_TOKEN);
function createUserClient(uid) { return new TelegramClient(new StoreSession(sessionName(uid)), API_ID, API_HASH, { connectionRetries: 5 }); }

async function ensureSession(state) {
  if (state.client && state.connectedUsername) return true;
  if (state.restorePromise) return state.restorePromise;
  state.restorePromise = (async () => {
    const client = createUserClient(state.uid);
    try {
      await client.connect();
      if (!(await client.checkAuthorization())) { await client.disconnect(); return false; }
      const me = await client.getMe();
      state.client = client;
      state.connectedUsername = me?.username || String(me?.id || "connected");
      console.log(`Restored Telegram session for TelePilot user ${state.uid}`);
      return true;
    } catch (err) {
      console.error(`Could not restore session for ${state.uid}:`, err?.message || err);
      try { await client.disconnect(); } catch {}
      return false;
    } finally { state.restorePromise = null; }
  })();
  return state.restorePromise;
}

function accountDisplay(state) { return state.connectedUsername ? (/^\d+$/.test(String(state.connectedUsername)) ? "Connected" : `@${state.connectedUsername}`) : "Not connected"; }
function formatInterval(m) { const v=Number(m); if(v<60)return `${v} min`; if(v%60===0)return `${v/60}h`; return `${Math.floor(v/60)}h ${v%60}m`; }
function formatAgo(ts){if(!ts)return"Never";const s=Math.max(0,Math.floor((Date.now()-ts)/1000));if(s<10)return"Just now";if(s<60)return`${s}s ago`;const m=Math.floor(s/60);if(m<60)return`${m}m ago`;const h=Math.floor(m/60);if(h<24)return`${h}h ago`;return`${Math.floor(h/24)}d ago`;}
function formatUntil(state){if(!state.nextRunAt||!state.posting)return"—";const s=Math.max(0,Math.ceil((state.nextRunAt-Date.now())/1000));if(s<60)return"<1 min";return formatInterval(Math.ceil(s/60));}

function sanitizeBotEntities(entities=[]){const allowed=new Set(["bold","italic","underline","strikethrough","spoiler","blockquote","expandable_blockquote","code","pre","text_link","custom_emoji"]);return entities.filter(e=>allowed.has(e?.type)).map(e=>({type:e.type,offset:Number(e.offset),length:Number(e.length),...(e.url?{url:String(e.url)}:{}),...(e.language?{language:String(e.language)}:{}),...(e.custom_emoji_id?{custom_emoji_id:String(e.custom_emoji_id)}:{})})).filter(e=>Number.isInteger(e.offset)&&Number.isInteger(e.length)&&e.offset>=0&&e.length>0);}
function toMtprotoEntities(entities=[]){const out=[];for(const e of entities){const b={offset:Number(e.offset),length:Number(e.length)};try{switch(e.type){case"bold":out.push(new Api.MessageEntityBold(b));break;case"italic":out.push(new Api.MessageEntityItalic(b));break;case"underline":out.push(new Api.MessageEntityUnderline(b));break;case"strikethrough":out.push(new Api.MessageEntityStrike(b));break;case"spoiler":out.push(new Api.MessageEntitySpoiler(b));break;case"code":out.push(new Api.MessageEntityCode(b));break;case"pre":out.push(new Api.MessageEntityPre({...b,language:e.language||""}));break;case"text_link":out.push(new Api.MessageEntityTextUrl({...b,url:e.url||""}));break;case"blockquote":out.push(new Api.MessageEntityBlockquote({...b,collapsed:false}));break;case"expandable_blockquote":out.push(new Api.MessageEntityBlockquote({...b,collapsed:true}));break;case"custom_emoji":if(/^\d+$/.test(e.custom_emoji_id||""))out.push(new Api.MessageEntityCustomEmoji({...b,documentId:bigInt(e.custom_emoji_id)}));break}}catch{}}return out;}
async function safeDelete(chatId,messageId){if(!chatId||!messageId)return;try{await bot.api.deleteMessage(chatId,messageId)}catch{}}
async function autoDeleteNotice(chatId,text,ms=9000){try{const m=await bot.api.sendMessage(chatId,text);setTimeout(()=>void safeDelete(chatId,m.message_id),ms)}catch{}}
function clearAwaiting(state){state.awaiting=null;state.awaitingPromptMessageId=null;state.awaitingPromptChatId=null;}

function mainKeyboard(){return new InlineKeyboard().text("👤 Account","account").text("📝 Message","message").row().text("👥 Groups","groups").text("⏱ Interval","interval").row().text("▶️ START","start").text("⏹ STOP","stop").row().text("📊 Activity","activity").text("🔄 Refresh","home");}
function dashboard(state){return ["✈️ TELEPILOT","",state.posting?"🟢 Running":"⚪ Stopped","",`👤 Account: ${accountDisplay(state)}`,`📝 Message: ${state.adMessage?`✅ Set (${state.adMessage.length} chars)`:"❌ Not set"}`,`👥 Groups: ${state.groups.length}`,`⏱ Interval: ${formatInterval(state.intervalMinutes)}`,state.posting?`⏳ Next post: ${formatUntil(state)}`:null].filter(Boolean).join("\n");}
async function showHome(ctx,state){clearAwaiting(state);const opts={reply_markup:mainKeyboard()};try{if(ctx.callbackQuery?.message)await ctx.editMessageText(dashboard(state),opts);else await ctx.reply(dashboard(state),opts)}catch{await ctx.reply(dashboard(state),opts)}}
async function editDashboard(chatId,messageId,state){try{await bot.api.editMessageText(chatId,messageId,dashboard(state),{reply_markup:mainKeyboard()});return true}catch{return false}}
function normalizeTarget(input){let v=String(input||"").trim().replace(/^https?:\/\/(www\.)?t\.me\//i,"");v=v.split(/[/?#]/)[0];if(!v)return null;if(/^-?\d+$/.test(v))return v;v=v.replace(/^@/,"");return /^[A-Za-z0-9_]{5,}$/.test(v)?`@${v}`:null;}

async function sendCycle(state){if(!state.posting||!state.client||!state.adMessage||!state.groups.length)return;let success=0,failed=0;const formattingEntities=toMtprotoEntities(state.adEntities);for(const target of state.groups){if(!state.posting)break;try{await state.client.sendMessage(target,{message:state.adMessage,...(formattingEntities.length?{formattingEntities}:{})});success++;state.totalSent++;await new Promise(r=>setTimeout(r,1500))}catch(err){failed++;console.error(`User ${state.uid} failed to post to ${target}:`,err?.message||err)}}state.lastRunAt=Date.now();state.lastCycleSuccess=success;state.lastCycleFailed=failed;saveState(state);}
function scheduleNextCycle(state){if(state.postingTimer)clearTimeout(state.postingTimer);if(!state.posting){state.nextRunAt=null;return}const delay=state.intervalMinutes*60000;state.nextRunAt=Date.now()+delay;state.postingTimer=setTimeout(async()=>{await sendCycle(state);if(state.posting)scheduleNextCycle(state)},delay);}
function startPostingLoop(state){if(state.posting)return;state.posting=true;void sendCycle(state);scheduleNextCycle(state);}
function stopPostingLoop(state){state.posting=false;state.nextRunAt=null;if(state.postingTimer)clearTimeout(state.postingTimer);state.postingTimer=null;}

const connectService=createConnectService({botToken:BOT_TOKEN,apiId:API_ID,apiHash:API_HASH,publicUrl:PUBLIC_URL,getSessionName:async uid=>{fs.mkdirSync(userDir(uid),{recursive:true});return sessionName(uid)},onConnected:async(uid,client,me)=>{const state=getState(uid);if(state.client&&state.client!==client){try{await state.client.disconnect()}catch{}}state.client=client;state.connectedUsername=me?.username||String(me?.id||"connected");await autoDeleteNotice(Number(uid),`✅ Connected${me?.username?` as @${me.username}`:""}. Open /start to continue.`)}});
connectService.listen(PORT);

function stateFromCtx(ctx){const uid=ctx.from?.id;return uid?getState(uid):null;}
function privateOnly(ctx){return ctx.chat?.type==="private";}

bot.command("start",async ctx=>{if(!privateOnly(ctx))return;const state=stateFromCtx(ctx);await ensureSession(state);await showHome(ctx,state);});
bot.callbackQuery("home",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);if(!state)return;await ensureSession(state);await showHome(ctx,state);});
bot.callbackQuery("account",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);if(!state)return;await ensureSession(state);if(state.connectedUsername){const kb=new InlineKeyboard().text("🔌 Disconnect account","disconnect_account").row().text("⬅️ Back","home");return ctx.editMessageText(`👤 ACCOUNT\n\n✅ Connected: ${accountDisplay(state)}\n🔒 Your session is stored separately from other TelePilot users.`,{reply_markup:kb})}const url=connectService.makeConnectUrl(state.uid);const kb=new InlineKeyboard().url("🔐 Connect account on this phone",url).row().text("⬅️ Back","home");await ctx.editMessageText("👤 ACCOUNT\n\nConnect your Telegram account to your private TelePilot profile. Your session, groups, message and schedule are isolated from every other user.",{reply_markup:kb});});
bot.callbackQuery("disconnect_account",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);const kb=new InlineKeyboard().text("⚠️ Yes, disconnect","disconnect_confirm").row().text("⬅️ Keep account","account");await ctx.editMessageText("🔌 DISCONNECT ACCOUNT\n\nThis logs TelePilot out of your Telegram account and stops your posting. Your saved message and groups stay in your private profile.",{reply_markup:kb});});
bot.callbackQuery("disconnect_confirm",async ctx=>{const state=stateFromCtx(ctx);await ctx.answerCallbackQuery({text:"Account disconnected"});stopPostingLoop(state);if(state.client){try{await state.client.logOut()}catch{}try{await state.client.disconnect()}catch{}}state.client=null;state.connectedUsername=null;try{fs.rmSync(sessionDir(state.uid),{recursive:true,force:true})}catch{}await showHome(ctx,state);});

bot.callbackQuery("message",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);clearAwaiting(state);const kb=new InlineKeyboard();if(state.adMessage)kb.text("👁 Preview","message_preview").text("✏️ Change","message_change").row();else kb.text("➕ Set message","message_change").row();kb.text("⬅️ Back","home");await ctx.editMessageText(`📝 AD MESSAGE\n\n${state.adMessage?`✅ Saved • ${state.adMessage.length} characters`:"❌ No message set yet."}`,{reply_markup:kb});});
bot.callbackQuery("message_change",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);state.awaiting="message";state.awaitingPromptMessageId=ctx.callbackQuery.message?.message_id||null;state.awaitingPromptChatId=ctx.chat?.id||null;await ctx.editMessageText("✏️ SET AD MESSAGE\n\nSend the message you want TelePilot to post. Formatting, links and Premium/custom emoji are supported.",{reply_markup:new InlineKeyboard().text("⬅️ Cancel","message")});});
bot.callbackQuery("message_preview",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);const kb=new InlineKeyboard().text("✏️ Change","message_change").row().text("⬅️ Back","message");if(!state.adMessage)return ctx.editMessageText("No message set.",{reply_markup:kb});try{await ctx.editMessageText(state.adMessage,{reply_markup:kb,...(state.adEntities.length?{entities:state.adEntities}:{})})}catch{await ctx.editMessageText(state.adMessage,{reply_markup:kb})}});

bot.callbackQuery("groups",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);clearAwaiting(state);const list=state.groups.length?state.groups.map((g,i)=>`${i+1}. ${g}`).join("\n"):"No groups added.";const kb=new InlineKeyboard().text("➕ Add group","add_group");if(state.groups.length)kb.text("➖ Remove","remove_group_menu");kb.row();if(state.groups.length)kb.text("🗑 Clear all","clear_groups").row();kb.text("⬅️ Back","home");await ctx.editMessageText(`👥 GROUPS\n\n${list}\n\nOnly add groups/channels where your connected account is allowed to post.`,{reply_markup:kb});});
bot.callbackQuery("add_group",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);state.awaiting="group";state.awaitingPromptMessageId=ctx.callbackQuery.message?.message_id||null;state.awaitingPromptChatId=ctx.chat?.id||null;await ctx.editMessageText("➕ ADD GROUP\n\nSend an @username or t.me link for a group/channel your account is already allowed to post in.",{reply_markup:new InlineKeyboard().text("⬅️ Cancel","groups")});});
bot.callbackQuery("remove_group_menu",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);const kb=new InlineKeyboard();state.groups.slice(0,20).forEach((g,i)=>kb.text(`❌ ${g}`,`remove_group:${i}`).row());kb.text("⬅️ Back","groups");await ctx.editMessageText("➖ REMOVE GROUP\n\nChoose a destination to remove:",{reply_markup:kb});});
bot.callbackQuery(/^remove_group:(\d+)$/,async ctx=>{const state=stateFromCtx(ctx),i=Number(ctx.match[1]);if(!Number.isInteger(i)||i<0||i>=state.groups.length)return ctx.answerCallbackQuery({text:"That group is no longer in your list."});const [removed]=state.groups.splice(i,1);saveState(state);await ctx.answerCallbackQuery({text:`Removed ${removed}`});const list=state.groups.length?state.groups.map((g,n)=>`${n+1}. ${g}`).join("\n"):"No groups added.";const kb=new InlineKeyboard().text("➕ Add group","add_group");if(state.groups.length)kb.text("➖ Remove","remove_group_menu");kb.row();if(state.groups.length)kb.text("🗑 Clear all","clear_groups").row();kb.text("⬅️ Back","home");await ctx.editMessageText(`👥 GROUPS\n\n${list}`,{reply_markup:kb});});
bot.callbackQuery("clear_groups",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);await ctx.editMessageText(`🗑 CLEAR GROUPS\n\nRemove all ${state.groups.length} saved destinations?`,{reply_markup:new InlineKeyboard().text("⚠️ Yes, clear all","clear_groups_confirm").row().text("⬅️ Cancel","groups")});});
bot.callbackQuery("clear_groups_confirm",async ctx=>{const state=stateFromCtx(ctx);state.groups=[];saveState(state);await ctx.answerCallbackQuery({text:"Groups cleared"});await showHome(ctx,state);});

bot.callbackQuery("interval",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);const kb=new InlineKeyboard().text("1m","i1").text("5m","i5").text("10m","i10").row().text("15m","i15").text("30m","i30").text("45m","i45").row().text("1h","i60").text("1h 30m","i90").text("2h","i120").row().text("⬅️ Back","home");await ctx.editMessageText(`⏱ INTERVAL\n\nCurrent: ${formatInterval(state.intervalMinutes)}\n\nChoose how often TelePilot should post.`,{reply_markup:kb});});
for(const minutes of INTERVAL_VALUES)bot.callbackQuery(`i${minutes}`,async ctx=>{const state=stateFromCtx(ctx);state.intervalMinutes=minutes;saveState(state);if(state.posting)scheduleNextCycle(state);await ctx.answerCallbackQuery({text:`Set to ${formatInterval(minutes)}`});await showHome(ctx,state);});

bot.callbackQuery("activity",async ctx=>{await ctx.answerCallbackQuery();const state=stateFromCtx(ctx);await ctx.editMessageText(["📊 ACTIVITY","",`Status: ${state.posting?"🟢 Running":"⚪ Stopped"}`,`Total successful posts: ${state.totalSent}`,`Last cycle: ${formatAgo(state.lastRunAt)}`,`Last result: ${state.lastRunAt?`✅ ${state.lastCycleSuccess} sent • ❌ ${state.lastCycleFailed} failed`:"No runs yet"}`,`Next cycle: ${state.posting?formatUntil(state):"—"}`].join("\n"),{reply_markup:new InlineKeyboard().text("🔄 Refresh","activity").row().text("⬅️ Back","home")});});
bot.callbackQuery("start",async ctx=>{const state=stateFromCtx(ctx);await ensureSession(state);if(state.posting)return ctx.answerCallbackQuery({text:"TelePilot is already running."});if(!state.client||!state.connectedUsername)return ctx.answerCallbackQuery({text:"Connect your Telegram account first.",show_alert:true});if(!state.adMessage)return ctx.answerCallbackQuery({text:"Set an ad message first.",show_alert:true});if(!state.groups.length)return ctx.answerCallbackQuery({text:"Add at least one authorized group first.",show_alert:true});await ctx.answerCallbackQuery();await ctx.editMessageText(`▶️ START TELEPILOT\n\nDestinations: ${state.groups.length}\nInterval: ${formatInterval(state.intervalMinutes)}\n\nTelePilot will post once immediately, then continue on your selected interval.`,{reply_markup:new InlineKeyboard().text("▶️ Confirm start","start_confirm").row().text("⬅️ Cancel","home")});});
bot.callbackQuery("start_confirm",async ctx=>{const state=stateFromCtx(ctx);await ensureSession(state);if(!state.client||!state.connectedUsername||!state.adMessage||!state.groups.length)return showHome(ctx,state);startPostingLoop(state);await ctx.answerCallbackQuery({text:"TelePilot started"});await showHome(ctx,state);});
bot.callbackQuery("stop",async ctx=>{const state=stateFromCtx(ctx);const was=state.posting;if(was)stopPostingLoop(state);await ctx.answerCallbackQuery({text:was?"TelePilot stopped":"TelePilot is already stopped."});if(was)await showHome(ctx,state);});

bot.on("message:text",async ctx=>{if(!privateOnly(ctx))return;const state=stateFromCtx(ctx);if(!state?.awaiting)return;if(state.awaiting==="message"){const pm=state.awaitingPromptMessageId,pc=state.awaitingPromptChatId||ctx.chat.id;state.adMessage=ctx.message.text;state.adEntities=sanitizeBotEntities(ctx.message.entities||[]);clearAwaiting(state);saveState(state);await safeDelete(ctx.chat.id,ctx.message.message_id);if(!(await editDashboard(pc,pm,state)))await ctx.reply(dashboard(state),{reply_markup:mainKeyboard()});return}if(state.awaiting==="group"){const target=normalizeTarget(ctx.message.text);if(!target){const n=await ctx.reply("I couldn't read that. Send an @username or a t.me/username link.");setTimeout(()=>void safeDelete(ctx.chat.id,n.message_id),7000);return}const pm=state.awaitingPromptMessageId,pc=state.awaitingPromptChatId||ctx.chat.id;if(!state.groups.includes(target))state.groups.push(target);clearAwaiting(state);saveState(state);await safeDelete(ctx.chat.id,ctx.message.message_id);if(!(await editDashboard(pc,pm,state)))await ctx.reply(dashboard(state),{reply_markup:mainKeyboard()});}});

bot.catch(err=>console.error("Bot error:",err.error));
process.once("SIGINT",()=>bot.stop());process.once("SIGTERM",()=>bot.stop());
console.log("TelePilot multi-user mode starting…");
await bot.start({onStart:info=>console.log(`Control bot running as @${info.username}`)});
