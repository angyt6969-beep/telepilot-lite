import crypto from "node:crypto";

const INSTALL_MARK = Symbol.for("telepilot.telegramRuntimeOptimizer.v1");
const DEFAULT_GET_ME_TTL_MS = 5 * 60_000;
const DEFAULT_DIALOG_MIN_GAP_MS = 6_000;
const DEFAULT_CONNECT_MIN_GAP_MS = 750;

const getMeCache = new Map();
const dialogTails = new Map();
const dialogLastStart = new Map();
const connectTails = new Map();
const connectLastStart = new Map();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sessionFingerprint(client) {
  try {
    const saved = client?.session?.save?.();
    if (!saved) return "";
    return crypto.createHash("sha256").update(String(saved)).digest("hex").slice(0, 32);
  } catch {
    return "";
  }
}

function pruneIdentityCache(now = Date.now()) {
  if (getMeCache.size < 500) return;
  for (const [key, entry] of getMeCache) {
    if (!entry || Number(entry.expiresAt || 0) <= now) getMeCache.delete(key);
  }
}

function enqueuePerAccount(tails, lastStart, key, minGapMs, task) {
  const previous = tails.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const waitMs = Math.max(0, Number(lastStart.get(key) || 0) + minGapMs - Date.now());
    if (waitMs > 0) await delay(waitMs);
    lastStart.set(key, Date.now());
    return task();
  });
  const tail = run.then(() => undefined, () => undefined);
  tails.set(key, tail);
  void tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

export function installTelegramRuntimeOptimizer(TelegramClientClass, options = {}) {
  const proto = TelegramClientClass?.prototype;
  if (!proto) throw new Error("TelegramClient prototype is unavailable");
  if (proto[INSTALL_MARK]) return proto[INSTALL_MARK];

  const getMeTtlMs = Math.max(10_000, Number(options.getMeTtlMs || DEFAULT_GET_ME_TTL_MS));
  const dialogMinGapMs = Math.max(0, Number(options.dialogMinGapMs ?? DEFAULT_DIALOG_MIN_GAP_MS));
  const connectMinGapMs = Math.max(0, Number(options.connectMinGapMs ?? DEFAULT_CONNECT_MIN_GAP_MS));

  const originalGetMe = typeof proto.getMe === "function" ? proto.getMe : null;
  const originalGetDialogs = typeof proto.getDialogs === "function" ? proto.getDialogs : null;
  const originalConnect = typeof proto.connect === "function" ? proto.connect : null;

  if (originalGetMe) {
    proto.getMe = async function optimizedGetMe(...args) {
      const key = sessionFingerprint(this);
      if (!key) return originalGetMe.apply(this, args);

      const now = Date.now();
      const cached = getMeCache.get(key);
      if (cached && Number(cached.expiresAt || 0) > now) return cached.promise;

      pruneIdentityCache(now);
      const promise = Promise.resolve().then(() => originalGetMe.apply(this, args));
      const entry = { promise, expiresAt: now + getMeTtlMs };
      getMeCache.set(key, entry);
      try {
        return await promise;
      } catch (err) {
        if (getMeCache.get(key) === entry) getMeCache.delete(key);
        throw err;
      }
    };
  }

  if (originalGetDialogs) {
    proto.getDialogs = function optimizedGetDialogs(...args) {
      const key = sessionFingerprint(this);
      if (!key) return originalGetDialogs.apply(this, args);
      // Important: results are never cached. We only serialize and pace scans,
      // so post-import verification always receives a fresh Telegram result.
      return enqueuePerAccount(
        dialogTails,
        dialogLastStart,
        key,
        dialogMinGapMs,
        () => originalGetDialogs.apply(this, args),
      );
    };
  }

  if (originalConnect) {
    proto.connect = function optimizedConnect(...args) {
      const key = sessionFingerprint(this);
      if (!key) return originalConnect.apply(this, args);
      // Only the handshake is serialized. Once connected, independent clients
      // continue normally; this avoids bursts of simultaneous reconnects.
      return enqueuePerAccount(
        connectTails,
        connectLastStart,
        key,
        connectMinGapMs,
        () => originalConnect.apply(this, args),
      );
    };
  }

  const installed = Object.freeze({
    enabled: true,
    getMeTtlMs,
    dialogMinGapMs,
    connectMinGapMs,
  });
  Object.defineProperty(proto, INSTALL_MARK, { value: installed, configurable: false });
  return installed;
}

export const __test = {
  sessionFingerprint,
};
