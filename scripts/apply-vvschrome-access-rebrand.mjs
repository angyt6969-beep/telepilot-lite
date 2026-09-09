import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}
function write(file, value) {
  fs.writeFileSync(path.join(root, file), value);
}
function mustReplace(file, oldValue, newValue) {
  const before = read(file);
  if (!before.includes(oldValue)) throw new Error(`${file}: missing expected source anchor`);
  write(file, before.replace(oldValue, newValue));
}

// Remove old visible owner/support identity everywhere in tracked text sources.
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.name === ".git" || entry.name === "node_modules") continue;
  const walk = (target) => {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(target)) walk(path.join(target, child));
      return;
    }
    if (!/\.(?:js|mjs|json|md|yml|yaml|py)$/i.test(target)) return;
    let value = fs.readFileSync(target, "utf8");
    const next = value
      .replace(/noahxrp/gi, "vvschrome")
      .replace(/TelePilottBot/gi, "telepilotsbot");
    if (next !== value) fs.writeFileSync(target, next);
  };
  walk(path.join(root, entry.name));
}

// Tutorials no longer intercept /start. Keep the access-screen decorator, checkout and free-key systems.
const packageJson = JSON.parse(read("package.json"));
packageJson.scripts.start = packageJson.scripts.start
  .replace(" --import ./tutorial-navigation-priority.js", "")
  .replace(" --import ./tutorial-ui-isolation.js", "");
