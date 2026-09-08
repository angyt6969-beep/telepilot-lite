import fs from "node:fs";

function read(file) { return fs.readFileSync(file, "utf8"); }
function write(file, value) { fs.writeFileSync(file, value); }
function replaceOnce(source, pattern, replacement, label) {
  let count = 0;
  const next = source.replace(pattern, (...args) => {
    count++;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
  if (count !== 1) throw new Error(`${label}: expected exactly one match, got ${count}`);
  return next;
}

let app = read("app.js");
app = replaceOnce(
  app,
  'import { setReloadUserStateHandler, setSyncUserGroupsHandler } from "./runtime-hooks.js";\n',
  'import { setReloadUserStateHandler, setSyncUserGroupsHandler } from "./runtime-hooks.js";\nimport {\n  formatIntervalSeconds,\n  intervalMinutesForCompatibility,\n  intervalSecondsFromSettings,\n  parseCustomInterval,\n} from "./interval-settings.js";\n',
  "app interval helper import",
);
app = replaceOnce(
  app,
  '  const selection = normalizeAccountSelection(saved, accounts);\n  const state = {',
  '  const selection = normalizeAccountSelection(saved, accounts);\n  const intervalSeconds = intervalSecondsFromSettings(saved);\n  const state = {',
  "app interval migration local",
);
app = replaceOnce(
  app,
  '    intervalMinutes: INTERVAL_VALUES.includes(Number(saved.intervalMinutes)) ? Number(saved.intervalMinutes) : 30,',
  '    intervalSeconds,\n    intervalMinutes: intervalMinutesForCompatibility(intervalSeconds),',
  "app createState canonical interval",
);
app = replaceOnce(
  app,
  '    intervalMinutes: state.intervalMinutes,',
  '    intervalSeconds: state.intervalSeconds,\n    intervalMinutes: intervalMinutesForCompatibility(state.intervalSeconds),',
  "app save canonical interval",
);
app = replaceOnce(
  app,
  /function formatInterval\(m\) \{\n  const v = Number\(m\);\n  if \(v < 60\) return `\$\{v\} min`;\n  if \(v % 60 === 0\) return `\$\{v \/ 60\}h`;\n  return `\$\{Math\.floor\(v \/ 60\)\}h \$\{v % 60\}m`;\n\}/,
  'function formatInterval(m) {\n  return formatIntervalSeconds(Math.max(1, Math.round(Number(m || 0) * 60)));\n}',
  "app interval formatter",
);
app = app.replace(/state\.intervalMinutes\s*\*\s*60_000/g, "state.intervalSeconds * 1000");
if (/state\.intervalMinutes\s*\*\s*60_000/.test(app)) throw new Error("legacy minute scheduler math remains");

const intervalBlock = `function intervalKeyboard() {
  return new InlineKeyboard()
    .text("1m", "i1").text("5m", "i5").text("10m", "i10").row()
    .text("15m", "i15").text("30m", "i30").text("45m", "i45").row()
    .text("1h", "i60").text("1h 30m", "i90").text("2h", "i120").row()
    .text("⏱ Seconds", "interval_custom_seconds").text("📆 Minutes", "interval_custom_minutes").row()
    .text("⬅️ Back", "home");
}
function italicLineEntity(text, line) {
  const offset = text.indexOf(line);
  return offset >= 0 ? [{ type: "italic", offset, length: line.length }] : [];
}
function intervalScreen(state) {
  const instruction = "Choose a preset — or set an exact custom interval.";
  const text = [
    "📆 SCHEDULE",
    "",
    \`Current: \${formatIntervalSeconds(state.intervalSeconds)}\`,
    "",
    instruction,
    "",
    "Custom interval:",
  ].join("\\n");
  return { text, other: { reply_markup: intervalKeyboard(), entities: italicLineEntity(text, instruction) } };
}
async function showIntervalScreen(ctx, state) {
  const screen = intervalScreen(state);
  return ctx.editMessageText(screen.text, screen.other);
}
function customIntervalPrompt(unit) {
  const isSeconds = unit === "seconds";
  const instruction = isSeconds
    ? "Send a positive whole number of seconds — up to 7 days total."
    : "Send a positive whole number of minutes — up to 7 days total.";
  const text = [
    "📆 CUSTOM INTERVAL",
    "",
    \`Unit: \${isSeconds ? "Seconds" : "Minutes"}\`,
    "",
    instruction,
    \`Example: \${isSeconds ? "45" : "20"}\`,
  ].join("\\n");
  return {
    text,
    other: {
      entities: italicLineEntity(text, instruction),
      reply_markup: new InlineKeyboard().text("⬅️ Cancel", "interval"),
    },
  };
}

bot.callbackQuery("interval", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  clearAwaiting(state);
  await showIntervalScreen(ctx, state);
});
bot.callbackQuery("interval_custom_seconds", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  state.awaiting = "interval_custom_seconds";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  const prompt = customIntervalPrompt("seconds");
  await ctx.editMessageText(prompt.text, prompt.other);
});
bot.callbackQuery("interval_custom_minutes", async ctx => {
  await ctx.answerCallbackQuery();
  const state = stateFromCtx(ctx);
  state.awaiting = "interval_custom_minutes";
  state.awaitingPromptMessageId = ctx.callbackQuery.message?.message_id || null;
  state.awaitingPromptChatId = ctx.chat?.id || null;
  const prompt = customIntervalPrompt("minutes");
  await ctx.editMessageText(prompt.text, prompt.other);
});
for (const minutes of INTERVAL_VALUES) {
  bot.callbackQuery(\`i\${minutes}\`, async ctx => {
    const state = stateFromCtx(ctx);
    state.intervalSeconds = minutes * 60;
    state.intervalMinutes = intervalMinutesForCompatibility(state.intervalSeconds);
    saveState(state);
    if (state.posting) scheduleNextCycle(state);
    await ctx.answerCallbackQuery({ text: \`Set to \${formatIntervalSeconds(state.intervalSeconds)}\` });
    const tutorialScreen = advanceTutorialAfterAction(state.uid, 5, 6);
    if (tutorialScreen) {
      await ctx.editMessageText(tutorialScreen.text, { reply_markup: tutorialScreen.keyboard });
      return;
    }
    await showHome(ctx, state);
  });
}

bot.callbackQuery("activity"`;

app = replaceOnce(
  app,
  /bot\.callbackQuery\("interval", async ctx => \{[\s\S]*?\n\}\);\nfor \(const minutes of INTERVAL_VALUES\) \{[\s\S]*?\n\}\n\nbot\.callbackQuery\("activity"/,
  intervalBlock,
  "app schedule UI block",
);

const customInput = `if (state.awaiting === "interval_custom_seconds" || state.awaiting === "interval_custom_minutes") {
    const unit = state.awaiting === "interval_custom_seconds" ? "seconds" : "minutes";
    const promptMessageId = state.awaitingPromptMessageId;
    const promptChatId = state.awaitingPromptChatId || ctx.chat.id;
    const parsed = parseCustomInterval(ctx.message.text, unit);
    await safeDelete(ctx.chat.id, ctx.message.message_id);
    if (!parsed.ok) {
      const notice = await ctx.reply(\`\${parsed.error}\\n\\nUse a whole number — no decimals.\`);
      setTimeout(() => void safeDelete(ctx.chat.id, notice.message_id), 7000);
      return;
    }
    state.intervalSeconds = parsed.seconds;
    state.intervalMinutes = intervalMinutesForCompatibility(parsed.seconds);
    clearAwaiting(state);
    saveState(state);
    if (state.posting) scheduleNextCycle(state);

    const tutorialScreen = advanceTutorialAfterAction(state.uid, 5, 6);
    if (tutorialScreen) {
      try { await bot.api.editMessageText(promptChatId, promptMessageId, tutorialScreen.text, { reply_markup: tutorialScreen.keyboard }); }
      catch { await ctx.reply(tutorialScreen.text, { reply_markup: tutorialScreen.keyboard }); }
      return;
    }

    const screen = intervalScreen(state);
    try { await bot.api.editMessageText(promptChatId, promptMessageId, screen.text, screen.other); }
    catch { await ctx.reply(screen.text, screen.other); }
    return;
  }

  `;
app = replaceOnce(
  app,
  '  if (!hasAccess(state)) return showAccess(ctx, state, true);\n\n  if (state.awaiting === "phone") {',
  '  if (!hasAccess(state)) return showAccess(ctx, state, true);\n\n  ' + customInput + 'if (state.awaiting === "phone") {',
  "app custom interval input handler",
);

write("app.js", app);

let startup = read("startup.js");
startup = replaceOnce(
  startup,
  'import { installPauseResumeBot, installPauseResumeUi } from "./pause-resume-control-v1.js";\n',
  'import { installPauseResumeBot, installPauseResumeUi } from "./pause-resume-control-v1.js";\nimport { installIntervalDisplayUi } from "./interval-settings.js";\nimport { installReferralSystem, installReferralUi } from "./referral-system.js";\n',
  "startup feature imports",
);
startup = replaceOnce(
  startup,
  'installOwnerControlsBot(Bot);\n',
  'installOwnerControlsBot(Bot);\ninstallReferralSystem(Bot);\n',
  "startup referral bot install",
);
startup = replaceOnce(
  startup,
  '// Reliability UI remains outermost so generic legacy posting failures are\n// replaced by exact Telegram reasons after all other transforms finish.\ninstallPostingReliabilityUi(Api);',
  '// Referral and canonical interval display sit outside the standard UI stack so their new controls flow through the existing premium emoji/typography layers.\ninstallIntervalDisplayUi(Api);\ninstallReferralUi(Api);\n// Reliability UI remains outermost so generic legacy posting failures are\n// replaced by exact Telegram reasons after all other transforms finish.\ninstallPostingReliabilityUi(Api);',
  "startup UI feature installs",
);
write("startup.js", startup);

let ux = read("ux-v13.js");
ux = replaceOnce(
  ux,
  'import { advanceTutorialAfterAction } from "./onboarding.js";\n',
  'import { advanceTutorialAfterAction } from "./onboarding.js";\nimport { intervalMinutesForCompatibility, intervalSecondsFromSettings } from "./interval-settings.js";\n',
  "ux interval helper import",
);
ux = replaceOnce(
  ux,
  '    intervalMinutes: Number(settings.intervalMinutes || 30),',
  '    intervalSeconds: intervalSecondsFromSettings(settings),\n    intervalMinutes: intervalMinutesForCompatibility(intervalSecondsFromSettings(settings)),',
  "ux setup snapshot interval",
);
ux = replaceOnce(
  ux,
  '    intervalMinutes: Number(snapshot.intervalMinutes || 30),',
  '    intervalSeconds: intervalSecondsFromSettings(snapshot),\n    intervalMinutes: intervalMinutesForCompatibility(intervalSecondsFromSettings(snapshot)),',
  "ux setup apply interval",
);
write("ux-v13.js", ux);

const pkg = JSON.parse(read("package.json"));
const testV13 = String(pkg.scripts?.["test:v13"] || "");
if (!testV13.includes("referral-custom-interval-test.mjs")) {
  pkg.scripts["test:v13"] = `${testV13} && node referral-custom-interval-test.mjs`;
}
write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

for (const temporary of [
  "scripts/apply-referral-custom-interval-patch.mjs",
  ".github/workflows/apply-referral-custom-interval.yml",
]) {
  try { fs.rmSync(temporary); } catch {}
}

console.log("Guarded referral + custom interval patch applied");
