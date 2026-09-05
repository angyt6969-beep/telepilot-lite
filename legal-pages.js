import http from "node:http";

const SUPPORT_USERNAME = String(process.env.TELEPILOT_SUPPORT_USERNAME || "noahxrp").replace(/^@+/, "");
const SUPPORT_URL = `https://t.me/${SUPPORT_USERNAME}`;
const LAST_UPDATED = "5 September 2026";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root{color-scheme:dark;--bg:#05080d;--card:rgba(12,18,27,.82);--border:rgba(255,255,255,.09);--text:#f5f8fc;--muted:#9aaabd;--blue:#2aabee;--cyan:#49d8ff}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{min-height:100svh;background:#05080d;color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;padding:clamp(16px,4vw,44px);overflow-x:hidden}
.ambient{position:fixed;inset:clamp(10px,3vw,32px);overflow:hidden;border-radius:clamp(28px,5vw,54px);pointer-events:none;background:linear-gradient(145deg,rgba(255,255,255,.032),rgba(255,255,255,.008) 58%,rgba(42,171,238,.035)),#10151c;border:1px solid rgba(255,255,255,.055);box-shadow:0 28px 90px rgba(0,0,0,.42)}
.ambient:before{content:"";position:absolute;inset:0;opacity:.24;background-image:radial-gradient(circle,rgba(184,211,238,.45) 1px,transparent 1.35px);background-size:19px 19px;mask-image:radial-gradient(ellipse 54% 42% at 78% 23%,#000 0 42%,transparent 76%)}
.glow{position:absolute;width:min(68vw,780px);aspect-ratio:1;border-radius:50%;filter:blur(78px);opacity:.42;will-change:transform}.a{left:-18%;top:-34%;background:radial-gradient(circle,rgba(35,139,255,.78),rgba(42,171,238,.24) 38%,transparent 68%);animation:a 15s ease-in-out infinite alternate}.b{right:-22%;bottom:-36%;background:radial-gradient(circle,rgba(73,216,255,.56),rgba(20,96,220,.24) 40%,transparent 69%);animation:b 19s ease-in-out infinite alternate}@keyframes a{to{transform:translate3d(42%,30%,0) scale(1.15)}}@keyframes b{to{transform:translate3d(-43%,-27%,0) scale(.92)}}
.wrap{position:relative;z-index:2;width:min(880px,100%);margin:0 auto}.brand{display:flex;align-items:center;gap:11px;margin:8px 0 20px;font-weight:750;letter-spacing:-.02em}.mark{width:39px;height:39px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(145deg,rgba(42,171,238,.24),rgba(22,135,255,.10));border:1px solid rgba(91,200,255,.24)}
.card{background:linear-gradient(155deg,rgba(255,255,255,.05),rgba(255,255,255,.01) 42%),var(--card);border:1px solid var(--border);border-radius:28px;padding:clamp(24px,5vw,48px);box-shadow:0 32px 90px rgba(0,0,0,.43);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px)}
.badge{display:inline-flex;padding:6px 10px;border-radius:999px;background:rgba(42,171,238,.08);border:1px solid rgba(76,188,255,.14);color:#a9dfff;font-size:12px;font-weight:700;margin-bottom:16px}h1{font-size:clamp(31px,7vw,48px);line-height:1.02;letter-spacing:-.045em;margin:0 0 12px}h2{font-size:19px;margin:30px 0 9px;letter-spacing:-.02em}p,li{color:var(--muted);line-height:1.65;font-size:15px}p{margin:9px 0}ul{padding-left:22px;margin:9px 0}a{color:#8bdcff;text-decoration:none}a:hover{text-decoration:underline}.lead{font-size:16px;color:#c6d2df;max-width:720px}.notice{margin:24px 0;padding:15px 17px;border-radius:16px;background:rgba(42,171,238,.07);border:1px solid rgba(73,216,255,.12);color:#b9d5e8}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:25px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:13px;background:linear-gradient(135deg,#2aabee,#177dff);color:white;font-weight:720;text-decoration:none;box-shadow:0 10px 24px rgba(16,130,255,.20)}.button.secondary{background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09);box-shadow:none}.button:hover{text-decoration:none;filter:brightness(1.06)}
.footer{display:flex;justify-content:center;gap:16px;flex-wrap:wrap;padding:18px 8px 4px;color:#647588;font-size:12px}.footer a{color:#7d91a7}@media(max-width:600px){body{padding:10px}.ambient{inset:8px;border-radius:30px}.card{border-radius:23px;padding:24px 20px}.brand{margin:7px 8px 15px}.glow{filter:blur(56px)}}@media(prefers-reduced-motion:reduce){.glow{animation:none!important}}
`;

const PAGES = {
  privacy: {
    title: "Privacy Policy",
    badge: "Privacy & data",
    lead: "This policy explains what TelePilot processes when you use the bot, connect a Telegram account, contact support, or use TelePilot’s web connection flow.",
    body: `
<h2>1. Information TelePilot processes</h2>
<p>TelePilot may process your Telegram numeric user ID, Telegram username and profile name when Telegram provides them; your TelePilot settings; saved messages and formatting; destination configuration; schedules; templates; access status; posting statistics; and limited diagnostic, audit and security metadata.</p>
<p>If you connect a personal Telegram account, TelePilot stores the resulting Telegram authorization session in encrypted form so scheduled posts can be sent from that account.</p>
<h2>2. Login codes, 2-Step Verification and phone numbers</h2>
<p>Your Telegram login code and 2-Step Verification password are submitted only through TelePilot’s short-lived HTTPS connection flow and are used to complete Telegram authentication. TelePilot is designed not to persist those credentials. A phone number is used to initiate Telegram authentication and is not intended to remain in the bot chat after that step.</p>
<h2>3. Why this information is used</h2>
<p>Information is used to provide posting and scheduling features, maintain your configuration, verify access, secure the service, diagnose failures, answer support requests, prevent abuse and operate TelePilot.</p>
<h2>4. Service providers</h2>
<p>TelePilot relies on Telegram to provide Telegram services and Railway to host the application and persistent runtime storage. Those providers may process technical information under their own terms and privacy practices.</p>
<h2>5. Selling data</h2>
<p>TelePilot does not sell your personal data.</p>
<h2>6. Retention</h2>
<p>Your active configuration and encrypted personal-account session are retained while needed to provide TelePilot. Disconnecting a personal account removes the stored TelePilot session for that account. Support information is retained while needed to handle the case and maintain reasonable service records.</p>
<p>If you request deletion, TelePilot will remove user configuration and stored session data that is no longer required. Limited audit, security or anti-abuse records may be retained when reasonably necessary for service integrity, dispute handling, legal obligations or prevention of misuse.</p>
<h2>7. Your choices</h2>
<p>You can disconnect your personal Telegram account, export supported configuration, or request deletion through the bot’s Support screen. You may also contact support to ask about access, correction or deletion of information associated with your TelePilot account where applicable.</p>
<h2>8. Security</h2>
<p>TelePilot uses controls including encrypted personal-account sessions, restricted server-side files, short-lived authentication flows, rate limits, access controls and security logging. No internet service can guarantee absolute security.</p>
<h2>9. Contact</h2>
<p>For privacy questions or requests, contact <a href="${SUPPORT_URL}" rel="noreferrer">@${escapeHtml(SUPPORT_USERNAME)}</a> on Telegram.</p>`,
  },
  terms: {
    title: "Terms of Service",
    badge: "Terms of use",
    lead: "These terms describe the rules for using TelePilot. By using the service, you agree to use it responsibly and only where you are authorized to post.",
    body: `
<h2>1. Authorized use</h2>
<p>You may use TelePilot only with Telegram accounts, groups and channels that you are authorized to access and post to. You are responsible for the content you configure and the destinations you select.</p>
<h2>2. Prohibited use</h2>
<ul><li>Spam, scams, deceptive activity, harassment or unlawful content.</li><li>Attempts to bypass TelePilot access controls, security protections, rate limits or administrator restrictions.</li><li>Attempts to obtain another user’s keys, sessions, configuration or private information.</li><li>Using TelePilot to interfere with Telegram, TelePilot or other users.</li></ul>
<h2>3. Telegram rules</h2>
<p>Your use of Telegram remains subject to Telegram’s own rules, restrictions and technical limits. TelePilot cannot prevent Telegram-side rate limits, account restrictions, outages or API changes.</p>
<h2>4. Access keys</h2>
<p>TelePilot access keys grant the duration or access type specified when issued. Keys may be single-use or bound to a specific Telegram user. Unless the operator explicitly allows it, keys must not be resold, shared or transferred. Fraudulent or abusive access may be revoked.</p>
<h2>5. Availability and changes</h2>
<p>TelePilot may change features, security controls or service behavior to improve reliability, comply with platform requirements or protect users. Continuous or error-free availability is not guaranteed.</p>
<h2>6. Suspension and termination</h2>
<p>Access may be suspended or revoked for abuse, security threats, prohibited use, attempts to exploit the service or material violations of these terms.</p>
<h2>7. Your account and backups</h2>
<p>You are responsible for maintaining access to your Telegram account and for reviewing important posting configuration. TelePilot provides safeguards, but you should verify important schedules and destinations before relying on them.</p>
<h2>8. Liability</h2>
<p>To the extent permitted by applicable law, TelePilot is provided without a guarantee that every message will be delivered at an exact time or that third-party services will remain available. Nothing in these terms excludes rights or liability that cannot legally be excluded, including mandatory consumer protections where they apply.</p>
<h2>9. Contact</h2>
<p>Questions about these terms can be sent to <a href="${SUPPORT_URL}" rel="noreferrer">@${escapeHtml(SUPPORT_USERNAME)}</a> on Telegram.</p>`,
  },
  support: {
    title: "Support",
    badge: "TelePilot help",
    lead: "Use the Support screen inside @TelePilottBot for the fastest help. Each report receives a diagnostic case ID without exposing authentication secrets.",
    body: `
<div class="notice"><strong>Never send a Telegram login code, 2-Step Verification password, raw Telegram session, bot token or full TelePilot access key to support.</strong></div>
<h2>What you can report</h2>
<ul><li>Account or login problems</li><li>Posting or destination problems</li><li>Access-key or access problems</li><li>Security concerns</li><li>Privacy and data requests</li></ul>
<h2>Safe diagnostics</h2>
<p>Support reports may include a case ID, TelePilot version, Telegram user ID, posting mode, configured-destination count and limited non-secret status information. TelePilot’s support flow is designed not to attach login codes, 2FA passwords, raw sessions, API secrets or full access keys.</p>
<h2>Privacy and deletion</h2>
<p>Use the Support screen in the bot to open a privacy request or request deletion of your TelePilot data. Destructive deletion requests require confirmation before they are processed.</p>
<div class="actions"><a class="button" href="${SUPPORT_URL}" rel="noreferrer">Message @${escapeHtml(SUPPORT_USERNAME)}</a><a class="button secondary" href="/privacy">Privacy Policy</a><a class="button secondary" href="/terms">Terms</a></div>`,
  },
};

export function renderLegalPage(kind) {
  const page = PAGES[kind];
  if (!page) return "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>TelePilot — ${escapeHtml(page.title)}</title><style>${STYLE}</style></head><body><div class="ambient" aria-hidden="true"><div class="glow a"></div><div class="glow b"></div></div><main class="wrap"><div class="brand"><div class="mark">✈️</div><span>TelePilot</span></div><article class="card"><div class="badge">${escapeHtml(page.badge)}</div><h1>${escapeHtml(page.title)}</h1><p class="lead">${escapeHtml(page.lead)}</p><p>Last updated: ${LAST_UPDATED}</p>${page.body}</article><nav class="footer" aria-label="Legal and support"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a><a href="${SUPPORT_URL}" rel="noreferrer">@${escapeHtml(SUPPORT_USERNAME)}</a></nav></main></body></html>`;
}

function sendPage(res, body) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(body);
}

export function installLegalPages() {
  if (http.__telepilotLegalPagesInstalled) return;
  Object.defineProperty(http, "__telepilotLegalPagesInstalled", { value: true });
  const originalCreateServer = http.createServer.bind(http);
  http.createServer = function createTelePilotLegalServer(...args) {
    const listenerIndex = args.findIndex(arg => typeof arg === "function");
    if (listenerIndex < 0) return originalCreateServer(...args);
    const listener = args[listenerIndex];
    args[listenerIndex] = function telePilotLegalRequestListener(req, res) {
      let pathname = "";
      try { pathname = new URL(req.url || "/", "http://telepilot.local").pathname; } catch {}
      if (req.method === "GET" && ["/privacy", "/terms", "/support"].includes(pathname)) {
        return sendPage(res, renderLegalPage(pathname.slice(1)));
      }
      return listener(req, res);
    };
    return originalCreateServer(...args);
  };
}
