---
name: Python deps install in this repl
description: How to install Python packages into .pythonlibs when the standard tools fail.
---

# Installing Python packages in this workspace

`pip install`, the `installLanguagePackages` callback, and `uv add` all FAIL here
with "Permission denied" / externally-managed-environment errors, because they try
to write into the immutable Nix store interpreter.

**Working method:**
```
uv pip install --target /home/runner/workspace/.pythonlibs/lib/python3.11/site-packages <pkgs>
```
The workspace `python3` resolves `.pythonlibs/lib/python3.11/site-packages` on its
path, so packages installed there import normally.

**Why:** the active interpreter is `/home/runner/workspace/.pythonlibs/bin/python`
(CPython 3.11) but its site-packages is the only writable target; `--target`
unpacks straight into it without touching the Nix store.

**How to apply:** any time you must add a Python dependency for a service in this
repl (e.g. the Odysseus service), use the `--target` form above. Heavy optional
deps (fastembed, chromadb) can be skipped — apps that need them should degrade
gracefully.
