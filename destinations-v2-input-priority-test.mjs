import assert from "node:assert/strict";
import fs from "node:fs";

const startup = fs.readFileSync("startup.js", "utf8");
const priority = fs.readFileSync("destinations-v2-input-priority.js", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const copy = fs.readFileSync("destinations-v2-copy.js", "utf8");

assert.ok(app.includes('bot.on("message:text"'), "legacy app text handler fixture changed");
assert.ok(copy.includes('button.callback_data = "d2_add"'), "Destination Hub must still route Add to Destinations v2");
assert.ok(priority.includes("scanDestinationSources"), "priority handler must use the Destinations v2 scanner");
assert.ok(priority.includes("pending?.type !== \"source\""), "priority handler must only consume pending destination input");
assert.ok(priority.includes("this.use(destinationInputPriorityMiddleware)"), "priority handler must be inserted before app message:text");
assert.ok(priority.includes("proto.on = function"), "priority handler must intercept message:text registration order");
assert.ok(priority.includes("review,"), "scan result must be persisted for the existing review/confirm callbacks");

for (const forbidden of [
  ".joinChannel(",
  ".importChatInvite(",
  "joinChatlistInvite(",
  "joinChatlistUpdates(",
  "UpdateNotifySettings",
  "EditPeerFolders",
]) {
  assert.equal(priority.includes(forbidden), false, `input priority must not contain automatic Telegram action: ${forbidden}`);
}

const installAt = startup.indexOf("installDestinationsV2InputPriority(Bot);");
const appImportAt = startup.indexOf('await import("./app.js")');
assert.ok(installAt >= 0, "Destinations v2 input priority is not installed");
assert.ok(appImportAt >= 0, "app.js startup import is missing");
assert.ok(installAt < appImportAt, "Destinations v2 input priority must be installed before app.js registers message:text");

console.log("TelePilot Destinations v2 text-routing regression checks passed");
