import { Api, Bot } from "grammy";
import { installFreeTrialTutorialTracking, installFreeTrialUi, installFreeTrialWeb } from "./free-trial.js";

// Free-trial web, tutorial tracking and UI hooks are installed before app startup.
installFreeTrialWeb();
installFreeTrialTutorialTracking(Bot);
installFreeTrialUi(Api);
