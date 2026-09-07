import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telepilot-checkout-"));
process.env.DATA_DIR = temp;
process.env.TELEPILOT_SECURITY_SECRET = "checkout-test-secret-".padEnd(64, "x");
process.env.TELEPILOT_PAYMENT_TEST_UIDS = "12345";
process.env.NOWPAYMENTS_MODE = "sandbox";
process.env.TELEPILOT_SUPPORT_USERNAME = "noahxrp";

const store = await import("./crypto-checkout-store.js");
const provider = await import("./nowpayments-client.js");
const issuer = await import("./payment-key-issuer.js");
const service = await import("./crypto-payment-service.js");
const botUi = await import("./crypto-checkout-bot-ui.js");

assert.equal(store.CHECKOUT_PLANS["1d"].priceUsd, 5);
assert.equal(store.CHECKOUT_PLANS["7d"].priceUsd, 20);
assert.equal(store.CHECKOUT_PLANS["30d"].priceUsd, 50);
assert.equal(store.CHECKOUT_PLANS["90d"].priceUsd, 100);
assert.equal(store.CHECKOUT_PLANS["365d"].priceUsd, 180);
assert.equal(store.CHECKOUT_PLANS.lifetime.priceUsd, 300);
assert.deepEqual(Object.keys(store.CHECKOUT_CURRENCIES), ["ton", "sol", "eth", "btc"]);

const secret = process.env.TELEPILOT_SECURITY_SECRET;
const token = store.createCheckoutToken("12345", { secret, now: 1_000_000, ttlMs: 600_000 });
assert.equal(token.includes("12345"), false);
assert.deepEqual(store.readCheckoutToken(token, { secret, now: 1_100_000 }), { uid: "12345", exp: 1_600_000 });
assert.equal(store.readCheckoutToken(token + "x", { secret, now: 1_100_000 }), null);
assert.equal(store.readCheckoutToken(token, { secret, now: 1_700_000 }), null);

const providerCalls = [];
const providerFetch = async (url, init = {}) => {
  providerCalls.push({ url: String(url), init });
  if (String(url).endsWith("/payment") && init.method === "POST") {
    return { ok: true, status: 200, json: async () => ({ payment_id: 991122, payment_status: "waiting", pay_address: "sandbox-address", pay_amount: "1.25", pay_currency: "ton" }) };
  }
  if (String(url).endsWith("/payment/991122")) {
    return { ok: true, status: 200, json: async () => ({ payment_id: 991122, payment_status: "finished", pay_amount: "1.25", actually_paid: "1.25", pay_currency: "ton" }) };
  }
  throw new Error(`unexpected provider request ${url}`);
};

const created = await provider.createNowPayment({ orderId: "TPP-ABCDEF12", priceAmount: 5, payCurrency: "ton", description: "TelePilot 1 Day access key" }, {
  mode: "sandbox", apiKey: "sandbox-test-key", baseUrl: "https://api-sandbox.nowpayments.io/v1", fetchImpl: providerFetch,
});
assert.equal(created.paymentId, "991122");
const createBody = JSON.parse(providerCalls[0].init.body);
assert.equal(createBody.price_amount, 5);
assert.equal(createBody.price_currency, "usd");
assert.equal(createBody.pay_currency, "ton");
assert.equal(createBody.case, "success");

