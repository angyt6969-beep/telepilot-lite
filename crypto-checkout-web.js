import http from "node:http";
import { takeRateLimit, requestAddress } from "./security-core.js";
import { nowPaymentsConfigured } from "./nowpayments-client.js";
import { createCheckoutToken, readCheckoutToken, checkoutCookie, CHECKOUT_PLANS, CHECKOUT_CURRENCIES, findOrder } from "./crypto-checkout-store.js";
import { createPaymentOrder, refreshPaymentOrder, paymentAllowed, startPaymentWorker } from "./crypto-payment-service.js";
import { decryptIssuedKey } from "./payment-key-issuer.js";

const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
const SUPPORT_USERNAME = String(process.env.TELEPILOT_SUPPORT_USERNAME || "noahxrp").replace(/^@+/, "");
const PAYMENT_MODE = String(process.env.NOWPAYMENTS_MODE || "disabled").toLowerCase();

export function checkoutUrlForUid(uid, options = {}) {
  const base = String(options.publicUrl || PUBLIC_URL || "").replace(/\/$/, "");
  if (!base) return `https://t.me/${SUPPORT_USERNAME}`;
  return `${base}/checkout?t=${encodeURIComponent(createCheckoutToken(uid, options))}`;
}
function readCookies(req) {
  const out = {};
  for (const part of String(req.headers?.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}
function sessionFromRequest(req) { return readCheckoutToken(readCookies(req)["__Host-telepilot_checkout"] || ""); }
function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}
function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  });
  res.end(html);
}
async function readBody(req, max = 8192) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error("Request too large"); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function publicOrder(order) {
  if (!order) return null;
  const key = order.encryptedKey ? decryptIssuedKey(order.encryptedKey, order.id) : "";
  return {
    id: order.id, planId: order.planId, planLabel: order.planLabel, priceUsd: order.priceUsd,
    payCurrency: order.payCurrency, payAmount: order.payAmount, payAddress: order.payAddress,
    status: order.providerStatus, actuallyPaid: order.actuallyPaid || "", keySent: !!order.keySentAt,
    ...(key ? { key } : {}), error: order.lastError || "",
  };
}
function expiredPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TelePilot Checkout</title><style>body{margin:0;background:#05080d;color:#f5f8fc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.box{max-width:440px;background:#111820;border:1px solid #263545;border-radius:22px;padding:28px;box-shadow:0 24px 70px #0008}a{color:#49bfff}</style></head><body><div class="box"><h1>✈️ TelePilot Checkout</h1><p>This checkout link is missing or expired.</p><p>Open <a href="https://t.me/TelePilottBot">@TelePilottBot</a> and press <b>Get a Key</b> again, or message <a href="https://t.me/${SUPPORT_USERNAME}">@${SUPPORT_USERNAME}</a>.</p></div></body></html>`;
}
function checkoutPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>TelePilot Checkout</title><style>
:root{color-scheme:dark;--bg:#05080d;--card:rgba(12,18,27,.78);--text:#f5f8fc;--muted:#93a2b5;--muted2:#6f8094;--blue:#2aabee;--danger:#ff8e9a;--success:#7de8ad}*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{background:radial-gradient(circle at 50% -20%,rgba(36,104,173,.16),transparent 40%),var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;min-height:100svh;display:grid;place-items:center;padding:clamp(18px,4vw,42px);overflow-x:hidden}.ambient-panel{position:fixed;inset:clamp(14px,3.3vw,34px);border-radius:clamp(28px,5vw,54px);overflow:hidden;pointer-events:none;background:linear-gradient(145deg,rgba(255,255,255,.035),rgba(255,255,255,.008) 55%,rgba(42,171,238,.035)),#10151c;border:1px solid rgba(255,255,255,.055);box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 28px 90px rgba(0,0,0,.42)}.ambient-panel::before{content:"";position:absolute;inset:0;opacity:.28;background-image:radial-gradient(circle,rgba(184,211,238,.48) 1px,transparent 1.35px);background-size:19px 19px}.glow{position:absolute;width:min(66vw,760px);aspect-ratio:1;border-radius:50%;filter:blur(74px);opacity:.48}.a{left:-18%;top:-30%;background:radial-gradient(circle,rgba(35,139,255,.78),rgba(42,171,238,.27) 36%,transparent 68%);animation:a 14s ease-in-out infinite alternate}.b{right:-22%;bottom:-34%;background:radial-gradient(circle,rgba(73,216,255,.60),rgba(20,96,220,.26) 40%,transparent 69%);animation:b 17s ease-in-out infinite alternate}.c{left:38%;top:28%;width:min(38vw,440px);opacity:.25;background:radial-gradient(circle,rgba(68,122,255,.72),transparent 67%);animation:c 20s ease-in-out infinite alternate}@keyframes a{to{transform:translate3d(43%,32%,0) scale(1.16)}}@keyframes b{to{transform:translate3d(-45%,-28%,0) scale(.91)}}@keyframes c{to{transform:translate3d(20%,-25%,0) scale(1.22)}}.shell{position:relative;z-index:2;width:min(520px,100%)}.brand{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:18px;font-weight:700}.mark{width:40px;height:40px;border-radius:13px;display:grid;place-items:center;font-size:20px;background:linear-gradient(145deg,rgba(42,171,238,.24),rgba(22,135,255,.10));border:1px solid rgba(91,200,255,.24);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 8px 24px rgba(0,121,255,.13)}.card{position:relative;overflow:hidden;border-radius:28px;padding:clamp(24px,5vw,34px);background:linear-gradient(155deg,rgba(255,255,255,.055),rgba(255,255,255,.012) 38%),var(--card);border:1px solid rgba(255,255,255,.10);box-shadow:0 32px 90px rgba(0,0,0,.46),inset 0 1px 0 rgba(255,255,255,.065);backdrop-filter:blur(22px) saturate(120%)}.card:before{content:"";position:absolute;left:12%;right:12%;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(105,208,255,.72),transparent)}.eyebrow{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border-radius:999px;background:rgba(42,171,238,.08);border:1px solid rgba(76,188,255,.14);color:#a9dfff;font-size:12px;font-weight:650;margin-bottom:15px}.dot{width:6px;height:6px;border-radius:50%;background:#56d6ff;box-shadow:0 0 14px rgba(86,214,255,.8)}h1{margin:0;font-size:clamp(28px,7vw,36px);line-height:1.06;letter-spacing:-.04em}.sub{margin:13px 0 0;color:var(--muted);font-size:15px;line-height:1.58}.status{margin:22px 0 0;padding:14px 15px;border-radius:15px;color:#cbd7e5;font-size:14px;line-height:1.45;background:rgba(3,8,14,.44);border:1px solid rgba(255,255,255,.065)}.section{margin-top:22px}.label{display:block;margin:0 0 9px 2px;color:#dce5ef;font-size:13px;font-weight:640}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.opt{min-height:54px;padding:10px 12px;border-radius:15px;border:1px solid rgba(139,177,214,.17);background:rgba(3,8,14,.45);color:#dce5ef;text-align:left;cursor:pointer}.opt strong{display:block;font-size:14px}.opt span{display:block;margin-top:3px;font-size:12px;color:var(--muted)}.opt.active{border-color:rgba(58,183,255,.68);background:rgba(25,111,185,.18);box-shadow:0 0 0 3px rgba(42,171,238,.08)}.primary{width:100%;min-height:52px;border:0;border-radius:15px;margin-top:18px;color:#fff;font:inherit;font-size:15px;font-weight:720;cursor:pointer;background:linear-gradient(135deg,#2aabee,#177dff);box-shadow:0 12px 28px rgba(16,130,255,.24),inset 0 1px 0 rgba(255,255,255,.22)}.primary:disabled{opacity:.5}.payment{margin-top:18px;padding:16px;border-radius:17px;background:rgba(3,8,14,.48);border:1px solid rgba(255,255,255,.07)}.row{display:flex;justify-content:space-between;gap:16px;padding:6px 0;font-size:13px}.row span:first-child{color:var(--muted)}.value{font-weight:650;text-align:right;word-break:break-all}.copy{width:100%;margin-top:8px;min-height:40px;border-radius:12px;border:1px solid rgba(139,177,214,.17);background:rgba(255,255,255,.045);color:#dce5ef;font-weight:650}.ok{color:var(--success)}.error{color:var(--danger);font-size:13px;margin-top:12px}.manual{margin-top:20px;padding-top:18px;border-top:1px solid rgba(255,255,255,.06);text-align:center;color:var(--muted2);font-size:12px;line-height:1.5}.manual a{color:#9edcff;text-decoration:none;font-weight:650}.footer{margin-top:15px;text-align:center;color:#566779;font-size:11px}.hidden{display:none!important}@media(max-width:560px){body{padding:14px}.ambient-panel{inset:9px;border-radius:30px}.card{border-radius:24px;padding:24px 20px}.glow{filter:blur(54px)}}@media(prefers-reduced-motion:reduce){.glow{animation:none!important}}</style></head><body><div class="ambient-panel"><div class="glow a"></div><div class="glow b"></div><div class="glow c"></div></div><main class="shell"><div class="brand"><div class="mark">✈️</div><span>TelePilot</span></div><section class="card"><div class="eyebrow"><span class="dot"></span><span id="mode">Secure crypto checkout</span></div><h1>Get TelePilot access</h1><p class="sub">Choose a plan and pay with TON, SOL, ETH or BTC. After the payment is verified, your TelePilot key is generated and sent directly to you in Telegram.</p><div id="status" class="status">Loading checkout…</div><div id="picker" class="hidden"><div class="section"><span class="label">Choose your plan</span><div id="plans" class="grid"></div></div><div class="section"><span class="label">Pay with</span><div id="coins" class="grid"></div></div><button id="pay" class="primary" disabled>Create payment</button></div><div id="payment" class="payment hidden"></div><div id="error" class="error"></div><div class="manual">Prefer a manual purchase? <a href="https://t.me/${SUPPORT_USERNAME}">Message @${SUPPORT_USERNAME}</a> to get a key.</div></section><div class="footer">TELEPILOT • SECURE CHECKOUT</div></main><script>
const S=document.getElementById('status'),P=document.getElementById('picker'),PE=document.getElementById('plans'),CE=document.getElementById('coins'),B=document.getElementById('pay'),O=document.getElementById('payment'),E=document.getElementById('error'),M=document.getElementById('mode');let plan='',coin='',order='';function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function opt(label,sub,id,type){const b=document.createElement('button');b.type='button';b.className='opt';b.dataset.id=id;b.dataset.type=type;b.innerHTML='<strong>'+esc(label)+'</strong><span>'+esc(sub)+'</span>';b.onclick=()=>{if(type==='plan')plan=id;else coin=id;for(const x of document.querySelectorAll('.opt'))x.classList.toggle('active',(x.dataset.type==='plan'?plan:coin)===x.dataset.id);B.disabled=!plan||!coin};return b}async function load(){try{const r=await fetch('/checkout/session',{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Session expired.');if(d.mode==='sandbox')M.textContent='Sandbox test checkout';if(!d.allowed){S.textContent='Sandbox testing is limited to approved tester accounts.';return}if(!d.providerReady){S.textContent='Crypto checkout is being configured. You can still message @${SUPPORT_USERNAME} for a key.';return}S.textContent=d.mode==='sandbox'?'Sandbox ready — no real crypto will be moved.':'Secure checkout is ready.';d.plans.forEach(x=>PE.appendChild(opt(x.label,'$'+x.priceUsd,x.id,'plan')));d.currencies.forEach(x=>CE.appendChild(opt(x.label,'Crypto',x.id,'coin')));P.classList.remove('hidden')}catch(e){S.textContent='Checkout unavailable.';E.textContent=e.message}}B.onclick=async()=>{B.disabled=true;E.textContent='';S.textContent='Creating your payment…';try{const r=await fetch('/checkout/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({plan,currency:coin})}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not create payment.');order=d.order.id;show(d.order);poll()}catch(e){E.textContent=e.message;S.textContent='Payment could not be created.';B.disabled=false}};function copyButton(value,label){return '<button class="copy" data-value="'+esc(value)+'" data-label="'+esc(label)+'">'+esc(label)+'</button>'}function show(o){O.classList.remove('hidden');P.classList.add('hidden');S.innerHTML=o.status==='finished'?'<span class="ok">✅ Payment confirmed — your key is ready.</span>':'Payment status: '+esc(String(o.status||'waiting').replaceAll('_',' '));O.innerHTML='<div class="row"><span>Plan</span><span class="value">'+esc(o.planLabel)+'</span></div><div class="row"><span>Price</span><span class="value">$'+esc(o.priceUsd)+'</span></div><div class="row"><span>Send exactly</span><span class="value">'+esc(o.payAmount)+' '+esc(String(o.payCurrency||'').toUpperCase())+'</span></div>'+copyButton(o.payAmount,'Copy amount')+'<div class="row"><span>Address</span><span class="value">'+esc(o.payAddress)+'</span></div>'+copyButton(o.payAddress,'Copy address')+(o.key?'<div class="row"><span>TelePilot key</span><span class="value">'+esc(o.key)+'</span></div>'+copyButton(o.key,'Copy key'):'')+(o.keySent?'<div class="row"><span>Delivery</span><span class="value ok">Sent to Telegram</span></div>':'');for(const b of O.querySelectorAll('[data-value]'))b.onclick=()=>navigator.clipboard.writeText(b.dataset.value||'').then(()=>{const x=b.textContent;b.textContent='Copied ✓';setTimeout(()=>b.textContent=x,900)}).catch(()=>{})}async function poll(){if(!order)return;try{const r=await fetch('/checkout/order?id='+encodeURIComponent(order),{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not check payment.');show(d.order);if(!['finished','failed','refunded','expired'].includes(d.order.status))setTimeout(poll,3000)}catch(e){E.textContent=e.message;setTimeout(poll,5000)}}load();</script></body></html>`;
}

async function handle(req, res) {
  const url = new URL(req.url || "/", PUBLIC_URL || "http://telepilot.local");
  if (!url.pathname.startsWith("/checkout")) return false;
  if (req.method === "GET" && url.pathname === "/checkout") {
    const token = url.searchParams.get("t") || "";
    if (token) {
      if (!readCheckoutToken(token)) { sendHtml(res, 410, expiredPage()); return true; }
      res.writeHead(303, { location: "/checkout", "set-cookie": checkoutCookie(token), "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end(); return true;
    }
    const session = sessionFromRequest(req);
    sendHtml(res, session ? 200 : 401, session ? checkoutPage() : expiredPage()); return true;
  }
  const session = sessionFromRequest(req);
  if (!session) { sendJson(res, 401, { error: "Checkout session expired. Open Get a Key in TelePilot again." }); return true; }
  if (req.method === "GET" && url.pathname === "/checkout/session") {
    sendJson(res, 200, { mode: PAYMENT_MODE, providerReady: nowPaymentsConfigured(), allowed: paymentAllowed(session.uid), plans: Object.values(CHECKOUT_PLANS).map(({id,label,priceUsd})=>({id,label,priceUsd})), currencies: Object.values(CHECKOUT_CURRENCIES).map(({id,label})=>({id,label})) }); return true;
  }
  if (req.method === "POST" && url.pathname === "/checkout/create") {
    const a = takeRateLimit("checkout-ip", requestAddress(req), 20, 10*60_000), b = takeRateLimit("checkout-user", session.uid, 10, 10*60_000);
    if (!a.ok || !b.ok) { sendJson(res, 429, { error: "Too many checkout attempts. Try again later." }); return true; }
    try { const body = await readBody(req); const order = await createPaymentOrder(session.uid, body.plan, body.currency); sendJson(res, 200, { order: publicOrder(order) }); }
    catch (err) { sendJson(res, 502, { error: String(err?.message || "Could not create payment") }); }
    return true;
  }
  if (req.method === "GET" && url.pathname === "/checkout/order") {
    const id = String(url.searchParams.get("id") || ""); let order = findOrder(id);
    if (!order || String(order.uid) !== session.uid) { sendJson(res, 404, { error: "Payment order not found." }); return true; }
    order = await refreshPaymentOrder(id).catch(()=>findOrder(id)||order); sendJson(res, 200, { order: publicOrder(order) }); return true;
  }
  sendJson(res, 404, { error: "not found" }); return true;
}

export function installCryptoCheckoutWeb() {
  if (http.__telepilotCryptoCheckoutWebInstalled) return false;
  Object.defineProperty(http, "__telepilotCryptoCheckoutWebInstalled", { value: true });
  const previousCreateServer = http.createServer.bind(http);
  http.createServer = function(...args) {
    const i = args.findIndex(x => typeof x === "function");
    if (i < 0) return previousCreateServer(...args);
    const listener = args[i];
    args[i] = async function(req,res){ try { if (await handle(req,res)) return; } catch(err){ console.warn("TelePilot checkout HTTP error:",err?.message||err); if(!res.headersSent)return sendJson(res,500,{error:"Checkout request failed."}); try{res.end()}catch{} return; } return listener(req,res); };
    return previousCreateServer(...args);
  };
  startPaymentWorker();
  return true;
}
