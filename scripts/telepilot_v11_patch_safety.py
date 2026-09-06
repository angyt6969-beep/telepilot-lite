from pathlib import Path

def once(s,old,new,label):
 c=s.count(old)
 if c!=1: raise RuntimeError(f'{label}: expected one, got {c}')
 return s.replace(old,new,1)

def section(s,start,end,new,label):
 a=s.find(start)
 if a<0: raise RuntimeError(f'{label}: start missing')
 b=s.find(end,a+len(start))
 if b<0: raise RuntimeError(f'{label}: end missing')
 return s[:a]+new.rstrip()+'\n\n'+s[b:]

# Support: cancellation and deletion correctness.
p=Path('support-center.js');s=p.read_text()
s=once(s,'import {\n  hasPersonalSessionFile,\n  readAppSettings,\n  readProSettings,\n} from "./posting-engine-enhancements.js";\n','import {\n  hasPersonalSessionFile,\n  readAppSettings,\n  readProSettings,\n} from "./posting-engine-enhancements.js";\nimport { listAccounts } from "./account-store.js";\n','support account import')
s=s.replace('sender: hasPersonalSessionFile(uid) ? "personal" : "bot",','sender: listAccounts(uid).length ? `${listAccounts(uid).length} personal account(s)` : "bot",')
# Opening/canceling an admin case clears stale reply input.
s=once(s,'''      baseCallbackQuery.call(bot, /^support_admin_case:(TP-SUP-[A-Z2-9]+)$/, async ctx => {
        if (!ensurePrivate(ctx) || !isAdmin(uidOf(ctx))) return;
        try { await ctx.answerCallbackQuery(); } catch {}
        return showAdminCase(ctx, String(ctx.match?.[1] || ""));
      });''','''      baseCallbackQuery.call(bot, /^support_admin_case:(TP-SUP-[A-Z2-9]+)$/, async ctx => {
        if (!ensurePrivate(ctx) || !isAdmin(uidOf(ctx))) return;
        awaiting.delete(uidOf(ctx));
        try { await ctx.answerCallbackQuery(); } catch {}
        return showAdminCase(ctx, String(ctx.match?.[1] || ""));
      });''','support reply cancel')
s=section(s,'async function processDeletion(ctx, item) {','function supportIntent(ctx) {',r'''async function processDeletion(ctx, item) {
  const adminUid=uidOf(ctx),targetUid=String(item?.uid||"");
  if(!isAdmin(adminUid)||!/^\d+$/.test(targetUid))throw new Error("Invalid deletion target");
  if(isAdmin(targetUid))throw new Error("Admin profiles cannot be deleted through support controls");
  try { if(typeof appStopHandler==="function")await appStopHandler(fakeTargetContext(ctx,targetUid,"stop"),async()=>undefined); } catch {}
  try { if(typeof appDisconnectHandler==="function")await appDisconnectHandler(fakeTargetContext(ctx,targetUid,"account_disconnect"),async()=>undefined); } catch {}
  scrubKeyIdentity(targetUid);
  const dir=userDir(targetUid);
  fs.rmSync(dir,{recursive:true,force:true});
  if(fs.existsSync(dir))throw new Error("User directory still exists after deletion");
  markDeleted(targetUid,item.id);
  const db=loadCases();
  for(const current of db.cases){if(String(current.uid||"")!==targetUid)continue;current.uid="";current.username="";current.message=current.id===item.id?"User-requested data deletion completed.":"Support report content removed after user data deletion.";current.diagnostic={};current.replies=[];current.status="resolved";current.deletedAt=Date.now();current.updatedAt=Date.now();}
  saveCases(db);
  appendSecurityEvent("user_data_deleted",{actorUid:adminUid,caseId:item.id});
  try { await ctx.api.sendMessage(Number(targetUid),["✅ TelePilot data deletion completed","","Your stored TelePilot configuration and connected personal-account sessions have been removed. Limited security/audit records may remain where necessary for service integrity.","",`Questions — @${SUPPORT_USERNAME}`].join("\n"),{reply_markup:new InlineKeyboard().url(`@${SUPPORT_USERNAME}`,SUPPORT_URL)}); } catch {}
}
''','safe deletion order')
s=s.replace('personal-account session. Your posting','personal-account sessions. Your posting')
s=s.replace('personal-account session, removes','personal-account sessions, removes')
p.write_text(s);print('patched support-center.js')

# Security: bound memory growth for rate/confirmation maps.
p=Path('security-core.js');s=p.read_text()
insert=r'''
function sweepEphemeralSecurityState(now = Date.now()) {
  for (const [key,bucket] of rateBuckets) if (!bucket || now >= Number(bucket.resetAt||0)) rateBuckets.delete(key);
  for (const [token,item] of confirmationTokens) if (!item || now >= Number(item.expiresAt||0)) confirmationTokens.delete(token);
}
'''
# confirmationTokens is declared later, so define sweep after that declaration instead.
s=once(s,'const confirmationTokens = new Map();\n','const confirmationTokens = new Map();\n\nfunction sweepEphemeralSecurityState(now = Date.now()) {\n  for (const [key,bucket] of rateBuckets) if (!bucket || now >= Number(bucket.resetAt||0)) rateBuckets.delete(key);\n  for (const [token,item] of confirmationTokens) if (!item || now >= Number(item.expiresAt||0)) confirmationTokens.delete(token);\n}\nconst ephemeralSweep = setInterval(() => sweepEphemeralSecurityState(), 10 * 60_000);\nephemeralSweep.unref?.();\n','security sweep')
# Opportunistic sweep under unusually high cardinality too.
s=once(s,'export function takeRateLimit(scope, subject, limit, windowMs) {\n  const now = Date.now();','export function takeRateLimit(scope, subject, limit, windowMs) {\n  const now = Date.now();\n  if (rateBuckets.size > 10000) for (const [key,bucket] of rateBuckets) if (now >= Number(bucket?.resetAt||0)) rateBuckets.delete(key);','rate bucket pressure')
p.write_text(s);print('patched security-core.js')
