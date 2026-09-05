from pathlib import Path

app = Path("app.js")
source = app.read_text()
source = source.replace(
    "async function handleAdminAwaitingText(ctx, state) {\n\nasync function handleAdminAwaitingText(ctx, state) {",
    "async function handleAdminAwaitingText(ctx, state) {",
)
app.write_text(source)
print("Generated security migration boundary fixes applied")
