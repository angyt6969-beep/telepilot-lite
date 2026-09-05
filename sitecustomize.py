import os
from pathlib import Path

if os.environ.get("GITHUB_ACTIONS") == "true":
    app = Path("app.js")
    if app.exists():
        source = app.read_text()
        duplicate = "async function handleAdminAwaitingText(ctx, state) {\n\nasync function handleAdminAwaitingText(ctx, state) {"
        if duplicate in source:
            app.write_text(source.replace(duplicate, "async function handleAdminAwaitingText(ctx, state) {", 1))
