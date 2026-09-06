import assert from "node:assert/strict";

const bridge = await import("./destination-automation.js");
assert.equal(typeof bridge.destinationAccountReady, "function");
assert.equal(typeof bridge.recordDestinationFailure, "function");
assert.equal(typeof bridge.recheckDestinations, "function");

// This import reproduces the production module linkage that failed on Railway.
const worker = await import("./v1-worker.js");
assert.equal(typeof worker.startV1Worker, "function");

console.log("TelePilot Destinations v2 worker compatibility check passed");
