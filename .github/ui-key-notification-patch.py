from pathlib import Path

p = Path('ui-clutter-cleanup-v2.js')
s = p.read_text()

old = 'import { Api } from "grammy";\n'
new = 'import { Api } from "grammy";\nimport { checkoutUrlForUid } from "./crypto-checkout-web.js";\nimport { CHECKOUT_GET_KEY_EMOJI_ID } from "./crypto-checkout-bot-ui.js";\n'
if 'checkoutUrlForUid' not in s:
    assert old in s, 'Api import marker changed'
    s = s.replace(old, new, 1)

old = 'function backButton(callbackData) {\n  return { text: BACK_TEXT, callback_data: callbackData };\n}\n'
new = '''function backButton(callbackData) {\n  return { text: BACK_TEXT, callback_data: callbackData };\n}\n\nfunction checkoutButton(chatId) {\n  return {\n    text: "Buy / Renew Key",\n    url: checkoutUrlForUid(String(chatId || "")),\n    icon_custom_emoji_id: CHECKOUT_GET_KEY_EMOJI_ID,\n    style: "primary",\n  };\n}\n'''
if 'function checkoutButton(chatId)' not in s:
    assert old in s, 'backButton marker changed'
    s = s.replace(old, new, 1)

old = 'const posting = cleanActionButton(buttonByData(other, "v1_posting_setup_v13", "posting_setup"), "Posting Setup", "v1_posting_setup_v13", "primary");'
new = 'const posting = cleanActionButton(buttonByData(other, "v1_posting_setup_v13", "posting_setup"), "Posting Setup", "v1_posting_setup_v13");'
assert old in s, 'dashboard Posting Setup style marker changed'
s = s.replace(old, new, 1)

old = '''    [\n      cleanActionButton(buttonByData(other, "referrals"), "Referrals", "referrals"),\n      cleanActionButton(buttonByData(other, "support"), "Support", "support"),\n    ],\n    [cleanActionButton(buttonByData(other, "tutorial_restart"), "Tutorial", "tutorial_restart")],\n  ];'''
new = '''    [checkoutButton(chatId)],\n    [\n      cleanActionButton(buttonByData(other, "referrals"), "Referrals", "referrals"),\n      cleanActionButton(buttonByData(other, "support"), "Support", "support"),\n    ],\n    [cleanActionButton(buttonByData(other, "tutorial_restart"), "Tutorial", "tutorial_restart")],\n  ];'''
if '[checkoutButton(chatId)]' not in s:
    assert old in s, 'settings rows marker changed'
    s = s.replace(old, new, 1)

marker = '\nfunction destinationMoreRows() {'
addition = '''

function compactNotifications(text, other) {
  const lines = plainLines(text);
  const mode = (metric(lines, "Mode") || "important").toLowerCase();
  const weekly = metric(lines, "Weekly recap") || "Disabled";
  const modeButton = (value, label) => cleanActionButton(
    buttonByData(other, `v1_notify:${value}`),
    mode === value ? `✓ ${label}` : label,
    `v1_notify:${value}`,
    mode === value ? "primary" : undefined,
  );
  const weeklyTemplate = buttonByData(other, "v1_weekly_toggle");
  const rows = [
    [modeButton("all", "All"), modeButton("important", "Important"), modeButton("silent", "Silent")],
    [cleanActionButton(weeklyTemplate, /enabled/i.test(weekly) ? "Disable Weekly Recap" : "Enable Weekly Recap", "v1_weekly_toggle")],
    [backButton("v1_settings_v13")],
  ];
  const body = [
    `<b>Mode:</b> — ${esc(mode.charAt(0).toUpperCase() + mode.slice(1))}`,
    `<b>Weekly recap:</b> — ${esc(weekly)}`,
    "",
    "<i>Choose how much TelePilot should notify you.</i>",
  ];
  return htmlPage(text, other, "🔔", "Notifications", body, rows);
}
'''
if 'function compactNotifications(text, other)' not in s:
    assert marker in s, 'destinationMoreRows marker changed'
    s = s.replace(marker, addition + marker, 1)

