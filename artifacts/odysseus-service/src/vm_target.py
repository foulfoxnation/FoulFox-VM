"""
vm_target.py

Process-global "selected VM" for the agent's shell + filesystem tools.

When the agent calls ``select_vm``, the selected VM id is stored here. The tool
dispatcher (``tool_execution._execute_tool_block_impl``) reads it on every tool
call: when set, the shell + filesystem tools (bash/python/read_file/write_file/
edit_file/ls/glob/grep) run on that VM — reached over the api-server
``/api/shell/exec`` bridge — instead of on the host. ``None`` means the host
(the default, and the historical behavior).

Kept in its own tiny module with no heavy imports so the dispatcher can read the
selection without importing ``tool_implementations`` (which would create an
import cycle).
"""

from typing import Optional

_selected_vm: Optional[str] = None


def get_selected_vm() -> Optional[str]:
    """The VM id the agent's shell + file tools currently target, or None (host)."""
    return _selected_vm


def set_selected_vm(vm_id: Optional[str]) -> None:
    """Set (or clear, with None/empty) the targeted VM id."""
    global _selected_vm
    _selected_vm = (vm_id or None)