const issued = issuer.issuePaymentKey({ orderId: "TPP-KEYTEST12", uid: "12345", durationDays: 30, lifetime: false, providerPaymentId: "55" }, { dataDir: temp, secret });
assert.match(issued.key, /^TP-[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/);
assert.equal(issued.record.boundTo, "12345");
assert.equal(fs.readFileSync(path.join(temp, "access-keys.json"), "utf8").includes(issued.key), false);
const duplicate = issuer.issuePaymentKey({ orderId: "TPP-KEYTEST12", uid: "12345", durationDays: 30, lifetime: false, providerPaymentId: "55" }, { dataDir: temp, secret });
assert.equal(duplicate.alreadyIssued, true);
assert.equal(duplicate.key, issued.key);

const delivered = [];
const paymentOrder = await service.createPaymentOrder("12345", "1d", "ton", {
  mode: "sandbox", apiKey: "sandbox-test-key", baseUrl: "https://api-sandbox.nowpayments.io/v1", fetchImpl: providerFetch, dataDir: temp, secret,
  notifyKey: async (order, key) => delivered.push({ order: order.id, key }),
});
assert.equal(paymentOrder.providerStatus, "waiting");
assert.equal(paymentOrder.payAddress, "sandbox-address");

const finished = await service.refreshPaymentOrder(paymentOrder.id, {
  mode: "sandbox", apiKey: "sandbox-test-key", baseUrl: "https://api-sandbox.nowpayments.io/v1", fetchImpl: providerFetch, dataDir: temp, secret, force: true,
  notifyKey: async (order, key) => delivered.push({ order: order.id, key }),
});
assert.equal(finished.providerStatus, "finished");
assert.ok(finished.keyIssuedAt > 0);
assert.ok(finished.keySentAt > 0);
assert.equal(delivered.length, 1);
assert.match(delivered[0].key, /^TP-/);

await service.refreshPaymentOrder(paymentOrder.id, {
  mode: "sandbox", apiKey: "sandbox-test-key", baseUrl: "https://api-sandbox.nowpayments.io/v1", fetchImpl: providerFetch, dataDir: temp, secret, force: true,
  notifyKey: async (order, key) => delivered.push({ order: order.id, key }),
});
assert.equal(delivered.length, 1, "finished payment must not issue/deliver a second key");

const recoveryIssued = issuer.issuePaymentKey({ orderId: "TPP-RECOVERY12", uid: "12345", durationDays: 7, lifetime: false, providerPaymentId: "777" }, { dataDir: temp, secret });
store.putOrder({
  version: 1, id: "TPP-RECOVERY12", uid: "12345", planId: "7d", planLabel: "7 Days", priceUsd: 20, payCurrency: "sol",
  providerPaymentId: "777", providerStatus: "finished", payAddress: "sandbox", payAmount: "2", actuallyPaid: "2",
  createdAt: Date.now(), updatedAt: Date.now(), lastProviderCheckAt: Date.now(), encryptedKey: "", keyId: "", keyIssuedAt: 0, keySentAt: 0, sendAttempts: 0, lastError: "",
}, temp);
const recoveryDelivered = [];
const recovered = await service.fulfillOrder("TPP-RECOVERY12", { dataDir: temp, secret, notifyKey: async (order, key) => recoveryDelivered.push(key) });
assert.equal(recovered.key, recoveryIssued.key);
assert.equal(recoveryDelivered.length, 1);
assert.equal(recoveryDelivered[0], recoveryIssued.key);

const markup = { reply_markup: { inline_keyboard: [[{ text: "Get a Key", url: "https://t.me/noahxrp", icon_custom_emoji_id: "old" }]] } };
const decorated = botUi.decorateCryptoCheckoutLinks("12345", "Need one? Message @noahxrp.", markup, { publicUrl: "https://telepilot.example", secret });
const buttons = decorated.other.reply_markup.inline_keyboard.flat();
const getKey = buttons.find(button => button.text === "Get a Key");
assert.ok(getKey.url.startsWith("https://telepilot.example/checkout?t="));
assert.equal(getKey.url.includes("12345"), false);
assert.equal(getKey.icon_custom_emoji_id, "5307843983102204243");
assert.equal(buttons.some(button => button.url === "https://t.me/noahxrp" && /Message/.test(button.text)), true);
assert.match(decorated.text, /TelePilot Checkout/);

fs.rmSync(temp, { recursive: true, force: true });
console.log("crypto checkout v1 regression tests passed");
