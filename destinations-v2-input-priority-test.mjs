import assert from "node:assert/strict";
import fs from "node:fs";

const startup = fs.readFileSync("startup.js", "utf8");
const priority = fs.readFileSync("destinations-v2-input-priority.js", "utf8");
const engine = fs.readFileSync("destination-import-engine-v2.js", "utf8");
const resultV3 = fs.readFileSync("destination-import-result-v3.js", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const copy = fs.readFileSync("destinations-v2-copy.js", "utf8");

assert.ok(app.includes('bot.on("message:text"'), "legacy app text handler fixture changed");
assert.ok(copy.includes('button.callback_data = "d2_add"'), "Destination Hub must still route Add to Destinations v2");
assert.ok(priority.includes('from "./destination-import-result-v3.js"'), "priority handler must route active imports through destination result v3");
assert.ok(priority.includes("importDestinationBatch"), "priority handler must run the destination auto-import engine");
assert.ok(priority.includes("importResultScreen"), "priority handler must render the exact import result screen");
assert.ok(priority.includes("pending?.type !== \"source\""), "priority handler must only consume pending destination input");
assert.ok(priority.includes("this.use(destinationInputPriorityMiddleware)"), "priority handler must be inserted before app message:text");
assert.ok(priority.includes("proto.on = function"), "priority handler must intercept message:text registration order");
assert.ok(priority.includes("review: result.postReview"), "final verified review must be persisted for Browse/Topics compatibility");
assert.ok(priority.includes("<b><i>Adding destinations</i></b>"), "progress screen must use TelePilot bold/italic typography");
assert.ok(priority.includes("Read-only groups:</b> — discarded before joining"), "progress screen must state read-only discard behavior");

assert.ok(engine.includes("chatlists.joinChatlistInvite"), "base Addlist engine must retain Telegram native shared-folder bulk import");
assert.ok(engine.includes("chatlists.joinChatlistUpdates"), "base Addlist engine must retain Telegram native folder updates");
assert.ok(engine.includes("Telegram join cooldown"), "normal group batch errors must expose Telegram cooldowns clearly");
assert.ok(resultV3.includes("postingBlockReason"), "active import must preflight destination posting permission");
assert.ok(resultV3.includes("Discarded without joining"), "read-only groups must report a clear discard reason");
assert.ok(resultV3.includes("joinChatlistInvite"), "filtered Addlists must still use Telegram native bulk import");
assert.ok(resultV3.includes("joinChatlistUpdates"), "filtered imported Addlists must still use Telegram native update import");
assert.equal(resultV3.includes("client.joinChannel"), false, "v3 Addlist filtering must never add a one-by-one join fallback");

const installAt = startup.indexOf("installDestinationsV2InputPriority(Bot);");
const appImportAt = startup.indexOf('await import("./app.js")');
assert.ok(installAt >= 0, "Destinations v2 input priority is not installed");
assert.ok(appImportAt >= 0, "app.js startup import is missing");
assert.ok(installAt < appImportAt, "Destinations v2 input priority must be installed before app.js registers message:text");

console.log("TelePilot destination auto-import text-routing regression checks passed");
