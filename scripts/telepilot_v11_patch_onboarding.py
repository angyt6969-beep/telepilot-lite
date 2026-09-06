from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count == 0 and new in text:
        return text
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


# Make onboarding aware of the new multi-account store instead of the removed legacy session file.
p = Path("onboarding.js")
s = p.read_text()
s = replace_once(
    s,
    'import { InlineKeyboard } from "grammy";\n',
    'import { InlineKeyboard } from "grammy";\nimport { hasAnyAccount, listAccounts, senderSummary } from "./account-store.js";\n',
    "onboarding account-store import",
)
s = s.replace('function personalSessionPath(uid) { return path.join(userDir(uid), "personal-session.enc"); }\n', '')
s = replace_once(
    s,
    '''function hasPersonalSession(uid) {\n  try { return fs.existsSync(personalSessionPath(uid)) && fs.statSync(personalSessionPath(uid)).size > 20; }\n  catch { return false; }\n}\n''',
    '''function hasPersonalSession(uid) { return hasAnyAccount(uid); }\n''',
    "onboarding account detection",
)
s = s.replace('"📱 Personal-account or bot posting",', '"📱 One or more personal-account senders, or bot posting",')
s = s.replace('"• Post from TelePilot Bot or your personal Telegram account",', '"• Post from TelePilot Bot or one or more personal Telegram accounts",')
s = s.replace('? "✅ Your personal Telegram account is connected."', '? "✅ At least one personal Telegram account is connected."')
s = replace_once(
    s,
    '''  const sender = hasPersonalSession(uid)\n    ? (saved.personalUsername ? `@${saved.personalUsername}` : "Personal account")\n    : "TelePilot Bot";''',
    '''  const sender = hasPersonalSession(uid)\n    ? senderSummary(saved, listAccounts(uid))\n    : "TelePilot Bot";''',
    "onboarding sender summary",
)
p.write_text(s)


# Opening Smart Preview during tutorial Step 5 should advance to the ready/finish step.
p = Path("v1-extras.js")
s = p.read_text()
s = replace_once(
    s,
    'import { InlineKeyboard } from "grammy";\n',
    'import { InlineKeyboard } from "grammy";\nimport { listAccounts, senderSummary } from "./account-store.js";\nimport { advanceTutorialAfterAction } from "./onboarding.js";\n',
    "preview imports",
)
s = replace_once(
    s,
    '''function senderLabel(settings) {\n  return settings.personalUsername ? `@${settings.personalUsername}` : "TelePilot Bot";\n}\n''',
    '''function senderLabel(settings, uid) {\n  const accounts = listAccounts(uid);\n  return accounts.length ? senderSummary(settings, accounts) : "TelePilot Bot";\n}\n''',
    "preview sender summary",
)
s = replace_once(
    s,
    '  const kb = new InlineKeyboard();\n',
    '  const kb = new InlineKeyboard();\n  const tutorialReady = advanceTutorialAfterAction(uid, 6, 7);\n  if (tutorialReady) kb.text("✅ Finish setup", "tutorial:7").row();\n',
    "preview tutorial continuation",
)
s = s.replace('`Sender — ${senderLabel(settings)}`', '`Sender — ${senderLabel(settings, uid)}`')
p.write_text(s)


# Keep the UI recognizer aligned with the 1.1 changelog heading.
p = Path("v1-ui.js")
s = p.read_text().replace('"🆕 What\'s new in TelePilot 1.0",', '"🆕 What\'s new in TelePilot 1.1",')
p.write_text(s)

print("TelePilot 1.1 onboarding/preview migration applied")
