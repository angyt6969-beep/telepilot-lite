from pathlib import Path

script = Path(__file__).with_name("telepilot_v11_release_gate_fix.py")
source = script.read_text(encoding="utf-8")
start_marker = "# v1-extras.js: Smart Preview must never call multi-account mode \"Bot\"."
end_marker = "# sender-destination-ui.js: stop reading the deleted legacy session path."
start = source.find(start_marker)
end = source.find(end_marker, start)
if start < 0 or end < 0:
    raise RuntimeError("Could not locate the Smart Preview patch section")
# The onboarding migration already converted v1-extras.js to listAccounts +
# senderSummary. Skip that historical patch section and apply the remaining
# release-gate changes against the current branch state.
source = source[:start] + "# Smart Preview is already multi-account-aware on this branch.\n\n" + source[end:]
exec(compile(source, str(script), "exec"), {"__name__": "__main__", "__file__": str(script)})
