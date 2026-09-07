import crypto from "node:crypto";

const MODE = String(process.env.NOWPAYMENTS_MODE || "disabled").toLowerCase();
const API_KEY = String(process.env.NOWPAYMENTS_API_KEY || "");
const INTERNAL_TEST = String(process.env.TELEPILOT_INTERNAL_PAYMENT_TEST || "").toLowerCase();
const INTERNAL_FINISH_MS = 2_500;

export const NOWPAYMENTS_BASE_URL = MODE === "sandbox"
  ? "https://api-sandbox.nowpayments.io/v1"
  : MODE === "production"
    ? "https://api.nowpayments.io/v1"
    : "";

function internalTestEnabled(options = {}) {
  const mode = String(options.mode ?? MODE).toLowerCase();
  const value = String(options.internalTest ?? INTERNAL_TEST).toLowerCase();
  return mode === "sandbox" && ["1", "true", "yes", "on"].includes(value);
}

export function nowPaymentsConfigured(options = {}) {
  if (internalTestEnabled(options)) return true;
  const mode = String(options.mode ?? MODE).toLowerCase();
  const apiKey = String(options.apiKey ?? API_KEY);
  return ["sandbox", "production"].includes(mode) && apiKey.length > 0;
}

async function request(pathname, init = {}, options = {}) {
  const mode = String(options.mode ?? MODE).toLowerCase();
  const apiKey = String(options.apiKey ?? API_KEY);
  const baseUrl = String(options.baseUrl || (mode === "sandbox" ? "https://api-sandbox.nowpayments.io/v1" : mode === "production" ? "https://api.nowpayments.io/v1" : ""));
  if (!baseUrl || !apiKey) throw new Error("NOWPayments is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl || fetch)(`${baseUrl}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "x-api-key": apiKey,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(data?.message || data?.error || `NOWPayments HTTP ${response.status}`));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function internalPaymentId(options = {}) {
  const now = Math.max(0, Math.floor(Number(options.now ?? Date.now())));
  const randomInt = typeof options.randomInt === "function" ? options.randomInt : crypto.randomInt;
  const suffix = Math.max(0, Math.min(999, Number(randomInt(0, 1000)) || 0));
  return `9${String(now).padStart(13, "0").slice(-13)}${String(suffix).padStart(3, "0")}`;
}
function internalCreatedAt(paymentId) {
  const match = String(paymentId || "").match(/^9(\d{13})\d{3}$/);
  return match ? Number(match[1]) : 0;
}

export async function createNowPayment(input, options = {}) {
  const mode = String(options.mode ?? MODE).toLowerCase();
  const payload = {
    price_amount: Number(input.priceAmount),
    price_currency: "usd",
    pay_currency: String(input.payCurrency || "").toLowerCase(),
    order_id: String(input.orderId || ""),
    order_description: String(input.description || "TelePilot access key").slice(0, 200),
    ...(mode === "sandbox" && !internalTestEnabled(options) ? { case: "success" } : {}),
  };
  if (!Number.isFinite(payload.price_amount) || payload.price_amount <= 0) throw new Error("Invalid payment price");
  if (!/^(ton|sol|eth|btc)$/.test(payload.pay_currency)) throw new Error("Unsupported payment currency");
  if (!/^TPP-[A-Z0-9-]{8,80}$/.test(payload.order_id)) throw new Error("Invalid payment order ID");

  // Internal simulation is deliberately possible only while the service is in
  // sandbox mode. It never calls NOWPayments and therefore can never move funds.
  // The checkout service separately restricts sandbox access to owner/admin and
  // TELEPILOT_PAYMENT_TEST_UIDS before this function is reached.
  if (internalTestEnabled(options)) {
    return {
      paymentId: internalPaymentId(options),
      status: "waiting",
      payAddress: "INTERNAL-TEST-NO-PAYMENT-REQUIRED",
      payAmount: "0",
      payCurrency: payload.pay_currency,
    };
  }

  const data = await request("/payment", { method: "POST", body: JSON.stringify(payload) }, options);
  if (!data?.payment_id || !data?.pay_address || data?.pay_amount == null) throw new Error("NOWPayments returned incomplete payment details");
  return {
    paymentId: String(data.payment_id),
    status: String(data.payment_status || "waiting").toLowerCase(),
    payAddress: String(data.pay_address),
    payAmount: String(data.pay_amount),
    payCurrency: String(data.pay_currency || payload.pay_currency).toLowerCase(),
  };
}

export async function getNowPayment(paymentId, options = {}) {
  if (!/^\d+$/.test(String(paymentId || ""))) throw new Error("Invalid NOWPayments payment ID");

  if (internalTestEnabled(options)) {
    const createdAt = internalCreatedAt(paymentId);
    if (!createdAt) throw new Error("Invalid internal test payment ID");
    const now = Math.max(0, Math.floor(Number(options.now ?? Date.now())));
    const finishAfterMs = Math.max(500, Number(options.internalFinishMs || INTERNAL_FINISH_MS));
    return {
      paymentId: String(paymentId),
      status: now - createdAt >= finishAfterMs ? "finished" : "waiting",
      payAmount: "0",
      actuallyPaid: "0",
      payCurrency: "",
    };
  }

  const data = await request(`/payment/${encodeURIComponent(String(paymentId))}`, { method: "GET" }, options);
  return {
    paymentId: String(data.payment_id || paymentId),
    status: String(data.payment_status || "").toLowerCase(),
    payAmount: data.pay_amount == null ? "" : String(data.pay_amount),
    actuallyPaid: data.actually_paid == null ? "" : String(data.actually_paid),
    payCurrency: String(data.pay_currency || "").toLowerCase(),
  };
}

export function paymentIsFinished(status) {
  return String(status || "").toLowerCase() === "finished";
}
