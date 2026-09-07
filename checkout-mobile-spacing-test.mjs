import assert from "node:assert/strict";
import { CHECKOUT_SPACING_CSS, injectCheckoutSpacing } from "./checkout-mobile-spacing.js";

const checkout = '<!doctype html><html><head><title>TelePilot Checkout</title></head><body><div class="payment"><div class="row"><span>Address</span><span class="value">LONG-ADDRESS</span></div></div></body></html>';
const injected = injectCheckoutSpacing(checkout);
assert.match(injected, /telepilot-checkout-spacing-v1/);
assert.match(injected, /line-height:1\.72/);
assert.match(injected, /overflow-wrap:anywhere/);
assert.match(injected, /grid-template-columns:minmax\(92px/);
assert.equal((injected.match(/telepilot-checkout-spacing-v1/g) || []).length, 1);
assert.equal(injectCheckoutSpacing(injected), injected, "spacing injection must be idempotent");

const unrelated = '<!doctype html><html><head><title>TelePilot Login</title></head><body>Login</body></html>';
assert.equal(injectCheckoutSpacing(unrelated), unrelated, "non-checkout HTML must remain untouched");
assert.match(CHECKOUT_SPACING_CSS, /\.payment\{margin-top:22px;padding:20px 18px/);
assert.match(CHECKOUT_SPACING_CSS, /\.row\{display:grid/);

console.log("checkout mobile spacing regression tests passed");
