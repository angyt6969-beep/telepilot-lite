// Compatibility bridge for older TelePilot modules.
// The previous destination automation subsystem was removed. All active logic now
// lives in destinations-v2.js and performs manual access checks only.
export {
  destinationAccountReady,
  handleDestinationText,
  parseDestinationInput,
  processRoutingQueue,
  queueRoutingSync,
  recheckDestinations,
} from "./destinations-v2.js";

export function installDestinationAutomation() {
  // Intentionally empty. Destinations v2 is installed directly from startup.js.
}

export function startDestinationAutomationWorker() {
  // Intentionally no background worker. Destinations v2 is user-driven only.
  return null;
}
