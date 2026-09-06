import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("destination-delete-ui.js", "utf8");
const startup = fs.readFileSync("startup.js", "utf8");
const app = fs.readFileSync("app.js", "utf8");

assert.match(source, /v1_delete_groups_v13/, "Delete Groups callback missing");
assert.match(source, /remove_group_menu/, "Manual delete option should reuse the existing individual destination removal flow");
assert.match(source, /clear_groups/, "Delete all option should reuse the existing confirmed clear-all flow");
assert.match(source, /Delete manually/, "Manual delete label missing");
assert.match(source, /Delete all/, "Delete all label missing");
assert.match(source, /startsWith\("📁 Destinations"\)/, "Delete Groups button is not attached to the v1.3 Destinations screen");
assert.match(startup, /installDestinationDeleteControls\(Bot\)/, "Destination delete bot controls are not installed");
assert.match(startup, /installDestinationDeleteUi\(Api\)/, "Destination delete UI layer is not installed");

assert.match(app, /callbackQuery\("clear_groups"/, "Existing clear-all handler is missing");
assert.match(app, /clear_groups_confirm/, "Clear-all confirmation is missing");
assert.match(app, /callbackQuery\(\/\^remove_group:/, "Existing individual delete handler is missing");

console.log("TelePilot destination delete control checks passed");