write("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

let startup = read("startup.js");
startup = startup.replace('import { installLinearOnboardingV4, installLinearOnboardingV4Ui } from "./linear-onboarding-v4.js";\n', "");
startup = startup.replace(/\/\/ New users follow one fixed path:[\s\S]*?installLinearOnboardingV4\(Bot\);\n/, "");
startup = startup.replace(/\/\/ Apply the mandatory onboarding\/activation\/dashboard polish[\s\S]*?installLinearOnboardingV4Ui\(Api\);\n/, "");
write("startup.js", startup);

// The old tutorial-final decorator is now the canonical inactive /start access screen.
write("tutorial-final-access-ui.js", `import { Api } from "grammy";
import { checkoutUrlForUid } from "./crypto-checkout-web.js";
import { FREE_TRIAL_EMOJI_ID, freeTrialUrlForUid } from "./free-trial.js";

export const TELEPILOT_OWNER_USERNAME = "vvschrome";
const BUY_KEY_EMOJI_ID = "5307843983102204243";
const REDEEM_KEY_EMOJI_ID = "5206607081334906820";

function cloneOther(other) {
  const next = other && typeof other === "object" ? { ...other } : {};
  if (other?.reply_markup?.inline_keyboard) {
    next.reply_markup = {
      ...other.reply_markup,
      inline_keyboard: other.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button }))),
    };
  }
  return next;
}

function callbackSet(other) {
  return new Set((other?.reply_markup?.inline_keyboard || []).flat().map(button => String(button?.callback_data || "")).filter(Boolean));
}

export function isInactiveAccessScreen(text, other) {
  const callbacks = callbackSet(other);
  if (!callbacks.has("redeem_key") || callbacks.has("home")) return false;
  return /(?:^|\\n)\\s*🔑\\s*ACCESS\\b/i.test(String(text || ""));
}

export function accessStartPayload(chatId, text, other, options = {}) {
  const uid = String(chatId || "");
  if (!/^\\d+$/.test(uid) || !isInactiveAccessScreen(text, other)) return { text, other };

  const checkoutUrl = String(options.checkoutUrl || checkoutUrlForUid(uid, options));
  const freeTrialUrl = String(options.freeTrialUrl || freeTrialUrlForUid(uid, options));
  const next = cloneOther(other);
  next.parse_mode = "HTML";
  next.entities = undefined;
  next.reply_markup = {
    ...(next.reply_markup || {}),
    inline_keyboard: [
      [{
        text: "Redeem Key",
        callback_data: "redeem_key",
        icon_custom_emoji_id: REDEEM_KEY_EMOJI_ID,
        style: "success",
      }],
      [{
        text: "Buy Key",
        url: checkoutUrl,
        icon_custom_emoji_id: BUY_KEY_EMOJI_ID,
        style: "primary",
      }],
      [{
        text: "Free 1-Day Key",
        url: freeTrialUrl,
        icon_custom_emoji_id: FREE_TRIAL_EMOJI_ID,
      }],
    ],
  };

  return {
    text: [
      "✈️ <b><i>TelePilot Access</i></b>",
      "",
      "Choose how you want to unlock TelePilot.",
      "",
      "<b>Redeem Key</b> — use an existing access key.",
      "<b>Buy Key</b> — purchase TelePilot access.",
      "<b>Free 1-Day Key</b> — claim your one-time free key.",
      "",
      `<i>Owner & support: @${TELEPILOT_OWNER_USERNAME}</i>`,
    ].join("\\n"),
    other: next,
  };
}

// Compatibility export for the existing regression import name.
export const finalTutorialAccessPayload = accessStartPayload;

export function installTutorialFinalAccessUi(ApiClass = Api) {
  if (!ApiClass?.prototype || ApiClass.prototype.__telepilotTutorialFinalAccessUiInstalled) return false;
  const originalSend = ApiClass.prototype.sendMessage;
  const originalEdit = ApiClass.prototype.editMessageText;
  if (typeof originalSend !== "function" || typeof originalEdit !== "function") {
    throw new Error("Unsupported grammY Api shape for TelePilot access start UI");
  }
  Object.defineProperty(ApiClass.prototype, "__telepilotTutorialFinalAccessUiInstalled", { value: true });
  ApiClass.prototype.sendMessage = function(chatId, text, other, ...rest) {
    const result = accessStartPayload(chatId, text, other);
    return originalSend.call(this, chatId, result.text, result.other, ...rest);
  };
  ApiClass.prototype.editMessageText = function(chatId, messageId, text, other, ...rest) {
    const result = accessStartPayload(chatId, text, other);
    return originalEdit.call(this, chatId, messageId, result.text, result.other, ...rest);
  };
  return true;
}

installTutorialFinalAccessUi(Api);
`);

write("tutorial-final-access-ui-test.mjs", `import assert from "node:assert/strict";
import { accessStartPayload, isInactiveAccessScreen, TELEPILOT_OWNER_USERNAME } from "./tutorial-final-access-ui.js";

const inactiveOther = {
  reply_markup: { inline_keyboard: [[{ text: "Redeem Key", callback_data: "redeem_key" }]] },
};
assert.equal(isInactiveAccessScreen("🔑 ACCESS\\n\\nInactive", inactiveOther), true);

const screen = accessStartPayload(
  "123456789",
  "🔑 ACCESS\\n\\n🔒 Access inactive. Redeem a key to continue.",
  inactiveOther,
  {
    checkoutUrl: "https://telepilot.example/checkout?t=signed-checkout",
    freeTrialUrl: "https://telepilot.example/free-trial?t=signed-trial",
  },
);
const rows = screen.other.reply_markup.inline_keyboard;
assert.deepEqual(rows.map(row => row[0].text), ["Redeem Key", "Buy Key", "Free 1-Day Key"]);
assert.equal(rows[0][0].callback_data, "redeem_key");
assert.equal(rows[1][0].url, "https://telepilot.example/checkout?t=signed-checkout");
assert.equal(rows[2][0].url, "https://telepilot.example/free-trial?t=signed-trial");
assert.equal(rows[2][0].icon_custom_emoji_id, "4983746717313664194");
assert.equal(TELEPILOT_OWNER_USERNAME, "vvschrome");
assert.match(screen.text, /Owner & support: @vvschrome/);
assert.doesNotMatch(screen.text, /tutorial/i);

const activeOther = {
  reply_markup: { inline_keyboard: [
    [{ text: "Redeem another key", callback_data: "redeem_key" }],
    [{ text: "Back", callback_data: "home" }],
  ] },
};
const active = accessStartPayload("123456789", "🔑 ACCESS\\n\\n✅ Active", activeOther, {
  checkoutUrl: "https://telepilot.example/checkout",
  freeTrialUrl: "https://telepilot.example/free-trial",
});
assert.equal(active.other, activeOther, "active access screen must not be replaced");
assert.equal(active.text, "🔑 ACCESS\\n\\n✅ Active");

console.log("TelePilot access start UI regression tests passed");
`);

// Free-key web/UI stays one-per-account and membership-gated, but tutorial completion is no longer required.
write("free-trial-startup.js", `import { Api } from "grammy";
import { installFreeTrialUi, installFreeTrialWeb } from "./free-trial.js";

installFreeTrialWeb();
installFreeTrialUi(Api);
`);

let trial = read("free-trial.js");
trial = trial.replace('const SUPPORT_USERNAME = String(process.env.TELEPILOT_SUPPORT_USERNAME || "vvschrome").replace(/^@+/, "");', 'const SUPPORT_USERNAME = "vvschrome";');
trial = trial.replace('export const FREE_TRIAL_BUTTON_TEXT = "Claim your Free 1 day key!";', 'export const FREE_TRIAL_BUTTON_TEXT = "Free 1-Day Key";');
trial = trial.replace(
  '  const tutorial = readFreeTrialTutorial(id);\n  if (!tutorial.eligible) return { ok: false, code: "tutorial_required", error: "Finish the TelePilot tutorial first, then open this button again." };\n',
  '',
);
trial = trial.replace('    const tutorial = readFreeTrialTutorial(session.uid);\n', '');
trial = trial.replace('sendJson(res, 200, { eligible: tutorial.eligible, deleted, channel:', 'sendJson(res, 200, { eligible: !deleted, deleted, channel:');
trial = trial.replace('Tutorial reward', 'Free access');
trial = trial.replace('Finish the TelePilot tutorial, join <b>@${CHANNEL_USERNAME}</b>, then verify your membership. The reward can be claimed once per Telegram account.', 'Join <b>@${CHANNEL_USERNAME}</b>, then verify your membership. The free 1-day key can be claimed once per Telegram account.');
trial = trial.replace('<div class="steps"><div class="step"><b>1. Tutorial</b><br>Complete all five tutorial slides in @telepilotsbot.</div><div class="step"><b>2. Join the channel</b><br>Membership in @${CHANNEL_USERNAME} is checked by TelePilot when you claim.</div><div class="step"><b>3. Claim your key</b><br>Your 1-day key is bound to the Telegram account that opened this page.</div></div>', '<div class="steps"><div class="step"><b>1. Join the channel</b><br>Membership in @${CHANNEL_USERNAME} is checked by TelePilot when you claim.</div><div class="step"><b>2. Claim your key</b><br>Your 1-day key is bound to the Telegram account that opened this page.</div></div>');
trial = trial.replace("if(!d.eligible){B.disabled=true;return showError('Finish the TelePilot tutorial first, then open the free-key button again.')}", '');
trial = trial.replace("S.textContent='Tutorial complete. Join @${CHANNEL_USERNAME}, then tap Verify & claim key.'", "S.textContent='Join @${CHANNEL_USERNAME}, then tap Verify & claim key.'");
write("free-trial.js", trial);

// Hard-code the new owner/support identity in live bot + web modules so an old Railway fallback cannot resurrect noahxrp.
for (const file of [
  "crypto-checkout-bot-ui.js",
  "crypto-checkout-web.js",
  "support-center.js",
  "legal-pages.js",
  "linear-onboarding-v4.js",
  "tutorial-final-access-ui.js",
]) {
  let value = read(file);
  value = value.replace(/const SUPPORT_USERNAME = String\(process\.env\.TELEPILOT_SUPPORT_USERNAME \|\| "vvschrome"\)\.replace\(\/\^@\+\/, ""\);/g, 'const SUPPORT_USERNAME = "vvschrome";');
  value = value.replace(/String\(username \|\| "vvschrome"\)\.replace\(\/\^@\+\/, ""\)/g, 'String(username || "vvschrome").replace(/^@+/, "")');
  write(file, value);
}

// Update the free-trial regression to prove a brand-new account is eligible without tutorial state.
let trialTest = read("free-trial-test.mjs");
trialTest = trialTest.replace(/\n\s*assert\.equal\(mod\.readFreeTrialTutorial\(uid\)\.eligible,[\s\S]*?assert\.equal\(completed\.furthestSlide, 5\);\n/, `\n  const directClaim = await mod.claimFreeTrial(uid, { now, membershipChecker: async () => true });\n  assert.equal(directClaim.ok, true, "a brand-new account must be able to claim without completing a tutorial");\n  assert.match(directClaim.key, /^TP-/);\n`);
trialTest = trialTest.replace('"Claim your Free 1 day key!"', '"Free 1-Day Key"');
write("free-trial-test.mjs", trialTest);

// Final identity/runtime invariants.
const textFiles = [];
const collect = (target) => {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    if ([".git", "node_modules"].includes(path.basename(target))) return;
    for (const child of fs.readdirSync(target)) collect(path.join(target, child));
    return;
  }
  if (/\.(?:js|mjs|json|md|yml|yaml|py)$/i.test(target)) textFiles.push(target);
};
collect(root);
const leftovers = textFiles.filter(file => /noahxrp|TelePilottBot/i.test(fs.readFileSync(file, "utf8")));
if (leftovers.length) throw new Error(`old identity still present in: ${leftovers.map(file => path.relative(root, file)).join(", ")}`);
if (/tutorial-navigation-priority|tutorial-ui-isolation/.test(JSON.parse(read("package.json")).scripts.start)) throw new Error("tutorial runtime preloads still active");
if (/installLinearOnboardingV4\(|installLinearOnboardingV4Ui\(/.test(read("startup.js"))) throw new Error("linear onboarding still intercepts runtime");
if (/tutorial_required|Finish the TelePilot tutorial first/.test(read("free-trial.js"))) throw new Error("tutorial still gates free trial");

console.log("TelePilot vvschrome access rebrand applied successfully");
