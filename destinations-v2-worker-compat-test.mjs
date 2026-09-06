import assert from "node:assert/strict";
import fs from "node:fs";

const bridge = await import("./destination-automation.js");
assert.equal(typeof bridge.destinationAccountReady, "function");
assert.equal(typeof bridge.destinationMenu, "function");
assert.equal(typeof bridge.recordDestinationFailure, "function");
assert.equal(typeof bridge.recheckDestinations, "function");

// Reproduce the production worker module linkage that previously failed on Railway.
const worker = await import("./v1-worker.js");
assert.equal(typeof worker.startV1Worker, "function");

// Keep app.js and the compatibility bridge contract synchronized without importing
// app.js itself (which intentionally starts the live bot/server as a side effect).
const appSource = fs.readFileSync("app.js", "utf8");
const importMatch = appSource.match(/import\s*\{([\s\S]*?)\}\s*from\s*["']\.\/destination-automation\.js["'];/);
assert.ok(importMatch, "app.js destination bridge import block was not found");
const importedNames = importMatch[1]
  .split(",")
  .map(value => value.trim().split(/\s+as\s+/)[0])
  .filter(Boolean);
assert.ok(importedNames.length > 0);
for (const name of importedNames) {
  assert.ok(name in bridge, `destination-automation.js is missing app.js import: ${name}`);
}

const menu = bridge.destinationMenu("123456");
assert.match(String(menu?.text || ""), /Destination Hub/);
assert.ok(Array.isArray(menu?.keyboard?.inline_keyboard));

console.log("TelePilot Destinations v2 app/worker compatibility checks passed");
