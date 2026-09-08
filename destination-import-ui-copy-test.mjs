import assert from "node:assert/strict";
import { isolateTutorialPayload } from "./tutorial-ui-isolation.js";
import { __test as destinationUi } from "./destination-import-ui-copy.js";

const rawSlide3 = {
  text: '<tg-emoji emoji-id="5231361378748472914">✈️</tg-emoji> <b><i>Add destinations</i></b>\n<i>Slide 3 of 5</i>\n\n📍 <b>Destinations:</b> — Add groups and channels.',
  other: {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Next", callback_data: "linear_tutorial:4" }],
        [{ text: "Back", callback_data: "linear_tutorial:2" }],
      ],
    },
  },
};

// Reproduce production wrapper order: tutorial isolation runs first, then the
// older destination-import copy transformer receives the resulting payload.
const isolated = isolateTutorialPayload(rawSlide3.text, rawSlide3.other);
const afterDestinationUi = destinationUi.transform(isolated.text, isolated.other);

assert.match(afterDestinationUi.text, /Add destinations/);
assert.match(afterDestinationUi.text, /Slide 3 of 5/);
assert.doesNotMatch(afterDestinationUi.text, /Addlists use Telegram’s native bulk folder import/);
const tutorialCallbacks = afterDestinationUi.other.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
assert.ok(tutorialCallbacks.includes("linear_tutorial:4"), "slide 3 must keep Next -> slide 4");
assert.ok(tutorialCallbacks.includes("linear_tutorial:2"), "slide 3 must keep Back -> slide 2");
assert.ok(!tutorialCallbacks.includes("v1_destinations_v13"), "tutorial slide must not be replaced by destination Back navigation");

const importScreen = destinationUi.transform("📍 Add destinations", {
  reply_markup: { inline_keyboard: [[{ text: "Old back", callback_data: "home" }]] },
});
assert.match(importScreen.text, /Add \/ Import/);
assert.match(importScreen.text, /Addlists use Telegram’s native bulk folder import/);
assert.deepEqual(importScreen.other.reply_markup.inline_keyboard, [[{ text: "𝙂𝙤 𝙗𝙖𝙘𝙠", callback_data: "v1_destinations_v13" }]]);

console.log("destination import UI copy regression tests passed");
