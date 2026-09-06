from pathlib import Path

APP = Path("app.js")
POSTING = Path("posting-engine-enhancements.js")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


app = APP.read_text()
posting = POSTING.read_text()

# Keep a small cache for private MTProto destinations so every post cycle does not
# refetch the user's entire dialog list.
app = replace_once(
    app,
    'const states = new Map();\nconst loginAttempts = new Map();',
    'const states = new Map();\nconst loginAttempts = new Map();\nconst personalTargetCache = new Map();\nconst PERSONAL_TARGET_CACHE_MS = 10 * 60_000;',
    'runtime maps',
)

# Make client ownership explicit. Username-only ownership breaks for valid Telegram
# accounts that do not have a public @username.
app = replace_once(
    app,
    '  if (!hasPersonalSession(state.uid)) return null;\n  if (state.personalClient) return state.personalClient;',
    '  if (!hasPersonalSession(state.uid)) return null;\n  if (state.personalClient) {\n    state.personalClient.__telepilotOwnerUid = String(state.uid);\n    return state.personalClient;\n  }',
    'existing personal client owner',
)
app = replace_once(
    app,
    '      client = new TelegramClient(new StringSession(loadPersonalSession(state.uid)), API_ID, API_HASH, {\n        connectionRetries: 5,\n        floodSleepThreshold: 60,\n      });\n      await client.connect();',
    '      client = new TelegramClient(new StringSession(loadPersonalSession(state.uid)), API_ID, API_HASH, {\n        connectionRetries: 5,\n        floodSleepThreshold: 60,\n      });\n      client.__telepilotOwnerUid = String(state.uid);\n      await client.connect();',
    'restored personal client owner',
)
app = replace_once(
    app,
    '      state.personalUsername = me?.username || state.personalUsername || "";\n      state.personalClient = client;\n      saveState(state);\n      return client;\n    } catch (err) {\n      try { await client?.disconnect(); } catch {}\n      console.warn(`Could not restore personal Telegram account for user ${state.uid}:`, err?.message || err);\n      return null;',
    '      state.personalUsername = me?.username || state.personalUsername || "";\n      state.personalClient = client;\n      state.personalRestoreError = "";\n      state.personalRestoreFatal = false;\n      saveState(state);\n      return client;\n    } catch (err) {\n      state.personalRestoreError = telegramErrorCode(err).slice(0, 120) || "UNKNOWN";\n      state.personalRestoreFatal = isFatalPersonalSessionError(err);\n      try { await client?.disconnect(); } catch {}\n      console.warn(`Could not restore personal Telegram account for user ${state.uid}:`, err?.message || err);\n      return null;',
    'personal restore classification',
)
app = replace_once(
    app,
    '  state.personalClient = attempt.client;\n  saveState(state);',
    '  attempt.client.__telepilotOwnerUid = String(state.uid);\n  state.personalClient = attempt.client;\n  state.personalRestoreError = "";\n  state.personalRestoreFatal = false;\n  saveState(state);',
    'completed login owner',
)
app = replace_once(
    app,
    '  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {\n    connectionRetries: 5,\n    floodSleepThreshold: 0,\n  });\n  const attempt = {',
    '  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {\n    connectionRetries: 5,\n    floodSleepThreshold: 0,\n  });\n  client.__telepilotOwnerUid = String(uid);\n  const attempt = {',
    'login client owner',
)

