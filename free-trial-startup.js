import { Api } from "grammy";
import { installFreeTrialUi, installFreeTrialWeb } from "./free-trial.js";

installFreeTrialWeb();
installFreeTrialUi(Api);
