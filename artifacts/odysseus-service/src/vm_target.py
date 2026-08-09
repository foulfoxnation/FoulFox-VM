"""
vm_target.py

Process-global "selected VM" and "workspace mode" for the agent's shell +
filesystem tools.

When the agent calls ``select_vm``, the selected VM id is stored here. The tool
dispatcher (``tool_execution._execute_tool_block_impl``) reads it on every tool
call: when set, the shell + filesystem tools (bash/python/read_file/write_file/
edit_file/ls/glob/grep) run on that VM — reached over the api-server
``/api/shell/exec`` bridge — instead of on the host. ``None`` means the host
(the default, and the historical behavior).

``workspace_mode`` is set by the shell UI toggle ("FoulFox OS" / "Windows VM").
When ``"windows"``, chat_processor injects a system context telling the agent
to work in the Windows VM by default.

Kept in its own tiny module with no heavy imports so the dispatcher can read the
selection without importing ``tool_implementations`` (which would create an
import cycle).
"""

from typing import Optional

_selected_vm: Optional[str] = None

# Workspace mode set by the shell UI toggle.
# "windows" → agent works in the Windows VM by default.
# "host"    → agent works on the FoulFox OS host (default).
_workspace_mode: str = "windows"
_workspace_vm_label: Optional[str] = None


def get_selected_vm() -> Optional[str]:
    """The VM id the agent's shell + file tools currently target, or None (host)."""
    return _selected_vm


def set_selected_vm(vm_id: Optional[str]) -> None:
    """Set (or clear, with None/empty) the targeted VM id."""
    global _selected_vm
    _selected_vm = (vm_id or None)


def get_workspace_mode() -> str:
    """The workspace mode set by the shell toggle: 'windows' or 'host'."""
    return _workspace_mode


def get_workspace_vm_label() -> Optional[str]:
    """Human-readable label for the active Windows VM (e.g. 'My Windows VM')."""
    return _workspace_vm_label


def set_workspace_mode(mode: str, vm_label: Optional[str] = None) -> None:
    """Set the workspace mode from the shell toggle."""
    global _workspace_mode, _workspace_vm_label
    _workspace_mode = mode if mode in ("windows", "host") else "host"
    _workspace_vm_label = vm_label or None
