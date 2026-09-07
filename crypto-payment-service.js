import { createNowPayment, getNowPayment, nowPaymentsConfigured, paymentIsFinished } from "./nowpayments-client.js";
import { createOrder, findOrder, putOrder, planFor, currencyFor, readOrders } from "./crypto-checkout-store.js";
import { issuePaymentKey, decryptIssuedKey } from "./payment-key-issuer.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const BOT_TOKEN = String(process.env.BOT_TOKEN || "");
const PAYMENT_MODE = String(process.env.NOWPAYMENTS_MODE || "disabled").toLowerCase();
const POLL_INTERVAL_MS = 15_000;
const PROVIDER_REFRESH_MS = 10_000;

function testerIds() {
  const ids = new Set();
  for (const raw of [process.env.TELEPILOT_ADMIN_ID, process.env.OWNER_ID, process.env.TELEPILOT_PAYMENT_TEST_UIDS]) {
    for (const value of String(raw || "").split(/[\s,;]+/)) if (/^\d+$/.test(value)) ids.add(value);
  }
  return ids;
}
export function paymentAllowed(uid, mode = PAYMENT_MODE) {
  return mode !== "sandbox" || testerIds().has(String(uid || ""));
}
function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function telegramSend(payload, options = {}) {
  if (!BOT_TOKEN && !options.botToken) throw new Error("BOT_TOKEN is unavailable for key delivery");
  const token = String(options.botToken || BOT_TOKEN);
  const response = await (options.fetchImpl || fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok !== true) throw new Error(String(data?.description || `Telegram HTTP ${response.status}`));
  return true;
}
export async function deliverPaymentKey(order, key, options = {}) {
  if (typeof options.notifyKey === "function") return options.notifyKey(order, key);
  const plan = planFor(order.planId);
  const coin = currencyFor(order.payCurrency);
  return telegramSend({
    chat_id: Number(order.uid),
    parse_mode: "HTML",
    text: [
      "✅ <b>Payment confirmed</b>",
      "",
      `<b>Plan:</b> — ${escapeHtml(plan?.label || order.planLabel)}`,
      `<b>Price:</b> — $${Number(order.priceUsd || 0)}`,
      `<b>Paid with:</b> — ${escapeHtml(coin?.label || String(order.payCurrency || "").toUpperCase())}`,
      "",
      "🔑 <b>Your TelePilot key:</b>",
      `<code>${escapeHtml(key)}</code>`,
      "",
      "<i>This key is bound to your Telegram account. Redeem it in TelePilot to activate access.</i>",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Copy key", copy_text: { text: key } }],
        [{ text: "✈️ Open TelePilot", url: "https://t.me/TelePilottBot" }],
      ],
    },
  }, options);
}

const locks = new Map();
async function withLock(id, fn) {
  const key = String(id);
  const previous = locks.get(key) || Promise.resolve();
  let tracked;
  const run = previous.catch(() => {}).then(fn);
  tracked = run.finally(() => { if (locks.get(key) === tracked) locks.delete(key); });
  locks.set(key, tracked);
  return tracked;
}

export async function fulfillOrder(orderId, options = {}) {
  return withLock(orderId, async () => {
    const dataDir = options.dataDir || DATA_DIR;
    let order = findOrder(orderId, dataDir);
    if (!order) throw new Error("Payment order not found");
    if (!paymentIsFinished(order.providerStatus)) return { fulfilled: false, order };
    let key = order.encryptedKey ? decryptIssuedKey(order.encryptedKey, order.id, options) : "";
    if (!order.keyId) {
      const issued = issuePaymentKey({
        orderId: order.id,
        uid: order.uid,
        durationDays: planFor(order.planId)?.durationDays,
        lifetime: planFor(order.planId)?.lifetime === true,
        providerPaymentId: order.providerPaymentId,
      }, options);
      key = issued.key;
      order = findOrder(order.id, dataDir) || order;
      order.keyId = issued.record.id;
      order.encryptedKey = issued.encryptedKey;
      order.keyIssuedAt = Number(order.keyIssuedAt || 0) || Date.now();
      order.updatedAt = Date.now();
      putOrder(order, dataDir);
    }
    if (!key) key = decryptIssuedKey(order.encryptedKey, order.id, options);
    if (!key) throw new Error("Issued key could not be recovered");
    if (!order.keySentAt) {
      order.sendAttempts = Number(order.sendAttempts || 0) + 1;
      putOrder(order, dataDir);
      await deliverPaymentKey(order, key, options);
      order = findOrder(order.id, dataDir) || order;
      order.keySentAt = Date.now();
      order.lastError = "";
      order.updatedAt = Date.now();
      putOrder(order, dataDir);
    }
    return { fulfilled: true, order, key };
  });
}

