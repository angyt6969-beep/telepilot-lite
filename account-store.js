import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getExternalSessionKey } from "./security-core.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USERS_DIR = path.join(DATA_DIR, "users");
const LEGACY_KEY_FILE = path.join(DATA_DIR, ".personal-session-key");
const EXTERNAL_KEY = getExternalSessionKey();

function userDir(uid) { return path.join(USERS_DIR, String(uid)); }
function accountsDir(uid) { return path.join(userDir(uid), "accounts"); }
function accountsFile(uid) { return path.join(userDir(uid), "accounts.json"); }
function legacySessionFile(uid) { return path.join(userDir(uid), "personal-session.enc"); }
function accountSessionFile(uid, accountId) { return path.join(accountsDir(uid), `${safeAccountId(accountId)}.enc`); }
function settingsFile(uid) { return path.join(userDir(uid), "settings.json"); }

function safeAccountId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid account ID");
  return id;
}
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function legacyKey() {
  try {
    const key = fs.readFileSync(LEGACY_KEY_FILE);
    return key.length === 32 ? key : null;
  } catch { return null; }
}
function keyForPayload(parsed) {
  if (parsed?.v === 2 && parsed?.keyVersion === "env") return EXTERNAL_KEY;
  if (parsed?.v === 1 || parsed?.keyVersion === "legacy") return legacyKey();
  return null;
}
function encryptSession(session) {
  const key = EXTERNAL_KEY || legacyKey();
  if (!key) throw new Error("Personal-session encryption key is unavailable");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(session), "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 2,
    keyVersion: EXTERNAL_KEY ? "env" : "legacy",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  });
}
function decryptPayload(raw) {
  const parsed = JSON.parse(String(raw));
  const key = keyForPayload(parsed);
  if (!key) throw new Error("Personal-session encryption key is unavailable");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
function dbFor(uid) {
  const raw = readJson(accountsFile(uid), { version: 2, accounts: [] });
  return {
    version: 2,
    accounts: Array.isArray(raw?.accounts) ? raw.accounts.filter(item => item && /^[A-Za-z0-9_-]{1,80}$/.test(String(item.id || ""))) : [],
  };
}
function saveDb(uid, db) {
  const seen = new Set();
  const accounts = [];
  for (const raw of db.accounts || []) {
    const id = String(raw?.id || "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    accounts.push({
      id,
      telegramId: /^\d+$/.test(String(raw.telegramId || "")) ? String(raw.telegramId) : "",
      username: String(raw.username || "").replace(/^@/, "").slice(0, 64),
      firstName: String(raw.firstName || "").slice(0, 80),
      lastName: String(raw.lastName || "").slice(0, 80),
      connectedAt: Number(raw.connectedAt || 0) || Date.now(),
      lastVerifiedAt: Number(raw.lastVerifiedAt || 0) || 0,
      status: ["connected", "needs-reconnect", "unknown"].includes(raw.status) ? raw.status : "unknown",
      lastError: String(raw.lastError || "").slice(0, 180),
    });
  }
  writeJsonAtomic(accountsFile(uid), { version: 2, accounts });
}
function migrateLegacy(uid) {
  const legacy = legacySessionFile(uid);
  if (!fs.existsSync(legacy)) return;
  const db = dbFor(uid);
  const existingLegacy = db.accounts.find(item => item.id === "legacy");
  if (!existingLegacy) {
    let username = "";
    try { username = String(readJson(settingsFile(uid), {}).personalUsername || "").replace(/^@/, ""); } catch {}
    fs.mkdirSync(accountsDir(uid), { recursive: true, mode: 0o700 });
    const target = accountSessionFile(uid, "legacy");
    if (!fs.existsSync(target)) fs.copyFileSync(legacy, target);
    db.accounts.push({ id: "legacy", telegramId: "", username, firstName: "", lastName: "", connectedAt: Date.now(), lastVerifiedAt: 0, status: "unknown", lastError: "" });
    saveDb(uid, db);
  }
  try { fs.rmSync(legacy, { force: true }); } catch {}
}
function normalizeMeta(item) {
  return {
    id: String(item.id),
    telegramId: String(item.telegramId || ""),
    username: String(item.username || ""),
    firstName: String(item.firstName || ""),
    lastName: String(item.lastName || ""),
    connectedAt: Number(item.connectedAt || 0) || 0,
    lastVerifiedAt: Number(item.lastVerifiedAt || 0) || 0,
    status: String(item.status || "unknown"),
    lastError: String(item.lastError || ""),
  };
}

