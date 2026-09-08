import fs from "node:fs";

function read(file) { return fs.readFileSync(file, "utf8"); }
function write(file, value) { fs.writeFileSync(file, value); }
function replaceOnce(source, from, to, label) {
  const index = source.indexOf(from);
  if (index < 0) throw new Error(`${label}: source text not found`);
  if (source.indexOf(from, index + from.length) >= 0) throw new Error(`${label}: source text matched more than once`);
  return source.slice(0, index) + to + source.slice(index + from.length);
}

let ux = read("ux-v13.js");
ux = replaceOnce(
  ux,
  '      [inline("🔔 Notifications", "v1_notifications")],\n',
  '      [inline("🔔 Notifications", "v1_notifications"), inline("🔥 Referrals", "referrals")],\n',
  "Settings notifications/referrals row",
);
write("ux-v13.js", ux);

let nav = read("navigation-cleanup-v1.js");
nav = replaceOnce(
  nav,
  '  if (rows.length && rows.at(-1)?.length === 1 && isParentNavigationButton(rows.at(-1)[0])) rows.pop();\n  if (hasHistory) rows.push([{ text: "Go back", callback_data: NAV_BACK }]);\n',
  `  const lastRow = rows.at(-1);\n  const parentButton = lastRow?.length === 1 && isParentNavigationButton(lastRow[0]) ? lastRow[0] : null;\n\n  if (parentButton) {\n    const data = String(parentButton.callback_data || "");\n    if (data === NAV_BACK) {\n      if (!hasHistory) rows.pop();\n    } else {\n      // Keep the real parent callback so Back survives process restarts/deploys.\n      parentButton.text = "Go back";\n    }\n  } else if (hasHistory) {\n    rows.push([{ text: "Go back", callback_data: NAV_BACK }]);\n  }\n`,
  "deterministic parent navigation",
);
write("navigation-cleanup-v1.js", nav);

let navTest = read("navigation-cleanup-v1-test.mjs");
navTest = replaceOnce(
  navTest,
  'assert.deepEqual(bottom[0], { text: "Go back", callback_data: "telepilot_nav_back" });\nassert.equal(withBackRows.flat().some(button => button.callback_data === "v1_dashboard_v13"), false, "hardcoded bottom Dashboard must be replaced");\n',
  'assert.deepEqual(bottom[0], { text: "Go back", callback_data: "v1_dashboard_v13" });\nassert.equal(withBackRows.flat().some(button => button.callback_data === "telepilot_nav_back"), false, "a real parent callback should be preserved instead of replaced with volatile history");\n',
  "navigation activity parent assertion",
);
navTest = replaceOnce(
  navTest,
  '// A normal hardcoded Dashboard footer is still treated as parent navigation and removed.\nconst ordinaryFooter = applyGoBackButton("⚙️ Settings", {\n  reply_markup: { inline_keyboard: [[{ text: "Dashboard", callback_data: "v1_dashboard_v13" }]] },\n}, false);\nassert.equal(ordinaryFooter.other.reply_markup.inline_keyboard.length, 0);\n',
  '// A normal parent footer becomes Go back but keeps its deterministic callback.\nconst ordinaryFooter = applyGoBackButton("⚙️ Settings", {\n  reply_markup: { inline_keyboard: [[{ text: "Dashboard", callback_data: "v1_dashboard_v13" }]] },\n}, false);\nassert.deepEqual(ordinaryFooter.other.reply_markup.inline_keyboard.at(-1)[0], { text: "Go back", callback_data: "v1_dashboard_v13" });\n\nconst settingsParent = applyGoBackButton("💬 Topic Preferences", {\n  reply_markup: { inline_keyboard: [[{ text: "Settings", callback_data: "v1_settings_v13" }]] },\n}, false);\nassert.deepEqual(settingsParent.other.reply_markup.inline_keyboard.at(-1)[0], { text: "Go back", callback_data: "v1_settings_v13" });\n',
  "navigation ordinary footer assertion",
);
navTest = replaceOnce(
  navTest,
  'assert.deepEqual(activityRendered.other.reply_markup.inline_keyboard.at(-1)[0], { text: "Go back", callback_data: "telepilot_nav_back" });\n',
  'assert.deepEqual(activityRendered.other.reply_markup.inline_keyboard.at(-1)[0], { text: "Go back", callback_data: "v1_dashboard_v13" });\n',
  "navigation rendered parent assertion",
);
write("navigation-cleanup-v1-test.mjs", navTest);

let referralTest = read("referral-custom-interval-test.mjs");
referralTest = replaceOnce(
  referralTest,
  '  assert.match(ux, /intervalSeconds:\\s*intervalSecondsFromSettings\\(snapshot\\)/, "saved posting setups should restore canonical seconds");\n',
  '  assert.match(ux, /intervalSeconds:\\s*intervalSecondsFromSettings\\(snapshot\\)/, "saved posting setups should restore canonical seconds");\n  assert.match(ux, /\\[inline\\("🔔 Notifications", "v1_notifications"\\), inline\\("🔥 Referrals", "referrals"\\)\\]/, "Settings should render Referrals directly beside Notifications");\n',
  "direct Settings referral regression",
);
write("referral-custom-interval-test.mjs", referralTest);

for (const file of [
  "scripts/apply-settings-referrals-navigation-fix.mjs",
  ".github/workflows/apply-settings-referrals-navigation-fix.yml",
]) {
  try { fs.rmSync(file); } catch {}
}

console.log("Settings referral + deterministic navigation fix applied");
