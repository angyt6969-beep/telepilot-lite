from pathlib import Path

DEEP = Path("premium-deep-ui.js")
MAIN = Path("premium-emoji.js")
MARKER = "TELEPILOT_SEMANTIC_EMOJI_V1"


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


deep = DEEP.read_text()
if MARKER not in deep:
    deep = replace_once(
        deep,
        '''function premiumIdForEmoji(emoji) {\n  const exact = directId(emoji);\n  if (exact) return exact;\n  const semantic = firstAvailable(FALLBACK_EMOJI.get(String(emoji || "")) || FALLBACK_EMOJI.get(normalizeEmoji(emoji)) || []);\n  return semantic || stableFallbackId(emoji);\n}\n''',
        '''// TELEPILOT_SEMANTIC_EMOJI_V1\n// Never substitute an unrelated premium emoji. If Telegram does not have an\n// exact premium match for the visible emoji, keep the normal Unicode emoji.\nfunction premiumIdForEmoji(emoji) {\n  return directId(emoji);\n}\n''',
        "deep premium exact-match policy",
    )
    DEEP.write_text(deep)
    print("premium-deep-ui.js semantic emoji fix applied")
else:
    print("premium-deep-ui.js semantic emoji fix already applied")

main = MAIN.read_text()
if MARKER not in main:
    main = replace_once(main, '["access", "💎"],', '["access", "🔑"],', "access button icon")
    main = replace_once(main, '["redeem_key", "💎"],', '["redeem_key", "🔑"],', "redeem button icon")
    main = replace_once(
        main,
        '  "✅", "🔥", "💡", "📱", "📝", "📁", "📆", "📈", "💎", "⚡️", "❗️", "✍️", "👀", "⏳",\n',
        '  "✅", "🔥", "💡", "📱", "📝", "📁", "📆", "📈", "🔑", "⚡️", "❗️", "✍️", "👀", "⏳",\n',
        "premium text emoji list",
    )
    main = replace_once(main, '.replace(/^🔑 Access/m, "💎 Access")', '.replace(/^🔑 Access/m, "🔑 Access")', "access heading")
    main = replace_once(main, '.replace(/^🔒 TelePilot Access/m, "💎 TelePilot Access")', '.replace(/^🔒 TelePilot Access/m, "🔑 TelePilot Access")', "access page heading")
    main = replace_once(main, '.replace(/^Access\\s{2,}/gm, "💎 Access — ")', '.replace(/^Access\\s{2,}/gm, "🔑 Access — ")', "access detail label")
    main = replace_once(
        main,
        'const TELEPILOT_DUCK_CUSTOM_EMOJI_ID = "5231361378748472914";\n',
        'const TELEPILOT_DUCK_CUSTOM_EMOJI_ID = "5231361378748472914";\n\n// TELEPILOT_SEMANTIC_EMOJI_V1\n',
        "main semantic marker",
    )
    MAIN.write_text(main)
    print("premium-emoji.js key semantics fix applied")
else:
    print("premium-emoji.js key semantics fix already applied")