export async function createPaymentOrder(uid, planId, payCurrency, options = {}) {
  const dataDir = options.dataDir || DATA_DIR;
  if (!paymentAllowed(uid, options.mode || PAYMENT_MODE)) throw new Error("Sandbox checkout is limited to approved tester accounts");
  if (!nowPaymentsConfigured(options)) throw new Error("Crypto checkout is not configured yet");
  const order = createOrder(uid, planId, payCurrency, dataDir);
  try {
    const payment = await createNowPayment({
      orderId: order.id,
      priceAmount: order.priceUsd,
      payCurrency: order.payCurrency,
      description: `TelePilot ${order.planLabel} access key`,
    }, options);
    const current = findOrder(order.id, dataDir) || order;
    current.providerPaymentId = payment.paymentId;
    current.providerStatus = payment.status;
    current.payAddress = payment.payAddress;
    current.payAmount = payment.payAmount;
    current.payCurrency = payment.payCurrency;
    current.lastProviderCheckAt = Date.now();
    current.updatedAt = Date.now();
    putOrder(current, dataDir);
    if (paymentIsFinished(current.providerStatus)) await fulfillOrder(current.id, options);
    return findOrder(current.id, dataDir) || current;
  } catch (err) {
    const current = findOrder(order.id, dataDir) || order;
    current.providerStatus = "failed";
    current.lastError = String(err?.message || err).slice(0, 240);
    current.updatedAt = Date.now();
    putOrder(current, dataDir);
    throw err;
  }
}

export async function refreshPaymentOrder(orderId, options = {}) {
  const dataDir = options.dataDir || DATA_DIR;
  let order = findOrder(orderId, dataDir);
  if (!order || !order.providerPaymentId) return order;
  if (["failed", "refunded", "expired"].includes(String(order.providerStatus || ""))) return order;
  if (paymentIsFinished(order.providerStatus) && order.keySentAt) return order;
  if (!options.force && Date.now() - Number(order.lastProviderCheckAt || 0) < PROVIDER_REFRESH_MS) return order;
  try {
    const payment = await getNowPayment(order.providerPaymentId, options);
    order = findOrder(order.id, dataDir) || order;
    order.providerStatus = payment.status || order.providerStatus;
    if (payment.payAmount) order.payAmount = payment.payAmount;
    if (payment.actuallyPaid) order.actuallyPaid = payment.actuallyPaid;
    if (payment.payCurrency) order.payCurrency = payment.payCurrency;
    order.lastProviderCheckAt = Date.now();
    order.lastError = "";
    order.updatedAt = Date.now();
    putOrder(order, dataDir);
  } catch (err) {
    order.lastProviderCheckAt = Date.now();
    order.lastError = String(err?.message || err).slice(0, 240);
    order.updatedAt = Date.now();
    putOrder(order, dataDir);
    return order;
  }
  if (paymentIsFinished(order.providerStatus)) {
    try { return (await fulfillOrder(order.id, options)).order; }
    catch (err) {
      order = findOrder(order.id, dataDir) || order;
      order.lastError = String(err?.message || err).slice(0, 240);
      order.updatedAt = Date.now();
      putOrder(order, dataDir);
    }
  }
  return order;
}

let workerStarted = false;
export function startPaymentWorker(options = {}) {
  if (workerStarted) return false;
  workerStarted = true;
  const tick = async () => {
    if (!nowPaymentsConfigured(options)) return;
    const rows = readOrders(options.dataDir || DATA_DIR).orders
      .filter(order => order?.providerPaymentId && (!paymentIsFinished(order.providerStatus) || !order.keySentAt) && !["failed", "refunded", "expired"].includes(String(order.providerStatus || "")))
      .slice(-100);
    for (const order of rows) {
      try { await refreshPaymentOrder(order.id, options); }
      catch (err) { console.warn(`TelePilot payment refresh failed ${order.id}:`, err?.message || err); }
    }
  };
  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 3_000).unref?.();
  console.log(`TelePilot crypto payment worker enabled (${PAYMENT_MODE}; ${nowPaymentsConfigured(options) ? "provider configured" : "waiting for provider credentials"})`);
  return true;
}
