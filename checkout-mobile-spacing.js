import http from "node:http";

export const CHECKOUT_SPACING_CSS = `
<style id="telepilot-checkout-spacing-v1">
.sub{line-height:1.68;margin-top:16px}
.status{margin-top:25px;padding:16px 17px;line-height:1.55}
.section{margin-top:26px}
.label{margin-bottom:12px}
.grid{gap:12px}
.opt{min-height:58px;padding:12px 14px}
.opt span{margin-top:5px;line-height:1.4}
.primary{min-height:55px;margin-top:22px}
.payment{margin-top:22px;padding:20px 18px;border-radius:19px}
.row{display:grid;grid-template-columns:minmax(92px,.72fr) minmax(0,1.28fr);align-items:start;gap:18px;padding:10px 0;font-size:13px;line-height:1.5}
.row span:first-child{line-height:1.5}
.value{line-height:1.5;word-break:normal;overflow-wrap:anywhere}
.copy{margin-top:12px;min-height:46px;padding:9px 12px;line-height:1.35}
.error{margin-top:16px;line-height:1.5}
.manual{margin-top:26px;padding-top:22px;line-height:1.65}
@media(max-width:560px){
  body{padding:16px 14px 24px}
  .card{padding:28px 22px 30px}
  .brand{margin-bottom:22px}
  .eyebrow{margin-bottom:18px}
  h1{line-height:1.12}
  .sub{margin-top:18px;line-height:1.72}
  .status{margin-top:27px;padding:17px 18px;line-height:1.58}
  .section{margin-top:30px}
  .grid{gap:12px}
  .opt{min-height:62px;padding:13px 14px}
  .primary{min-height:58px;margin-top:24px}
  .payment{margin-top:24px;padding:21px 18px}
  .row{gap:16px;padding:11px 0;line-height:1.55}
  .value{line-height:1.55}
  .copy{margin-top:13px;min-height:48px}
  .manual{margin-top:29px;padding-top:24px;line-height:1.72}
  .footer{margin-top:18px;line-height:1.5}
}
@media(max-width:390px){
  .card{padding:26px 19px 28px}
  .payment{padding:19px 15px}
  .row{grid-template-columns:88px minmax(0,1fr);gap:12px}
}
</style>`;

export function injectCheckoutSpacing(html) {
  const source = String(html ?? "");
  if (!source.includes("TelePilot Checkout") || source.includes("telepilot-checkout-spacing-v1")) return source;
  if (source.includes("</head>")) return source.replace("</head>", `${CHECKOUT_SPACING_CSS}</head>`);
  return source;
}

export function installCheckoutMobileSpacing() {
  if (http.__telepilotCheckoutMobileSpacingInstalled) return false;
  Object.defineProperty(http, "__telepilotCheckoutMobileSpacingInstalled", { value: true });
  const previousCreateServer = http.createServer.bind(http);
  http.createServer = function(...args) {
    const index = args.findIndex(value => typeof value === "function");
    if (index < 0) return previousCreateServer(...args);
    const listener = args[index];
    args[index] = function(req, res) {
      const originalEnd = res.end.bind(res);
      res.end = function(chunk, encoding, callback) {
        let body = chunk;
        const isCheckout = String(req?.url || "").split("?", 1)[0] === "/checkout";
        const contentType = String(res.getHeader?.("content-type") || "").toLowerCase();
        if (isCheckout && contentType.includes("text/html") && (typeof chunk === "string" || Buffer.isBuffer(chunk))) {
          const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          body = injectCheckoutSpacing(text);
        }
        return originalEnd(body, encoding, callback);
      };
      return listener(req, res);
    };
    return previousCreateServer(...args);
  };
  return true;
}

installCheckoutMobileSpacing();
