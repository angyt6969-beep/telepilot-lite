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
  if (typeof realStart !== "function" || typeof preSupportUse !== "function") {
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

  let ensuring = false;
  function ensureSupport(instance) {
    if (!instance || instance.__telepilotSupportHandlersRegistered || ensuring) return;
    ensuring = true;

    const hadOwnUse = Object.prototype.hasOwnProperty.call(instance, "use");
    const ownUse = hadOwnUse ? instance.use : undefined;
    try {
      // grammY's callbackQuery()/command() use this.use() internally. During support route
      // registration that must be the pre-support implementation, otherwise supportIntent()
      // skips the very route being registered.
      Object.defineProperty(instance, "use", {
        configurable: true,
        writable: true,
        value: (...args) => preSupportUse.call(instance, ...args),
      });
      registerSupport.call(instance);
    } finally {
      if (hadOwnUse) {
        Object.defineProperty(instance, "use", { configurable: true, writable: true, value: ownUse });
      } else {
        delete instance.use;
      }
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
  BotClass.prototype.command = function(...args) {
    ensureSupport(this);
    return supportCommand.call(this, ...args);
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
