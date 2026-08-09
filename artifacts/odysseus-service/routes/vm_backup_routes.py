"""
Windows VM backup API.

GET  /api/vm/{vm_id}/windows-backup/status   last run info + snapshot list
POST /api/vm/{vm_id}/windows-backup          trigger a backup now
GET  /api/vm/{vm_id}/windows-backups         list snapshots (alias)
"""
from __future__ import annotations

import asyncio
import logging
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional

logger = logging.getLogger(__name__)
router = APIRouter(tags=["vm-backup"])


class WindowsBackupRequest(BaseModel):
    folders: Optional[List[str]] = None   # override default folders


@router.get("/api/vm/{vm_id}/windows-backup/status")
async def windows_backup_status(vm_id: str):
    """Return the last backup run status and snapshot list for a VM."""
    from src.vm_backup import read_status, list_snapshots
    status    = read_status(vm_id)
    snapshots = list_snapshots(vm_id)
    return JSONResponse({"status": status, "snapshots": snapshots})


@router.get("/api/vm/{vm_id}/windows-backups")
async def windows_backup_list(vm_id: str):
    """List all snapshots for a VM."""
    from src.vm_backup import list_snapshots
    return JSONResponse({"snapshots": list_snapshots(vm_id)})


@router.post("/api/vm/{vm_id}/windows-backup")
async def windows_backup_now(vm_id: str, body: WindowsBackupRequest = WindowsBackupRequest()):
    """
    Trigger an immediate backup for a single VM.
    Fetches SSH port from the api-server; returns 409 if VM is not ready.
    """
    from src.vm_backup import backup_vm, _fetch_vms

    vms = await _fetch_vms()
    vm  = next((v for v in vms if v.get("id") == vm_id), None)
    if vm is None:
        raise HTTPException(status_code=404, detail=f"VM '{vm_id}' not found")

    if vm.get("state") != "running":
        raise HTTPException(
            status_code=409,
            detail=f"VM '{vm_id}' is not running (state={vm.get('state')}) — start it first",
        )

    ports    = vm.get("ports") or {}
    ssh_port = ports.get("ssh") or vm.get("sshPort")
    if not ssh_port:
        raise HTTPException(status_code=409, detail=f"VM '{vm_id}' has no SSH port configured")

    try:
        result = await asyncio.wait_for(
            backup_vm(
                vm_id=vm_id,
                ssh_port=int(ssh_port),
                folders=body.folders or None,
            ),
            timeout=600,   # 10 min hard cap for manual backup
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Backup timed out after 10 minutes")

    if result.get("skipped"):
        raise HTTPException(status_code=409, detail=result["detail"])

    status_code = 200 if result["ok"] else 500
    return JSONResponse(result, status_code=status_code)
