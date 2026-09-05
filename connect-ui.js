import http from "node:http";

const CONNECT_TITLE = "<title>TelePilot Connect</title>";

const PREMIUM_STYLE = `<style>
:root{
  color-scheme:dark;
  --bg:#05080d;
  --panel:#111820;
  --panel-soft:#17212b;
  --card:rgba(12,18,27,.78);
  --card-border:rgba(255,255,255,.10);
  --text:#f5f8fc;
  --muted:#93a2b5;
  --muted-2:#6f8094;
  --blue:#2aabee;
  --blue-2:#1687ff;
  --cyan:#49d8ff;
  --danger:#ff8e9a;
  --success:#7de8ad;
}
*{box-sizing:border-box}
html,body{min-height:100%;margin:0}
body{
  background:
    radial-gradient(circle at 50% -20%,rgba(36,104,173,.16),transparent 40%),
    var(--bg);
  color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  min-height:100svh;
  display:grid;
  place-items:center;
  padding:clamp(18px,4vw,42px);
  overflow-x:hidden;
}
.ambient-panel{
  position:fixed;
  inset:clamp(14px,3.3vw,34px);
  border-radius:clamp(28px,5vw,54px);
  overflow:hidden;
  pointer-events:none;
  background:
    linear-gradient(145deg,rgba(255,255,255,.035),rgba(255,255,255,.008) 55%,rgba(42,171,238,.035)),
    #10151c;
  border:1px solid rgba(255,255,255,.055);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.04),
    0 28px 90px rgba(0,0,0,.42);
}
.ambient-panel::before{
  content:"";
  position:absolute;
  inset:0;
  opacity:.28;
  background-image:radial-gradient(circle,rgba(184,211,238,.48) 1px,transparent 1.35px);
  background-size:19px 19px;
  -webkit-mask-image:
    radial-gradient(ellipse 46% 36% at 80% 24%,#000 0 44%,transparent 76%),
    radial-gradient(ellipse 43% 35% at 18% 77%,#000 0 42%,transparent 76%);
  mask-image:
    radial-gradient(ellipse 46% 36% at 80% 24%,#000 0 44%,transparent 76%),
    radial-gradient(ellipse 43% 35% at 18% 77%,#000 0 42%,transparent 76%);
}
.glow{
  position:absolute;
  width:min(66vw,760px);
  aspect-ratio:1;
  border-radius:50%;
  filter:blur(74px);
  opacity:.48;
  will-change:transform;
}
.glow-a{
  left:-18%;
  top:-30%;
  background:radial-gradient(circle,rgba(35,139,255,.78) 0,rgba(42,171,238,.27) 36%,transparent 68%);
  animation:driftA 14s ease-in-out infinite alternate;
}
.glow-b{
  right:-22%;
  bottom:-34%;
  background:radial-gradient(circle,rgba(73,216,255,.60) 0,rgba(20,96,220,.26) 40%,transparent 69%);
  animation:driftB 17s ease-in-out infinite alternate;
}
.glow-c{
  left:38%;
  top:28%;
  width:min(38vw,440px);
  opacity:.25;
  background:radial-gradient(circle,rgba(68,122,255,.72),transparent 67%);
  animation:driftC 20s ease-in-out infinite alternate;
}
@keyframes driftA{
  from{transform:translate3d(-2%,-3%,0) scale(.92)}
  to{transform:translate3d(43%,32%,0) scale(1.16)}
}
@keyframes driftB{
  from{transform:translate3d(2%,4%,0) scale(1.08)}
  to{transform:translate3d(-45%,-28%,0) scale(.91)}
}
@keyframes driftC{
  from{transform:translate3d(-16%,18%,0) scale(.86)}
  to{transform:translate3d(20%,-25%,0) scale(1.22)}
}
.shell{
  position:relative;
  z-index:2;
  width:min(460px,100%);
}
.brand{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:12px;
  margin:0 0 18px;
  color:rgba(245,248,252,.92);
  font-weight:700;
  letter-spacing:-.02em;
}
.brand-mark{
  width:40px;
  height:40px;
  border-radius:13px;
  display:grid;
  place-items:center;
  font-size:20px;
  background:linear-gradient(145deg,rgba(42,171,238,.24),rgba(22,135,255,.10));
  border:1px solid rgba(91,200,255,.24);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 8px 24px rgba(0,121,255,.13);
}
.card{
  width:100%;
  position:relative;
  overflow:hidden;
  border-radius:28px;
  padding:clamp(24px,5vw,34px);
  background:
    linear-gradient(155deg,rgba(255,255,255,.055),rgba(255,255,255,.012) 38%),
    var(--card);
  border:1px solid var(--card-border);
  box-shadow:
    0 32px 90px rgba(0,0,0,.46),
    inset 0 1px 0 rgba(255,255,255,.065);
  backdrop-filter:blur(22px) saturate(120%);
  -webkit-backdrop-filter:blur(22px) saturate(120%);
}
.card::before{
  content:"";
  position:absolute;
  left:12%;
  right:12%;
  top:0;
  height:1px;
  background:linear-gradient(90deg,transparent,rgba(105,208,255,.72),transparent);
  opacity:.52;
}
.eyebrow{
  display:inline-flex;
  align-items:center;
  gap:7px;
  min-height:28px;
  padding:5px 10px;
  border-radius:999px;
  background:rgba(42,171,238,.08);
  border:1px solid rgba(76,188,255,.14);
  color:#a9dfff;
  font-size:12px;
  font-weight:650;
  letter-spacing:.01em;
  margin-bottom:15px;
}
.secure-dot{
  width:6px;
  height:6px;
  border-radius:50%;
  background:#56d6ff;
  box-shadow:0 0 14px rgba(86,214,255,.8);
}
h1{
  margin:0;
  font-size:clamp(28px,7vw,36px);
  line-height:1.06;
  letter-spacing:-.04em;
  font-weight:740;
}
.subtitle{
  margin:13px 0 0;
  color:var(--muted);
  font-size:15px;
  line-height:1.58;
}
.status{
  position:relative;
  margin:24px 0 20px;
  padding:14px 15px 14px 42px;
  min-height:48px;
  display:flex;
  align-items:center;
  border-radius:15px;
  color:#cbd7e5;
  font-size:14px;
  line-height:1.45;
  background:rgba(3,8,14,.44);
  border:1px solid rgba(255,255,255,.065);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.025);
}
.status::before{
  content:"";
  position:absolute;
  left:17px;
  width:9px;
  height:9px;
  border-radius:50%;
  background:var(--blue);
  box-shadow:0 0 0 5px rgba(42,171,238,.10),0 0 16px rgba(42,171,238,.52);
  animation:pulse 2.2s ease-in-out infinite;
}
@keyframes pulse{50%{opacity:.48;transform:scale(.83)}}
form{margin-top:4px}
label{
  display:block;
  margin:0 0 8px 2px;
  color:#dce5ef;
  font-size:13px;
  font-weight:640;
}
input{
  width:100%;
  height:54px;
  padding:0 16px;
  margin:0 0 12px;
  border-radius:15px;
  border:1px solid rgba(139,177,214,.20);
  background:rgba(3,8,14,.54);
  color:#fff;
  outline:none;
  font:inherit;
  font-size:17px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.025);
  transition:border-color .18s ease,box-shadow .18s ease,background .18s ease;
}
input::placeholder{color:#607186}
input:focus{
  border-color:rgba(58,183,255,.68);
  background:rgba(3,10,18,.72);
  box-shadow:0 0 0 4px rgba(42,171,238,.10),0 10px 30px rgba(0,111,230,.08);
}
button{
  width:100%;
  height:52px;
  border:0;
  border-radius:15px;
  margin-top:2px;
  color:#fff;
  font:inherit;
  font-size:15px;
  font-weight:720;
  letter-spacing:-.01em;
  cursor:pointer;
  background:linear-gradient(135deg,#2aabee,#177dff);
  box-shadow:0 12px 28px rgba(16,130,255,.24),inset 0 1px 0 rgba(255,255,255,.22);
  transition:transform .15s ease,filter .15s ease,box-shadow .15s ease;
}
button:hover{filter:brightness(1.06);box-shadow:0 14px 32px rgba(16,130,255,.30),inset 0 1px 0 rgba(255,255,255,.25)}
button:active{transform:translateY(1px) scale(.995)}
button:disabled{opacity:.55;cursor:wait;transform:none}
.error{
  min-height:0;
  margin-top:12px;
  color:var(--danger);
  font-size:13px;
  line-height:1.45;
}
.error:empty{display:none}
.ok{color:var(--success);font-weight:620}
.hidden{display:none!important}
.security-note{
  display:flex;
  gap:10px;
  align-items:flex-start;
  margin-top:20px;
  padding-top:18px;
  border-top:1px solid rgba(255,255,255,.06);
  color:var(--muted-2);
  font-size:12px;
  line-height:1.5;
}
.lock{
  flex:0 0 auto;
  width:25px;
  height:25px;
  border-radius:8px;
  display:grid;
  place-items:center;
  background:rgba(42,171,238,.075);
  color:#9edcff;
  font-size:12px;
}
.footer{
  margin-top:15px;
  text-align:center;
  color:#566779;
  font-size:11px;
  letter-spacing:.015em;
}
@media(max-width:560px){
  body{padding:14px}
  .ambient-panel{inset:9px;border-radius:30px}
  .shell{width:min(100%,430px)}
  .brand{margin-bottom:13px}
  .card{border-radius:24px;padding:24px 20px}
  .glow{filter:blur(54px);opacity:.45}
}
@media(prefers-reduced-motion:reduce){
  .glow,.status::before{animation:none!important}
  button,input{transition:none}
}
</style>`;

