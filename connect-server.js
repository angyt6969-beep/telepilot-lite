import http from "node:http";
import crypto from "node:crypto";
import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions/index.js";

const MAX_BODY = 8192;
const CONNECT_TTL_MS = 10 * 60_000;
const LOGIN_TTL_MS = 7 * 60_000;

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function html(res, status, body, nonce) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(a || "") || !/^[a-f0-9]{64}$/i.test(b || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function cleanPhone(value) {
  const phone = String(value || "").trim().replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) return null;
  return phone;
}

function humanizeAuthError(err) {
  const raw = String(err?.errorMessage || err?.message || "").toUpperCase();
  if (raw.includes("PHONE_CODE_INVALID")) return "That login code is incorrect. Try the newest code from Telegram.";
  if (raw.includes("PHONE_CODE_EXPIRED")) return "That login code expired. Start the login again.";
  if (raw.includes("PASSWORD_HASH_INVALID")) return "That 2-step verification password is incorrect.";
  if (raw.includes("PHONE_NUMBER_INVALID")) return "Telegram did not accept that phone number.";
  if (raw.includes("FLOOD")) return "Telegram temporarily limited login attempts. Please wait before trying again.";
  if (raw.includes("AUTH_USER_CANCEL")) return "Login cancelled.";
  return "Telegram could not complete that step. Please try again.";
}

