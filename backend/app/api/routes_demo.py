from __future__ import annotations

import os
from collections import deque
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Query
from starlette.responses import FileResponse

from app.deps import get_twin_service
from app.models.domain import DecisionResponse

router = APIRouter()


def _require_demo_mode() -> None:
    if os.getenv("DEMO_MODE", "false").strip().lower() not in ("1", "true", "yes", "on"):
        raise HTTPException(status_code=404, detail="Not found")


@router.post("/scenario/{name}", response_model=DecisionResponse)
async def run_demo_scenario(name: str) -> DecisionResponse:
    """
    Deterministic demo scenarios:
      - approved
      - grid_block
      - thermal_block
    """
    _require_demo_mode()
    svc = get_twin_service()

    orig_T = float(svc.therm_state.T_c)
    orig_cool = float(svc.therm_state.P_cool_kw)
    orig_gnn = svc.gnn

    try:
        # Ensure deterministic behavior (avoid random GNN clamp)
        svc.gnn = None

        if name == "approved":
            svc.therm_state.T_c = 42.0
            svc.therm_state.P_cool_kw = 800.0
            out = svc.decide(
                deltaP_request_kw=400.0,
                P_site_kw=20000.0,
                grid_headroom_kw=5000.0,
                horizon_s=30,
                dt_s=1,
                ramp_rate_kw_per_s=250.0,
            )

        elif name == "grid_block":
            svc.therm_state.T_c = 42.0
            svc.therm_state.P_cool_kw = 800.0
            out = svc.decide(
                deltaP_request_kw=1500.0,
                P_site_kw=25000.0,
                grid_headroom_kw=0.0,
                horizon_s=30,
                dt_s=1,
                ramp_rate_kw_per_s=250.0,
            )

        elif name == "thermal_block":
            # Start near T_max and request an import (negative deltaP) to force heat rise.
            svc.therm_state.T_c = 49.7
            svc.therm_state.P_cool_kw = 400.0
            out = svc.decide(
                deltaP_request_kw=-2000.0,
                P_site_kw=50000.0,
                grid_headroom_kw=20000.0,
                horizon_s=30,
                dt_s=1,
                ramp_rate_kw_per_s=500.0,
            )

        else:
            raise HTTPException(status_code=400, detail="Unknown scenario")

        return DecisionResponse(**out)

    finally:
        svc.therm_state.T_c = orig_T
        svc.therm_state.P_cool_kw = orig_cool
        svc.gnn = orig_gnn


@router.post("/reset")
async def reset_demo_state() -> Dict[str, Any]:
    _require_demo_mode()
    svc = get_twin_service()
    svc.therm_state.T_c = 42.0
    svc.therm_state.P_cool_kw = 800.0
    return {"ok": True, "T_c": svc.therm_state.T_c, "P_cool_kw": svc.therm_state.P_cool_kw}


@router.get("/logs/tail")
async def demo_logs_tail(lines: int = Query(200, ge=10, le=2000)) -> Dict[str, Any]:
    _require_demo_mode()
    log_dir = os.getenv("LOG_DIR")
    if not log_dir:
        return {"ok": False, "hint": "Set LOG_DIR to enable file logs."}

    path = os.path.join(log_dir, "backend.jsonl")
    if not os.path.exists(path):
        return {"ok": False, "hint": f"Log file not found at {path}. Ensure file logging is enabled."}

    dq = deque(maxlen=lines)
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            dq.append(line.rstrip("\n"))

    return {"ok": True, "path": path, "lines": list(dq)}


@router.get("/logs/download")
async def demo_logs_download() -> FileResponse:
    _require_demo_mode()
    log_dir = os.getenv("LOG_DIR")
    if not log_dir:
        raise HTTPException(status_code=400, detail="LOG_DIR not set")

    path = os.path.join(log_dir, "backend.jsonl")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="backend.jsonl not found")

    return FileResponse(path, filename="backend.jsonl", media_type="application/json")
