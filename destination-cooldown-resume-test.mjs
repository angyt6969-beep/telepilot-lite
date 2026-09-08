import assert from "node:assert/strict";
import { __test } from "./destinations-v2-input-priority.js";

const raw = [
  "@premiumszxcc",
  "@sfsmarket2",
  "@areumart",
  "@asclepiusmarket",
  "@caratmarket",
].join("\n");

const result = {
  cooldownSeconds: 3,
  outcomes: [
    { source: "@premiumszxcc", sourceKind: "public", status: "already", kind: "already" },
    { source: "@sfsmarket2", sourceKind: "public", status: "joined", kind: "joined" },
    { source: "@areumart", sourceKind: "public", status: "error", kind: "cooldown", reason: "Telegram join cooldown — try again in 3s." },
    { source: "@asclepiusmarket", sourceKind: "public", status: "not_attempted", kind: "cooldown", reason: "Not attempted — Telegram join cooldown is active for 3s." },
    { source: "@caratmarket", sourceKind: "public", status: "not_attempted", kind: "cooldown", reason: "Not attempted — Telegram join cooldown is active for 3s." },
  ],
};

assert.equal(
  __test.buildResumeText(result, raw),
  ["@areumart", "@asclepiusmarket", "@caratmarket"].join("\n"),
  "resume list must preserve the cooldown-failed source and every not-attempted source without reprocessing successful groups",
);

const decorated = __test.decorateCooldownScreen({
  text: [
    "⚠️ <b><i>Destination import finished</i></b>",
    "",
    "⚠️ <b>@areumart</b> — Telegram join cooldown — try again in 3s.",
    "⚠️ <b>@asclepiusmarket</b> — Not attempted — Telegram join cooldown is active for 3s.",
    "⚠️ <b>@caratmarket</b> — Not attempted — Telegram join cooldown is active for 3s.",
    "<i>…and 2 more results</i>",
  ].join("\n"),
  parse_mode: "HTML",
  rows: [[{ text: "Browse", callback_data: "d2_browse:0" }]],
}, result, {
  text: ["@areumart", "@asclepiusmarket", "@caratmarket"].join("\n"),
  createdAt: Date.now(),
  availableAt: Date.now() + 3000,
});
assert.match(decorated.text, /Remaining:<\/b> — 3/);
assert.equal(decorated.text.includes("@asclepiusmarket</b> — Not attempted"), false, "repeated cooldown rows should be collapsed");
assert.equal(decorated.rows[0][0].callback_data, "d3_resume_import");
assert.equal(decorated.rows[0][0].text, "Continue remaining");

console.log("TelePilot destination cooldown resume regression test passed");