# Do not count Telegram/network/server failures as incorrect OTP or 2FA attempts.
old_code = '''async function submitLoginCode(attempt, code) {
  if (attempt.stage !== "code") return;
  const value = String(code || "").replace(/\\D/g, "");
  if (!/^\\d{3,10}$/.test(value)) return failLoginAttempt(attempt, "code", new Error("PHONE_CODE_INVALID"));
  try {
    const result = await attempt.client.invoke(new Api.auth.SignIn({
      phoneNumber: attempt.phone,
      phoneCodeHash: attempt.phoneCodeHash,
      phoneCode: value,
    }));
    const user = result?.user || result;
    await completeLogin(attempt, user);
  } catch (err) {
    const codeName = telegramErrorCode(err);
    if (codeName.includes("SESSION_PASSWORD_NEEDED")) {
      attempt.stage = "password";
      attempt.error = "";
      return;
    }
    attempt.error = cleanAuthError(err);
    return failLoginAttempt(attempt, "code", err);
  }
}
'''
new_code = '''async function submitLoginCode(attempt, code) {
  if (attempt.stage !== "code") return;
  const value = String(code || "").replace(/\\D/g, "");
  if (!/^\\d{3,10}$/.test(value)) return failLoginAttempt(attempt, "code", new Error("PHONE_CODE_INVALID"));
  let result;
  try {
    result = await attempt.client.invoke(new Api.auth.SignIn({
      phoneNumber: attempt.phone,
      phoneCodeHash: attempt.phoneCodeHash,
      phoneCode: value,
    }));
  } catch (err) {
    const codeName = telegramErrorCode(err);
    if (codeName.includes("SESSION_PASSWORD_NEEDED")) {
      attempt.stage = "password";
      attempt.error = "";
      return;
    }
    attempt.error = cleanAuthError(err);
    if (codeName.includes("PHONE_CODE_INVALID")) return failLoginAttempt(attempt, "code", err);
    if (codeName.includes("PHONE_CODE_EXPIRED")) attempt.stage = "error";
    throw new Error(attempt.error);
  }
  try {
    await completeLogin(attempt, result?.user || result);
  } catch (err) {
    attempt.stage = "error";
    attempt.error = "Telegram accepted the login, but TelePilot could not finish connecting the account. Start the connection again.";
    appendSecurityEvent("login_finalize_failed", { uid: String(attempt.uid), reason: telegramErrorCode(err).slice(0, 80) });
    throw new Error(attempt.error);
  }
}
'''
app = replace_once(app, old_code, new_code, 'login code classification')

old_password = '''async function submitLoginPassword(attempt, password) {
  if (attempt.stage !== "password") return;
  const value = String(password || "");
  if (!value) return failLoginAttempt(attempt, "password", new Error("PASSWORD_HASH_INVALID"));
  let passwordError = null;
  try {
    const user = await attempt.client.signInWithPassword(
      { apiId: API_ID, apiHash: API_HASH },
      {
        password: async () => value,
        onError: async err => {
          passwordError = err;
          return true;
        },
      },
    );
    await completeLogin(attempt, user);
  } catch (err) {
    attempt.error = cleanAuthError(passwordError || err);
    return failLoginAttempt(attempt, "password", passwordError || err);
  }
}
'''
new_password = '''async function submitLoginPassword(attempt, password) {
  if (attempt.stage !== "password") return;
  const value = String(password || "");
  if (!value) return failLoginAttempt(attempt, "password", new Error("PASSWORD_HASH_INVALID"));
  let passwordError = null;
  let user;
  try {
    user = await attempt.client.signInWithPassword(
      { apiId: API_ID, apiHash: API_HASH },
      {
        password: async () => value,
        onError: async err => {
          passwordError = err;
          return true;
        },
      },
    );
  } catch (err) {
    const authErr = passwordError || err;
    const codeName = telegramErrorCode(authErr);
    attempt.error = cleanAuthError(authErr);
    if (codeName.includes("PASSWORD_HASH_INVALID")) return failLoginAttempt(attempt, "password", authErr);
    throw new Error(attempt.error);
  }
  try {
    await completeLogin(attempt, user);
  } catch (err) {
    attempt.stage = "error";
    attempt.error = "Telegram accepted the login, but TelePilot could not finish connecting the account. Start the connection again.";
    appendSecurityEvent("login_finalize_failed", { uid: String(attempt.uid), reason: telegramErrorCode(err).slice(0, 80) });
    throw new Error(attempt.error);
  }
}
'''
app = replace_once(app, old_password, new_password, 'login password classification')