const PREMIUM_BODY = `<body>
<div class="ambient-panel" aria-hidden="true">
  <div class="glow glow-a"></div>
  <div class="glow glow-b"></div>
  <div class="glow glow-c"></div>
</div>
<main class="shell">
  <div class="brand"><div class="brand-mark">✈️</div><span>TelePilot</span></div>
  <section class="card">
    <div class="eyebrow"><span class="secure-dot"></span> Secure account connection</div>
    <h1>Connect Telegram</h1>
    <p class="subtitle">Finish linking your personal Telegram account to TelePilot. Your login code and 2FA password are entered only on this secure connection page — never in bot chat.</p>
    <div id="status" class="status" role="status" aria-live="polite">Checking login…</div>
    <form id="codeForm" class="hidden" autocomplete="off">
      <label for="code">Telegram login code</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Enter your code" aria-label="Telegram login code">
      <button type="submit">Continue securely</button>
    </form>
    <form id="passwordForm" class="hidden" autocomplete="off">
      <label for="password">2-Step Verification password</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="Enter your password" aria-label="Telegram 2FA password">
      <button type="submit">Connect account</button>
    </form>
    <div id="error" class="error" role="alert" aria-live="assertive"></div>
    <div class="security-note"><span class="lock">🔒</span><span>This link expires automatically. TelePilot stores the resulting encrypted Telegram session, not your login code or 2FA password.</span></div>
  </section>
  <div class="footer">TELEPILOT • SECURE CONNECTION</div>
</main>`;

