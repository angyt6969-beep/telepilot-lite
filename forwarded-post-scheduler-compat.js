import fs from "node:fs";
import path from "node:path";
import { readForwardedPostConfig } from "./forwarded-post-v1.js";
import { reloadUserState } from "./runtime-hooks.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
export const FORWARD_SCHEDULER_SENTINEL = "\u2063";

function settingsFile(uid) {
  return path.join(USERS_DIR, String(uid), "settings.json");
}

function readJson(file, fallback = {}) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function schedulerSettingsForMode(settings, forwardedEnabled) {
  const current = settings && typeof settings === "object" && !Array.isArray(settings)
    ? { ...settings }
    : {};
  const message = typeof current.adMessage === "string" ? current.adMessage : "";

  if (forwardedEnabled === true && message.length === 0) {
    return {
      settings: { ...current, adMessage: FORWARD_SCHEDULER_SENTINEL, adEntities: [] },
      changed: true,
      insertedPlaceholder: true,
      removedPlaceholder: false,
    };
  }

  if (forwardedEnabled !== true && message === FORWARD_SCHEDULER_SENTINEL) {
    return {
      settings: { ...current, adMessage: "", adEntities: [] },
      changed: true,
      insertedPlaceholder: false,
      removedPlaceholder: true,
    };
  }

  return {
    settings: current,
    changed: false,
    insertedPlaceholder: false,
    removedPlaceholder: false,
  };
}

function syncSchedulerState(uid) {
  const key = String(uid || "");
  if (!/^\d+$/.test(key)) return { changed: false, forwardedEnabled: false, placeholder: false };

  let cfg;
  try { cfg = readForwardedPostConfig(key); }
  catch { return { changed: false, forwardedEnabled: false, placeholder: false }; }

  const file = settingsFile(key);
  const existing = readJson(file, {});
  const beforePlaceholder = existing?.adMessage === FORWARD_SCHEDULER_SENTINEL;
  const result = schedulerSettingsForMode(existing, cfg?.enabled === true);

  if (result.changed) {
    writeJsonAtomic(file, result.settings);
    try { reloadUserState(key); } catch {}
  }

  return {
    changed: result.changed,
    forwardedEnabled: cfg?.enabled === true,
    placeholder: result.settings?.adMessage === FORWARD_SCHEDULER_SENTINEL,
    beforePlaceholder,
    insertedPlaceholder: result.insertedPlaceholder,
    removedPlaceholder: result.removedPlaceholder,
  };
}

function rewriteUiText(text, sync) {
  let value = String(text || "");
  if (!value) return value;

  if (sync?.forwardedEnabled) {
    value = value.replace(/📝 Message:\s*✅ Set \(\d+ chars?\)/i, "📝 Message: ✅ Forwarded Post");
    if (sync.placeholder) {
      value = value.replace(/✅ Saved\s*•\s*1 characters?/i, "✅ Forward source active");
    }
    return value;
  }

  if (sync?.removedPlaceholder || sync?.beforePlaceholder) {
    value = value.replace(/📝 Message:\s*✅ Set \(1 chars?\)/i, "📝 Message: ❌ Not set");
    value = value.replace(/✅ Saved\s*•\s*1 characters?/i, "❌ No message set yet.");
  }
  return value;
}

export function migrateForwardedPostSchedulerState() {
  let changed = 0;
  let scanned = 0;
  try {
    if (!fs.existsSync(USERS_DIR)) return { scanned, changed };
    for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      scanned += 1;
      try {
        if (syncSchedulerState(entry.name).changed) changed += 1;
      } catch {}
    }
  } catch {}
  return { scanned, changed };
}

export function installForwardedPostSchedulerCompat(ApiClass) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotForwardedPostSchedulerCompatInstalled) return false;
  const originalSendMessage = ApiClass.prototype.sendMessage;
  const originalEditMessageText = ApiClass.prototype.editMessageText;
  if (typeof originalSendMessage !== "function" || typeof originalEditMessageText !== "function") {
    throw new Error("Unsupported grammY Api shape for Forwarded Post scheduler compatibility");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotForwardedPostSchedulerCompatInstalled", { value: true });

  const migration = migrateForwardedPostSchedulerState();
  if (migration.changed) {
    console.log(`TelePilot Forwarded Post scheduler compatibility repaired ${migration.changed}/${migration.scanned} user profile(s)`);
  }

  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const sync = /^\d+$/.test(String(chatId || "")) ? syncSchedulerState(String(chatId)) : null;
    return originalSendMessage.call(this, chatId, rewriteUiText(text, sync), other, ...rest);
  };

  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const sync = /^\d+$/.test(String(chatId || "")) ? syncSchedulerState(String(chatId)) : null;
    return originalEditMessageText.call(this, chatId, messageId, rewriteUiText(text, sync), other, ...rest);
  };
  return true;
}

export const __test = { rewriteUiText };
