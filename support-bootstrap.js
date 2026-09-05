// support-center.js historically registers its routes from Bot.start(). grammY composes
// middleware in registration order, so routes added only when polling starts are too late
// for an already-built bot. This adapter lets the existing support center register its
// routes on the first Bot registration call, while preserving the real start chain.
export function installSupportCenterEarly(BotClass, installSupportCenter) {
  if (!BotClass?.prototype || BotClass.prototype.__telepilotSupportEarlyInstalled) return;
  if (typeof installSupportCenter !== "function") throw new Error("TelePilot support installer is unavailable");

  const realStart = BotClass.prototype.start;
  if (typeof realStart !== "function") throw new Error("Unsupported grammY Bot start method");

  // Give support-center a non-starting baseStart. Calling its generated start wrapper
  // will therefore register handlers without starting Telegram polling.
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
    try {
      // registerSupport sets __telepilotSupportHandlersRegistered before adding routes.
      registerSupport.call(instance);
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
