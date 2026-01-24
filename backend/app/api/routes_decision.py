from __future__ import annotations

from fastapi import APIRouter, Query
from app.deps import get_twin_service
from app.models.domain import DecisionResponse

router = APIRouter()

@router.get("/latest", response_model=DecisionResponse)
async def decision_latest(
    deltaP_request_kw: float = Query(300.0, ge=0.0, le=5000.0, description="Requested shift/load change (kW)"),
    P_site_kw: float = Query(1000.0, ge=0.0, le=10000.0, description="Current site IT load (kW)"),
    grid_headroom_kw: float = Query(1500.0, ge=0.0, le=10000.0, description="Grid headroom available (kW)"),
    horizon_s: int = Query(30, ge=5, le=300, description="Ramp planning horizon (seconds)"),
    dt_s: int = Query(1, ge=1, le=10, description="Simulation timestep (seconds)"),
    ramp_rate_kw_per_s: float = Query(50.0, ge=1.0, le=1000.0, description="Ramp rate cap (kW/s)"),
) -> DecisionResponse:
    svc = get_twin_service()

    out = svc.decide(
        deltaP_request_kw=deltaP_request_kw,
        P_site_kw=P_site_kw,
        grid_headroom_kw=grid_headroom_kw,
        horizon_s=horizon_s,
        dt_s=dt_s,
        ramp_rate_kw_per_s=ramp_rate_kw_per_s,
    )

    return DecisionResponse(**out)
