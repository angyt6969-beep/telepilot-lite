import assert from "node:assert/strict";
import {
  FORWARD_SCHEDULER_SENTINEL,
  schedulerSettingsForMode,
  __test,
} from "./forwarded-post-scheduler-compat.js";

const empty = schedulerSettingsForMode({ adMessage: "", adEntities: [{ type: "bold" }], keep: 1 }, true);
assert.equal(empty.changed, true);
assert.equal(empty.insertedPlaceholder, true);
assert.equal(empty.settings.adMessage, FORWARD_SCHEDULER_SENTINEL);
assert.deepEqual(empty.settings.adEntities, []);
assert.equal(empty.settings.keep, 1);

const realMessage = schedulerSettingsForMode({ adMessage: "Real normal post", adEntities: [{ type: "bold" }] }, true);
assert.equal(realMessage.changed, false);
assert.equal(realMessage.settings.adMessage, "Real normal post");
assert.deepEqual(realMessage.settings.adEntities, [{ type: "bold" }]);

const alreadyPrepared = schedulerSettingsForMode({ adMessage: FORWARD_SCHEDULER_SENTINEL, adEntities: [] }, true);
assert.equal(alreadyPrepared.changed, false);

const backToNormal = schedulerSettingsForMode({ adMessage: FORWARD_SCHEDULER_SENTINEL, adEntities: [] }, false);
assert.equal(backToNormal.changed, true);
assert.equal(backToNormal.removedPlaceholder, true);
assert.equal(backToNormal.settings.adMessage, "");

const preserveRealOnNormal = schedulerSettingsForMode({ adMessage: "Keep me" }, false);
assert.equal(preserveRealOnNormal.changed, false);
assert.equal(preserveRealOnNormal.settings.adMessage, "Keep me");

assert.equal(
  __test.rewriteUiText("✈️ TELEPILOT\n📝 Message: ✅ Set (1 chars)", { forwardedEnabled: true, placeholder: true }),
  "✈️ TELEPILOT\n📝 Message: ✅ Forwarded Post",
);
assert.equal(
  __test.rewriteUiText("📝 AD MESSAGE\n\n✅ Saved • 1 characters", { forwardedEnabled: true, placeholder: true }),
  "📝 AD MESSAGE\n\n✅ Forward source active",
);
assert.equal(
  __test.rewriteUiText("✈️ TELEPILOT\n📝 Message: ✅ Set (1 chars)", { forwardedEnabled: false, beforePlaceholder: true, removedPlaceholder: true }),
  "✈️ TELEPILOT\n📝 Message: ❌ Not set",
);

console.log("forwarded post scheduler compatibility tests passed");
