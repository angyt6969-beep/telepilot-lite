// Compatibility bridge for older TelePilot modules.
// The previous destination automation subsystem was removed. All active logic now
// lives in destinations-v2.js and performs manual access checks only.
import {
  destinationAccountReady as destinationAccountReadyV2,
  destinationsHomeScreen,
  handleDestinationText,
  parseDestinationInput,
  processRoutingQueue,
  queueRoutingSync,
  recheckDestinations,
} from "./destinations-v2.js";
import { recordDestinationFailure } from "./destination-failure-v2.js";

export {
  handleDestinationText,
  parseDestinationInput,
  processRoutingQueue,
  queueRoutingSync,
  recheckDestinations,
  recordDestinationFailure,
};

// app.js still calls this historical rendering contract. It now renders the new
// Destination Hub only; none of the removed legacy automation behavior is used.
export function destinationMenu(uid) {
  const screen = destinationsHomeScreen(String(uid || ""));
  return {
    text: screen.text,
    keyboard: {
      inline_keyboard: (screen.rows || []).filter(row => Array.isArray(row) && row.length),
    },
  };
}

export function destinationAccountReady(destination, accountId = "") {
  const map = destination?.accountJoin && typeof destination.accountJoin === "object" && !Array.isArray(destination.accountJoin)
    ? destination.accountJoin
    : {};
  if (!Object.keys(map).length) {
    if (destination?.topicRequired === true && !Number(destination?.topicId || 0)) return false;
    return String(destination?.joinStatus || "ready") === "ready";
  }
  return destinationAccountReadyV2(destination, accountId);
}

export function installDestinationAutomation() {
  // Intentionally empty. Destinations v2 is installed directly from startup.js.
}

export function startDestinationAutomationWorker() {
  // Intentionally no background worker. Destinations v2 is user-driven only.
  return null;
}
