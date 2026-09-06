import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("destination-delete-ui.js", "utf8");
const startup = fs.readFileSync("startup.js", "utf8");

for (const marker of [
  "v1_delete_groups_v13",
  "v1_delete_manual_v13",
  "v1_delete_one_v13",
  "v1_delete_all_v13",
  "v1_delete_all_confirm_v13",
]) assert.ok(source.includes(marker), `Destination delete flow missing ${marker}`);

assert.match(source, /Delete manually/, "Manual delete label missing");
assert.match(source, /Delete all/, "Delete all label missing");
assert.match(source, /startsWith\("📁 Destinations"\)/, "Delete Groups button is not attached to the v1.3 Destinations screen");
assert.match(source, /DELETE_CONFIRM_TTL_MS = 2 \* 60_000/, "Delete-all confirmation should expire");
assert.match(source, /automation\.joinQueue = \[\]/, "Delete all must cancel pending fast auto-joins");
assert.match(source, /automation\.unresolvedInvites = \[\]/, "Delete all must clear unresolved destination imports");
assert.match(source, /archive\.pending = \[\]/, "Delete all must clear pending archive/mute cleanup");
assert.match(source, /archive\.scanAccounts = \[\]/, "Delete all must cancel archive/mute account scans");
assert.match(source, /postingEnabled: false/, "Deleting the final destination should stop interval posting");
assert.match(source, /reloadUserState\(uid\)/, "Deleting the final destination should clear the active runtime posting state");
assert.match(startup, /installDestinationDeleteControls\(Bot\)/, "Destination delete bot controls are not installed");
assert.match(startup, /installDestinationDeleteUi\(Api\)/, "Destination delete UI layer is not installed");

console.log("TelePilot destination delete control checks passed");
