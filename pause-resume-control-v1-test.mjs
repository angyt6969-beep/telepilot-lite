import assert from "node:assert/strict";
import { __test } from "./pause-resume-control-v1.js";

assert.equal(__test.isControlPage("✈️ TELEPILOT\n\n🟢 Running"), true, "live dashboard title must be recognized case-insensitively");
assert.equal(__test.isControlPage("✈️ TelePilot\nStatus — READY"), true);
assert.equal(__test.isControlPage("⚙️ TelePilot Tools"), true);
assert.equal(__test.isControlPage("🛑 Emergency stop"), true);
assert.equal(__test.isControlPage("random page"), false);

assert.deepEqual(__test.controlButtonForState({ paused: true, postingEnabled: false, text: "✈️ TELEPILOT\n\n⚪ Stopped" }), {
  text: "Resume posting",
  callback_data: "v7_resume",
  style: "success",
});

assert.deepEqual(__test.controlButtonForState({ paused: false, postingEnabled: true, text: "✈️ TELEPILOT\n\n🟢 Running" }), {
  text: "Pause posting",
  callback_data: "v7_pause",
});

assert.equal(__test.controlButtonForState({ paused: false, postingEnabled: false, text: "✈️ TELEPILOT\n\n⚪ Stopped" }), null);
assert.equal(__test.controlButtonForState({ paused: false, postingEnabled: false, text: "✈️ TelePilot\nStatus — LIVE" })?.callback_data, "v7_pause");
assert.match(__test.pausedPageText("✈️ TELEPILOT\n\n⚪ Stopped\n\nMessage set", true), /⏸ Paused/);
assert.match(__test.pausedPageText("✈️ TelePilot\nStatus — LIVE", true), /Status — PAUSED/);

console.log("pause/resume control regression tests passed");