function pageTemplate(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#111827">
  <title>TelePilot Connect</title>
  <style>
    :root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;background:linear-gradient(180deg,#0b1020,#111827 48%,#0b1020);color:#f8fafc;display:flex;align-items:center;justify-content:center;padding:24px}
    .wrap{width:min(100%,440px)} .brand{text-align:center;margin-bottom:20px}.logo{width:66px;height:66px;border-radius:22px;margin:0 auto 12px;background:linear-gradient(145deg,#60a5fa,#7c3aed);display:grid;place-items:center;font-size:34px;box-shadow:0 18px 45px #0007}.brand h1{margin:0;font-size:27px}.brand p{margin:7px 0 0;color:#94a3b8;font-size:14px}
    .card{background:#111827e8;border:1px solid #ffffff17;border-radius:24px;padding:22px;box-shadow:0 24px 70px #0008;backdrop-filter:blur(18px)}
    .step{display:none}.step.active{display:block} h2{font-size:21px;margin:0 0 8px}.sub{color:#aeb9ca;line-height:1.45;margin:0 0 18px;font-size:15px}
    label{display:block;font-size:13px;color:#cbd5e1;margin:0 0 8px}input{width:100%;font-size:18px;padding:15px 16px;border-radius:14px;border:1px solid #ffffff22;background:#070b14;color:#fff;outline:none}input:focus{border-color:#60a5fa;box-shadow:0 0 0 3px #60a5fa22}
    button{width:100%;border:0;border-radius:14px;padding:15px 16px;margin-top:13px;font-size:16px;font-weight:700;color:#fff;background:linear-gradient(90deg,#3b82f6,#7c3aed);cursor:pointer}button:disabled{opacity:.55;cursor:default}.secondary{background:#1e293b;color:#dbeafe}.status{min-height:21px;margin-top:12px;color:#fca5a5;font-size:14px;line-height:1.4}.hint{font-size:12px;color:#7f8da3;margin-top:14px;line-height:1.45}.ok{font-size:52px;margin-bottom:10px}.success{text-align:center}.success .sub{margin-bottom:6px}.pill{display:inline-block;margin-top:10px;border:1px solid #34d39955;background:#10b98118;color:#a7f3d0;padding:8px 12px;border-radius:999px;font-size:13px}
    .spinner{width:34px;height:34px;border:3px solid #ffffff20;border-top-color:#60a5fa;border-radius:50%;animation:s 1s linear infinite;margin:8px auto 18px}@keyframes s{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
<div class="wrap">
  <div class="brand"><div class="logo">✈️</div><h1>TelePilot Connect</h1><p>Secure Telegram account connection</p></div>
  <div class="card">
    <section id="phone" class="step active">
      <h2>Connect your Telegram</h2>
      <p class="sub">Enter the phone number on the Telegram account you want TelePilot to use.</p>
      <label for="phoneInput">Phone number</label>
      <input id="phoneInput" type="tel" autocomplete="tel" inputmode="tel" placeholder="+371 2XXXXXXX">
      <button id="phoneBtn">Continue</button>
      <div class="status" id="phoneStatus"></div>
      <div class="hint">Your login code and 2FA password are used only for this Telegram authorization attempt. TelePilot does not save those values.</div>
    </section>

    <section id="waiting" class="step"><div class="spinner"></div><h2 style="text-align:center">Connecting to Telegram…</h2><p class="sub" style="text-align:center">This normally takes a few seconds.</p></section>

    <section id="code" class="step">
      <h2>Enter your Telegram code</h2>
      <p class="sub" id="codeSub">Telegram sent a login code. Enter the newest code below.</p>
      <label for="codeInput">Login code</label>
      <input id="codeInput" type="text" autocomplete="one-time-code" inputmode="numeric" maxlength="12" placeholder="12345">
      <button id="codeBtn">Verify code</button><div class="status" id="codeStatus"></div>
    </section>

    <section id="password" class="step">
      <h2>2-step verification</h2><p class="sub" id="passwordSub">This Telegram account has an additional password.</p>
      <label for="passwordInput">Telegram 2FA password</label>
      <input id="passwordInput" type="password" autocomplete="current-password" placeholder="Password">
      <button id="passwordBtn">Continue</button><div class="status" id="passwordStatus"></div>
    </section>

    <section id="email" class="step">
      <h2>Email verification</h2><p class="sub">Telegram requires an email address before continuing this login.</p>
      <label for="emailInput">Email address</label>
      <input id="emailInput" type="email" autocomplete="email" placeholder="you@example.com">
      <button id="emailBtn">Continue</button><div class="status" id="emailStatus"></div>
    </section>

    <section id="email_code" class="step">
      <h2>Check your email</h2><p class="sub" id="emailCodeSub">Enter the verification code Telegram sent to your email.</p>
      <label for="emailCodeInput">Email code</label>
      <input id="emailCodeInput" type="text" autocomplete="one-time-code" inputmode="numeric" maxlength="16" placeholder="Code">
      <button id="emailCodeBtn">Verify email</button><div class="status" id="emailCodeStatus"></div>
    </section>

    <section id="done" class="step success"><div class="ok">✅</div><h2>Account connected</h2><p class="sub" id="doneText">You can return to TelePilot.</p><div class="pill">Session saved on your TelePilot service</div><button class="secondary" id="closeBtn">Return to Telegram</button></section>
    <section id="failed" class="step"><h2>Couldn’t connect</h2><p class="sub" id="failedText">Please try again.</p><button class="secondary" id="retryBtn">Try again</button></section>
  </div>
</div>
<script nonce="${nonce}">
const qs = new URLSearchParams(location.search);
const connect = { uid: qs.get('uid'), exp: qs.get('exp'), sig: qs.get('sig') };
let current = 'phone'; let pollTimer = null;
const $ = id => document.getElementById(id);
function show(id){ document.querySelectorAll('.step').forEach(x=>x.classList.remove('active')); $(id).classList.add('active'); current=id; }
async function post(url, body){ const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||'Request failed'); return j; }
function setBusy(btn,busy){btn.disabled=busy;}
function startPolling(){ if(pollTimer) clearInterval(pollTimer); pollTimer=setInterval(checkStatus,900); checkStatus(); }
async function checkStatus(){
  try{
    const r=await fetch('/api/login/status',{cache:'no-store'}); const s=await r.json();
    if(!r.ok) return;
    if(s.step==='code'){ show('code'); $('codeSub').textContent=s.viaApp?'Telegram sent the code inside your Telegram app. Enter the newest code below.':'Telegram sent a login code. Enter it below.'; if(s.error) $('codeStatus').textContent=s.error; }
    else if(s.step==='password'){ show('password'); $('passwordSub').textContent=s.hint?('This account has 2FA enabled. Hint: '+s.hint):'This Telegram account has 2-step verification enabled.'; if(s.error) $('passwordStatus').textContent=s.error; }
    else if(s.step==='email'){ show('email'); if(s.error) $('emailStatus').textContent=s.error; }
    else if(s.step==='email_code'){ show('email_code'); $('emailCodeSub').textContent=s.emailPattern?('Telegram sent a code to '+s.emailPattern+'.'):'Telegram sent a verification code to your email.'; if(s.error) $('emailCodeStatus').textContent=s.error; }
    else if(s.step==='done'){ clearInterval(pollTimer); show('done'); $('doneText').textContent=s.username?('Connected as @'+s.username+'. You can return to TelePilot.'):'Your Telegram account is connected. You can return to TelePilot.'; }
    else if(s.step==='failed'){ clearInterval(pollTimer); show('failed'); $('failedText').textContent=s.error||'Telegram could not complete the login.'; }
    else if(!['phone','waiting'].includes(current)) show('waiting');
  }catch{}
}
$('phoneBtn').onclick=async()=>{ const phone=$('phoneInput').value.trim(); $('phoneStatus').textContent=''; setBusy($('phoneBtn'),true); try{ await post('/api/login/start',{...connect,phone}); show('waiting'); startPolling(); }catch(e){ $('phoneStatus').textContent=e.message; } finally{setBusy($('phoneBtn'),false);} };
async function submit(kind,input,status,btn){ const value=$(input).value; $(status).textContent=''; setBusy($(btn),true); try{ await post('/api/login/input',{kind,value}); show('waiting'); }catch(e){ $(status).textContent=e.message; } finally{ if(kind!=='password') $(input).value=''; else $(input).value=''; setBusy($(btn),false); } }
$('codeBtn').onclick=()=>submit('code','codeInput','codeStatus','codeBtn');
$('passwordBtn').onclick=()=>submit('password','passwordInput','passwordStatus','passwordBtn');
$('emailBtn').onclick=()=>submit('email','emailInput','emailStatus','emailBtn');
$('emailCodeBtn').onclick=()=>submit('email_code','emailCodeInput','emailCodeStatus','emailCodeBtn');
$('retryBtn').onclick=()=>location.reload();
$('closeBtn').onclick=()=>{ location.href='tg://resolve?domain=TelePilottBot'; };
if(!connect.uid||!connect.exp||!connect.sig){ show('failed'); $('failedText').textContent='This TelePilot connection link is invalid. Open Account → Connect account again.'; }
</script>
</body></html>`;
}

export function createConnectService({ botToken, apiId, apiHash, sessionName, publicUrl, onConnected }) {
  const pending = new Map();

  function signature(uid, exp) {
    return crypto.createHmac("sha256", botToken).update(`${uid}.${exp}.telepilot-connect-v1`).digest("hex");
  }

  function makeConnectUrl(uid) {
    const exp = Date.now() + CONNECT_TTL_MS;
    const sig = signature(uid, exp);
    return `${publicUrl}/connect?uid=${encodeURIComponent(uid)}&exp=${exp}&sig=${sig}`;
  }

  function verifyConnect(uid, expRaw, sig) {
    const exp = Number(expRaw);
    if (!/^\d+$/.test(String(uid || "")) || !Number.isFinite(exp)) return false;
    if (Date.now() > exp || exp - Date.now() > CONNECT_TTL_MS + 30_000) return false;
    return safeEqualHex(signature(uid, exp), String(sig || ""));
  }

  function getLogin(req) {
    const id = parseCookies(req).tp_login;
    if (!id) return null;
    return pending.get(id) || null;
  }

  function waitForInput(login, kind, meta = {}) {
    login.step = kind;
    login.error = login.nextError || null;
    login.nextError = null;
    Object.assign(login, meta);
    return new Promise((resolve, reject) => {
      login.waiting = { kind, resolve, reject };
    });
  }

  function stopLogin(login, message) {
    if (login.finished) return;
    login.finished = true;
    login.step = "failed";
    login.error = message;
    if (login.waiting) {
      login.waiting.reject(new Error("AUTH_USER_CANCEL"));
      login.waiting = null;
    }
    void login.client.disconnect().catch(() => {});
  }

  async function startAuth(login, phone) {
    try {
      await login.client.start({
        phoneNumber: phone,
        phoneCode: async (viaApp) => waitForInput(login, "code", { viaApp: !!viaApp }),
        password: async (hint) => waitForInput(login, "password", { hint: hint || "" }),
        emailAddress: async () => waitForInput(login, "email"),
        emailVerification: async (options = {}) => {
          const code = await waitForInput(login, "email_code", { emailPattern: options.emailPattern || "" });
          return { type: "code", code };
        },
        firstAndLastNames: async () => { throw new Error("AUTH_USER_CANCEL"); },
        onError: async (err) => {
          const raw = String(err?.errorMessage || err?.message || "").toUpperCase();
          login.nextError = humanizeAuthError(err);
          if (raw.includes("FLOOD") || raw.includes("PHONE_CODE_EXPIRED") || raw.includes("AUTH_USER_CANCEL")) return true;
          return false;
        },
      });

      if (login.finished) return;
      const me = await login.client.getMe();
      login.finished = true;
      login.step = "done";
      login.username = me?.username || "";
      login.waiting = null;
      await onConnected(login.uid, login.client, me);
    } catch (err) {
      if (login.finished && login.step === "failed") return;
      login.finished = true;
      login.step = "failed";
      login.error = login.nextError || humanizeAuthError(err);
      login.waiting = null;
      try { await login.client.disconnect(); } catch {}
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", publicUrl);

      if (req.method === "GET" && url.pathname === "/") {
        return json(res, 200, { ok: true, service: "TelePilot Connect" });
      }

      if (req.method === "GET" && url.pathname === "/connect") {
        const uid = url.searchParams.get("uid");
        const exp = url.searchParams.get("exp");
        const sig = url.searchParams.get("sig");
        const nonce = crypto.randomBytes(18).toString("base64");
        if (!verifyConnect(uid, exp, sig)) return html(res, 403, pageTemplate(nonce), nonce);
        return html(res, 200, pageTemplate(nonce), nonce);
      }

      if (req.method === "POST" && url.pathname === "/api/login/start") {
        const body = await readJson(req);
        if (!verifyConnect(body.uid, body.exp, body.sig)) return json(res, 403, { error: "This connection link expired. Open TelePilot and try again." });
        const phone = cleanPhone(body.phone);
        if (!phone) return json(res, 400, { error: "Enter your phone number in international format, for example +371…" });

        for (const login of pending.values()) {
          if (String(login.uid) === String(body.uid) && !login.finished) stopLogin(login, "A newer login attempt was started.");
        }

        const id = crypto.randomBytes(32).toString("hex");
        const client = new TelegramClient(new StoreSession(sessionName), apiId, apiHash, { connectionRetries: 5 });
        const login = { id, uid: String(body.uid), client, step: "starting", error: null, nextError: null, waiting: null, finished: false, username: "", createdAt: Date.now() };
        pending.set(id, login);
        setTimeout(() => {
          if (!login.finished) stopLogin(login, "This login attempt expired. Start again from TelePilot.");
          setTimeout(() => pending.delete(id), 60_000);
        }, LOGIN_TTL_MS);
        void startAuth(login, phone);
        return json(res, 200, { ok: true }, { "set-cookie": `tp_login=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.ceil(LOGIN_TTL_MS / 1000)}` });
      }

      if (req.method === "GET" && url.pathname === "/api/login/status") {
        const login = getLogin(req);
        if (!login) return json(res, 404, { error: "No active login." });
        return json(res, 200, {
          step: login.step,
          error: login.error,
          viaApp: !!login.viaApp,
          hint: login.hint || "",
          emailPattern: login.emailPattern || "",
          username: login.username || "",
        });
      }

      if (req.method === "POST" && url.pathname === "/api/login/input") {
        const login = getLogin(req);
        if (!login || login.finished) return json(res, 409, { error: "This login is no longer active." });
        const body = await readJson(req);
        const kind = String(body.kind || "");
        const rawValue = String(body.value ?? "");
        const value = kind === "password" ? rawValue : rawValue.trim();
        if (!login.waiting || login.waiting.kind !== kind) return json(res, 409, { error: "Telegram is not waiting for that step yet." });
        if (!value || value.length > 256) return json(res, 400, { error: "Enter a valid value." });
        const { resolve } = login.waiting;
        login.waiting = null;
        login.step = "working";
        login.error = null;
        resolve(value);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "Not found" });
    } catch (err) {
      if (String(err?.message || "") === "REQUEST_TOO_LARGE") return json(res, 413, { error: "Request too large" });
      return json(res, 500, { error: "TelePilot Connect hit an unexpected error." });
    }
  });

  return {
    makeConnectUrl,
    listen(port) {
      server.listen(port, "0.0.0.0", () => console.log(`TelePilot Connect listening on port ${port}`));
    },
  };
}
