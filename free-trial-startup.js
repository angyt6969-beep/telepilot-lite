import { Api, Bot } from "grammy";
import { installFreeTrialTutorialTracking, installFreeTrialUi, installFreeTrialWeb } from "./free-trial.js";

installFreeTrialWeb();
installFreeTrialTutorialTracking(Bot);
installFreeTrialUi(Api);
