import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, got ${count}`);
  return source.replace(before, after);
}

const navPath = "navigation-cleanup-v1.js";
let nav = fs.readFileSync(navPath, "utf8");
const oldBlock = `export function cleanActivityControls(text, other) {
  if (!/^Activity$/i.test(firstLine(text))) return { text, other };
  const next = cloneOther(other);
  if (!next?.reply_markup?.inline_keyboard) return { text, other: next };

  const rows = [];
  for (const row of next.reply_markup.inline_keyboard) {
    const kept = [];
    for (const source of row) {
      const button = { ...source };
      const data = String(button.callback_data || "");
      if (data === "v1_accounts_v13" || data === "v1_destinations_v13") continue;
      if (data === "v1_history" || /^History$/i.test(String(button.text || ""))) {
        button.text = "Posting History";
        delete button.style;
      }
      kept.push(button);
    }
    if (kept.length) rows.push(kept);
  }
  next.reply_markup.inline_keyboard = rows;
  return { text, other: next };
}`;
const newBlock = `export function cleanActivityControls(text, other) {
  if (!/^Activity$/i.test(firstLine(text))) return { text, other };
  const next = cloneOther(other);
  if (!next?.reply_markup?.inline_keyboard) return { text, other: next };

  const rows = [];
  let historyKept = false;
  for (const row of next.reply_markup.inline_keyboard) {
    const kept = [];
    for (const source of row) {
      const button = { ...source };
      const data = String(button.callback_data || "");
      const label = String(button.text || "").replace(LEADING_DECORATION_RE, "").trim();
      if (data === "v1_accounts_v13" || data === "v1_destinations_v13") continue;

      const isPostingHistory = data === "history"
        || data === "v1_history"
        || /^(?:Posting\\s+)?History$/i.test(label);
      if (isPostingHistory) {
        if (historyKept) continue;
        historyKept = true;
        // The production history page is registered on the legacy-but-active
        // \"history\" callback in pro-controls.js. Canonicalize every Activity
        // history button to that known working route while removing duplicates.
        button.callback_data = "history";
        button.text = "Posting History";
        delete button.style;
      }
      kept.push(button);
    }
    if (kept.length) rows.push(kept);
  }
  next.reply_markup.inline_keyboard = rows;
  return { text, other: next };
}`;
nav = replaceOnce(nav, oldBlock, newBlock, "Activity cleanup block");
fs.writeFileSync(navPath, nav);

const testPath = "navigation-cleanup-v1-test.mjs";
let test = fs.readFileSync(testPath, "utf8");
test = test.replaceAll('button.callback_data === "v1_history"', 'button.callback_data === "history"');
test = test.replaceAll('button => button.callback_data === "v1_history"', 'button => button.callback_data === "history"');
const anchor = `assert.equal(activityButtons.some(button => button.callback_data === "v1_pause_menu_v13"), true);\n`;
const extra = `assert.equal(activityButtons.filter(button => button.callback_data === "history").length, 1, "Activity must show exactly one Posting History button");\n\nconst duplicateHistory = cleanActivityControls("📊 Activity\\n\\nPosting: — Running", {\n  reply_markup: {\n    inline_keyboard: [\n      [{ text: "📜 History", callback_data: "v1_history", style: "primary" }],\n      [{ text: "Posting History", callback_data: "history" }],\n      [{ text: "History", callback_data: "history" }],\n      [{ text: "Dashboard", callback_data: "v1_dashboard_v13" }],\n    ],\n  },\n});\nconst duplicateHistoryButtons = duplicateHistory.other.reply_markup.inline_keyboard.flat();\nassert.equal(duplicateHistoryButtons.filter(button => button.callback_data === "history").length, 1, "duplicate Activity history controls must collapse to one working button");\nassert.equal(duplicateHistoryButtons.find(button => button.callback_data === "history")?.text, "Posting History");\nassert.equal(duplicateHistoryButtons.some(button => button.callback_data === "v1_history"), false, "the stale unhandled v1_history route must not remain");\n`;
test = replaceOnce(test, anchor, anchor + extra, "Activity history regression anchor");
fs.writeFileSync(testPath, test);

const proControls = fs.readFileSync("pro-controls.js", "utf8");
if (!/bot\.callbackQuery\("history"[\s\S]*?showHistory\(ctx\)/.test(proControls)) {
  throw new Error("Working production history callback was not found in pro-controls.js");
}

for (const temp of [
  "scripts/apply-activity-single-history.mjs",
  ".github/workflows/apply-activity-single-history.yml",
]) {
  try { fs.rmSync(temp); } catch {}
}

console.log("Activity Posting History dedupe patch applied; working history callback verified");
