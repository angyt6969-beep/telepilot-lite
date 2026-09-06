from pathlib import Path

script = Path(__file__).with_name("telepilot_v11_release_gate_fix.py")
source = script.read_text(encoding="utf-8")

# The original release-gate patch used a broad first-match brace cleanup after
# replacing the final senderSummary function. Restrict that cleanup to EOF so
# it cannot remove a brace from an earlier function.
bad_cleanup = 'text = text.replace("}\\n}\\n", "}\\n", 1) if "export function senderSummary" in text else text'
good_cleanup = 'text = text[:-2] if text.endswith("}\\n}\\n") else text'
if bad_cleanup not in source:
    raise RuntimeError("Could not locate account-store cleanup in release-gate patch")
source = source.replace(bad_cleanup, good_cleanup, 1)

start_marker = "# v1-extras.js: Smart Preview must never call multi-account mode \"Bot\"."
end_marker = "# sender-destination-ui.js: stop reading the deleted legacy session path."
start = source.find(start_marker)
end = source.find(end_marker, start)
if start < 0 or end < 0:
    raise RuntimeError("Could not locate the Smart Preview patch section")

# Smart Preview was already migrated to listAccounts + senderSummary by the
# onboarding integration. Skip that historical patch block and apply the rest.
source = source[:start] + "# Smart Preview is already multi-account-aware on this branch.\n\n" + source[end:]
exec(compile(source, str(script), "exec"), {"__name__": "__main__", "__file__": str(script)})

# Repair generated JavaScript Array.join literals: the patch template turns a
# backslash-n escape into a raw newline, which is illegal inside JS quotes.
app_path = script.parent.parent / "app.js"
app = app_path.read_text(encoding="utf-8")
app = app.replace('.join("\n")', '.join("\\n")')
app_path.write_text(app, encoding="utf-8")