# Browser handoff: keep the secret out of the HTTP URL by moving the browser token
# into the fragment. Fragments are not sent in HTTP requests or Referer headers.
# JS consumes it immediately and removes it from the address bar. This also makes
# the flow work in Telegram/Android webviews that fail to persist the cookie.
app = replace_once(
    app,
    'function connectCookie(token, maxAge = 600) {\n  return `__Host-telepilot_connect=${encodeURIComponent(token || "")}; Path=/; Max-Age=${Math.max(0, maxAge)}; HttpOnly; Secure; SameSite=Strict`;\n}\nfunction authAttemptFromRequest(req, fallbackToken = "") {\n  const cookieToken = readCookies(req)["__Host-telepilot_connect"] || "";\n  return getAttemptByBrowserToken(cookieToken) || getAttemptByToken(fallbackToken);\n}',
    'function connectCookie(token, maxAge = 600) {\n  return `__Host-telepilot_connect=${encodeURIComponent(token || "")}; Path=/; Max-Age=${Math.max(0, maxAge)}; HttpOnly; Secure; SameSite=Lax`;\n}\nfunction authAttemptFromRequest(req, fallbackToken = "") {\n  const cookieToken = readCookies(req)["__Host-telepilot_connect"] || "";\n  return getAttemptByBrowserToken(cookieToken)\n    || getAttemptByBrowserToken(fallbackToken)\n    || getAttemptByToken(fallbackToken);\n}',
    'connect cookie fallback',
)
app = replace_once(
    app,
    'const token=${safeToken};\nconst statusEl=',
    'const token=(location.hash.length>1?decodeURIComponent(location.hash.slice(1)):${safeToken});\nif(location.hash) history.replaceState(null,"",location.pathname+location.search);\nconst statusEl=',
    'connect page fragment token',
)
app = replace_once(
    app,
    '        attempt.token = "";\n        const browserToken = rotateBrowserToken(attempt);\n        res.writeHead(303, {\n          location: "/connect",',
    '        attempt.token = "";\n        const browserToken = rotateBrowserToken(attempt);\n        res.writeHead(303, {\n          location: `/connect#${encodeURIComponent(browserToken)}` ,',
    'connect redirect fragment',
)
app = replace_once(
    app,
    '''      const attempt = authAttemptFromRequest(req);
      if (!attempt) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end("<h1>TelePilot link expired</h1><p>Return to the bot and start account connection again.</p>");
      }
      res.writeHead(200, {''',
    '''      const attempt = authAttemptFromRequest(req);
      // Some Telegram/Android in-app browsers do not persist the redirect cookie.
      // Serve the generic page anyway: its fragment-held browser token authenticates
      // the API calls, while a truly invalid token still receives HTTP 410 from /auth/status.
      res.writeHead(200, {''',
    'connect generic page fallback',
)
app = replace_once(
    app,
    '        if (attempt.stage === "password") res.setHeader("set-cookie", connectCookie(rotateBrowserToken(attempt)));\n        if (attempt.stage === "done") res.setHeader("set-cookie", connectCookie("", 0));',
    '        if (attempt.stage === "done") res.setHeader("set-cookie", connectCookie("", 0));',
    'avoid browser token rotation between stages',
)

# Remove the 500-dialog ceiling for destination discovery. This happens only on
# add/cache miss; private send targets are cached for ten minutes below.
app = app.replace('client.getDialogs({ limit: 500 })', 'client.getDialogs({})')
if 'client.getDialogs({ limit: 500 })' in app:
    raise SystemExit('dialog limit replacement failed')

old_resolve = '''async function resolvePersonalTarget(client, destination) {
  if (destination.username) return destination.username;
  const dialogs = await client.getDialogs({});
  for (const dialog of dialogs) {
    const candidates = [
      dialog?.id,
      dialog?.entity?.id,
      dialog?.inputEntity?.chatId,
      dialog?.inputEntity?.channelId,
    ].filter(v => v !== undefined && v !== null).map(v => String(v));
    if (candidates.includes(String(destination.id))) return dialog;
  }
  throw new Error("This personal account could not resolve that private destination. Add a public username or reopen the group in Telegram and try again.");
}
'''
new_resolve = '''async function resolvePersonalTarget(client, destination, uid) {
  if (destination.username) return destination.username;
  const cacheKey = `${uid}:${destination.id}`;
  const cached = personalTargetCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PERSONAL_TARGET_CACHE_MS) return cached.entity;
  const dialogs = await client.getDialogs({});
  for (const dialog of dialogs) {
    const candidates = [
      dialog?.id,
      dialog?.entity?.id,
      dialog?.inputEntity?.chatId,
      dialog?.inputEntity?.channelId,
    ].filter(v => v !== undefined && v !== null).map(v => String(v));
    const normalizedTarget = String(destination.id).replace(/^-100/, "").replace(/^-/, "");
    const matched = candidates.includes(String(destination.id))
      || candidates.some(value => value.replace(/\\D/g, "") === normalizedTarget);
    if (matched) {
      personalTargetCache.set(cacheKey, { at: Date.now(), entity: dialog });
      return dialog;
    }
  }
  throw new Error("This personal account could not resolve that private destination. Reopen the group in Telegram and try again.");
}
'''
app = replace_once(app, old_resolve, new_resolve, 'private destination cache')
app = replace_once(
    app,
    '        const entity = await resolvePersonalTarget(personalClient, target);',
    '        const entity = await resolvePersonalTarget(personalClient, target, state.uid);',
    'private destination resolve call',
)

