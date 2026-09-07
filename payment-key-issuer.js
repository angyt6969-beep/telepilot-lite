import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { secureLicenseHash } from "./security-core.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const SECURITY_SECRET = String(process.env.TELEPILOT_SECURITY_SECRET || "");
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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
  if (String(secret || "").length < 32) throw new Error("TelePilot payment encryption secret is unavailable");
  return crypto.createHmac("sha256", secret).update(String(label)).digest();
}
function encryptKey(key, orderId, secret = SECURITY_SECRET) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derive(`payment-key:${orderId}`, secret), iv);
  const body = Buffer.concat([cipher.update(String(key), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
export function decryptIssuedKey(encrypted, orderId, options = {}) {
  try {
    const raw = Buffer.from(String(encrypted || ""), "base64url");
    if (raw.length < 29) return "";
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), body = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", derive(`payment-key:${orderId}`, options.secret || SECURITY_SECRET), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch { return ""; }
}
function randomSegment(length = 5) {
  let out = "";
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  return out;
}
function makeKey() { return `TP-${randomSegment()}-${randomSegment()}-${randomSegment()}-${randomSegment()}`; }

export function issuePaymentKey(input, options = {}) {
  const dataDir = options.dataDir || DATA_DIR;
  const file = path.join(dataDir, "access-keys.json");
  const raw = readJson(file, { version: 2, keys: [] });
  const db = { version: 2, keys: Array.isArray(raw?.keys) ? raw.keys : [] };
  const orderId = String(input.orderId || "");
  const uid = String(input.uid || "");
  if (!/^TPP-[A-Z0-9-]{8,80}$/.test(orderId)) throw new Error("Invalid payment order ID");
  if (!/^\d+$/.test(uid)) throw new Error("Invalid Telegram user ID");
  const existing = db.keys.find(row => String(row?.paymentOrderId || "") === orderId);
  if (existing) {
    const encryptedKey = String(existing.paymentEncryptedKey || "");
    const key = decryptIssuedKey(encryptedKey, orderId, options);
    if (!encryptedKey || !key) throw new Error("Existing payment key cannot be recovered safely");
    return { record: existing, key, encryptedKey, alreadyIssued: true };
  }
  const lifetime = input.lifetime === true;
  const durationDays = lifetime ? null : Number(input.durationDays);
  if (!lifetime && (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650)) throw new Error("Invalid key duration");
  let key = "", hash = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    key = makeKey();
    hash = secureLicenseHash(key);
    if (!db.keys.some(row => String(row?.hash || "") === hash)) break;
    key = "";
  }
  if (!key) throw new Error("Could not allocate a unique TelePilot key");
  const encryptedKey = encryptKey(key, orderId, options.secret || SECURITY_SECRET);
  const record = {
    id: crypto.randomBytes(5).toString("hex"),
    hash,
    hashVersion: 2,
    hint: `${key.slice(0, 8)}-•••••-•••••-•••••`,
    durationDays,
    lifetime,
    boundTo: uid,
    createdAt: Date.now(),
    redeemedAt: null,
    redeemedBy: null,
    revokedAt: null,
    source: "nowpayments",
    paymentOrderId: orderId,
    providerPaymentId: String(input.providerPaymentId || ""),
    paymentEncryptedKey: encryptedKey,
  };
  db.keys.push(record);
  writeJsonAtomic(file, db);
  return { record, key, encryptedKey, alreadyIssued: false };
}
