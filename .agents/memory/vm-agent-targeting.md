---
name: VM agent targeting (multi-VM)
description: How the Odysseus agent targets a specific VM for shell/file tools, and why it uses a process-global instead of a per-call param.
---

# Agent VM targeting

The agent scopes its shell + filesystem tools (bash, python, read_file,
write_file, edit_file, ls, glob, grep) to a VM via a `select_vm` tool that sets a
**process-global selected VM id** (`src/vm_target.py`; `None` = host). `list_vms`
lists the registry. When a VM is selected, the tool dispatcher routes the
routable tools to `do_vm_tool`, which translates each into ONE shell command run
on the VM over the api-server `/api/shell/exec` bridge (`{command, vm}`).

**Why a process-global, not a per-call `vm` param:** tools dispatch by their
content block (and some are MCP-fronted), so there is no clean seam to thread an
extra per-call argument through every tool. A selected-target model needs only
the one `select_vm` tool and leaves every tool's content schema untouched.

## Constraints / gotchas (non-obvious)
- **Interception must stay AFTER the security gates** (disabled/policy/admin/
  public) and before the `ask_user`/UI-marker branches in the dispatcher. Moving
  it earlier would let VM routing bypass tool gating.
- **Translation is base64-wrapped** for python/write_file/edit_file (a
  `python3 -c "exec(base64.b64decode(...))"` one-liner) so arbitrary content
  never fights shell quoting. read_file→`cat --`/`sed -n a,bp`, ls→`ls -la --`,
  glob→`find -name`, grep→`grep -rnE`. edit_file returns `EDIT_NOT_FOUND` /
  `EDIT_NOT_UNIQUE:n` sentinels mapped back to friendly errors.
- **No background jobs on a VM:** `#!bg` is not honored; it rides along as a bash
  comment so the command runs synchronously (honest "no bg on VM"), never as a
  tracked bg job.
- **Auth reuses the existing bridge:** `_internal_headers()` →
  `X-Odysseus-Internal-Token` == api-server `process.env.ODYSSEUS_INTERNAL_TOKEN`.
  `GET /api/vm/list` is unauthenticated (read-only); exec/mutations need the token.
  `_SHELL_EXEC_BASE` (env `ODYSSEUS_SHELL_EXEC_BASE`, set in start.sh) points at
  the api-server, NOT the Python service's own `_INTERNAL_BASE`.
- **Honest failure here:** with no `/dev/kvm` a VM never reaches `running`, so the
  bridge returns exitCode -1 + "VM is not running" and every VM-targeted tool
  fails honestly — same code path connects for real on a KVM/Hyper-V/HVF host.
