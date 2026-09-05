import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { appendSecurityEvent } from "./security-core.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const DELETED_FILE = path.join(DATA_DIR, "deleted-users.json");

function deletedHash(uid) {
  return crypto.createHash("sha256").update(`telepilot-deleted-user:${String(uid)}`).digest("hex");
}

function reactivateDeletedUser(uid) {
  if (!/^\d+$/.test(String(uid || ""))) return false;
  let db;
  try {
    db = fs.existsSync(DELETED_FILE)
      ? JSON.parse(fs.readFileSync(DELETED_FILE, "utf8"))
      : { version: 1, users: {} };
  } catch {
    return false;
  }
  if (!db?.users || typeof db.users !== "object" || Array.isArray(db.users)) return false;
  const key = deletedHash(uid);
  if (!db.users[key]) return false;

  delete db.users[key];
  fs.mkdirSync(path.dirname(DELETED_FILE), { recursive: true, mode: 0o700 });
  const temp = `${DELETED_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, users: db.users }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DELETED_FILE);
  appendSecurityEvent("user_reactivated_after_deletion", { uid: String(uid) });
  return true;
}

// support-center.js historically registers its routes from Bot.start(). Two details matter:
// 1) those routes must exist before polling starts, and
// 2) grammY callbackQuery/command registration internally calls `this.use()`.
// support-center also wraps `use()` to skip app middleware for support traffic, so registering
// its own routes through that wrapped `use()` accidentally made the support routes skip
// themselves. This adapter registers them early while temporarily using the pre-support
// `use()` implementation for the registration operation only.
export function installSupportCenterEarly(BotClass, installSupportCenter) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotSupportEarlyInstalled) return;
  if (typeof installSupportCenter !== "function") throw new Error("TelePilot support installer is unavailable");

  const realStart = BotClass.prototype.start;
  const preSupportUse = BotClass.prototype.use;
  const preSupportCommand = BotClass.prototype.command;
  if (![realStart, preSupportUse, preSupportCommand].every(fn => typeof fn === "function")) {
    throw new Error("Unsupported grammY Bot shape for early support registration");
  }

  // Give support-center a non-starting baseStart. Its generated start wrapper can then be
  // invoked purely as a route registrar without opening Telegram polling.
  BotClass.prototype.start = function telepilotSupportRegistrationOnly() { return undefined; };
  installSupportCenter(BotClass);

  const registerSupport = BotClass.prototype.start;
  const supportUse = BotClass.prototype.use;
  const supportOn = BotClass.prototype.on;
  const supportCommand = BotClass.prototype.command;
  const supportCallbackQuery = BotClass.prototype.callbackQuery;

  if (![registerSupport, supportUse, supportOn, supportCommand, supportCallbackQuery].every(fn => typeof fn === "function")) {
    BotClass.prototype.start = realStart;
    throw new Error("TelePilot support center did not install correctly");
  }

  function withPreSupportUse(instance, operation) {
    const hadOwnUse = Object.prototype.hasOwnProperty.call(instance, "use");
    const ownUse = hadOwnUse ? instance.use : undefined;
    try {
      Object.defineProperty(instance, "use", {
        configurable: true,
        writable: true,
        value: (...args) => preSupportUse.call(instance, ...args),
      });
      return operation();
    } finally {
      if (hadOwnUse) {
        Object.defineProperty(instance, "use", { configurable: true, writable: true, value: ownUse });
      } else {
        delete instance.use;
      }
    }
  }

  let ensuring = false;
  function ensureSupport(instance) {
    if (!instance || instance.__telepilotSupportHandlersRegistered || ensuring) return;
    ensuring = true;
    try {
      // grammY's callbackQuery()/command() use this.use() internally. During support route
      // registration that must be the pre-support implementation, otherwise supportIntent()
      // skips the very route being registered.
      withPreSupportUse(instance, () => registerSupport.call(instance));
    } finally {
      ensuring = false;
    }
  }

  BotClass.prototype.use = function(...args) {
    ensureSupport(this);
    return supportUse.call(this, ...args);
  };
  BotClass.prototype.on = function(...args) {
    ensureSupport(this);
    return supportOn.call(this, ...args);
  };
  BotClass.prototype.command = function(command, ...middleware) {
    ensureSupport(this);

    // Account deletion removes the user's TelePilot directory, but it must not become a
    // permanent ban. A later private /start is an explicit request to create a fresh profile.
    // Register /start outside the deleted-user guard, clear only the hashed deletion marker
    // when that command is actually received, then let onboarding/app startup run normally.
    if (command === "start") {
      const wrapped = middleware.map(handler => typeof handler !== "function" ? handler : async function(ctx, next) {
        const uid = ctx?.from?.id ? String(ctx.from.id) : "";
        if (uid && ctx?.chat?.type === "private") reactivateDeletedUser(uid);
        return handler.call(this, ctx, next);
      });
      return withPreSupportUse(this, () => preSupportCommand.call(this, command, ...wrapped));
    }

    return supportCommand.call(this, command, ...middleware);
  };
  BotClass.prototype.callbackQuery = function(...args) {
    ensureSupport(this);
    return supportCallbackQuery.call(this, ...args);
  };
  BotClass.prototype.start = function(...args) {
    ensureSupport(this);
    return realStart.apply(this, args);
  };

  Object.defineProperty(BotClass.prototype, "__telepilotSupportEarlyInstalled", { value: true });
}
