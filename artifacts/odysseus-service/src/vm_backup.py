"""
FoulFox — Windows VM folder backup.

Periodically (every 6 h) pulls Documents, Desktop, and Downloads from each
running Windows guest via SCP, using the per-VM ed25519 key provisioned
during VM setup.  Each run creates a timestamped snapshot under

    $ODYSSEUS_DATA_DIR/vm-backups/windows/<vm-id>/<YYYYMMDD_HHMMSS>/

and the last KEEP (default 5) snapshots per VM are retained.

Non-ready VMs (wrong state, no SSH port, no key) are skipped silently.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────
DATA_DIR         = os.environ.get("ODYSSEUS_DATA_DIR", "/var/lib/foulfox")
BACKUP_ROOT      = os.path.join(DATA_DIR, "vm-backups", "windows")
KEYS_ROOT        = os.path.join(DATA_DIR, "keys")
API_PORT         = os.environ.get("PORT", "8080")
SSH_USER         = os.environ.get("FF_VM_SSH_USER", "foulfox")
KEEP_SNAPSHOTS   = int(os.environ.get("FF_VM_BACKUP_KEEP", "5"))
BACKUP_INTERVAL  = int(os.environ.get("FF_VM_BACKUP_INTERVAL_HOURS", "6")) * 3600
DEFAULT_FOLDERS  = ["Documents", "Desktop", "Downloads"]


# ── Key / path helpers ─────────────────────────────────────────────────────────

def _key_path(vm_id: str) -> Optional[str]:
    """Return the ed25519 key path for a VM, or None if not found."""
    # Primary layout: $KEYS_ROOT/<vm-id>/id_ed25519
    for layout in (
        os.path.join(KEYS_ROOT, vm_id, "id_ed25519"),
        os.path.join(KEYS_ROOT, f"{vm_id}.pem"),
        os.path.join(KEYS_ROOT, f"{vm_id}.key"),
    ):
        if os.path.isfile(layout):
            return layout
    return None


def _snapshot_dir(vm_id: str) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return Path(BACKUP_ROOT) / vm_id / ts


def _status_path(vm_id: str) -> Path:
    return Path(BACKUP_ROOT) / vm_id / "status.json"


def _write_status(vm_id: str, data: dict) -> None:
    sp  = _status_path(vm_id)
    sp.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(sp) + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, sp)


def read_status(vm_id: str) -> dict:
    sp = _status_path(vm_id)
    if not sp.exists():
        return {
            "vmId": vm_id, "state": "never",
            "lastBackupAt": None, "sizeBytes": 0,
            "copiedFolders": [], "snapshots": [],
        }
    try:
        with open(sp) as fh:
            return json.load(fh)
    except Exception:
        return {
            "vmId": vm_id, "state": "error",
            "lastBackupAt": None, "sizeBytes": 0,
            "copiedFolders": [], "snapshots": [],
        }


def list_snapshots(vm_id: str) -> list[dict]:
    vm_dir = Path(BACKUP_ROOT) / vm_id
    if not vm_dir.is_dir():
        return []
    snaps = []
    for entry in sorted(vm_dir.iterdir(), reverse=True):
        if not entry.is_dir():
            continue
        try:
            size = sum(f.stat().st_size for f in entry.rglob("*") if f.is_file())
        except Exception:
            size = 0
        # Parse timestamp from dir name: YYYYMMDD_HHMMSS
        try:
            dt = datetime.strptime(entry.name, "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)
            created_at = dt.isoformat()
        except ValueError:
            created_at = entry.name
        snaps.append({
            "snapshotId": entry.name,
            "vmId":       vm_id,
            "createdAt":  created_at,
            "sizeBytes":  size,
            "folders":    [d.name for d in entry.iterdir() if d.is_dir()],
        })
    return snaps


def _prune_snapshots(vm_id: str) -> None:
    vm_dir = Path(BACKUP_ROOT) / vm_id
    if not vm_dir.is_dir():
        return
    dirs = sorted(
        [d for d in vm_dir.iterdir() if d.is_dir()],
        key=lambda d: d.name,
        reverse=True,
    )
    for old in dirs[KEEP_SNAPSHOTS:]:
        try:
            shutil.rmtree(old)
            logger.info("[vm_backup] pruned old snapshot %s", old)
        except Exception as exc:
            logger.warning("[vm_backup] could not prune %s: %s", old, exc)


def _dir_size(path: Path) -> int:
    try:
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    except Exception:
        return 0


# ── VM list ────────────────────────────────────────────────────────────────────

async def _fetch_vms() -> list[dict]:
    """Fetch running VM list from the api-server."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"http://127.0.0.1:{API_PORT}/api/vm/list")
            r.raise_for_status()
            return r.json().get("vms", [])
    except Exception as exc:
        logger.warning("[vm_backup] could not fetch VM list: %s", exc)
        return []


# ── SCP transfer ───────────────────────────────────────────────────────────────

