import importlib.util
import os
import sysconfig

_stdlib_path = os.path.join(sysconfig.get_path("stdlib"), "pathlib.py")
_spec = importlib.util.spec_from_file_location("_telepilot_stdlib_pathlib", _stdlib_path)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
Path = _mod.Path

# The app migration replaces a function section and older migration revisions
# accidentally emitted the end marker twice. Fix only that exact generated form
# before the next migration script runs.
_app = Path("app.js")
if _app.exists():
    _source = _app.read_text()
    _duplicate = "async function handleAdminAwaitingText(ctx, state) {\n\nasync function handleAdminAwaitingText(ctx, state) {"
    if _duplicate in _source:
        _app.write_text(_source.replace(_duplicate, "async function handleAdminAwaitingText(ctx, state) {", 1))