function transformConnectPage(html) {
  const source = String(html || "");
  if (!source.includes(CONNECT_TITLE)) return source;

  const withStyle = source.replace(/<style>[\s\S]*?<\/style>/i, PREMIUM_STYLE);
  return withStyle.replace(/<body><main class="card">[\s\S]*?<\/main>/i, PREMIUM_BODY);
}

export function installConnectUi() {
  if (http.__telepilotConnectUiInstalled) return;
  Object.defineProperty(http, "__telepilotConnectUiInstalled", { value: true });

  const originalCreateServer = http.createServer.bind(http);
  http.createServer = function createTelePilotServer(...args) {
    const listenerIndex = args.findIndex(arg => typeof arg === "function");
    if (listenerIndex < 0) return originalCreateServer(...args);

    const listener = args[listenerIndex];
    args[listenerIndex] = function telePilotRequestListener(req, res) {
      let pathname = "";
      try { pathname = new URL(req.url || "/", "http://telepilot.local").pathname; } catch {}

      if (req.method === "GET" && pathname === "/connect") {
        const originalEnd = res.end.bind(res);
        res.end = function telePilotConnectEnd(chunk, encoding, callback) {
          if (chunk !== undefined && chunk !== null) {
            const body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
            const transformed = transformConnectPage(body);
            if (transformed !== body) chunk = transformed;
          }
          return originalEnd(chunk, encoding, callback);
        };
      }

      return listener(req, res);
    };

    return originalCreateServer(...args);
  };
}

export { transformConnectPage };
