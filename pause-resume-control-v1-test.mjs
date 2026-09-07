import assert from "node:assert/strict";
import { __test } from "./pause-resume-control-v1.js";

assert.equal(__test.isControlPage("✈️ TelePilot\nStatus — READY"), true);
assert.equal(__test.isControlPage("⚙️ TelePilot Tools"), true);
assert.equal(__test.isControlPage("random page"), false);

assert.deepEqual(__test.controlButtonForState({ paused: true, postingEnabled: false, text: "✈️ TelePilot\nStatus — READY" }), {
  text: "Resume posting",
  callback_data: "v7_resume",
  style: "success",
});

assert.deepEqual(__test.controlButtonForState({ paused: false, postingEnabled: true, text: "✈️ TelePilot\nStatus — LIVE" }), {
  text: "Pause posting",
  callback_data: "v7_pause",
});

assert.equal(__test.controlButtonForState({ paused: false, postingEnabled: false, text: "✈️ TelePilot\nStatus — READY" }), null);
assert.equal(__test.controlButtonForState({ paused: false, postingEnabled: false, text: "✈️ TelePilot\nStatus — LIVE" })?.callback_data, "v7_pause");

console.log("pause/resume control regression tests passed");