export function listAccounts(uid) {
  migrateLegacy(uid);
  const db = dbFor(uid);
  return db.accounts.filter(item => {
    try { return fs.existsSync(accountSessionFile(uid, item.id)) && fs.statSync(accountSessionFile(uid, item.id)).size > 20; }
    catch { return false; }
  }).map(normalizeMeta);
}
export function hasAnyAccount(uid) { return listAccounts(uid).length > 0; }
export function countAccounts(uid) { return listAccounts(uid).length; }
export function getAccount(uid, accountId) { return listAccounts(uid).find(item => item.id === String(accountId)) || null; }
export function accountDisplayLabel(account) {
  if (!account) return "Personal account";
  if (account.username) return `@${String(account.username).replace(/^@/, "")}`;
  const name = [account.firstName, account.lastName].filter(Boolean).join(" ").trim();
  return name || (account.telegramId ? `Account ${account.telegramId}` : "Personal account");
}
export function loadAccountSession(uid, accountId) {
  migrateLegacy(uid);
  return decryptPayload(fs.readFileSync(accountSessionFile(uid, accountId), "utf8"));
}
export function saveAccountSession(uid, user, sessionString) {
  migrateLegacy(uid);
  const db = dbFor(uid);
  const telegramId = /^\d+$/.test(String(user?.id || "")) ? String(user.id) : "";
  const username = String(user?.username || "").replace(/^@/, "");
  let record = telegramId ? db.accounts.find(item => String(item.telegramId || "") === telegramId) : null;
  if (!record && username) record = db.accounts.find(item => String(item.username || "").toLowerCase() === username.toLowerCase());
  if (!record && db.accounts.length === 1 && db.accounts[0].id === "legacy" && !db.accounts[0].telegramId) record = db.accounts[0];
  if (!record) {
    const base = telegramId ? `tg_${telegramId}` : `acc_${crypto.randomBytes(8).toString("hex")}`;
    let id = base;
    let n = 2;
    while (db.accounts.some(item => item.id === id)) id = `${base}_${n++}`;
    record = { id, connectedAt: Date.now() };
    db.accounts.push(record);
  }
  record.telegramId = telegramId || String(record.telegramId || "");
  record.username = username;
  record.firstName = String(user?.firstName || user?.first_name || "");
  record.lastName = String(user?.lastName || user?.last_name || "");
  record.connectedAt = Number(record.connectedAt || 0) || Date.now();
  record.lastVerifiedAt = Date.now();
  record.status = "connected";
  record.lastError = "";
  fs.mkdirSync(accountsDir(uid), { recursive: true, mode: 0o700 });
  const file = accountSessionFile(uid, record.id);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, encryptSession(sessionString), { mode: 0o600 });
  fs.renameSync(temp, file);
  saveDb(uid, db);
  return normalizeMeta(record);
}
export function updateAccountStatus(uid, accountId, patch = {}) {
  migrateLegacy(uid);
  const db = dbFor(uid);
  const item = db.accounts.find(account => account.id === String(accountId));
  if (!item) return null;
  if (patch.username !== undefined) item.username = String(patch.username || "").replace(/^@/, "");
  if (patch.firstName !== undefined) item.firstName = String(patch.firstName || "");
  if (patch.lastName !== undefined) item.lastName = String(patch.lastName || "");
  if (patch.telegramId !== undefined && /^\d+$/.test(String(patch.telegramId || ""))) item.telegramId = String(patch.telegramId);
  if (patch.status !== undefined) item.status = String(patch.status || "unknown");
  if (patch.lastError !== undefined) item.lastError = String(patch.lastError || "").slice(0, 180);
  if (patch.lastVerifiedAt !== undefined) item.lastVerifiedAt = Number(patch.lastVerifiedAt || 0) || 0;
  saveDb(uid, db);
  return normalizeMeta(item);
}
export function removeAccount(uid, accountId) {
  migrateLegacy(uid);
  const db = dbFor(uid);
  const id = safeAccountId(accountId);
  const before = db.accounts.length;
  db.accounts = db.accounts.filter(item => item.id !== id);
  try { fs.rmSync(accountSessionFile(uid, id), { force: true }); } catch {}
  if (db.accounts.length !== before) saveDb(uid, db);
  return db.accounts.length !== before;
}
export function removeAllAccounts(uid) {
  migrateLegacy(uid);
  const db = dbFor(uid);
  for (const item of db.accounts) {
    try { fs.rmSync(accountSessionFile(uid, item.id), { force: true }); } catch {}
  }
  try { fs.rmSync(accountsDir(uid), { recursive: true, force: true }); } catch {}
  saveDb(uid, { version: 2, accounts: [] });
  try { fs.rmSync(legacySessionFile(uid), { force: true }); } catch {}
}
export function normalizeAccountSelection(settings, accounts = []) {
  const valid = new Set(accounts.map(item => String(item.id)));
  const selected = [...new Set((Array.isArray(settings?.selectedAccountIds) ? settings.selectedAccountIds : []).map(String).filter(id => valid.has(id)))];
  const requestedMode = String(settings?.senderMode || "");
  // Preserve legacy behaviour for profiles created before senderMode existed:
  // a connected personal account remains selected unless the user explicitly chooses Bot.
  const mode = requestedMode === "bot" ? "bot" : requestedMode === "all" ? "all" : "selected";
  if (mode === "selected" && !selected.length && accounts[0]) selected.push(String(accounts[0].id));
  return { mode, selected };
}
export function usesBotSender(settings, destination = null, accounts = []) {
  if (!accounts.length) return true;
  const routeMode = ["inherit", "bot", "all", "selected"].includes(destination?.accountMode) ? destination.accountMode : "inherit";
  if (routeMode === "bot") return true;
  if (routeMode !== "inherit") return false;
  return normalizeAccountSelection(settings, accounts).mode === "bot";
}
export function effectiveAccountIds(settings, destination = null, accounts = []) {
  if (!accounts.length) return [];
  const valid = new Set(accounts.map(item => String(item.id)));
  const routeMode = ["inherit", "bot", "all", "selected"].includes(destination?.accountMode) ? destination.accountMode : "inherit";
  if (routeMode === "bot") return [];
  if (routeMode === "all") return accounts.map(item => String(item.id));
  if (routeMode === "selected") {
    return [...new Set((Array.isArray(destination?.accountIds) ? destination.accountIds : []).map(String).filter(id => valid.has(id)))];
  }
  const global = normalizeAccountSelection(settings, accounts);
  if (global.mode === "bot") return [];
  return global.mode === "all" ? accounts.map(item => String(item.id)) : global.selected;
}
export function senderSummary(settings, accounts = []) {
  if (!accounts.length) return "TelePilot Bot";
  const selected = normalizeAccountSelection(settings, accounts);
  if (selected.mode === "bot") return "TelePilot Bot";
  if (selected.mode === "all") return accounts.length === 1 ? accountDisplayLabel(accounts[0]) : `All ${accounts.length} accounts`;
  if (selected.selected.length === 1) return accountDisplayLabel(accounts.find(item => item.id === selected.selected[0]));
  return `${selected.selected.length} selected accounts`;
}
