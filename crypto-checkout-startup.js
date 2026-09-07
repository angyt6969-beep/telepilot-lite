import { Api } from "grammy";
import { installCryptoCheckoutWeb } from "./crypto-checkout-web.js";
import { installCryptoCheckoutBotUi } from "./crypto-checkout-bot-ui.js";

installCryptoCheckoutWeb();
installCryptoCheckoutBotUi(Api);
