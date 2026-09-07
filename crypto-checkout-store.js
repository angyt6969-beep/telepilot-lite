import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || "/data";
const SECURITY_SECRET = String(process.env.TELEPILOT_SECURITY_SECRET || "");
const TOKEN_TTL_MS = 2 * 60 * 60_000;

export const CHECKOUT_PLANS = Object.freeze({
  "1d": Object.freeze({ id: "1d", label: "1 Day", priceUsd: 5, durationDays: 1, lifetime: false }),
  "7d": Object.freeze({ id: "7d", label: "7 Days", priceUsd: 20, durationDays: 7, lifetime: false }),
  "30d": Object.freeze({ id: "30d", label: "30 Days", priceUsd: 50, durationDays: 30, lifetime: false }),
  "90d": Object.freeze({ id: "90d", label: "90 Days", priceUsd: 100, durationDays: 90, lifetime: false }),
  "365d": Object.freeze({ id: "365d", label: "1 Year", priceUsd: 180, durationDays: 365, lifetime: false }),
  lifetime: Object.freeze({ id: "lifetime", label: "Lifetime", priceUsd: 300, durationDays: null, lifetime: true }),
});
export const CHECKOUT_CURRENCIES = Object.freeze({
  ton: Object.freeze({ id: "ton", label: "TON" }),
  sol: Object.freeze({ id: "sol", label: "SOL" }),
  eth: Object.freeze({ id: "eth", label: "ETH" }),
  btc: Object.freeze({ id: "btc", label: "BTC" }),
});

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
function derive(label, secret = SECURITY_SECRET) {
  if (String(secret || "").length < 32) throw new Error("TelePilot checkout security secret is unavailable");
  return crypto.createHmac("sha256", secret).update(String(label)).digest();
}
function seal(value, label, secret = SECURITY_SECRET) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derive(label, secret), iv);
  const body = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
function unseal(value, label, secret = SECURITY_SECRET) {
  try {
    const raw = Buffer.from(String(value || ""), "base64url");
    if (raw.length < 29) return "";
    const decipher = crypto.createDecipheriv("aes-256-gcm", derive(label, secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

export function createCheckoutToken(uid, options = {}) {
  const id = String(uid || "");
  if (!/^\d+$/.test(id)) throw new Error("Invalid Telegram user ID");
  const now = Number(options.now || Date.now());
  const ttlMs = Math.min(6 * 60 * 60_000, Math.max(5 * 60_000, Number(options.ttlMs || TOKEN_TTL_MS)));
  return seal(JSON.stringify({ v: 1, uid: id, exp: now + ttlMs, nonce: crypto.randomBytes(12).toString("base64url") }), "checkout-session-v1", options.secret || SECURITY_SECRET);
}
export function readCheckoutToken(token, options = {}) {
  const raw = unseal(token, "checkout-session-v1", options.secret || SECURITY_SECRET);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const now = Number(options.now || Date.now());
    if (value?.v !== 1 || !/^\d+$/.test(String(value?.uid || "")) || Number(value?.exp || 0) <= now) return null;
    return { uid: String(value.uid), exp: Number(value.exp) };
  } catch { return null; }
}
export function checkoutCookie(token, maxAgeSeconds = Math.floor(TOKEN_TTL_MS / 1000)) {
  return `__Host-telepilot_checkout=${encodeURIComponent(String(token || ""))}; Path=/; Max-Age=${Math.max(0, maxAgeSeconds)}; HttpOnly; Secure; SameSite=Lax`;
}
export function planFor(id) { return CHECKOUT_PLANS[String(id || "")] || null; }
export function currencyFor(id) { return CHECKOUT_CURRENCIES[String(id || "").toLowerCase()] || null; }

function dbPath(dataDir = DATA_DIR) { return path.join(dataDir, "payment-orders.json"); }
export function readOrders(dataDir = DATA_DIR) {
  const raw = readJson(dbPath(dataDir), { version: 1, orders: [] });
  return { version: 1, orders: Array.isArray(raw?.orders) ? raw.orders : [] };
}
export function saveOrders(db, dataDir = DATA_DIR) {
  const rows = Array.isArray(db?.orders) ? db.orders : [];
  const pending = rows.filter(order => !["finished", "failed", "refunded", "expired"].includes(String(order?.providerStatus || "")) || !order?.keySentAt);
  const terminal = rows.filter(order => !pending.includes(order)).slice(-5000);
  writeJsonAtomic(dbPath(dataDir), { version: 1, orders: [...terminal, ...pending] });
}
export function findOrder(id, dataDir = DATA_DIR) {
  return readOrders(dataDir).orders.find(order => String(order?.id || "") === String(id || "")) || null;
}
export function putOrder(order, dataDir = DATA_DIR) {
  const db = readOrders(dataDir);
  const index = db.orders.findIndex(row => String(row?.id || "") === String(order?.id || ""));
  if (index < 0) db.orders.push(order); else db.orders[index] = order;
  saveOrders(db, dataDir);
  return order;
}
export function createOrder(uid, planId, payCurrency, dataDir = DATA_DIR) {
  const plan = planFor(planId), currency = currencyFor(payCurrency);
  if (!/^\d+$/.test(String(uid || "")) || !plan || !currency) throw new Error("Invalid checkout order");
  const order = {
    version: 1,
    id: `TPP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
    uid: String(uid), planId: plan.id, planLabel: plan.label, priceUsd: plan.priceUsd, payCurrency: currency.id,
    providerPaymentId: "", providerStatus: "creating", payAddress: "", payAmount: "", actuallyPaid: "",
    createdAt: Date.now(), updatedAt: Date.now(), lastProviderCheckAt: 0,
    encryptedKey: "", keyId: "", keyIssuedAt: 0, keySentAt: 0, sendAttempts: 0, lastError: "",
  };
  return putOrder(order, dataDir);
}
