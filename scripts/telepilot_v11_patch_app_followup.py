from pathlib import Path
P=Path('app.js'); s=P.read_text()

def once(old,new,label):
 global s
 c=s.count(old)
 if c!=1: raise RuntimeError(f'{label}: expected one, got {c}')
 s=s.replace(old,new,1)

# Remove the duplicate closing pair accidentally left by the primary source migration if present.
s=s.replace('\n  }\n});\n  }\n});\n\nbot.callbackQuery("account_cancel_login"','\n  }\n});\n\nbot.callbackQuery("account_cancel_login"',1)

once('import { setReloadUserStateHandler } from "./runtime-hooks.js";\n', 'import { setReloadUserStateHandler } from "./runtime-hooks.js";\nimport { loadPersistedLogins, persistLoginAttempt, removePersistedLogin } from "./login-attempt-store.js";\n', 'login imports')

old='''function cancelLoginAttempt(uid, reason = "cancelled") {
  const attempt = loginAttempts.get(String(uid));
  if (!attempt) return;
  loginAttempts.delete(String(uid));
  attempt.stage = reason;
  try { void attempt.client?.disconnect(); } catch {}
}'''
new='''function cancelLoginAttempt(uid, reason = "cancelled") {
  const attempt = loginAttempts.get(String(uid));
  if (!attempt) { if (reason !== "shutdown") removePersistedLogin(uid); return; }
  if (reason === "shutdown") {
    try { persistLoginAttempt(attempt); } catch {}
    loginAttempts.delete(String(uid));
    try { void attempt.client?.disconnect(); } catch {}
    return;
  }
  loginAttempts.delete(String(uid));
  attempt.stage = reason;
  removePersistedLogin(uid);
  try { void attempt.client?.disconnect(); } catch {}
}'''
once(old,new,'cancel login')

once('''const bot = new Bot(BOT_TOKEN);
const botInfo = await bot.api.getMe();''','''const bot = new Bot(BOT_TOKEN);
for (const saved of loadPersistedLogins(LOGIN_TTL_MS)) {
  try {
    const client = new TelegramClient(new StringSession(saved.sessionString), API_ID, API_HASH, { connectionRetries: 5, floodSleepThreshold: 0 });
    client.__telepilotOwnerUid = String(saved.uid);
    loginAttempts.set(String(saved.uid), { ...saved, uid: Number(saved.uid), client });
  } catch (err) { console.warn(`Could not restore pending login for ${saved.uid}:`, err?.message || err); }
}
const botInfo = await bot.api.getMe();''','restore pending login')

once('''    attempt.phoneCodeHash = sent.phoneCodeHash;
    attempt.isCodeViaApp = sent.isCodeViaApp === true;
    attempt.stage = "code";
    appendSecurityEvent("login_started", { uid: String(uid) });''','''    attempt.phoneCodeHash = sent.phoneCodeHash;
    attempt.isCodeViaApp = sent.isCodeViaApp === true;
    attempt.stage = "code";
    persistLoginAttempt(attempt);
    appendSecurityEvent("login_started", { uid: String(uid) });''','persist login start')

once('''function rotateBrowserToken(attempt) {
  const token = createLoginToken();
  attempt.browserToken = token;
  return token;
}''','''function rotateBrowserToken(attempt) {
  const token = createLoginToken();
  attempt.browserToken = token;
  try { persistLoginAttempt(attempt); } catch {}
  return token;
}''','persist rotated token')

once('''  attempt[field] = Number(attempt[field] || 0) + 1;
  const count = attempt[field];''','''  attempt[field] = Number(attempt[field] || 0) + 1;
  try { persistLoginAttempt(attempt); } catch {}
  const count = attempt[field];''','persist failed auth count')

once('''  let result;
  try {
    result = await attempt.client.invoke(new Api.auth.SignIn({''','''  let result;
  try {
    await attempt.client.connect();
    result = await attempt.client.invoke(new Api.auth.SignIn({''','reconnect code client')

once('''      attempt.stage = "password";
      attempt.error = "";
      return;''','''      attempt.stage = "password";
      attempt.error = "";
      try { persistLoginAttempt(attempt); } catch {}
      return;''','persist 2fa stage')

once('''  let passwordError = null;
  let user;
  try {
    user = await attempt.client.signInWithPassword(''','''  let passwordError = null;
  let user;
  try {
    await attempt.client.connect();
    user = await attempt.client.signInWithPassword(''','reconnect 2fa client')

# The successful completion must erase the short-lived persisted handoff.
once('''  attempt.client = null;
  attempt.stage = "done";''','''  attempt.client = null;
  attempt.stage = "done";
  removePersistedLogin(attempt.uid);''','clear persisted handoff')

# URL token is intentionally one-use, but persist the rotated browser token after clearing it.
once('''        attempt.token = "";
        const browserToken = rotateBrowserToken(attempt);''','''        attempt.token = "";
        const browserToken = rotateBrowserToken(attempt);''','url rotation marker')

P.write_text(s)
print('TelePilot 1.1 app follow-up applied')
