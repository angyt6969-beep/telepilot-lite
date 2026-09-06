from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return (ROOT / name).read_text(encoding="utf-8")


def write(name, text):
    (ROOT / name).write_text(text, encoding="utf-8")


def replace_once(text, old, new, label):
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one old block, found {count}")
    return text.replace(old, new, 1)


# Only sender accounts that are actually selected globally may validate a new
# public destination. This avoids accepting a destination because an unrelated,
# unselected connected account happens to be a member.
name = "app.js"
text = read(name)
text = replace_once(
    text,
    '''    let matched = null;
    for (const account of accounts) {
      const client = await ensurePersonalClient(ownerState, account.id);''',
    '''    const selectedAccountIds = effectiveAccountIds(ownerState, null, accounts);
    const accountById = new Map(accounts.map(account => [String(account.id), account]));
    let matched = null;
    for (const accountId of selectedAccountIds) {
      const account = accountById.get(String(accountId));
      if (!account) continue;
      const client = await ensurePersonalClient(ownerState, account.id);''',
    "destination validation must use selected senders",
)
text = text.replace(
    'None of your selected sender accounts can currently post to @${wanted}.',
    'None of your selected sender accounts can currently post to @${wanted}.',
)
write(name, text)


# The tutorial's "Use TelePilot Bot" choice must be a real persisted sender
# choice, not merely navigation to the next page. It also needs to invalidate an
# already-loaded app state so the dashboard immediately reflects that choice.
name = "onboarding.js"
text = read(name)
text = replace_once(
    text,
    'import { hasAnyAccount, listAccounts, senderSummary } from "./account-store.js";',
    'import { hasAnyAccount, listAccounts, normalizeAccountSelection, senderSummary } from "./account-store.js";\nimport { reloadUserState } from "./runtime-hooks.js";',
    "onboarding sender imports",
)
text = replace_once(
    text,
    '''function settingsFor(uid) { return readJson(settingsPath(uid), {}); }
function accessActive(uid) {''',
    '''function settingsFor(uid) { return readJson(settingsPath(uid), {}); }
function setTutorialSenderMode(uid, mode) {
  const id = String(uid || "");
  if (!id) return;
  const saved = settingsFor(id);
  const accounts = listAccounts(id);
  if (mode === "bot") {
    writeJson(settingsPath(id), { ...saved, senderMode: "bot", selectedAccountIds: [] });
  } else {
    const selection = normalizeAccountSelection({ ...saved, senderMode: "selected" }, accounts);
    writeJson(settingsPath(id), { ...saved, senderMode: "selected", selectedAccountIds: selection.selected });
  }
  reloadUserState(id);
}
function accessActive(uid) {''',
    "tutorial persisted sender helper",
)
old_page = '''function setupPage2(uid) {
  const connected = hasPersonalSession(uid);
  return {
    text: [
      "📱 Step 1 of 5 — Choose your sender",
      "",
      connected
        ? "✅ At least one personal Telegram account is connected."
        : "Choose who should send your posts.",
      "",
      "TelePilot Bot is the simplest option. A personal account lets posts appear from your own Telegram account.",
      "",
      connected ? "You're ready for the next step." : "You can connect a personal account now, or use TelePilot Bot and continue.",
    ].join("\\n"),
    keyboard: connected
      ? new InlineKeyboard().text("← Back", "tutorial:1").text("Next →", "tutorial:3").row().text("Skip tutorial", "tutorial:skip")
      : new InlineKeyboard()
          .text("👤 Connect Personal Account", "account").row()
          .text("🤖 Use TelePilot Bot", "tutorial:3").row()
          .text("← Back", "tutorial:1").text("Skip tutorial", "tutorial:skip"),
  };
}'''
new_page = '''function setupPage2(uid) {
  const saved = settingsFor(uid);
  const accounts = listAccounts(uid);
  const connected = accounts.length > 0;
  const currentSender = senderSummary(saved, accounts);
  return {
    text: [
      "📱 Step 1 of 5 — Choose your sender",
      "",
      connected
        ? `✅ ${accounts.length} personal account${accounts.length === 1 ? " is" : "s are"} connected.`
        : "Choose who should send your posts.",
      connected ? `Current sender: ${currentSender}` : "",
      "",
      "TelePilot Bot is the simplest option. A personal account lets posts appear from your own Telegram account.",
      "",
      connected ? "Choose the sender you want for this setup, or keep the current selection and continue." : "You can connect a personal account now, or use TelePilot Bot and continue.",
    ].filter(Boolean).join("\\n"),
    keyboard: connected
      ? new InlineKeyboard()
          .text("👤 Use Connected Account", "tutorial:personal").row()
          .text("🤖 Use TelePilot Bot", "tutorial:bot").row()
          .text("← Back", "tutorial:1").text("Next →", "tutorial:3").row()
          .text("Skip tutorial", "tutorial:skip")
      : new InlineKeyboard()
          .text("👤 Connect Personal Account", "account").row()
          .text("🤖 Use TelePilot Bot", "tutorial:bot").row()
          .text("← Back", "tutorial:1").text("Skip tutorial", "tutorial:skip"),
  };
}'''
text = replace_once(text, old_page, new_page, "tutorial sender page")
text = replace_once(
    text,
    '''  bot.callbackQuery(/^tutorial:([1-7])$/, async ctx => {
    await ctx.answerCallbackQuery();
    await showTutorial(ctx, Number(ctx.match[1]), true);
  });''',
    '''  bot.callbackQuery("tutorial:bot", async ctx => {
    const uid = uidOf(ctx);
    if (uid) setTutorialSenderMode(uid, "bot");
    await ctx.answerCallbackQuery({ text: "TelePilot Bot selected" });
    await showTutorial(ctx, 3, true);
  });
  bot.callbackQuery("tutorial:personal", async ctx => {
    const uid = uidOf(ctx);
    if (uid) setTutorialSenderMode(uid, "selected");
    await ctx.answerCallbackQuery({ text: "Personal account selected" });
    await showTutorial(ctx, 3, true);
  });
  bot.callbackQuery(/^tutorial:([1-7])$/, async ctx => {
    await ctx.answerCallbackQuery();
    await showTutorial(ctx, Number(ctx.match[1]), true);
  });''',
    "tutorial sender callbacks",
)
write(name, text)


# Extend regression source invariants for the two final sender-choice fixes.
name = "telepilot-v11-regression-test.mjs"
text = read(name)
text = replace_once(
    text,
    'const senderUi = source("sender-destination-ui.js");',
    'const senderUi = source("sender-destination-ui.js");\nconst onboarding = source("onboarding.js");',
    "onboarding regression fixture",
)
text = replace_once(
    text,
    'assert.match(app, /account_mode_bot/);',
    'assert.match(app, /account_mode_bot/);\nassert.match(app, /selectedAccountIds = effectiveAccountIds\\(ownerState, null, accounts\\)/);',
    "selected destination validation invariant",
)
text = replace_once(
    text,
    'assert.doesNotMatch(senderUi, /personal-session\\.enc/);',
    'assert.doesNotMatch(senderUi, /personal-session\\.enc/);\nassert.match(onboarding, /tutorial:bot/);\nassert.match(onboarding, /tutorial:personal/);\nassert.match(onboarding, /reloadUserState/);',
    "tutorial sender invariants",
)
write(name, text)

print("TelePilot 1.1 final sender-choice checks applied")