# A transient Telegram/transport problem should not invalidate a perfectly good
# encrypted session or stop the user's posting schedule permanently.
old_restore_block = '''  if (hasPersonalSession(state.uid) && !personalClient) {
    stopPostingLoop(state);
    await autoDeleteNotice(state.uid, "⚠️ Your personal Telegram session could not be restored. Reconnect the account.", 15000);
    return;
  }
'''
new_restore_block = '''  if (hasPersonalSession(state.uid) && !personalClient) {
    state.lastRunAt = Date.now();
    state.lastCycleSuccess = 0;
    state.lastCycleFailed = targets.length;
    saveState(state);
    if (state.personalRestoreFatal) {
      stopPostingLoop(state);
      await autoDeleteNotice(state.uid, "⚠️ Your personal Telegram session is no longer authorized. Reconnect the account.", 15000);
    } else {
      const noticeRate = takeRateLimit("personal-restore-notice", String(state.uid), 1, 30 * 60_000);
      if (noticeRate.ok) {
        await autoDeleteNotice(state.uid, "⚠️ Telegram connection issue. Your session is still saved and TelePilot will retry automatically.", 15000);
      }
    }
    return;
  }
'''
app = replace_once(app, old_restore_block, new_restore_block, 'transient restore handling')

# Give users useful destination errors without spamming every cycle, and invalidate
# a stale private-target cache entry when Telegram says access changed.
old_catch = '''    } catch (err) {
      failed++;
      console.error(`User ${state.uid} failed to post to ${target.id}:`, err?.errorMessage || err?.description || err?.message || err);
      if (personalClient && isFatalPersonalSessionError(err)) {
        stopPostingLoop(state);
        await autoDeleteNotice(state.uid, "⚠️ Your personal Telegram session is no longer authorized. Reconnect the account.", 15000);
        break;
      }
    }
'''
new_catch = '''    } catch (err) {
      failed++;
      const errorCode = telegramErrorCode(err);
      personalTargetCache.delete(`${state.uid}:${target.id}`);
      console.error(`User ${state.uid} failed to post to ${target.id}:`, err?.errorMessage || err?.description || err?.message || err);
      if (personalClient && isFatalPersonalSessionError(err)) {
        stopPostingLoop(state);
        await autoDeleteNotice(state.uid, "⚠️ Your personal Telegram session is no longer authorized. Reconnect the account.", 15000);
        break;
      }
      const destinationIssue = errorCode.includes("CHANNEL_PRIVATE")
        || errorCode.includes("CHAT_WRITE_FORBIDDEN")
        || errorCode.includes("USER_BANNED_IN_CHANNEL")
        || errorCode.includes("CHAT_SEND_PHOTOS_FORBIDDEN")
        || errorCode.includes("CHAT_SEND_VIDEOS_FORBIDDEN")
        || errorCode.includes("CHAT_SEND_MEDIA_FORBIDDEN");
      if (destinationIssue) {
        const noticeRate = takeRateLimit("destination-error-notice", `${state.uid}:${target.id}:${errorCode.slice(0, 50)}`, 1, 6 * 60 * 60_000);
        if (noticeRate.ok) {
          const detail = errorCode.includes("CHANNEL_PRIVATE")
            ? "the connected account can no longer access this destination"
            : errorCode.includes("CHAT_SEND_")
              ? "this destination does not allow that media type"
              : "the connected account cannot post in this destination";
          await autoDeleteNotice(state.uid, `⚠️ ${destinationLabel(target)} failed: ${detail}. Check its permissions or remove it from Destinations.`, 20000);
        }
      }
    }
'''
app = replace_once(app, old_catch, new_catch, 'destination error handling')

# Benign Telegram Bot API edit races should not pollute production logs as bot errors.
app = replace_once(
    app,
    'bot.catch(err => console.error("Bot error:", err.error));',
    'bot.catch(err => {\n  const value = String(err?.error?.description || err?.error?.message || err?.error || "");\n  if (value.includes("message is not modified")) return;\n  console.error("Bot error:", err.error);\n});',
    'benign edit error handling',
)

