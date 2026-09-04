import http from "node:http";
import crypto from "node:crypto";
import { Api, TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions/index.js";

const MAX_BODY = 8192;
const LINK_TTL = 10 * 60_000;
const LOGIN_TTL = 7 * 60_000;
const FINISHED_TTL = 2 * 60_000;
const DEFAULT_RESEND_WAIT = 30;
const START_COOLDOWN_MS = 10_000;
const MAX_AUTO_FIREBASE_FALLBACKS = 2;
const COOKIE_NAME = "__Host-tp_login";
const BOT = "TelePilottBot";

function securityHeaders() {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
  };
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function html(res, status, content, nonce) {
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "text/html; charset=utf-8",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
  res.end(content);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[key] = ""; }
  }
  return out;
}

function setLoginCookie(id) {
  return `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.ceil(LOGIN_TTL / 1000)}`;
}
function clearLoginCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(a || "") || !/^[a-f0-9]{64}$/i.test(b || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function cleanPhone(value) {
  const number = String(value || "").trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : null;
}

function classKey(value) {
  return String(value?.className || value?.constructor?.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
function isType(value, suffix) {
  return classKey(value).endsWith(String(suffix).toLowerCase().replace(/[^a-z0-9]/g, ""));
}
function errorCode(error) {
  return String(error?.errorMessage || error?.message || "").toUpperCase();
}
function authCancelError() {
  return Object.assign(new Error("AUTH_USER_CANCEL"), { errorMessage: "AUTH_USER_CANCEL" });
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }

function friendlyError(error) {
  const e = errorCode(error);
  if (e.includes("PHONE_CODE_INVALID")) return "That code is incorrect. Use the newest code Telegram sent.";
  if (e.includes("PHONE_CODE_EXPIRED")) return "That code expired. Start a fresh login.";
  if (e.includes("PHONE_CODE_EMPTY")) return "Enter the login code Telegram sent.";
  if (e.includes("PASSWORD_HASH_INVALID")) return "That 2-step verification password is incorrect.";
  if (e.includes("PHONE_NUMBER_INVALID")) return "Telegram did not accept that phone number.";
  if (e.includes("PHONE_NUMBER_BANNED")) return "Telegram reports that this phone number is banned.";
  if (e.includes("PHONE_NUMBER_FLOOD") || e.includes("PHONE_PASSWORD_FLOOD")) return "Telegram temporarily blocked more login attempts for this account. Wait before trying again.";
  if (e.includes("API_ID_PUBLISHED_FLOOD")) return "Telegram has restricted this app's API credentials. TelePilot cannot start new logins until that is resolved.";
  if (e.includes("UPDATE_APP_TO_LOGIN")) return "Telegram requires a newer client authorization flow for this account. TelePilot cannot complete this login yet.";
  if (e.includes("SMS_CODE_CREATE_FAILED")) return "Telegram could not create an SMS login code for this number/provider. Try Telegram's next available method if offered.";
  if (e.includes("PHONE_NUMBER_APP_SIGNUP_FORBIDDEN")) return "Telegram requires this account to be created in the official Telegram app first.";
  if (e.includes("SEND_CODE_UNAVAILABLE")) return "Telegram has no additional code-delivery method available for this login.";
  if (e.includes("EMAIL_INVALID") || e.includes("EMAIL_NOT_ALLOWED")) return "Telegram did not accept that email address.";
  if (e.includes("EMAIL_VERIFY_EXPIRED")) return "That email verification code expired.";
  if (e.includes("CODE_INVALID") || e.includes("EMAIL_CODE_INVALID")) return "That email verification code is incorrect.";
  if (e.includes("FLOOD")) return "Telegram temporarily limited login attempts. Wait before trying again.";
  if (e.includes("RECAPTCHA_CHECK")) return "Telegram requires an additional reCAPTCHA check that this TelePilot login page cannot complete yet.";
  if (e.includes("AUTH_USER_CANCEL") || e.includes("QR LOGIN ABORTED")) return "Login cancelled.";
  return "Telegram could not complete that step. Please try again.";
}

function deliveryInfo(type) {
  const k = classKey(type);
  const length = Number(type?.length) || null;
  const numericPlaceholder = length ? "•".repeat(Math.min(length, 12)) : "12345";

  if (k.endsWith("sentcodetypeapp")) return { kind: "app", label: "Telegram app", instruction: "Telegram says it sent a login code to the Telegram service chat. If it does not arrive, use Telegram app approval below instead.", inputMode: "numeric", placeholder: numericPlaceholder };
  if (k.endsWith("sentcodetypesms")) return { kind: "sms", label: "SMS", instruction: "Telegram says the login code was sent by SMS.", inputMode: "numeric", placeholder: numericPlaceholder };
  if (k.endsWith("sentcodetypesmsword")) return { kind: "sms_word", label: "SMS word", instruction: "Telegram sent an SMS containing a word. Enter that word exactly.", inputMode: "text", placeholder: type?.beginning ? `${type.beginning}…` : "Secret word" };
  if (k.endsWith("sentcodetypesmsphrase")) return { kind: "sms_phrase", label: "SMS phrase", instruction: "Telegram sent an SMS containing a phrase. Enter the phrase exactly.", inputMode: "text", placeholder: type?.beginning ? `${type.beginning} …` : "Secret phrase" };
  if (k.endsWith("sentcodetypecall")) return { kind: "call", label: "Phone call", instruction: "Telegram will call this number and provide the login code.", inputMode: "numeric", placeholder: numericPlaceholder };
  if (k.endsWith("sentcodetypeflashcall")) return { kind: "flash_call", label: "Flash call", instruction: "Telegram selected flash-call verification. Follow the calling-number pattern Telegram provides.", inputMode: "tel", placeholder: type?.pattern || "Calling number" };
  if (k.endsWith("sentcodetypemissedcall")) return { kind: "missed_call", label: "Missed call", instruction: "Telegram will place a missed call. Enter the requested ending digits from the calling number.", inputMode: "numeric", placeholder: length ? "•".repeat(Math.min(length, 12)) : "Last digits" };
  if (k.endsWith("sentcodetypefragmentsms")) {
    const url = typeof type?.url === "string" && /^https:\/\//i.test(type.url) ? type.url : null;
    return { kind: "fragment", label: "Fragment", instruction: "Telegram sent this login code through Fragment. Open Fragment, then enter the code here.", inputMode: "numeric", placeholder: numericPlaceholder, fragmentUrl: url };
  }
  if (k.endsWith("sentcodetypeemailcode")) return { kind: "email", label: "Email", instruction: type?.emailPattern ? `Telegram sent a login code to ${type.emailPattern}.` : "Telegram sent the login code to the account's login email.", inputMode: "numeric", placeholder: numericPlaceholder };
  if (k.endsWith("sentcodetypesetupemailrequired")) return { kind: "email_setup", label: "Email setup", instruction: "Telegram requires a login email to be verified before it will send the phone login code.", inputMode: "email", placeholder: "you@example.com" };
  if (k.endsWith("sentcodetypefirebasesms")) return { kind: "firebase", label: "Firebase SMS", instruction: "Telegram selected Firebase-protected SMS, which third-party clients cannot complete directly.", inputMode: "numeric", placeholder: numericPlaceholder };
  return { kind: "unknown", label: "Unsupported verification", instruction: "Telegram selected a verification method this TelePilot version does not support yet.", inputMode: "text", placeholder: "Login code" };
}

function nextDeliveryLabel(nextType) {
  const k = classKey(nextType);
  if (!k) return null;
  if (k.endsWith("codetypesms")) return "Try SMS";
  if (k.endsWith("codetypecall")) return "Try phone call";
  if (k.endsWith("codetypeflashcall")) return "Try flash call";
  if (k.endsWith("codetypemissedcall")) return "Try missed call";
  if (k.endsWith("codetypefragmentsms")) return "Try Fragment";
  if (k.endsWith("codetypeemailcode")) return "Try email";
  return "Try another method";
}

function publicLoginStatus(login) {
  const resendAt = Number(login.resendAt || 0);
  const resendAfterSeconds = resendAt ? Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)) : 0;
  return {
    step: login.step,
    error: login.error,
    notice: login.notice,
    username: login.username || "",
    hint: login.hint || "",
    emailPattern: login.emailPattern || "",
    emailCodeLength: login.emailCodeLength || null,
    delivery: login.delivery || null,
    fragmentUrl: login.delivery?.fragmentUrl || null,
    canResend: !!login.nextType && login.step === "code" && !login.finished,
    canUseQr: login.step === "code" && !login.finished,
    resendAfterSeconds,
    resendLabel: nextDeliveryLabel(login.nextType),
    qrUrl: login.step === "qr" ? login.qrUrl || null : null,
    qrExpiresAt: login.step === "qr" ? login.qrExpiresAt || null : null,
    blockedReason: login.blockedReason || null,
  };
}

function page(nonce, linkValid = true) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b1020"><title>TelePilot Connect</title><style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(#0b1020,#111827,#0b1020);color:#f8fafc;display:grid;place-items:center;padding:24px}.w{width:min(100%,440px)}.brand{text-align:center;margin-bottom:18px}.logo{width:64px;height:64px;border-radius:21px;margin:auto;background:linear-gradient(145deg,#60a5fa,#7c3aed);display:grid;place-items:center;font-size:34px}.brand h1{margin:10px 0 3px}.brand p,.sub,.hint{color:#94a3b8}.card{background:#111827e8;border:1px solid #ffffff17;border-radius:24px;padding:22px;box-shadow:0 22px 70px #0007}.step{display:none}.active{display:block}.ey{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7f8da3}h2{margin:7px 0 8px;font-size:21px}.sub{line-height:1.45;margin:0 0 18px}input{width:100%;font-size:18px;padding:15px;border-radius:14px;border:1px solid #ffffff22;background:#070b14;color:white;outline:none}input:focus{border-color:#60a5fa;box-shadow:0 0 0 3px #60a5fa20}button{width:100%;border:0;border-radius:14px;padding:15px;margin-top:12px;font-size:16px;font-weight:700;color:white;background:linear-gradient(90deg,#3b82f6,#7c3aed)}button:disabled{opacity:.45}.secondary{background:#1e293b}.ghost{background:transparent;border:1px solid #ffffff17;color:#94a3b8}.err{min-height:20px;margin-top:10px;color:#fca5a5;font-size:14px;line-height:1.4}.note{min-height:20px;margin-top:10px;color:#93c5fd;font-size:13px;line-height:1.4}.hint{font-size:12px;margin-top:12px;line-height:1.4}.spin{width:34px;height:34px;border:3px solid #ffffff20;border-top-color:#60a5fa;border-radius:50%;animation:s 1s linear infinite;margin:10px auto 18px}@keyframes s{to{transform:rotate(360deg)}}.center{text-align:center}.pw{position:relative}.pw input{padding-right:72px}.show{position:absolute;right:7px;top:7px;width:auto;margin:0;padding:9px;background:#1e293b;font-size:13px}.delivery{display:flex;align-items:center;gap:10px;margin:0 0 14px;padding:11px 12px;border:1px solid #ffffff14;background:#0b1220;border-radius:13px}.dot{width:9px;height:9px;border-radius:50%;background:#60a5fa;box-shadow:0 0 16px #60a5fa}.delivery strong{font-size:14px}.delivery span{display:block;color:#94a3b8;font-size:12px;margin-top:2px}.link{display:none}.link.showlink{display:block}.divider{display:flex;align-items:center;gap:10px;color:#64748b;font-size:12px;margin:16px 0 4px}.divider:before,.divider:after{content:"";height:1px;flex:1;background:#ffffff14}.okbadge{width:48px;height:48px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;background:#16331f;font-size:26px}
</style></head><body><div class="w"><div class="brand"><div class="logo">✈️</div><h1>TelePilot Connect</h1><p>Connect your Telegram account</p></div><div class="card">
<section id="phone" class="step active"><div class="ey">Connect account</div><h2>Choose how to connect</h2><p class="sub">The easiest option uses Telegram's own login approval and does not need an SMS code.</p><button id="qrStartBtn">Open Telegram to approve</button><div class="divider">or use phone number</div><input id="phoneInput" type="tel" autocomplete="tel" inputmode="tel" placeholder="+___ __________"><button id="phoneBtn" class="secondary">Continue with phone number</button><div id="phoneErr" class="err"></div><div class="hint">Phone login uses the verification method Telegram chooses for that account.</div></section>
<section id="waiting" class="step center"><div class="spin"></div><h2>Talking to Telegram…</h2><p id="waitingText" class="sub">Preparing a secure Telegram login.</p><button class="ghost cancel">Cancel</button></section>
<section id="qr" class="step center"><div class="okbadge">✈️</div><div class="ey">Telegram approval</div><h2>Approve TelePilot in Telegram</h2><p id="qrText" class="sub">Tap below. Telegram will open and ask you to approve this new login. After approving, return here.</p><button id="qrOpenBtn" disabled>Preparing Telegram…</button><button class="ghost cancel">Cancel</button><div id="qrNote" class="note"></div><div id="qrErr" class="err"></div><div class="hint">This approval token is short-lived and is never stored in your TelePilot settings.</div></section>
<section id="code" class="step"><div class="ey">Step 2</div><h2>Verify your login</h2><div class="delivery"><div class="dot"></div><div><strong id="deliveryLabel">Telegram verification</strong><span id="deliverySmall">Delivery method selected by Telegram</span></div></div><p id="codeText" class="sub">Enter the newest code Telegram sends.</p><input id="codeInput" autocomplete="one-time-code" maxlength="96" placeholder="Login code"><button id="codeBtn">Verify code</button><button id="qrSwitchBtn" class="secondary link">Use Telegram app approval instead</button><button id="fragmentBtn" class="secondary link">Open Fragment</button><button id="resendBtn" class="secondary" disabled>Waiting for another method…</button><button class="ghost cancel">Cancel</button><div id="codeNote" class="note"></div><div id="codeErr" class="err"></div><div class="hint">TelePilot never stores the login code or your 2-step verification password in settings.</div></section>
<section id="password" class="step"><div class="ey">Security check</div><h2>2-step verification</h2><p id="pwText" class="sub">This Telegram account has 2-step verification enabled.</p><div class="pw"><input id="pwInput" type="password" autocomplete="off" placeholder="Password"><button id="showPw" class="show" type="button">Show</button></div><button id="pwBtn">Continue</button><button class="ghost cancel">Cancel</button><div id="pwErr" class="err"></div></section>
<section id="email" class="step"><div class="ey">Telegram security</div><h2>Set up login email</h2><p class="sub">Telegram requires an email verification step for this account before continuing.</p><input id="emailInput" type="email" autocomplete="email" placeholder="you@example.com"><button id="emailBtn">Continue</button><button class="ghost cancel">Cancel</button><div id="emailErr" class="err"></div></section>
<section id="email_code" class="step"><div class="ey">Telegram security</div><h2>Check your email</h2><p id="emailText" class="sub">Enter the verification code Telegram sent to your email.</p><input id="emailCodeInput" autocomplete="one-time-code" inputmode="numeric" maxlength="64" placeholder="Email code"><button id="emailCodeBtn">Verify email</button><button class="ghost cancel">Cancel</button><div id="emailCodeErr" class="err"></div></section>
<section id="done" class="step center"><div style="font-size:52px">✅</div><h2>Account connected</h2><p id="doneText" class="sub">You can return to TelePilot.</p><button id="returnBtn" class="secondary">Return to Telegram</button></section>
<section id="failed" class="step"><div class="ey">Telegram login</div><h2>Couldn’t complete this login</h2><p id="failText" class="sub">Please try again.</p><button id="retryBtn" class="secondary">Start a fresh login</button><button class="ghost back">Return to Telegram</button></section>
</div></div><script nonce="${nonce}">
const linkValid=${linkValid ? "true" : "false"},q=new URLSearchParams(location.search),auth={uid:q.get('uid'),exp:q.get('exp'),sig:q.get('sig')},$=id=>document.getElementById(id);let cur='phone',poll=null,resendTimer=null,fragmentUrl=null,qrUrl=null;
function show(id){document.querySelectorAll('.step').forEach(x=>x.classList.remove('active'));$(id).classList.add('active');cur=id}
async function post(url,data={}){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
function renderResend(s){clearInterval(resendTimer);const b=$('resendBtn');if(!s.canResend){b.disabled=true;b.textContent='No other code delivery method available';return}const end=Date.now()+Math.max(0,Number(s.resendAfterSeconds||0))*1000;const tick=()=>{const left=Math.max(0,Math.ceil((end-Date.now())/1000));b.disabled=left>0;b.textContent=left?((s.resendLabel||'Try another method')+' in '+left+'s'):(s.resendLabel||'Try another method');if(!left)clearInterval(resendTimer)};tick();resendTimer=setInterval(tick,500)}
async function status(){try{const r=await fetch('/api/login/status',{cache:'no-store'}),s=await r.json().catch(()=>({}));if(!r.ok){if(r.status===404){clearInterval(poll);show('failed');$('failText').textContent=s.error||'This login session expired. Start again from TelePilot.'}return}if(s.step==='qr'){show('qr');qrUrl=s.qrUrl||null;const b=$('qrOpenBtn');b.disabled=!qrUrl;b.textContent=qrUrl?'Open Telegram':'Preparing Telegram…';$('qrNote').textContent=s.notice||'Waiting for Telegram approval…';$('qrErr').textContent=s.error||''}else if(s.step==='code'){show('code');const d=s.delivery||{};$('deliveryLabel').textContent=d.label||'Telegram verification';$('deliverySmall').textContent='Selected by Telegram';$('codeText').textContent=d.instruction||'Enter the newest login code Telegram sends.';$('codeInput').inputMode=d.inputMode||'text';$('codeInput').placeholder=d.placeholder||'Login code';$('codeErr').textContent=s.error||'';$('codeNote').textContent=s.notice||'';fragmentUrl=s.fragmentUrl||null;$('fragmentBtn').classList.toggle('showlink',!!fragmentUrl);$('qrSwitchBtn').classList.toggle('showlink',!!s.canUseQr);renderResend(s)}else if(s.step==='password'){show('password');$('pwText').textContent=s.hint?('This account has 2-step verification enabled. Hint: '+s.hint):'This account has 2-step verification enabled.';$('pwErr').textContent=s.error||''}else if(s.step==='email'){show('email');$('emailErr').textContent=s.error||''}else if(s.step==='email_code'){show('email_code');$('emailText').textContent=s.emailPattern?('Telegram sent a verification code to '+s.emailPattern+'.'):'Enter the verification code Telegram sent to your login email.';$('emailCodeErr').textContent=s.error||''}else if(s.step==='done'){clearInterval(poll);clearInterval(resendTimer);show('done');$('doneText').textContent=s.username?('Connected as @'+s.username+'. You can return to TelePilot.'):'Your Telegram account is connected. You can return to TelePilot.'}else if(s.step==='failed'){clearInterval(poll);clearInterval(resendTimer);show('failed');$('failText').textContent=s.error||'Telegram could not complete this login.'}else{show('waiting');$('waitingText').textContent=s.notice||'Preparing a secure Telegram login.'}}catch{}}
function startPoll(){clearInterval(poll);poll=setInterval(status,900);status()}
async function startAttempt(url,data,errId){try{$(errId).textContent='';await post(url,data);show('waiting');startPoll()}catch(e){$(errId).textContent=e.message}}
$('qrStartBtn').onclick=async()=>{const b=$('qrStartBtn');if(b.disabled)return;b.disabled=true;await startAttempt('/api/login/qr/start',auth,'phoneErr');b.disabled=false};
$('phoneBtn').onclick=async()=>{const b=$('phoneBtn');if(b.disabled)return;b.disabled=true;await startAttempt('/api/login/start',{...auth,phone:$('phoneInput').value},'phoneErr');b.disabled=false};
async function send(kind,input,err){try{$(err).textContent='';await post('/api/login/input',{kind,value:$(input).value});$(input).value='';show('waiting')}catch(e){$(err).textContent=e.message}}
$('codeBtn').onclick=()=>send('code','codeInput','codeErr');$('pwBtn').onclick=()=>send('password','pwInput','pwErr');$('emailBtn').onclick=()=>send('email','emailInput','emailErr');$('emailCodeBtn').onclick=()=>send('email_code','emailCodeInput','emailCodeErr');
$('qrSwitchBtn').onclick=async()=>{const b=$('qrSwitchBtn');b.disabled=true;$('codeNote').textContent='Switching to Telegram app approval…';try{await post('/api/login/qr/switch');show('waiting')}catch(e){$('codeErr').textContent=e.message;b.disabled=false}};
$('qrOpenBtn').onclick=()=>{if(qrUrl)location.href=qrUrl};
$('resendBtn').onclick=async()=>{const b=$('resendBtn');b.disabled=true;$('codeNote').textContent='Asking Telegram for its next available delivery method…';try{await post('/api/login/resend');show('waiting')}catch(e){$('codeErr').textContent=e.message;status()}};
$('fragmentBtn').onclick=()=>{if(fragmentUrl)location.href=fragmentUrl};$('showPw').onclick=()=>{const i=$('pwInput'),x=i.type==='password';i.type=x?'text':'password';$('showPw').textContent=x?'Hide':'Show'};document.querySelectorAll('.cancel').forEach(b=>b.onclick=async()=>{try{await post('/api/login/cancel')}catch{}location.href='tg://resolve?domain=${BOT}'});document.querySelectorAll('.back').forEach(b=>b.onclick=()=>location.href='tg://resolve?domain=${BOT}');$('returnBtn').onclick=()=>location.href='tg://resolve?domain=${BOT}';$('retryBtn').onclick=()=>location.reload();document.addEventListener('visibilitychange',()=>{if(!document.hidden&&poll)status()});if(!linkValid||!auth.uid||!auth.exp||!auth.sig){show('failed');$('failText').textContent='This connection link is invalid or expired. Open Account → Connect account again.'}
</script></body></html>`;
}

export function createConnectService({ botToken, apiId, apiHash, getSessionName, publicUrl, onConnected }) {
  const pending = new Map();
  const lastStartByUid = new Map();
  let server = null;

  const signature = (uid, exp) => crypto.createHmac("sha256", botToken).update(`${uid}.${exp}.telepilot-connect-v5`).digest("hex");
  function makeConnectUrl(uid) {
    const exp = Date.now() + LINK_TTL;
    return `${publicUrl}/connect?uid=${encodeURIComponent(uid)}&exp=${exp}&sig=${signature(uid, exp)}`;
  }
  function verify(uid, expRaw, sig) {
    const exp = Number(expRaw);
    return /^\d+$/.test(String(uid || "")) && Number.isFinite(exp) && Date.now() <= exp && exp - Date.now() <= LINK_TTL + 30_000 && safeEqualHex(signature(uid, exp), String(sig || ""));
  }
  function loginFor(req) {
    const id = parseCookies(req)[COOKIE_NAME];
    return id ? pending.get(id) || null : null;
  }
  function hasActiveLogin(uid) {
    for (const login of pending.values()) if (!login.finished && String(login.uid) === String(uid)) return true;
    return false;
  }
  function setStep(login, step, meta = {}) {
    login.step = step;
    login.error = login.nextError || null;
    login.nextError = null;
    Object.assign(login, meta);
  }
  function waitForInput(login, kind, meta = {}) {
    if (login.finished) return Promise.reject(authCancelError());
    setStep(login, kind, meta);
    return new Promise((resolve, reject) => { login.waiting = { kind, resolve, reject }; });
  }
  function scheduleRemoval(login, ms = FINISHED_TTL) {
    if (login.expiryTimer) { clearTimeout(login.expiryTimer); login.expiryTimer = null; }
    if (login.removalTimer) clearTimeout(login.removalTimer);
    login.removalTimer = setTimeout(() => pending.delete(login.id), ms);
    login.removalTimer.unref?.();
  }
  async function cancelTelegramCode(login) {
    if (!login.phone || !login.phoneCodeHash) return;
    try {
      await login.client.invoke(new Api.auth.CancelCode({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash }));
    } catch (error) {
      const e = errorCode(error);
      if (!e.includes("PHONE_CODE_EXPIRED") && !e.includes("PHONE_CODE_HASH_EMPTY") && !e.includes("PHONE_CODE_INVALID") && !e.includes("AUTH_KEY_UNREGISTERED")) {
        console.warn(`TelePilot cancel-code warning user=${login.uid} error=${e || error?.message || "unknown"}`);
      }
    }
  }
  async function cleanupLogin(login, { cancelCode = true } = {}) {
    if (login.cleanupPromise) return login.cleanupPromise;
    login.cleanupPromise = (async () => {
      try { login.qrAbortController?.abort(); } catch {}
      if (cancelCode) await cancelTelegramCode(login);
      try { await login.client.disconnect(); } catch {}
    })();
    return login.cleanupPromise;
  }
  function markFailed(login, text, reason = null) {
    if (login.finished) return;
    login.finished = true;
    login.step = "failed";
    login.error = text;
    login.blockedReason = reason;
    login.notice = null;
    try { login.qrAbortController?.abort(); } catch {}
    if (login.waiting) {
      login.waiting.reject(authCancelError());
      login.waiting = null;
    }
    scheduleRemoval(login);
    void cleanupLogin(login, { cancelCode: true });
  }
  async function terminate(login, text = "Login cancelled.", reason = "cancelled") {
    if (!login.finished) {
      login.finished = true;
      login.step = "failed";
      login.error = text;
      login.blockedReason = reason;
      login.notice = null;
      try { login.qrAbortController?.abort(); } catch {}
      if (login.waiting) {
        login.waiting.reject(authCancelError());
        login.waiting = null;
      }
    }
    scheduleRemoval(login);
    await cleanupLogin(login, { cancelCode: true });
  }
  async function cancelUserLogins(uid) {
    const active = [...pending.values()].filter(login => !login.finished && String(login.uid) === String(uid));
    await Promise.allSettled(active.map(login => terminate(login, "Login cancelled.", "cancelled")));
  }
  function updateSentMeta(login, sent) {
    if (typeof sent?.phoneCodeHash === "string" && sent.phoneCodeHash) login.phoneCodeHash = sent.phoneCodeHash;
    login.nextType = sent?.nextType || null;
    login.delivery = deliveryInfo(sent?.type);
    const timeoutSeconds = Number(sent?.timeout);
    const waitSeconds = Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0 ? timeoutSeconds : DEFAULT_RESEND_WAIT;
    login.resendAt = Date.now() + waitSeconds * 1000;
    login.notice = null;
    console.log(`TelePilot login delivery user=${login.uid} type=${classKey(sent?.type) || "unknown"} next=${classKey(sent?.nextType) || "none"} timeout=${waitSeconds}s`);
  }
  async function invokeSendCode(login) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await login.client.invoke(new Api.auth.SendCode({ phoneNumber: login.phone, apiId, apiHash, settings: new Api.CodeSettings({}) }));
      } catch (error) {
        if (errorCode(error).includes("AUTH_RESTART") && attempt === 0) continue;
        throw error;
      }
    }
    throw new Error("Telegram could not start authorization.");
  }
  async function invokeResendCode(login) {
    if (!login.phoneCodeHash) throw new Error("Missing phone-code hash for resend.");
    return login.client.invoke(new Api.auth.ResendCode({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash }));
  }
  async function finish(login, user) {
    if (login.finished) return;
    login.finished = true;
    login.step = "done";
    login.waiting = null;
    login.error = null;
    login.notice = null;
    login.qrUrl = null;
    login.qrExpiresAt = null;
    login.username = user?.username || "";
    scheduleRemoval(login);
    try {
      await onConnected(login.uid, login.client, user);
    } catch (error) {
      console.error(`TelePilot onConnected error user=${login.uid}:`, error?.message || error);
    }
  }
  async function handlePassword(login) {
    try {
      const user = await login.client.signInWithPassword({ apiId, apiHash }, {
        password: async hint => String(await waitForInput(login, "password", { hint: hint || "" }) || ""),
        onError: async error => {
          const code = errorCode(error);
          if (code.includes("PASSWORD_HASH_INVALID")) { login.nextError = friendlyError(error); return false; }
          if (code.includes("FLOOD")) { markFailed(login, friendlyError(error), "flood"); return true; }
          if (code.includes("AUTH_USER_CANCEL")) return true;
          login.nextError = friendlyError(error);
          return false;
        },
      });
      if (!login.finished) await finish(login, user);
    } catch (error) {
      if (login.finished) return;
      throw error;
    }
  }
  async function runQrLogin(login) {
    try {
      await login.client.connect();
      if (login.finished) return;
      if (await login.client.checkAuthorization()) {
        const me = await login.client.getMe();
        await finish(login, me);
        return;
      }
      login.phoneCodeHash = "";
      login.nextType = null;
      login.delivery = null;
      login.resendAt = 0;
      login.qrAbortController = new AbortController();
      login.qrUrl = null;
      login.qrExpiresAt = null;
      login.step = "qr";
      login.error = null;
      login.notice = "Preparing Telegram approval…";
      console.log(`TelePilot QR login started user=${login.uid}`);
      const user = await login.client.signInUserWithQrCode({ apiId, apiHash }, {
        qrCode: async ({ token, expires }) => {
          if (login.finished) return;
          login.qrUrl = `tg://login?token=${Buffer.from(token).toString("base64url")}`;
          const exp = Number(expires);
          login.qrExpiresAt = Number.isFinite(exp) ? exp * 1000 : Date.now() + 30_000;
          login.step = "qr";
          login.error = null;
          login.notice = "Tap Open Telegram, approve the login there, then return to this page.";
          console.log(`TelePilot QR approval ready user=${login.uid}`);
        },
        password: async hint => String(await waitForInput(login, "password", { hint: hint || "" }) || ""),
        onError: async error => {
          if (login.finished) return true;
          const code = errorCode(error);
          if (code.includes("PASSWORD_HASH_INVALID")) { login.nextError = friendlyError(error); return false; }
          if (code.includes("FLOOD")) { markFailed(login, friendlyError(error), "flood"); return true; }
          login.nextError = friendlyError(error);
          return false;
        },
        abortSignal: login.qrAbortController.signal,
      });
      if (!login.finished) await finish(login, user);
    } catch (error) {
      if (login.finished) return;
      if (error?.name === "AbortError") return;
      console.error(`TelePilot QR login failed user=${login.uid} error=${errorCode(error) || error?.message || "unknown"}`);
      markFailed(login, friendlyError(error), "qr_error");
    }
  }
  async function verifyEmailCode(login, meta = {}) {
    while (!login.finished) {
      const code = String(await waitForInput(login, "email_code", meta) || "").trim();
      if (!code) { login.nextError = "Enter the email verification code."; continue; }
      try {
        const result = await login.client.invoke(new Api.account.VerifyEmail({
          purpose: new Api.EmailVerifyPurposeLoginSetup({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash }),
          verification: new Api.EmailVerificationCode({ code }),
        }));
        if (!isType(result, "emailverifiedlogin")) throw new Error(`Unexpected email verification result: ${result?.className || "unknown"}`);
        return result.sentCode;
      } catch (error) {
        const e = errorCode(error);
        if (e.includes("CODE_INVALID") || e.includes("EMAIL_CODE_INVALID")) { login.nextError = friendlyError(error); continue; }
        throw error;
      }
    }
    return null;
  }
  async function handleEmailSetup(login) {
    while (!login.finished) {
      const email = String(await waitForInput(login, "email") || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) { login.nextError = "Enter a valid email address."; continue; }
      try {
        const sent = await login.client.invoke(new Api.account.SendVerifyEmailCode({
          purpose: new Api.EmailVerifyPurposeLoginSetup({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash }),
          email,
        }));
        login.emailPattern = sent?.emailPattern || "";
        login.emailCodeLength = Number(sent?.length) || null;
        return verifyEmailCode(login, { emailPattern: login.emailPattern, emailCodeLength: login.emailCodeLength });
      } catch (error) {
        const e = errorCode(error);
        if (e.includes("EMAIL_INVALID") || e.includes("EMAIL_NOT_ALLOWED")) { login.nextError = friendlyError(error); continue; }
        throw error;
      }
    }
    return null;
  }
  async function handleExistingEmail(login, type) {
    login.emailPattern = type?.emailPattern || "";
    login.emailCodeLength = Number(type?.length) || null;
    return verifyEmailCode(login, { emailPattern: login.emailPattern, emailCodeLength: login.emailCodeLength });
  }
  async function handlePhoneCode(login) {
    while (!login.finished) {
      const action = await waitForInput(login, "code", { delivery: login.delivery });
      if (action && typeof action === "object" && action.action === "qr") {
        await cancelTelegramCode(login);
        return runQrLogin(login);
      }
      if (action && typeof action === "object" && action.action === "resend") {
        try {
          login.notice = "Telegram is selecting the next available verification method…";
          const resent = await invokeResendCode(login);
          return processSentCode(login, resent);
        } catch (error) {
          const code = errorCode(error);
          login.nextError = friendlyError(error);
          if (code.includes("SEND_CODE_UNAVAILABLE")) {
            login.nextType = null;
            login.notice = "Telegram did not offer another code-delivery method. You can use Telegram app approval instead.";
            continue;
          }
          if (code.includes("FLOOD")) { login.nextType = null; continue; }
          throw error;
        }
      }
      const code = String(action?.value ?? action ?? "").trim();
      if (!code) { login.nextError = "Enter the login code Telegram sent."; continue; }
      try {
        const result = await login.client.invoke(new Api.auth.SignIn({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash, phoneCode: code }));
        if (isType(result, "authorizationsignuprequired")) {
          markFailed(login, "This phone number is not registered as an existing Telegram account. Create the account in the official Telegram app first.", "signup_required");
          return;
        }
        const user = result?.user;
        if (!user) throw new Error("Telegram authorization returned no user.");
        await finish(login, user);
        return;
      } catch (error) {
        const codeName = errorCode(error);
        if (codeName.includes("SESSION_PASSWORD_NEEDED")) { await handlePassword(login); return; }
        if (codeName.includes("PHONE_CODE_INVALID") || codeName.includes("PHONE_CODE_EMPTY")) { login.nextError = friendlyError(error); continue; }
        if (codeName.includes("PHONE_CODE_EXPIRED")) { markFailed(login, friendlyError(error), "code_expired"); return; }
        throw error;
      }
    }
  }
  async function processSentCode(login, sent) {
    if (!sent || login.finished) return;
    if (isType(sent, "sentcodesuccess")) {
      const user = sent?.authorization?.user;
      if (!user) throw new Error("Telegram returned authorization success without a user.");
      await finish(login, user);
      return;
    }
    if (isType(sent, "sentcodepaymentrequired")) {
      if (typeof sent?.phoneCodeHash === "string") login.phoneCodeHash = sent.phoneCodeHash;
      markFailed(login, "Telegram requires a paid phone-verification step for this number/provider. Start again and use Telegram app approval instead.", "payment_required");
      return;
    }
    if (!isType(sent, "sentcode")) {
      markFailed(login, `Telegram returned an unsupported authorization response (${sent?.className || "unknown"}).`, "unsupported_response");
      return;
    }

    updateSentMeta(login, sent);
    const delivery = login.delivery;
    if (delivery.kind === "unknown") {
      console.warn(`TelePilot unsupported delivery user=${login.uid} type=${classKey(sent?.type) || "unknown"}`);
      markFailed(login, "Telegram selected a verification method this TelePilot version does not support yet. Start again and use Telegram app approval instead.", "unsupported_delivery");
      return;
    }
    if (delivery.kind === "firebase") {
      if (!login.nextType || login.autoFirebaseFallbacks >= MAX_AUTO_FIREBASE_FALLBACKS) {
        login.notice = "Telegram selected Firebase-protected SMS with no usable code fallback. Use Telegram app approval instead.";
        return handlePhoneCode(login);
      }
      login.autoFirebaseFallbacks += 1;
      login.step = "waiting_fallback";
      const waitMs = Math.max(0, login.resendAt - Date.now());
      login.notice = `Telegram selected Firebase-only SMS. Waiting ${Math.ceil(waitMs / 1000)}s for Telegram's next allowed method…`;
      console.log(`TelePilot Firebase fallback user=${login.uid} attempt=${login.autoFirebaseFallbacks} wait=${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
      if (login.finished) return;
      try {
        login.notice = "Asking Telegram for its next available verification method…";
        const resent = await invokeResendCode(login);
        return processSentCode(login, resent);
      } catch (error) {
        if (errorCode(error).includes("SEND_CODE_UNAVAILABLE")) {
          login.nextType = null;
          login.notice = "Telegram did not provide another code-delivery method. Use Telegram app approval instead.";
          return handlePhoneCode(login);
        }
        throw error;
      }
    }
    if (delivery.kind === "email_setup") {
      const next = await handleEmailSetup(login);
      if (next) return processSentCode(login, next);
      return;
    }
    if (delivery.kind === "email") {
      const next = await handleExistingEmail(login, sent.type);
      if (next) return processSentCode(login, next);
      return;
    }
    return handlePhoneCode(login);
  }
  async function runLogin(login) {
    try {
      await login.client.connect();
      if (login.finished) return;
      if (await login.client.checkAuthorization()) {
        const me = await login.client.getMe();
        await finish(login, me);
        return;
      }
      login.notice = "Telegram is choosing the verification method for this account…";
      const sent = await invokeSendCode(login);
      await processSentCode(login, sent);
    } catch (error) {
      if (login.finished) return;
      const text = friendlyError(error);
      console.error(`TelePilot login failed user=${login.uid} error=${errorCode(error) || error?.message || "unknown"}`);
      markFailed(login, text, "telegram_error");
    }
  }
  function enforceStartCooldown(uid) {
    const now = Date.now();
    const lastStart = Number(lastStartByUid.get(uid) || 0);
    if (now - lastStart < START_COOLDOWN_MS) return Math.ceil((START_COOLDOWN_MS - (now - lastStart)) / 1000);
    lastStartByUid.set(uid, now);
    setTimeout(() => { if (lastStartByUid.get(uid) === now) lastStartByUid.delete(uid); }, START_COOLDOWN_MS + 1000).unref?.();
    return 0;
  }
  async function createLogin(uid, phone = "") {
    const old = [...pending.values()].filter(login => !login.finished && String(login.uid) === String(uid));
    await Promise.allSettled(old.map(login => terminate(login, "A newer login attempt was started.", "superseded")));
    const id = crypto.randomBytes(32).toString("hex");
    const sessionName = await getSessionName(uid);
    const client = new TelegramClient(new StoreSession(sessionName), apiId, apiHash, { connectionRetries: 5, floodSleepThreshold: 60 });
    const login = {
      id, uid, phone, client,
      step: "starting", error: null, nextError: null, notice: "Starting Telegram authorization…", waiting: null, finished: false,
      username: "", hint: "", emailPattern: "", emailCodeLength: null, phoneCodeHash: "", delivery: null, nextType: null, resendAt: 0,
      autoFirebaseFallbacks: 0, blockedReason: null, cleanupPromise: null, expiryTimer: null, removalTimer: null,
      qrAbortController: null, qrUrl: null, qrExpiresAt: null,
    };
    pending.set(id, login);
    login.expiryTimer = setTimeout(() => {
      if (!login.finished) void terminate(login, "This login attempt expired. Start again from TelePilot.", "expired");
      else scheduleRemoval(login);
    }, LOGIN_TTL);
    login.expiryTimer.unref?.();
    return login;
  }

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", publicUrl);
      if (req.method === "GET" && url.pathname === "/") return json(res, 200, { ok: true, service: "TelePilot Connect" });
      if (req.method === "GET" && url.pathname === "/favicon.ico") { res.writeHead(204, securityHeaders()); return res.end(); }
      if (req.method === "GET" && url.pathname === "/connect") {
        const uid = url.searchParams.get("uid"), exp = url.searchParams.get("exp"), sig = url.searchParams.get("sig"), nonce = crypto.randomBytes(18).toString("base64");
        const valid = verify(uid, exp, sig);
        return html(res, valid ? 200 : 403, page(nonce, valid), nonce);
      }
      if (req.method === "POST" && url.pathname === "/api/login/start") {
        const data = await readBody(req);
        if (!verify(data.uid, data.exp, data.sig)) return json(res, 403, { error: "This connection link expired. Open TelePilot and try again." });
        const number = cleanPhone(data.phone);
        if (!number) return json(res, 400, { error: "Enter your full phone number starting with + and the country code." });
        const uid = String(data.uid);
        const wait = enforceStartCooldown(uid);
        if (wait) return json(res, 429, { error: `Please wait ${wait} seconds before starting another login.` });
        const login = await createLogin(uid, number);
        void runLogin(login);
        return json(res, 200, { ok: true }, { "set-cookie": setLoginCookie(login.id) });
      }
      if (req.method === "POST" && url.pathname === "/api/login/qr/start") {
        const data = await readBody(req);
        if (!verify(data.uid, data.exp, data.sig)) return json(res, 403, { error: "This connection link expired. Open TelePilot and try again." });
        const uid = String(data.uid);
        const wait = enforceStartCooldown(uid);
        if (wait) return json(res, 429, { error: `Please wait ${wait} seconds before starting another login.` });
        const login = await createLogin(uid, "");
        void runQrLogin(login);
        return json(res, 200, { ok: true }, { "set-cookie": setLoginCookie(login.id) });
      }
      if (req.method === "GET" && url.pathname === "/api/login/status") {
        const login = loginFor(req);
        if (!login) return json(res, 404, { error: "No active login. Start again from TelePilot." });
        return json(res, 200, publicLoginStatus(login));
      }
      if (req.method === "POST" && url.pathname === "/api/login/qr/switch") {
        const login = loginFor(req);
        if (!login || login.finished) return json(res, 409, { error: "This login is no longer active." });
        if (!login.waiting || login.waiting.kind !== "code") return json(res, 409, { error: "Telegram is not waiting for a phone login code right now." });
        const { resolve } = login.waiting;
        login.waiting = null;
        login.step = "working";
        login.error = null;
        login.notice = "Switching to Telegram app approval…";
        resolve({ action: "qr" });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/login/resend") {
        const login = loginFor(req);
        if (!login || login.finished) return json(res, 409, { error: "This login is no longer active." });
        if (!login.waiting || login.waiting.kind !== "code") return json(res, 409, { error: "Telegram is not waiting for a phone login code right now." });
        if (!login.nextType) return json(res, 409, { error: "Telegram did not offer another code-delivery method. Use Telegram app approval instead." });
        const remaining = Math.max(0, Number(login.resendAt || 0) - Date.now());
        if (remaining > 0) return json(res, 429, { error: `Please wait ${Math.ceil(remaining / 1000)} more seconds before trying the next method.` });
        const { resolve } = login.waiting;
        login.waiting = null;
        login.step = "working";
        login.error = null;
        login.notice = "Asking Telegram for its next available verification method…";
        resolve({ action: "resend" });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/login/input") {
        const login = loginFor(req);
        if (!login || login.finished) return json(res, 409, { error: "This login is no longer active." });
        const data = await readBody(req), kind = String(data.kind || ""), raw = String(data.value ?? ""), value = kind === "password" ? raw : raw.trim();
        if (!login.waiting || login.waiting.kind !== kind) return json(res, 409, { error: "Telegram is not waiting for that step right now." });
        if (!value || value.length > 256) return json(res, 400, { error: "Enter a valid value." });
        const { resolve } = login.waiting;
        login.waiting = null;
        login.step = "working";
        login.error = null;
        login.notice = "Checking with Telegram…";
        resolve(kind === "code" ? { action: "code", value } : value);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/login/cancel") {
        const login = loginFor(req);
        if (login && !login.finished) await terminate(login, "Login cancelled.", "cancelled");
        return json(res, 200, { ok: true }, { "set-cookie": clearLoginCookie() });
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      console.error("TelePilot web service error:", error?.message || error);
      if (String(error?.message || "") === "REQUEST_TOO_LARGE") return json(res, 413, { error: "Request too large" });
      if (String(error?.message || "") === "INVALID_JSON") return json(res, 400, { error: "Invalid request body" });
      return json(res, 500, { error: "TelePilot hit an unexpected error." });
    }
  });

  async function close() {
    await Promise.allSettled([...pending.values()].filter(login => !login.finished).map(login => terminate(login, "TelePilot is restarting. Open a fresh connection link afterward.", "shutdown")));
    if (!server?.listening) return;
    await new Promise(resolve => {
      let done = false;
      const finishClose = () => { if (done) return; done = true; clearTimeout(forceTimer); resolve(); };
      const forceTimer = setTimeout(() => { try { server.closeAllConnections?.(); } catch {} finishClose(); }, 3000);
      server.close(finishClose);
    });
  }

  return {
    makeConnectUrl,
    hasActiveLogin,
    cancelUserLogins,
    listen(port) { server.listen(port, "0.0.0.0", () => console.log(`TelePilot Connect listening on port ${port}`)); },
    close,
  };
}
