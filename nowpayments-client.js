const MODE = String(process.env.NOWPAYMENTS_MODE || "disabled").toLowerCase();
const API_KEY = String(process.env.NOWPAYMENTS_API_KEY || "");

export const NOWPAYMENTS_BASE_URL = MODE === "sandbox"
  ? "https://api-sandbox.nowpayments.io/v1"
  : MODE === "production"
    ? "https://api.nowpayments.io/v1"
    : "";

export function nowPaymentsConfigured(options = {}) {
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

export async function createNowPayment(input, options = {}) {
  const mode = String(options.mode ?? MODE).toLowerCase();
  const payload = {
    price_amount: Number(input.priceAmount),
    price_currency: "usd",
    pay_currency: String(input.payCurrency || "").toLowerCase(),
    order_id: String(input.orderId || ""),
    order_description: String(input.description || "TelePilot access key").slice(0, 200),
    ...(mode === "sandbox" ? { case: "success" } : {}),
  };
  if (!Number.isFinite(payload.price_amount) || payload.price_amount <= 0) throw new Error("Invalid payment price");
  if (!/^(ton|sol|eth|btc)$/.test(payload.pay_currency)) throw new Error("Unsupported payment currency");
  if (!/^TPP-[A-Z0-9-]{8,80}$/.test(payload.order_id)) throw new Error("Invalid payment order ID");
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