async def _scp_folder(
    ssh_user: str,
    ssh_host: str,
    ssh_port: int,
    key_path: str,
    remote_folder: str,   # relative to SSH user's home dir on Windows
    local_dest: Path,
) -> tuple[bool, str]:
    """
    Pull a single folder from the Windows guest via SCP.
    Returns (success, detail).
    Paths relative to home work with Windows OpenSSH out of the box.
    """
    local_dest.mkdir(parents=True, exist_ok=True)
    cmd = [
        "scp", "-r",
        "-i", key_path,
        "-P", str(ssh_port),
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=15",
        "-o", "BatchMode=yes",
        f"{ssh_user}@{ssh_host}:{remote_folder}",
        str(local_dest / remote_folder),
    ]
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode == 0:
            return True, "ok"
        err = result.stderr.strip() or f"scp exited {result.returncode}"
        return False, err
    except subprocess.TimeoutExpired:
        return False, "timed out after 5 minutes"
    except FileNotFoundError:
        return False, "'scp' not found on host — install openssh-client"
    except Exception as exc:
        return False, str(exc)


# ── Core backup ────────────────────────────────────────────────────────────────

async def backup_vm(
    vm_id:    str,
    ssh_port: int,
    ssh_host: str = "127.0.0.1",
    folders:  Optional[list[str]] = None,
) -> dict:
    """
    Pull Windows user folders from a single running VM into a timestamped
    snapshot directory.  Skips silently if the SSH key is missing.
    Returns a result dict with ok, skipped, detail, status.
    """
    folders = folders or DEFAULT_FOLDERS
    key     = _key_path(vm_id)

    if not key:
        msg = f"No SSH key for VM {vm_id} — skipping"
        logger.info("[vm_backup] %s", msg)
        return {"ok": False, "skipped": True, "detail": msg}

    snap_dir = _snapshot_dir(vm_id)
    snap_dir.mkdir(parents=True, exist_ok=True)
    started  = time.time()
    copied:  list[str] = []
    errors:  list[str] = []

    for folder in folders:
        ok, detail = await _scp_folder(
            ssh_user=SSH_USER,
            ssh_host=ssh_host,
            ssh_port=ssh_port,
            key_path=key,
            remote_folder=folder,
            local_dest=snap_dir,
        )
        if ok:
            copied.append(folder)
            logger.info("[vm_backup] %s — ✅ %s", vm_id, folder)
        else:
            errors.append(f"{folder}: {detail}")
            logger.warning("[vm_backup] %s — ⚠️  %s: %s", vm_id, folder, detail)

    # If nothing was copied, remove the empty snapshot dir so it doesn't clutter
    if not copied:
        try:
            shutil.rmtree(snap_dir)
        except Exception:
            pass
        status = {
            "vmId": vm_id, "state": "failed",
            "lastBackupAt": datetime.now(timezone.utc).isoformat(),
            "lastError": "; ".join(errors),
            "sizeBytes": 0, "copiedFolders": [],
            "snapshots": [s["snapshotId"] for s in list_snapshots(vm_id)],
        }
        _write_status(vm_id, status)
        return {"ok": False, "skipped": False, "detail": "; ".join(errors)}

    size = _dir_size(snap_dir)
    _prune_snapshots(vm_id)

    status = {
        "vmId":          vm_id,
        "state":         "ok" if not errors else "partial",
        "lastBackupAt":  datetime.now(timezone.utc).isoformat(),
        "lastError":     ("; ".join(errors) if errors else None),
        "sizeBytes":     size,
        "durationSec":   round(time.time() - started, 1),
        "copiedFolders": copied,
        "snapshots":     [s["snapshotId"] for s in list_snapshots(vm_id)],
    }
    _write_status(vm_id, status)
    logger.info(
        "[vm_backup] %s — done: %s (%d KB in %.1fs)",
        vm_id, copied, size // 1024, time.time() - started,
    )
    return {"ok": True, "skipped": False, "detail": f"Copied {copied}", "status": status}


async def backup_all_windows_vms() -> list[dict]:
    """
    Back up every running Windows VM.
    Non-ready VMs (wrong state, no SSH port, missing key) are skipped silently.
    """
    vms     = await _fetch_vms()
    results = []
    for vm in vms:
        if vm.get("osKind") != "windows":
            continue
        if vm.get("state") != "running":
            logger.debug("[vm_backup] skip %s — state=%s", vm.get("id"), vm.get("state"))
            continue
        ports    = vm.get("ports") or {}
        ssh_port = ports.get("ssh") or vm.get("sshPort")
        if not ssh_port:
            logger.debug("[vm_backup] skip %s — no SSH port", vm.get("id"))
            continue
        result = await backup_vm(vm_id=vm["id"], ssh_port=int(ssh_port))
        results.append({"vmId": vm["id"], **result})
    return results


# ── Background scheduler ───────────────────────────────────────────────────────

_loop_task: Optional[asyncio.Task] = None


async def _run_scheduler() -> None:
    logger.info(
        "[vm_backup] scheduler started — backing up every %dh, keeping %d snapshots",
        BACKUP_INTERVAL // 3600,
        KEEP_SNAPSHOTS,
    )
    while True:
        await asyncio.sleep(BACKUP_INTERVAL)
        try:
            results = await backup_all_windows_vms()
            ok  = sum(1 for r in results if r.get("ok"))
            skp = sum(1 for r in results if r.get("skipped"))
            logger.info("[vm_backup] scheduled run: %d ok, %d skipped", ok, skp)
        except Exception as exc:
            logger.warning("[vm_backup] scheduler error: %s", exc)


def start_backup_scheduler() -> None:
    """Start the background 6-hour backup loop (idempotent)."""
    global _loop_task
    if _loop_task and not _loop_task.done():
        return
    _loop_task = asyncio.create_task(_run_scheduler())
