---
name: Static-testing odysseus-service tool functions
description: How to import/exercise src.tool_implementations do_* functions without booting the service (no KVM).
---

Importing `src.tool_implementations` (or anything that pulls `core`) HANGS in a
bare script outside the running service: `core/__init__.py` does heavy
LLM/auth/session init at import time. tool_implementations itself only needs
`core.constants.internal_api_base`.

To statically test the do_* tool functions, stub the `core` package in
sys.modules BEFORE importing, and run from `artifacts/odysseus-service` with the
service dir on PYTHONPATH:

    import sys, types
    c = types.ModuleType("core"); c.__path__ = []
    cc = types.ModuleType("core.constants")
    cc.internal_api_base = lambda *a, **k: "http://127.0.0.1:0"
    c.constants = cc
    sys.modules["core"] = c; sys.modules["core.constants"] = cc
    # then: import src.tool_implementations as ti

Then monkeypatch the VM bridges to capture generated commands without a guest:
`ti._vm_shell_exec`, `ti._vm_input`, `ti._vm_os_kind`. For Windows VM tools the
guest command is base64 inside `powershell ... -EncodedCommand <b64utf16le>` —
decode with `base64.b64decode(b64).decode("utf-16le")` to assert on it.

**Why:** this host has no KVM, so guest VMs never boot; command-generation is the
only thing verifiable here, and the real code path is identical on a KVM host.
**How to apply:** use for any static verification of odysseus-service VM/shell
tools (do_vm_tool, do_vm_app, etc.).