# --- posting-engine-enhancements.js ---
# Robust FloodWait parsing and retry/backoff. A FLOOD_WAIT must never collapse to
# the generic 1.2-second retry.
old_retry = '''function retryDelayMs(err) {
  const retryAfter = Number(err?.parameters?.retry_after || 0);
  if (retryAfter > 0 && retryAfter <= 60) return retryAfter * 1000;
  const match = errorText(err).toUpperCase().match(/FLOOD_WAIT_?(\\d+)/);
  if (match && Number(match[1]) <= 60) return Number(match[1]) * 1000;
  return 1200;
}

function isRetryable(err) {
  const code = Number(err?.error_code || 0);
  const text = errorText(err).toUpperCase();
  if (code === 429 || code >= 500) return true;
  return ["TIMEOUT", "TIMED OUT", "ECONNRESET", "EAI_AGAIN", "RPC_CALL_FAIL", "INTERNAL", "SERVER_ERROR", "FLOOD_WAIT"].some(token => text.includes(token));
}

async function withRetry(fn) {
  try { return await fn(); }
  catch (err) {
    if (!isRetryable(err)) throw err;
    await new Promise(resolve => setTimeout(resolve, retryDelayMs(err)));
    return fn();
  }
}
'''
new_retry = '''export function floodWaitSeconds(err) {
  const direct = Number(err?.seconds || err?.retryAfter || err?.parameters?.retry_after || 0);
  if (Number.isFinite(direct) && direct > 0) return Math.ceil(direct);
  const match = errorText(err).toUpperCase().match(/FLOOD_WAIT_?(\\d+)/);
  return match ? Number(match[1]) : 0;
}

export function retryDelayMs(err, attempt = 0) {
  const flood = floodWaitSeconds(err);
  if (flood > 0) return (flood + 1) * 1000;
  return Math.min(10_000, 1200 * (2 ** Math.max(0, Number(attempt) || 0)));
}

export function isRetryable(err) {
  const code = Number(err?.error_code || 0);
  const text = errorText(err).toUpperCase();
  if (code === 429 || code >= 500) return true;
  return ["TIMEOUT", "TIMED OUT", "ECONNRESET", "EAI_AGAIN", "RPC_CALL_FAIL", "INTERNAL", "SERVER_ERROR", "FLOOD_WAIT"].some(token => text.includes(token));
}

async function withRetry(fn, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs(err, attempt)));
    }
  }
  throw lastError;
}
'''
posting = replace_once(posting, old_retry, new_retry, 'posting retry logic')

# Explicit client owner set by app.js wins; username discovery remains only as a
# backward-compatible fallback.
posting = replace_once(
    posting,
    '      let uid = clientOwners.get(this) || "";',
    '      let uid = String(this.__telepilotOwnerUid || clientOwners.get(this) || "");',
    'personal client owner lookup',
)
posting = replace_once(
    posting,
    '          if (uid) clientOwners.set(this, uid);',
    '          if (uid) {\n            clientOwners.set(this, uid);\n            this.__telepilotOwnerUid = String(uid);\n          }',
    'personal client owner fallback cache',
)

APP.write_text(app)
POSTING.write_text(posting)

# Permanent regression coverage for the behaviors that caused the user reports.
test = Path("teleproto-reliability-test.mjs")
test.write_text(r'''import fs from "node:fs";
import assert from "node:assert/strict";
import { floodWaitSeconds, retryDelayMs, isRetryable } from "./posting-engine-enhancements.js";

const app = fs.readFileSync("app.js", "utf8");

assert.equal(floodWaitSeconds({ errorMessage: "FLOOD_WAIT_300" }), 300);
assert.equal(retryDelayMs({ errorMessage: "FLOOD_WAIT_300" }), 301000);
assert.equal(floodWaitSeconds({ seconds: 75 }), 75);
assert.equal(isRetryable({ errorMessage: "FLOOD_WAIT_300" }), true);
assert.equal(isRetryable({ message: "ECONNRESET" }), true);

assert.match(app, /location: `\\/connect#\\$\\{encodeURIComponent\\(browserToken\\)\\}`/);
assert.match(app, /getAttemptByBrowserToken\\(fallbackToken\\)/);
assert.match(app, /history\\.replaceState/);
assert.doesNotMatch(app, /client\\.getDialogs\\(\\{ limit: 500 \\}\\)/);
assert.match(app, /personalRestoreFatal/);
assert.match(app, /will retry automatically/);
assert.match(app, /__telepilotOwnerUid/);
assert.match(app, /login_finalize_failed/);

console.log("TelePilot MTProto/login reliability regression checks passed");
''')

print("TelePilot MTProto/login reliability patch applied")