old = '  if (/^Settings$/i.test(title)) return compactSettings(chatId, text, ensureNoSmartPreview(other));\n'
new = old + '  if (/^Notifications$/i.test(title)) return compactNotifications(text, ensureNoSmartPreview(other));\n'
if 'return compactNotifications' not in s:
    assert old in s, 'cleanup Settings marker changed'
    s = s.replace(old, new, 1)

old = '  compactSettings,\n  destinationMoreRows,'
new = '  compactSettings,\n  compactNotifications,\n  destinationMoreRows,'
if '  compactNotifications,\n' not in s:
    assert old in s, '__test marker changed'
    s = s.replace(old, new, 1)

p.write_text(s)

p = Path('ui-clutter-cleanup-v2-test.mjs')
s = p.read_text()
env_marker = 'process.env.TELEPILOT_ADMIN_ID = "42";\n'
env_add = 'process.env.PUBLIC_URL = "https://telepilot.example";\nprocess.env.TELEPILOT_SECURITY_SECRET = "test-only-ui-key-notification-secret-0123456789abcdef";\n'
if 'process.env.PUBLIC_URL = "https://telepilot.example";' not in s:
    assert env_marker in s, 'test env marker changed'
    s = s.replace(env_marker, env_marker + env_add, 1)

marker = 'assert.equal(buttons(activeDashboard).find(item => item.callback_data === "v1_settings_v13")?.style, "primary", "Settings should use blue primary styling");\n'
add = marker + 'assert.equal(buttons(activeDashboard).find(item => item.callback_data === "v1_posting_setup_v13")?.style, undefined, "Posting Setup should stay neutral");\n'
if 'Posting Setup should stay neutral' not in s:
    assert marker in s, 'dashboard style assertion marker changed'
    s = s.replace(marker, add, 1)

marker = 'assert.equal(lastRow(settings)[0]?.style, undefined);\n'
add = '''assert.equal(lastRow(settings)[0]?.style, undefined);\nconst buyKey = buttons(settings).find(item => item.text === "Buy / Renew Key");\nassert.ok(buyKey, "Settings should expose Buy / Renew Key");\nassert.match(String(buyKey.url || ""), /^https:\/\/telepilot\.example\/checkout\?t=/);\nassert.equal(buyKey.icon_custom_emoji_id, "5307843983102204243");\nassert.equal(buyKey.style, "primary");\n'''
if 'Settings should expose Buy / Renew Key' not in s:
    assert marker in s, 'settings assertion marker changed'
    s = s.replace(marker, add, 1)

s = s.replace('assert.ok(actionCount(normalSettings) <= 5);', 'assert.ok(actionCount(normalSettings) <= 6);')

marker = 'const moreRows = __test.destinationMoreRows();\n'
notification_test = '''const notificationOther = other([\n  [button("All", "v1_notify:all"), button("✓ Important", "v1_notify:important"), button("Silent", "v1_notify:silent")],\n  [button("Disable weekly recap", "v1_weekly_toggle")],\n  [button("Advanced", "v1_tools", { style: "primary" })],\n]);\nconst notifications = cleanupUiClutterV2(42, "🔔 Notifications\\nMode — important\\nWeekly recap — Enabled", notificationOther);\nassert.deepEqual(callbacks(notifications), ["v1_notify:all", "v1_notify:important", "v1_notify:silent", "v1_weekly_toggle", "v1_settings_v13"]);\nassert.equal(callbacks(notifications).includes("v1_tools"), false, "Notifications must not expose Advanced");\nassert.equal(buttons(notifications).find(item => item.callback_data === "v1_notify:important")?.style, "primary");\nassert.equal(lastRow(notifications)[0]?.text, __test.BACK_TEXT);\nassert.equal(lastRow(notifications)[0]?.callback_data, "v1_settings_v13");\n\n'''
if 'Notifications must not expose Advanced' not in s:
    assert marker in s, 'notification test insertion marker changed'
    s = s.replace(marker, notification_test + marker, 1)

old = 'for (const result of [posting, activity, cleanActivity, destinations, cleanDestinations, settings, normalSettings]) {'
new = 'for (const result of [posting, activity, cleanActivity, destinations, cleanDestinations, settings, normalSettings, notifications]) {'
if new not in s:
    assert old in s, 'final back loop marker changed'
    s = s.replace(old, new, 1)
p.write_text(s)
